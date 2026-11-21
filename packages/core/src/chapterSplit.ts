import { insertSpineDocumentsAfter } from './opfEdit'
import { dirname, relativePath } from './path'
import { collectDocumentIds, rewriteAnchorReferences } from './references'
import type { EpubArchive, EpubPackage } from './types'
import { parsePackage } from './unpack'
import type { XmlCodec } from './xml'

/**
 * Sigil-compatible chapter splitting engine (`<hr class="sigil_split_marker" />`).
 * Operates directly on the source XHTML string with a strict XML tag stack so `<head>`,
 * namespaces, XML declarations, MathML/SVG islands, and original EOL stay intact.
 * See ADR 2026-11-21-chapter-structure-and-resource-tools.
 */

export const SPLIT_MARKER_CLASS = 'sigil_split_marker'
export const SPLIT_MARKER_HTML = '<hr class="sigil_split_marker" />'

const SPLIT_MARKER_TAG =
  /^<hr\b[^>]*\bclass\s*=\s*(?:"[^"]*\bsigil_split_marker\b[^"]*"|'[^']*\bsigil_split_marker\b[^']*')[^>]*\/?>$/i

const PROTECTED_ISLANDS = new Set(['math', 'svg', 'video', 'audio'])

const encoder = new TextEncoder()

export interface BodyBounds {
  openStart: number
  openEnd: number
  closeStart: number
  closeEnd: number
  openTag: string
  innerXml: string
}

interface OpenTagFrame {
  name: string
  lowerName: string
  openTag: string
  openStart: number
  openEnd: number
}

type BodyToken =
  | { kind: 'comment' | 'cdata' | 'pi' | 'text'; start: number; end: number }
  | { kind: 'open'; start: number; end: number; name: string; lowerName: string; raw: string }
  | { kind: 'self-closing'; start: number; end: number; name: string; lowerName: string; raw: string }
  | { kind: 'close'; start: number; end: number; name: string; lowerName: string }

export function detectDominantEol(text: string): '\r\n' | '\n' {
  let crlf = 0
  let lf = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      if (index > 0 && text[index - 1] === '\r') crlf += 1
      else lf += 1
    }
  }
  return crlf > lf ? '\r\n' : '\n'
}

function skipQuoted(text: string, start: number, quote: string): number {
  let index = start + 1
  while (index < text.length && text[index] !== quote) index += 1
  return index < text.length ? index + 1 : text.length
}

function readTagEnd(xml: string, start: number): { end: number; selfClosing: boolean; closed: boolean } {
  let index = start
  while (index < xml.length) {
    const ch = xml[index]
    if (ch === '"' || ch === "'") {
      index = skipQuoted(xml, index, ch)
      continue
    }
    if (ch === '>') {
      let prev = index - 1
      while (prev > start && /\s/.test(xml[prev] ?? '')) prev -= 1
      return { end: index + 1, selfClosing: xml[prev] === '/', closed: true }
    }
    index += 1
  }
  return { end: xml.length, selfClosing: false, closed: false }
}

/** Finds `<body...>...</body>` while skipping comments and CDATA in `<head>` / prolog. */
export function extractBodyBounds(xhtml: string): BodyBounds | null {
  let index = 0
  let openStart = -1
  let openEnd = -1
  let openTag = ''

  while (index < xhtml.length) {
    if (xhtml.startsWith('<!--', index)) {
      const end = xhtml.indexOf('-->', index + 4)
      index = end >= 0 ? end + 3 : xhtml.length
      continue
    }
    if (xhtml.startsWith('<![CDATA[', index)) {
      const end = xhtml.indexOf(']]>', index + 9)
      index = end >= 0 ? end + 3 : xhtml.length
      continue
    }
    if (xhtml[index] !== '<') {
      index += 1
      continue
    }

    const match = /^<body(?=[\s>])/i.exec(xhtml.slice(index))
    if (match) {
      const tag = readTagEnd(xhtml, index + 1)
      if (!tag.closed || tag.selfClosing) return null
      openStart = index
      openEnd = tag.end
      openTag = xhtml.slice(openStart, openEnd)
      break
    }

    const tag = readTagEnd(xhtml, index + 1)
    index = tag.end
  }

  if (openStart < 0 || openEnd < 0) return null

  const lower = xhtml.toLowerCase()
  const closeStart = lower.lastIndexOf('</body>')
  if (closeStart < openEnd) return null
  const closeEnd = closeStart + '</body>'.length

  return {
    openStart,
    openEnd,
    closeStart,
    closeEnd,
    openTag,
    innerXml: xhtml.slice(openEnd, closeStart),
  }
}

