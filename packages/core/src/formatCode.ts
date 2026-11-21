import { detectDominantEol } from './chapterSplit'
import type { XmlCodec } from './xml'

/**
 * Zero-dependency EPUB XHTML & CSS formatter.
 * Formats only block-container indentation while treating any element with non-whitespace text or
 * inline children as an untouched inline flow, and preserving `<pre>`, `<textarea>`, `<script>`,
 * `<style>`, `<math>`, `<svg>`, and multiline `<code>` verbatim.
 * See ADR 2026-11-21-code-productivity-and-command-palette.
 */

const INDENT = '  '

const VERBATIM_TAGS = new Set(['pre', 'textarea', 'script', 'style', 'math', 'svg'])

const BLOCK_TAGS = new Set([
  'html',
  'head',
  'body',
  'section',
  'article',
  'aside',
  'nav',
  'header',
  'footer',
  'main',
  'div',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'blockquote',
  'figure',
  'figcaption',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'colgroup',
  'col',
  'details',
  'summary',
  'address',
  'hgroup',
  'hr',
  'meta',
  'link',
  'title',
  'base',
  'pre',
  'style',
  'script',
])

type XmlNode =
  | { kind: 'decl' | 'doctype' | 'comment' | 'cdata' | 'verbatim' | 'text'; raw: string }
  | { kind: 'element'; name: string; lowerName: string; openTag: string; selfClosing: boolean; children: XmlNode[] }

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

function findMatchingVerbatimEnd(xml: string, afterOpen: number, tagName: string): number {
  const lowerTarget = tagName.toLowerCase()
  let depth = 1
  let index = afterOpen

  while (index < xml.length && depth > 0) {
    if (xml.startsWith('<!--', index)) {
      const end = xml.indexOf('-->', index + 4)
      if (end < 0) throw new Error('文档存在未闭合的 XML 注释，无法格式化。')
      index = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', index)) {
      const end = xml.indexOf(']]>', index + 9)
      if (end < 0) throw new Error('文档存在未闭合的 CDATA 区块，无法格式化。')
      index = end + 3
      continue
    }
    if (xml[index] !== '<') {
      index += 1
      continue
    }

    if (xml.startsWith('</', index)) {
      const closeMatch = /^<\/([A-Za-z_][\w:.-]*)\s*>/.exec(xml.slice(index))
      if (closeMatch?.[1]) {
        const end = index + closeMatch[0].length
        if (closeMatch[1].toLowerCase() === lowerTarget) {
          depth -= 1
          if (depth === 0) return end
        }
        index = end
        continue
      }
    }

    const openMatch = /^<([A-Za-z_][\w:.-]*)(?=[\s/>])/.exec(xml.slice(index))
    if (openMatch?.[1]) {
      const tag = readTagEnd(xml, index + 1 + openMatch[1].length)
      if (!tag.closed) throw new Error(`文档存在未闭合的 <${openMatch[1]}> 标签，无法格式化。`)
      if (!tag.selfClosing && openMatch[1].toLowerCase() === lowerTarget) {
        depth += 1
      }
      index = tag.end
      continue
    }

    index += 1
  }

  throw new Error(`文档存在未闭合的 <${tagName}> 标签，无法格式化。`)
}

