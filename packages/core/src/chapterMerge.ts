import { detectDominantEol, extractBodyBounds } from './chapterSplit'
import { insertSpineDocumentsAfter, removeManifestEntry } from './opfEdit'
import { dirname, relativePath, resolvePath, splitFragment } from './path'
import {
  collectDocumentIds,
  collectReferences,
  rewriteAnchorReferences,
  type WholeFileMove,
} from './references'
import type { EpubArchive, EpubPackage } from './types'
import { parsePackage } from './unpack'
import type { XmlCodec } from './xml'

/**
 * Chapter merge & duplication primitives.
 * Merging combines subsequent chapters' `<body>` content into the first chapter, preserves any
 * unique stylesheets, keeps bare links / TOC entries jumpable via start anchors, rewrites
 * book-wide references, and cleans OPF manifest & spine.
 * See ADR 2026-11-21-chapter-structure-and-resource-tools.
 */

const encoder = new TextEncoder()
const LINK_ATTR_PATTERN = /(\b(?:href|src|xlink:href)\s*=\s*)(?:"([^"]*)"|'([^']*)')/g
const STYLESHEET_LINK_PATTERN = /<link\b[^>]*>/gi

function assertValidChapter(path: string, xhtml: string, codec: XmlCodec) {
  const body = extractBodyBounds(xhtml)
  if (!body) throw new Error(`章节 ${path} 缺少有效的 <body> 标签，无法合并。`)
  let doc: Document
  try {
    doc = codec.parse(xhtml)
  } catch (error) {
    throw new Error(`章节 ${path} 不是良构 XML：${error instanceof Error ? error.message : String(error)}`)
  }
  const root = doc.documentElement
  const errors = doc.getElementsByTagName('parsererror')
  if (!root || root.nodeName === 'parsererror' || errors.length > 0) {
    throw new Error(`章节 ${path} 不是良构 XML，请先在代码模式修复。`)
  }
  return body
}

function extractHeadStylesheetPaths(xhtml: string, chapterPath: string): string[] {
  const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(xhtml)
  if (!headMatch?.[1]) return []
  const baseDir = dirname(chapterPath)
  const paths: string[] = []
  for (const match of headMatch[1].matchAll(STYLESHEET_LINK_PATTERN)) {
    const tag = match[0]
    if (!/\brel\s*=\s*(?:"[^"]*\bstylesheet\b[^"]*"|'[^']*\bstylesheet\b[^']*')/i.test(tag)) continue
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
    const rawHref = (hrefMatch?.[1] ?? hrefMatch?.[2] ?? '').trim()
    if (!rawHref || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawHref)) continue
    try {
      const resolved = resolvePath(baseDir, splitFragment(rawHref).path)
      if (!paths.includes(resolved)) paths.push(resolved)
    } catch {
      // Ignore malformed hrefs.
    }
  }
  return paths
}

function appendStylesheetLinks(xhtml: string, chapterPath: string, cssPaths: string[], eol: '\r\n' | '\n'): string {
  if (cssPaths.length === 0) return xhtml
  const closeHead = xhtml.toLowerCase().indexOf('</head>')
  if (closeHead < 0) return xhtml
  const baseDir = dirname(chapterPath)
  const links = cssPaths
    .map((cssPath) => `  <link rel="stylesheet" type="text/css" href="${relativePath(baseDir, cssPath)}" />`)
    .join(eol)
  const needsLeadEol = closeHead > 0 && xhtml[closeHead - 1] !== '\n'
  return `${xhtml.slice(0, closeHead)}${needsLeadEol ? eol : ''}${links}${eol}${xhtml.slice(closeHead)}`
}

/** Rebases relative `href`/`src`/`xlink:href` inside an XHTML fragment when merging across directories. */
function rebaseFragmentReferences(fragment: string, fromDir: string, toDir: string): string {
  if (fromDir === toDir) return fragment
  return fragment.replace(LINK_ATTR_PATTERN, (full, prefix: string, double?: string, single?: string) => {
    const raw = double ?? single ?? ''
    const quote = double !== undefined ? '"' : "'"
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.startsWith('//')) {
      return full
    }
    const { path, fragment: hash } = splitFragment(trimmed)
    try {
      const abs = resolvePath(fromDir, path)
      const rebased = relativePath(toDir, abs) + (hash ? `#${hash}` : '')
      return `${prefix}${quote}${rebased}${quote}`
    } catch {
      return full
    }
  })
}

function uniqueAnchorId(base: string, existingIds: Set<string>): string {
  const sanitized = base.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'section'
  const prefix = /^[a-zA-Z_]/.test(sanitized) ? `merged_${sanitized}` : `merged_ch_${sanitized}`
  let candidate = prefix
  let seq = 1
  while (existingIds.has(candidate)) {
    candidate = `${prefix}_${seq}`
    seq += 1
  }
  existingIds.add(candidate)
  return candidate
}