function assertXmlWellFormed(xhtml: string, codec: XmlCodec): void {
  let doc: Document
  try {
    doc = codec.parse(xhtml)
  } catch (error) {
    throw new Error(`当前章节不是良构 XML，请先在代码模式修复：${error instanceof Error ? error.message : String(error)}`)
  }
  const root = doc.documentElement
  const errors = doc.getElementsByTagName('parsererror')
  if (!root || root.nodeName === 'parsererror' || errors.length > 0) {
    const detail = errors[0]?.textContent?.trim().split('\n')[0]
    throw new Error(detail ? `当前章节不是良构 XML，请先修复：${detail}` : '当前章节不是良构 XML，请先修复。')
  }
}

/** Tokenizes `<body>` inner XML strictly and throws if tags are unbalanced or unclosed. */
function tokenizeBodyXml(bodyInner: string): BodyToken[] {
  const tokens: BodyToken[] = []
  const stack: string[] = []
  let index = 0

  while (index < bodyInner.length) {
    if (bodyInner.startsWith('<!--', index)) {
      const end = bodyInner.indexOf('-->', index + 4)
      if (end < 0) throw new Error('当前章节存在未闭合的 XML 注释，请先修复。')
      tokens.push({ kind: 'comment', start: index, end: end + 3 })
      index = end + 3
      continue
    }
    if (bodyInner.startsWith('<![CDATA[', index)) {
      const end = bodyInner.indexOf(']]>', index + 9)
      if (end < 0) throw new Error('当前章节存在未闭合的 CDATA 区块，请先修复。')
      tokens.push({ kind: 'cdata', start: index, end: end + 3 })
      index = end + 3
      continue
    }
    if (bodyInner.startsWith('<?', index)) {
      const end = bodyInner.indexOf('?>', index + 2)
      if (end < 0) throw new Error('当前章节存在未闭合的 XML 处理指令，请先修复。')
      tokens.push({ kind: 'pi', start: index, end: end + 2 })
      index = end + 2
      continue
    }
    if (bodyInner[index] !== '<') {
      const nextLt = bodyInner.indexOf('<', index)
      const end = nextLt >= 0 ? nextLt : bodyInner.length
      tokens.push({ kind: 'text', start: index, end })
      index = end
      continue
    }

    if (bodyInner.startsWith('</', index)) {
      const closeMatch = /^<\/([A-Za-z_][\w:.-]*)\s*>/.exec(bodyInner.slice(index))
      if (!closeMatch?.[1]) throw new Error('当前章节存在无效的闭合标签，请先修复。')
      const name = closeMatch[1]
      const end = index + closeMatch[0].length
      const expected = stack.pop()
      if (expected !== name) {
        throw new Error(`当前章节存在标签不匹配（</${name}>），请先修复。`)
      }
      tokens.push({ kind: 'close', start: index, end, name, lowerName: name.toLowerCase() })
      index = end
      continue
    }

    const openMatch = /^<([A-Za-z_][\w:.-]*)(?=[\s/>])/.exec(bodyInner.slice(index))
    if (!openMatch?.[1]) {
      throw new Error('当前章节存在无效的 XML 标签，请先修复。')
    }
    const name = openMatch[1]
    const tag = readTagEnd(bodyInner, index + 1 + name.length)
    if (!tag.closed) {
      throw new Error(`当前章节存在未闭合的 <${name}> 开始标签，请先修复。`)
    }
    const raw = bodyInner.slice(index, tag.end)
    if (tag.selfClosing) {
      tokens.push({ kind: 'self-closing', start: index, end: tag.end, name, lowerName: name.toLowerCase(), raw })
    } else {
      stack.push(name)
      tokens.push({ kind: 'open', start: index, end: tag.end, name, lowerName: name.toLowerCase(), raw })
    }
    index = tag.end
  }

  if (stack.length > 0) {
    throw new Error(`当前章节存在未闭合的 <${stack[stack.length - 1]}> 标签，请先修复。`)
  }

  return tokens
}