function parseXmlNodes(xml: string): XmlNode[] {
  const rootChildren: XmlNode[] = []
  const stack: Array<{ node: Extract<XmlNode, { kind: 'element' }>; parent: XmlNode[] }> = []
  const currentList = () => (stack.length > 0 ? stack[stack.length - 1]!.node.children : rootChildren)

  let index = 0
  while (index < xml.length) {
    if (xml.startsWith('<?', index)) {
      const end = xml.indexOf('?>', index + 2)
      if (end < 0) throw new Error('文档存在未闭合的处理指令，无法格式化。')
      currentList().push({ kind: 'decl', raw: xml.slice(index, end + 2) })
      index = end + 2
      continue
    }
    if (xml.startsWith('<!--', index)) {
      const end = xml.indexOf('-->', index + 4)
      if (end < 0) throw new Error('文档存在未闭合的 XML 注释，无法格式化。')
      currentList().push({ kind: 'comment', raw: xml.slice(index, end + 3) })
      index = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', index)) {
      const end = xml.indexOf(']]>', index + 9)
      if (end < 0) throw new Error('文档存在未闭合的 CDATA 区块，无法格式化。')
      currentList().push({ kind: 'cdata', raw: xml.slice(index, end + 3) })
      index = end + 3
      continue
    }
    if (/^<!DOCTYPE\b/i.test(xml.slice(index))) {
      // DOCTYPE may contain an internal subset `[ ... ]`.
      let cursor = index + 9
      let inBracket = false
      while (cursor < xml.length) {
        const ch = xml[cursor]
        if (ch === '"' || ch === "'") {
          cursor = skipQuoted(xml, cursor, ch)
          continue
        }
        if (ch === '[') inBracket = true
        else if (ch === ']') inBracket = false
        else if (ch === '>' && !inBracket) {
          cursor += 1
          break
        }
        cursor += 1
      }
      currentList().push({ kind: 'doctype', raw: xml.slice(index, cursor) })
      index = cursor
      continue
    }
    if (xml[index] !== '<') {
      const nextLt = xml.indexOf('<', index)
      const end = nextLt >= 0 ? nextLt : xml.length
      currentList().push({ kind: 'text', raw: xml.slice(index, end) })
      index = end
      continue
    }

    if (xml.startsWith('</', index)) {
      const closeMatch = /^<\/([A-Za-z_][\w:.-]*)\s*>/.exec(xml.slice(index))
      if (!closeMatch?.[1]) throw new Error('文档存在无效的闭合标签，无法格式化。')
      const name = closeMatch[1]
      const top = stack.pop()
      if (!top || top.node.name !== name) {
        throw new Error(`文档存在标签不匹配（</${name}>），请先修复 XML 语法。`)
      }
      index += closeMatch[0].length
      continue
    }

    const openMatch = /^<([A-Za-z_][\w:.-]*)(?=[\s/>])/.exec(xml.slice(index))
    if (!openMatch?.[1]) throw new Error('文档存在无效的 XML 标签，无法格式化。')
    const name = openMatch[1]
    const lowerName = name.toLowerCase()
    const tag = readTagEnd(xml, index + 1 + name.length)
    if (!tag.closed) throw new Error(`文档存在未闭合的 <${name}> 开始标签，无法格式化。`)
    const openTag = xml.slice(index, tag.end)

    if (tag.selfClosing) {
      currentList().push({
        kind: 'element',
        name,
        lowerName,
        openTag,
        selfClosing: true,
        children: [],
      })
      index = tag.end
      continue
    }

    if (VERBATIM_TAGS.has(lowerName)) {
      const verbatimEnd = findMatchingVerbatimEnd(xml, tag.end, name)
      currentList().push({ kind: 'verbatim', raw: xml.slice(index, verbatimEnd) })
      index = verbatimEnd
      continue
    }

    // Preserve multiline `<code>` blocks verbatim so code indentation is never touched.
    if (lowerName === 'code') {
      const codeEnd = findMatchingVerbatimEnd(xml, tag.end, name)
      const slice = xml.slice(index, codeEnd)
      if (slice.includes('\n')) {
        currentList().push({ kind: 'verbatim', raw: slice })
        index = codeEnd
        continue
      }
    }

    const element: Extract<XmlNode, { kind: 'element' }> = {
      kind: 'element',
      name,
      lowerName,
      openTag,
      selfClosing: false,
      children: [],
    }
    const parent = currentList()
    parent.push(element)
    stack.push({ node: element, parent })
    index = tag.end
  }

  if (stack.length > 0) {
    throw new Error(`文档存在未闭合的 <${stack[stack.length - 1]!.node.name}> 标签，请先修复 XML 语法。`)
  }

  return rootChildren
}

function isBlockContainer(el: Extract<XmlNode, { kind: 'element' }>): boolean {
  if (!BLOCK_TAGS.has(el.lowerName) || el.children.length === 0) return false
  let hasBlockChild = false
  for (const child of el.children) {
    if (child.kind === 'text') {
      // Any non-whitespace text makes this a mixed/inline-flow element: never split children onto lines.
      if (child.raw.trim().length > 0) return false
      continue
    }
    if (child.kind === 'comment') continue
    if (child.kind === 'verbatim') {
      // A standalone block-level verbatim child like `<style>`, `<script>`, `<pre>` can sit on its own line,
      // while `<math>` / `<svg>` inside a pure block container also stays on its own indented line.
      hasBlockChild = true
      continue
    }
    if (child.kind === 'element') {
      if (!BLOCK_TAGS.has(child.lowerName)) return false
      hasBlockChild = true
      continue
    }
    return false
  }
  return hasBlockChild
}