/**
 * Finds the leading element's `id` inside a body fragment, or injects a stable anchor `id` so
 * bare links / TOC entries pointing at the absorbed chapter still jump to its exact start.
 */
function ensureStartAnchor(bodyFragment: string, absorbedPath: string, existingIds: Set<string>): {
  xml: string
  anchorId: string
} {
  const leadingTag = /^(\s*)<([A-Za-z_][\w:.-]*)(\s[^>]*)?>/.exec(bodyFragment)
  if (leadingTag && leadingTag[2]) {
    const tagAttrs = leadingTag[3] ?? ''
    const existingIdMatch = /\b(?:xml:)?id\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tagAttrs)
    const existingId = (existingIdMatch?.[1] ?? existingIdMatch?.[2] ?? '').trim()
    if (existingId) {
      return { xml: bodyFragment, anchorId: existingId }
    }
    const isSelfClosing = /\/\s*$/.test(tagAttrs)
    const anchorId = uniqueAnchorId(absorbedPath.slice(absorbedPath.lastIndexOf('/') + 1), existingIds)
    const insertAt = leadingTag[1]!.length + 1 + leadingTag[2].length
    if (!isSelfClosing) {
      const injected = `${bodyFragment.slice(0, insertAt)} id="${anchorId}"${bodyFragment.slice(insertAt)}`
      return { xml: injected, anchorId }
    }
  }

  const anchorId = uniqueAnchorId(absorbedPath.slice(absorbedPath.lastIndexOf('/') + 1), existingIds)
  return { xml: `<div id="${anchorId}">${bodyFragment}</div>`, anchorId }
}

export interface MergeChaptersResult {
  files: Map<string, string>
  archive: EpubArchive
  pkg: EpubPackage
  primaryPath: string
  removedPaths: string[]
  referencesRewritten: number
}