/** Strips `id` and `xml:id` from reopened ancestor tags so split chapters never share duplicate IDs. */
function stripIdAttributes(openTag: string): string {
  return openTag.replace(/\s+(?:xml:)?id\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
}

function closingTagsFor(stack: OpenTagFrame[]): string {
  let out = ''
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    out += `</${stack[index]!.name}>`
  }
  return out
}

function reopenTagsFor(stack: OpenTagFrame[]): string {
  return stack.map((frame) => stripIdAttributes(frame.openTag)).join('')
}

function isSplitMarkerToken(token: BodyToken): boolean {
  return (token.kind === 'self-closing' || token.kind === 'open') && token.lowerName === 'hr' && SPLIT_MARKER_TAG.test(token.raw)
}

interface CutPoint {
  /** Start offset inside `bodyInner` where the previous piece ends. */
  cutStart: number
  /** End offset inside `bodyInner` where the next piece begins (differs from `cutStart` when stripping a marker). */
  cutEnd: number
  /** Active open ancestor stack at `cutStart`. */
  stack: OpenTagFrame[]
}

function buildSplitDocuments(xhtml: string, body: BodyBounds, cuts: CutPoint[], codec: XmlCodec): string[] {
  const prefix = xhtml.slice(0, body.openEnd)
  const suffix = xhtml.slice(body.closeStart)
  const eol = detectDominantEol(xhtml)
  const pieces: string[] = []

  let segmentStart = 0
  let carryOpen = ''

  for (const cut of cuts) {
    const rawChunk = body.innerXml.slice(segmentStart, cut.cutStart)
    const closing = closingTagsFor(cut.stack)
    const inner = `${carryOpen}${rawChunk}${closing}`
    pieces.push(assemblePiece(prefix, inner, suffix, eol))
    segmentStart = cut.cutEnd
    carryOpen = reopenTagsFor(cut.stack)
  }

  const tailInner = `${carryOpen}${body.innerXml.slice(segmentStart)}`
  pieces.push(assemblePiece(prefix, tailInner, suffix, eol))

  for (const piece of pieces) {
    assertXmlWellFormed(piece, codec)
  }

  return pieces
}

function assemblePiece(prefix: string, inner: string, suffix: string, eol: '\r\n' | '\n'): string {
  const lead = inner.startsWith('\n') || inner.startsWith('\r\n') || inner.length === 0 ? '' : eol
  const trail = inner.endsWith('\n') || inner.length === 0 ? '' : eol
  return `${prefix}${lead}${inner}${trail}${suffix}`
}

/**
 * Splits a single XHTML document at `offset` (character offset in `xhtml`).
 * Snaps safely out of tags, comments, CDATA, and `<math>`/`<svg>`/`<video>`/`<audio>` islands,
 * closes open ancestor tags in the first half, and reopens them (without duplicate `id`s) in the second.
 */