function serializeInline(nodes: XmlNode[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.kind === 'element') {
      if (node.selfClosing) {
        out += node.openTag
      } else {
        out += `${node.openTag}${serializeInline(node.children)}</${node.name}>`
      }
    } else {
      out += node.raw
    }
  }
  return out
}

function trimEdgeWhitespaceNodes(nodes: XmlNode[]): XmlNode[] {
  const copy = nodes.map((n) => ({ ...n }))
  while (copy.length > 0) {
    const first = copy[0]
    if (first && first.kind === 'text' && first.raw.trim() === '') copy.shift()
    else break
  }
  while (copy.length > 0) {
    const last = copy[copy.length - 1]
    if (last && last.kind === 'text' && last.raw.trim() === '') copy.pop()
    else break
  }
  const first = copy[0]
  if (first && first.kind === 'text') {
    copy[0] = { kind: 'text', raw: first.raw.replace(/^\s+/, '') }
  }
  const last = copy[copy.length - 1]
  if (last && last.kind === 'text') {
    copy[copy.length - 1] = { kind: 'text', raw: last.raw.replace(/\s+$/, '') }
  }
  return copy
}

function emitNode(node: XmlNode, depth: number, lines: string[]): void {
  const pad = INDENT.repeat(depth)
  if (node.kind !== 'element') {
    if (node.kind === 'text') {
      const trimmed = node.raw.trim()
      if (trimmed) lines.push(`${pad}${trimmed}`)
      return
    }
    if (node.kind === 'verbatim') {
      // Emit verbatim blocks without touching their internal newlines/whitespace.
      lines.push(`${pad}${node.raw}`)
      return
    }
    lines.push(`${pad}${node.raw.trim()}`)
    return
  }

  if (node.selfClosing) {
    lines.push(`${pad}${node.openTag}`)
    return
  }

  if (isBlockContainer(node)) {
    lines.push(`${pad}${node.openTag}`)
    for (const child of node.children) {
      if (child.kind === 'text' && child.raw.trim() === '') continue
      emitNode(child, depth + 1, lines)
    }
    lines.push(`${pad}</${node.name}>`)
    return
  }

  // Inline-flow block (e.g. `<p>`, `<h1>`, `<li>`, or mixed-content `<div>`):
  // keep internal inline whitespace exact so English/CJK spacing and inline tags never shift.
  const trimmedChildren = trimEdgeWhitespaceNodes(node.children)
  const inner = serializeInline(trimmedChildren)
  lines.push(`${pad}${node.openTag}${inner}</${node.name}>`)
}

/**
 * Formats a well-formed XHTML/XML document with 2-space block indentation.
 * Refuses to format malformed XML and preserves original dominant EOL.
 */
export function formatXhtml(xhtml: string, codec?: XmlCodec): string {
  if (codec) {
    let doc: Document
    try {
      doc = codec.parse(xhtml)
    } catch (error) {
      throw new Error(`XML 语法有误，无法格式化：${error instanceof Error ? error.message : String(error)}`)
    }
    const root = doc.documentElement
    const errors = doc.getElementsByTagName('parsererror')
    if (!root || root.nodeName === 'parsererror' || errors.length > 0) {
      const detail = errors[0]?.textContent?.trim().split('\n')[0]
      throw new Error(detail ? `XML 语法有误，无法格式化：${detail}` : 'XML 语法有误，无法格式化。')
    }
  }

  const eol = detectDominantEol(xhtml)
  const nodes = parseXmlNodes(xhtml)
  const lines: string[] = []

  for (const node of nodes) {
    if (node.kind === 'text' && node.raw.trim() === '') continue
    emitNode(node, 0, lines)
  }

  const formatted = lines.length > 0 ? `${lines.join(eol)}${eol}` : ''

  if (codec && formatted) {
    const checkDoc = codec.parse(formatted)
    if (!checkDoc.documentElement || checkDoc.getElementsByTagName('parsererror').length > 0) {
      throw new Error('格式化结果未通过 XML 良构校验，已取消修改。')
    }
  }

  return formatted
}