export function mergeChaptersInBook(args: {
  files: Map<string, string>
  pkg: EpubPackage
  archive: EpubArchive
  paths: string[]
  codec: XmlCodec
}): MergeChaptersResult {
  const { files, pkg, archive, codec } = args
  const uniquePaths = Array.from(new Set(args.paths))
  if (uniquePaths.length < 2) {
    throw new Error('合并章节至少需要选择两个章节。')
  }

  const primaryPath = uniquePaths[0]!
  const absorbedPaths = uniquePaths.slice(1)

  const primaryXhtml = files.get(primaryPath)
  if (primaryXhtml === undefined) throw new Error(`找不到目标章节：${primaryPath}`)
  const primaryBody = assertValidChapter(primaryPath, primaryXhtml, codec)
  const primaryEol = detectDominantEol(primaryXhtml)
  const primaryDir = dirname(primaryPath)
  const primaryStyles = new Set(extractHeadStylesheetPaths(primaryXhtml, primaryPath))
  const existingIds = collectDocumentIds(primaryXhtml)

  // Detect which absorbed chapters have bare (fragmentless) incoming references (e.g. TOC entries).
  const allRefs = collectReferences(files).filter((ref) => ref.from !== pkg.opfPath)
  const bareReferencedPaths = new Set(
    allRefs.filter((ref) => !ref.fragment && absorbedPaths.includes(ref.targetPath)).map((ref) => ref.targetPath),
  )

  const appendedBodies: string[] = []
  const extraStylesheets: string[] = []
  const wholeFileMoves = new Map<string, WholeFileMove>()

  for (const absorbedPath of absorbedPaths) {
    const absorbedXhtml = files.get(absorbedPath)
    if (absorbedXhtml === undefined) throw new Error(`找不到待合并章节：${absorbedPath}`)
    const absorbedBody = assertValidChapter(absorbedPath, absorbedXhtml, codec)

    for (const cssPath of extractHeadStylesheetPaths(absorbedXhtml, absorbedPath)) {
      if (!primaryStyles.has(cssPath)) {
        primaryStyles.add(cssPath)
        extraStylesheets.push(cssPath)
      }
    }

    for (const id of collectDocumentIds(absorbedXhtml)) existingIds.add(id)

    let fragment = rebaseFragmentReferences(absorbedBody.innerXml, dirname(absorbedPath), primaryDir)
    let defaultFragment: string | undefined
    if (bareReferencedPaths.has(absorbedPath)) {
      const anchored = ensureStartAnchor(fragment, absorbedPath, existingIds)
      fragment = anchored.xml
      defaultFragment = anchored.anchorId
    }

    wholeFileMoves.set(absorbedPath, { path: primaryPath, ...(defaultFragment ? { defaultFragment } : {}) })
    appendedBodies.push(fragment.trim())
  }

  // Splice appended bodies right before primary `</body>`, then add any missing stylesheet `<link>`s.
  const joinedBodies = appendedBodies.filter(Boolean).join(primaryEol)
  const beforeClose = primaryXhtml.slice(0, primaryBody.closeStart)
  const afterClose = primaryXhtml.slice(primaryBody.closeStart)
  const sep = beforeClose.endsWith('\n') || !joinedBodies ? '' : primaryEol
  const trail = joinedBodies ? primaryEol : ''
  let mergedPrimary = `${beforeClose}${sep}${joinedBodies}${trail}${afterClose}`
  mergedPrimary = appendStylesheetLinks(mergedPrimary, primaryPath, extraStylesheets, primaryEol)
  assertValidChapter(primaryPath, mergedPrimary, codec)

  const nextFiles = new Map(files)
  const nextEntries = new Map(archive.entries)
  let nextOrder = [...archive.order]
  const opfDir = dirname(pkg.opfPath)

  let nextOpf = nextFiles.get(pkg.opfPath) ?? ''
  for (const absorbedPath of absorbedPaths) {
    nextOpf = removeManifestEntry(nextOpf, absorbedPath, opfDir, codec)
    nextFiles.delete(absorbedPath)
    nextEntries.delete(absorbedPath)
    nextOrder = nextOrder.filter((entry) => entry !== absorbedPath)
  }

  nextFiles.set(primaryPath, mergedPrimary)
  nextEntries.set(primaryPath, encoder.encode(mergedPrimary))
  nextFiles.set(pkg.opfPath, nextOpf)
  nextEntries.set(pkg.opfPath, encoder.encode(nextOpf))

  const rewritten = rewriteAnchorReferences(nextFiles, {
    wholeFileMoves,
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
    primaryPath,
    removedPaths: absorbedPaths,
    referencesRewritten: rewritten.touched.length,
  }
}

export interface DuplicateChapterResult {
  files: Map<string, string>
  archive: EpubArchive
  pkg: EpubPackage
  createdPath: string
}

function nextDuplicatePath(sourcePath: string, existingPaths: ReadonlySet<string>): string {
  const dir = dirname(sourcePath)
  const slash = sourcePath.lastIndexOf('/')
  const filename = slash < 0 ? sourcePath : sourcePath.slice(slash + 1)
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : '.xhtml'

  let seq = 1
  while (true) {
    const suffix = seq === 1 ? '_copy' : `_copy_${seq}`
    const candidateName = `${stem}${suffix}${ext}`
    const candidatePath = dir ? `${dir}/${candidateName}` : candidateName
    if (!existingPaths.has(candidatePath)) return candidatePath
    seq += 1
  }
}

/** Clones an existing chapter and inserts it directly after the source chapter in `<spine>`. */
export function duplicateChapterInBook(args: {
  files: Map<string, string>
  pkg: EpubPackage
  archive: EpubArchive
  path: string
  codec: XmlCodec
}): DuplicateChapterResult {
  const { files, pkg, archive, path, codec } = args
  const content = files.get(path)
  if (content === undefined) throw new Error(`找不到章节文件：${path}`)

  const occupied = new Set<string>(archive.entries.keys())
  for (const key of files.keys()) occupied.add(key)

  const createdPath = nextDuplicatePath(path, occupied)
  const opfDir = dirname(pkg.opfPath)
  const mediaType = pkg.manifest.find((item) => item.path === path)?.mediaType || 'application/xhtml+xml'
  const baseName = createdPath.slice(createdPath.lastIndexOf('/') + 1)
  const stem = baseName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'chapter'
  const id = /^[a-zA-Z_]/.test(stem) ? stem : `ch_${stem}`

  const nextOpf = insertSpineDocumentsAfter(
    files.get(pkg.opfPath) ?? '',
    path,
    [{ id, href: relativePath(opfDir, createdPath), mediaType }],
    opfDir,
    codec,
  )

  const nextFiles = new Map(files)
  nextFiles.set(createdPath, content)
  nextFiles.set(pkg.opfPath, nextOpf)

  const nextEntries = new Map(archive.entries)
  nextEntries.set(createdPath, encoder.encode(content))
  nextEntries.set(pkg.opfPath, encoder.encode(nextOpf))

  const nextOrder = archive.order.includes(createdPath) ? [...archive.order] : [...archive.order, createdPath]
  const nextArchive: EpubArchive = { order: nextOrder, entries: nextEntries }
  const nextPkg = parsePackage(nextOpf, pkg.opfPath, codec.parse)

  return { files: nextFiles, archive: nextArchive, pkg: nextPkg, createdPath }
}