export function splitXhtmlAtOffset(xhtml: string, offset: number, codec: XmlCodec): [string, string] {
  assertXmlWellFormed(xhtml, codec)
  const body = extractBodyBounds(xhtml)
  if (!body) throw new Error('当前章节缺少有效的 <body> 标签，无法拆分。')

  if (offset < body.openEnd || offset > body.closeStart) {
    throw new Error('请先将光标放在 <body> 正文区域内再执行拆分。')
  }

  const tokens = tokenizeBodyXml(body.innerXml)
  const relOffset = offset - body.openEnd

  // Find safe split offset and the open tag stack active right at that cut.
  const stack: OpenTagFrame[] = []
  let islandDepth = 0
  let islandStartOffset = -1
  let islandStartStack: OpenTagFrame[] = []
  let safeOffset = relOffset
  let cutStack: OpenTagFrame[] | null = null

  for (const token of tokens) {
    if (token.end <= relOffset) {
      if (token.kind === 'open') {
        if (islandDepth === 0 && PROTECTED_ISLANDS.has(token.lowerName)) {
          islandStartOffset = token.start
          islandStartStack = [...stack]
        }
        if (PROTECTED_ISLANDS.has(token.lowerName)) islandDepth += 1
        stack.push({
          name: token.name,
          lowerName: token.lowerName,
          openTag: token.raw,
          openStart: token.start,
          openEnd: token.end,
        })
      } else if (token.kind === 'close') {
        stack.pop()
        if (PROTECTED_ISLANDS.has(token.lowerName) && islandDepth > 0) islandDepth -= 1
      }
      continue
    }

    // `relOffset` lands at or inside this token (`token.start <= relOffset < token.end` or `relOffset < token.start`).
    if (islandDepth > 0) {
      // Cursor is inside a protection island (`<math>`/`<svg>`): snap cleanly to just before the island.
      safeOffset = islandStartOffset
      cutStack = islandStartStack
      break
    }

    if (token.start < relOffset && relOffset < token.end) {
      if (token.kind === 'text') {
        safeOffset = relOffset
        cutStack = [...stack]
      } else if (token.kind === 'close') {
        // Cursor sits inside `</tag>`: split immediately after the closing tag completes.
        safeOffset = token.end
        const nextStack = [...stack]
        nextStack.pop()
        cutStack = nextStack
      } else {
        // Cursor sits inside `<tag ...>`, comment, CDATA, or PI: snap to right before the token.
        safeOffset = token.start
        cutStack = [...stack]
      }
    } else {
      safeOffset = relOffset
      cutStack = [...stack]
    }
    break
  }

  if (cutStack === null) {
    safeOffset = islandDepth > 0 ? islandStartOffset : relOffset
    cutStack = islandDepth > 0 ? islandStartStack : [...stack]
  }

  const beforeContent = body.innerXml.slice(0, safeOffset).trim()
  const afterContent = body.innerXml.slice(safeOffset).trim()
  if (!beforeContent || !afterContent) {
    throw new Error('当前光标位置前后存在空内容，无法拆分为两章。')
  }

  const [first, second] = buildSplitDocuments(
    xhtml,
    body,
    [{ cutStart: safeOffset, cutEnd: safeOffset, stack: cutStack }],
    codec,
  )
  return [first!, second!]
}

/** Counts Sigil split markers (`<hr class="sigil_split_marker" />`) inside `<body>`. */
export function countSplitMarkers(xhtml: string): number {
  const body = extractBodyBounds(xhtml)
  if (!body) return 0
  let tokens: BodyToken[]
  try {
    tokens = tokenizeBodyXml(body.innerXml)
  } catch {
    return 0
  }
  let count = 0
  let islandDepth = 0
  for (const token of tokens) {
    if (token.kind === 'open' && PROTECTED_ISLANDS.has(token.lowerName)) islandDepth += 1
    else if (token.kind === 'close' && PROTECTED_ISLANDS.has(token.lowerName) && islandDepth > 0) islandDepth -= 1
    else if (islandDepth === 0 && isSplitMarkerToken(token)) count += 1
  }
  return count
}