function normalizeSelectorHeader(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .trim()
}

function normalizeDeclaration(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  // Split at the first colon outside quotes/parentheses so `url(data:...)` stays intact.
  let colon = -1
  let parenDepth = 0
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]
    if (ch === '"' || ch === "'") {
      i = skipQuoted(trimmed, i, ch) - 1
      continue
    }
    if (ch === '(') parenDepth += 1
    else if (ch === ')' && parenDepth > 0) parenDepth -= 1
    else if (ch === ':' && parenDepth === 0) {
      colon = i
      break
    }
  }
  if (colon < 0) return trimmed
  const prop = trimmed.slice(0, colon).trim()
  const val = trimmed
    .slice(colon + 1)
    .replace(/\s+/g, ' ')
    .trim()
  return `${prop}: ${val}`
}

/**
 * Zero-dependency CSS formatter supporting comments, quoted strings, `url(...)`, and nested
 * `@media` / `@supports` / `@font-face` / `@page` rules with 2-space indentation.
 */
export function formatCss(css: string): string {
  const eol = detectDominantEol(css)
  const lines: string[] = []
  let depth = 0
  let buffer = ''
  let parenDepth = 0
  let i = 0

  const flushDeclaration = (withSemicolon: boolean) => {
    const cleaned = normalizeDeclaration(buffer)
    buffer = ''
    if (!cleaned) return
    lines.push(`${INDENT.repeat(depth)}${cleaned}${withSemicolon ? ';' : ''}`)
  }

  const maybeAddTopLevelGap = () => {
    if (depth === 0 && lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push('')
    }
  }

  while (i < css.length) {
    // Comments
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      const commentEnd = end >= 0 ? end + 2 : css.length
      const comment = css.slice(i, commentEnd).trim()
      if (buffer.trim()) {
        buffer += ` ${comment} `
      } else {
        maybeAddTopLevelGap()
        lines.push(`${INDENT.repeat(depth)}${comment}`)
      }
      i = commentEnd
      continue
    }

    const ch = css[i]!

    // Strings
    if (ch === '"' || ch === "'") {
      let end = i + 1
      while (end < css.length) {
        if (css[end] === '\\') {
          end += 2
          continue
        }
        if (css[end] === ch) {
          end += 1
          break
        }
        end += 1
      }
      buffer += css.slice(i, end)
      i = end
      continue
    }

    if (ch === '(') {
      parenDepth += 1
      buffer += ch
      i += 1
      continue
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth -= 1
      buffer += ch
      i += 1
      continue
    }

    if (parenDepth === 0 && ch === '{') {
      const header = normalizeSelectorHeader(buffer)
      buffer = ''
      maybeAddTopLevelGap()
      lines.push(`${INDENT.repeat(depth)}${header ? `${header} {` : '{'}`)
      depth += 1
      i += 1
      continue
    }

    if (parenDepth === 0 && ch === ';') {
      if (depth === 0) {
        const atRule = buffer.replace(/\s+/g, ' ').trim()
        buffer = ''
        if (atRule) {
          lines.push(`${atRule};`)
        }
      } else {
        flushDeclaration(true)
      }
      i += 1
      continue
    }

    if (parenDepth === 0 && ch === '}') {
      if (buffer.trim()) {
        flushDeclaration(true)
      }
      depth = Math.max(0, depth - 1)
      lines.push(`${INDENT.repeat(depth)}}`)
      i += 1
      continue
    }

    buffer += ch
    i += 1
  }

  if (buffer.trim()) {
    const rest = buffer.replace(/\s+/g, ' ').trim()
    lines.push(`${INDENT.repeat(depth)}${rest}`)
  }

  // Collapse multiple consecutive blank lines and trim leading/trailing blank lines.
  const compact: string[] = []
  for (const line of lines) {
    if (line === '' && (compact.length === 0 || compact[compact.length - 1] === '')) continue
    compact.push(line)
  }
  while (compact.length > 0 && compact[compact.length - 1] === '') compact.pop()

  return compact.length > 0 ? `${compact.join(eol)}${eol}` : ''
}