/** Finds line numbers of all `<hr class="sigil_split_marker" />` markers inside `<body>` (for linting). */
export function findSplitMarkerLines(xhtml: string): number[] {
  const body = extractBodyBounds(xhtml)
  if (!body) return []
  let tokens: BodyToken[]
  try {
    tokens = tokenizeBodyXml(body.innerXml)
  } catch {
    return []
  }

  const lines: number[] = []
  let islandDepth = 0
  for (const token of tokens) {
    if (token.kind === 'open' && PROTECTED_ISLANDS.has(token.lowerName)) {
      islandDepth += 1
    } else if (token.kind === 'close' && PROTECTED_ISLANDS.has(token.lowerName) && islandDepth > 0) {
      islandDepth -= 1
    } else if (islandDepth === 0 && isSplitMarkerToken(token)) {
      const absOffset = body.openEnd + token.start
      let line = 1
      for (let i = 0; i < absOffset && i < xhtml.length; i += 1) {
        if (xhtml[i] === '\n') line += 1
      }
      lines.push(line)
    }
  }
  return lines
}

/** Splits a single XHTML document at every `<hr class="sigil_split_marker" />`, removing the markers. */
export function splitXhtmlAtMarkers(xhtml: string, codec: XmlCodec): string[] {
  assertXmlWellFormed(xhtml, codec)
  const body = extractBodyBounds(xhtml)
  if (!body) throw new Error('当前章节缺少有效的 <body> 标签，无法拆分。')

  const tokens = tokenizeBodyXml(body.innerXml)
  const stack: OpenTagFrame[] = []
  const cuts: CutPoint[] = []
  let islandDepth = 0

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    if (islandDepth === 0 && isSplitMarkerToken(token)) {
      let cutEnd = token.end
      // Handle rare non-self-closing `<hr class="sigil_split_marker"></hr>` cleanly.
      if (token.kind === 'open') {
        const nextToken = tokens[i + 1]
        if (nextToken?.kind === 'close' && nextToken.lowerName === 'hr') {
          cutEnd = nextToken.end
          i += 1
        }
      }
      cuts.push({ cutStart: token.start, cutEnd, stack: [...stack] })
      continue
    }

    if (token.kind === 'open') {
      if (PROTECTED_ISLANDS.has(token.lowerName)) islandDepth += 1
      stack.push({
        name: token.name,
        lowerName: token.lowerName,
        openTag: token.raw,
        openStart: token.start,
        openEnd: token.end,
      })
    } else if (token.kind === 'close') {
      stack.pop()
      if (PROTECTED_ISLANDS.has(token.lowerName) && islandDepth > 0) islandDepth -= 1
    }
  }

  if (cuts.length === 0) {
    throw new Error('当前章节没有拆分标记（<hr class="sigil_split_marker" />）。')
  }

  return buildSplitDocuments(xhtml, body, cuts, codec)
}

/** Splits an XHTML chapter right before every `<h{level}>` heading (skipping the leading heading). */
export function splitXhtmlByHeadingLevel(xhtml: string, level: number, codec: XmlCodec): string[] {
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    throw new Error('标题层级必须是 1 到 6 之间的整数。')
  }
  assertXmlWellFormed(xhtml, codec)
  const body = extractBodyBounds(xhtml)
  if (!body) throw new Error('当前章节缺少有效的 <body> 标签，无法拆分。')

  const targetTag = `h${level}`
  const tokens = tokenizeBodyXml(body.innerXml)
  const stack: OpenTagFrame[] = []
  const cuts: CutPoint[] = []
  let islandDepth = 0
  let lastCutEnd = 0

  for (const token of tokens) {
    if (islandDepth === 0 && token.kind === 'open' && token.lowerName === targetTag) {
      // Step back across empty wrapper elements (e.g. `<section>` right before `<h1>`) so we split
      // cleanly between sections instead of leaving an empty `<section></section>` in the prior chapter.
      let cutOffset = token.start
      let cutStack = [...stack]
      while (cutStack.length > 0) {
        const top = cutStack[cutStack.length - 1]!
        if (top.openStart < lastCutEnd) break
        const between = body.innerXml.slice(top.openEnd, cutOffset)
        if (between.trim().length > 0) break
        cutOffset = top.openStart
        cutStack = cutStack.slice(0, -1)
      }

      const precedingContent = body.innerXml.slice(lastCutEnd, cutOffset).trim()
      if (precedingContent.length > 0) {
        cuts.push({ cutStart: cutOffset, cutEnd: cutOffset, stack: cutStack })
        lastCutEnd = cutOffset
      }
    }

    if (token.kind === 'open') {
      if (PROTECTED_ISLANDS.has(token.lowerName)) islandDepth += 1
      stack.push({
        name: token.name,
        lowerName: token.lowerName,
        openTag: token.raw,
        openStart: token.start,
        openEnd: token.end,
      })
    } else if (token.kind === 'close') {
      stack.pop()
      if (PROTECTED_ISLANDS.has(token.lowerName) && islandDepth > 0) islandDepth -= 1
    }
  }

  if (cuts.length === 0) {
    throw new Error(`当前章节没有可拆分的 <h${level}> 标题分段。`)
  }

  return buildSplitDocuments(xhtml, body, cuts, codec)
}

/** Derives Sigil-style sibling filenames (`ch001.xhtml` -> `ch001_0001.xhtml`, `ch001_0002.xhtml`). */
export function nextSplitChapterPath(sourcePath: string, existingPaths: ReadonlySet<string>): string {
  const dir = dirname(sourcePath)
  const slash = sourcePath.lastIndexOf('/')
  const filename = slash < 0 ? sourcePath : sourcePath.slice(slash + 1)
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : '.xhtml'

  let seq = 1
  while (true) {
    const candidateName = `${stem}_${String(seq).padStart(4, '0')}${ext}`
    const candidatePath = dir ? `${dir}/${candidateName}` : candidateName
    if (!existingPaths.has(candidatePath)) return candidatePath
    seq += 1
  }
}

function makeManifestId(path: string): string {
  const slash = path.lastIndexOf('/')
  const name = slash < 0 ? path : path.slice(slash + 1)
  const stem = name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'chapter'
  return /^[a-zA-Z_]/.test(stem) ? stem : `ch_${stem}`
}

export interface SplitChapterResult {
  files: Map<string, string>
  archive: EpubArchive
  pkg: EpubPackage
  sourcePath: string
  createdPaths: string[]
  referencesRewritten: number
}

function applySplitPiecesToBook(args: {
  files: Map<string, string>
  pkg: EpubPackage
  archive: EpubArchive
  sourcePath: string
  pieces: string[]
  codec: XmlCodec
}): SplitChapterResult {
  const { files, pkg, archive, sourcePath, pieces, codec } = args
  if (pieces.length < 2) {
    throw new Error('拆分结果不足两章。')
  }

  const nextFiles = new Map(files)
  const nextEntries = new Map(archive.entries)
  const nextOrder = [...archive.order]
  const occupied = new Set<string>(archive.entries.keys())
  for (const key of files.keys()) occupied.add(key)

  const createdPaths: string[] = []
  const newManifestItems: Array<{ id: string; href: string; mediaType: string }> = []
  const opfDir = dirname(pkg.opfPath)
  const sourceMediaType =
    pkg.manifest.find((item) => item.path === sourcePath)?.mediaType || 'application/xhtml+xml'

  // Update the source chapter with the first piece.
  const firstPiece = pieces[0]!
  nextFiles.set(sourcePath, firstPiece)
  nextEntries.set(sourcePath, encoder.encode(firstPiece))

  for (let index = 1; index < pieces.length; index += 1) {
    const pieceText = pieces[index]!
    const createdPath = nextSplitChapterPath(sourcePath, occupied)
    occupied.add(createdPath)
    createdPaths.push(createdPath)

    nextFiles.set(createdPath, pieceText)
    nextEntries.set(createdPath, encoder.encode(pieceText))
    if (!nextOrder.includes(createdPath)) nextOrder.push(createdPath)

    newManifestItems.push({
      id: makeManifestId(createdPath),
      href: relativePath(opfDir, createdPath),
      mediaType: sourceMediaType,
    })
  }

  // Insert all newly created chapters into OPF manifest & spine right after sourcePath.
  const opfXml = nextFiles.get(pkg.opfPath) ?? ''
  const nextOpf = insertSpineDocumentsAfter(opfXml, sourcePath, newManifestItems, opfDir, codec)
  nextFiles.set(pkg.opfPath, nextOpf)
  nextEntries.set(pkg.opfPath, encoder.encode(nextOpf))

  // Build anchor ownership table so any book-wide or intra-chapter `#id` link follows moved anchors.
  const allPaths = [sourcePath, ...createdPaths]
  const ownerById = new Map<string, string>()
  for (let index = 0; index < allPaths.length; index += 1) {
    const piecePath = allPaths[index]!
    const pieceText = pieces[index]!
    for (const id of collectDocumentIds(pieceText)) {
      if (!ownerById.has(id)) ownerById.set(id, piecePath)
    }
  }

  const anchorMoves = new Map<string, Map<string, string>>()
  for (const piecePath of allPaths) {
    const mapForPath = new Map<string, string>()
    for (const [id, ownerPath] of ownerById) {
      if (ownerPath !== piecePath) mapForPath.set(id, ownerPath)
    }
    if (mapForPath.size > 0) anchorMoves.set(piecePath, mapForPath)
  }

  const rewritten = rewriteAnchorReferences(nextFiles, {
    anchorMoves,
    skipPaths: new Set([pkg.opfPath]),
  })

  for (const [path, text] of rewritten.files) {
    if (nextFiles.get(path) !== text) {
      nextFiles.set(path, text)
      nextEntries.set(path, encoder.encode(text))
    }
  }

  const nextArchive: EpubArchive = { order: nextOrder, entries: nextEntries }
  const nextPkg = parsePackage(nextOpf, pkg.opfPath, codec.parse)

  return {
    files: nextFiles,
    archive: nextArchive,
    pkg: nextPkg,
    sourcePath,
    createdPaths,
    referencesRewritten: rewritten.touched.length,
  }
}

export function splitChapterInBook(args: {
  files: Map<string, string>
  pkg: EpubPackage
  archive: EpubArchive
  path: string
  offset: number
  codec: XmlCodec
}): SplitChapterResult {
  const xhtml = args.files.get(args.path)
  if (xhtml === undefined) throw new Error(`找不到章节文件：${args.path}`)
  const pieces = splitXhtmlAtOffset(xhtml, args.offset, args.codec)
  return applySplitPiecesToBook({
    files: args.files,
    pkg: args.pkg,
    archive: args.archive,
    sourcePath: args.path,
    pieces,
    codec: args.codec,
  })
}

export function splitChapterAtMarkersInBook(args: {
  files: Map<string, string>
  pkg: EpubPackage
  archive: EpubArchive
  path: string
  codec: XmlCodec
}): SplitChapterResult {
  const xhtml = args.files.get(args.path)
  if (xhtml === undefined) throw new Error(`找不到章节文件：${args.path}`)
  const pieces = splitXhtmlAtMarkers(xhtml, args.codec)
  return applySplitPiecesToBook({
    files: args.files,
    pkg: args.pkg,
    archive: args.archive,
    sourcePath: args.path,
    pieces,
    codec: args.codec,
  })
}

export function splitChapterByHeadingLevelInBook(args: {
  files: Map<string, string>
  pkg: EpubPackage
  archive: EpubArchive
  path: string
  level: number
  codec: XmlCodec
}): SplitChapterResult {
  const xhtml = args.files.get(args.path)
  if (xhtml === undefined) throw new Error(`找不到章节文件：${args.path}`)
  const pieces = splitXhtmlByHeadingLevel(xhtml, args.level, args.codec)
  return applySplitPiecesToBook({
    files: args.files,
    pkg: args.pkg,
    archive: args.archive,
    sourcePath: args.path,
    pieces,
    codec: args.codec,
  })
}
