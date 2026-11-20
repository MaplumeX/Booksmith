import type { XmlDocumentParser } from '@booksmith/core'
import { applyEol, detectEol } from './eol'

export const ISLAND_SELECTOR = 'math, svg, video, audio'

const ISLAND_TAG_NAMES = new Set(['math', 'svg', 'video', 'audio'])

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

const EDITOR_ONLY_ATTRS = new Set([
  'contenteditable',
  'data-booksmith-src',
  'data-booksmith-orig-alt',
  'data-booksmith-no-alt',
  'data-booksmith-island',
  'data-booksmith-selected',
  'data-booksmith-tabindex',
  'data-missing',
])

export interface BodyRange {
  openStart: number
  openEnd: number
  closeStart: number
  closeEnd: number
  openTag: string
  innerXml: string
}

export interface EditableAttrLike {
  name: string
  value: string
}

export interface EditableNodeLike {
  nodeType: number
  nodeValue?: string | null
  data?: string
  tagName?: string
  attributes?: ArrayLike<EditableAttrLike>
  childNodes: ArrayLike<EditableNodeLike>
  getAttribute?: (name: string) => string | null
  hasAttribute?: (name: string) => boolean
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

function skipQuoted(text: string, start: number, quote: string): number {
  let index = start + 1
  while (index < text.length && text[index] !== quote) index += 1
  return index < text.length ? index + 1 : text.length
}

/** Finds the outer `<body...>...</body>` span in XHTML so `<head>` and XML prolog stay untouched. */
export function extractBodyRange(xhtml: string): BodyRange | null {
  const openMatch = /<body(?:\s[^>]*)?>/i.exec(xhtml)
  if (!openMatch || openMatch.index === undefined) return null
  const openStart = openMatch.index
  const openTag = openMatch[0]
  const openEnd = openStart + openTag.length

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

/**
 * Verifies the chapter is well-formed XML with a `<body>` before allowing WYSIWYG edits.
 * Broken markup must be fixed in code mode first so browser HTML parsing never drops nodes.
 * See ADR 2026-11-20-wysiwyg-editing-mode.
 */
export function checkXmlWellFormed(
  xhtml: string,
  parse: XmlDocumentParser,
): { ok: true } | { ok: false; message: string } {
  if (!extractBodyRange(xhtml)) {
    return { ok: false, message: '当前文档缺少有效的 <body> 标签，请先在代码模式修复。' }
  }
  try {
    const doc = parse(xhtml)
    const root = doc.documentElement
    const errors = doc.getElementsByTagName('parsererror')
    if (!root || root.nodeName === 'parsererror' || errors.length > 0) {
      const detail = errors[0]?.textContent?.trim()
      return {
        ok: false,
        message: detail
          ? `当前章节存在 XML 语法错误，请先在代码模式修复：${detail.split('\n')[0]}`
          : '当前章节存在 XML 语法错误，请先在代码模式修复。',
      }
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: `当前章节 XML 解析失败，请先在代码模式修复：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function readTagEnd(xml: string, start: number): { end: number; selfClosing: boolean } {
  let index = start
  while (index < xml.length) {
    const ch = xml[index]
    if (ch === '"' || ch === "'") {
      index = skipQuoted(xml, index, ch)
      continue
    }
    if (ch === '>') {
      const prev = index > start ? xml[index - 1] : ''
      return { end: index + 1, selfClosing: prev === '/' }
    }
    index += 1
  }
  return { end: xml.length, selfClosing: false }
}

/**
 * Extracts raw XML substrings for top-level protection islands (`math`, `svg`, `video`, `audio`)
 * inside `<body>` in document order so untouched islands serialize byte-for-byte identically.
 */
export function extractTopLevelIslands(bodyInnerXml: string): string[] {
  const islands: string[] = []
  let index = 0

  while (index < bodyInnerXml.length) {
    if (bodyInnerXml.startsWith('<!--', index)) {
      const end = bodyInnerXml.indexOf('-->', index + 4)
      index = end >= 0 ? end + 3 : bodyInnerXml.length
      continue
    }
    if (bodyInnerXml.startsWith('<![CDATA[', index)) {
      const end = bodyInnerXml.indexOf(']]>', index + 9)
      index = end >= 0 ? end + 3 : bodyInnerXml.length
      continue
    }
    if (bodyInnerXml[index] !== '<') {
      index += 1
      continue
    }

    const openMatch = /^<(math|svg|video|audio)(?=[\s/>])/i.exec(bodyInnerXml.slice(index))
    if (!openMatch || !openMatch[1]) {
      const { end } = readTagEnd(bodyInnerXml, index + 1)
      index = end
      continue
    }

    const islandStart = index
    const rootTag = openMatch[1].toLowerCase()
    const firstTag = readTagEnd(bodyInnerXml, index + 1)
    index = firstTag.end
    if (firstTag.selfClosing) {
      islands.push(bodyInnerXml.slice(islandStart, index))
      continue
    }

    let depth = 1
    while (index < bodyInnerXml.length && depth > 0) {
      if (bodyInnerXml.startsWith('<!--', index)) {
        const end = bodyInnerXml.indexOf('-->', index + 4)
        index = end >= 0 ? end + 3 : bodyInnerXml.length
        continue
      }
      if (bodyInnerXml.startsWith('<![CDATA[', index)) {
        const end = bodyInnerXml.indexOf(']]>', index + 9)
        index = end >= 0 ? end + 3 : bodyInnerXml.length
        continue
      }
      if (bodyInnerXml[index] !== '<') {
        index += 1
        continue
      }

      const slice = bodyInnerXml.slice(index)
      const closeMatch = new RegExp(`^</${rootTag}\\s*>`, 'i').exec(slice)
      if (closeMatch) {
        depth -= 1
        index += closeMatch[0].length
        continue
      }

      const nestedOpen = new RegExp(`^<${rootTag}(?=[\\s/>])`, 'i').exec(slice)
      if (nestedOpen) {
        const tag = readTagEnd(bodyInnerXml, index + 1)
        if (!tag.selfClosing) depth += 1
        index = tag.end
        continue
      }

      const tag = readTagEnd(bodyInnerXml, index + 1)
      index = tag.end
    }

    islands.push(bodyInnerXml.slice(islandStart, index))
  }

  return islands
}

function serializeAttributes(el: EditableNodeLike, tag: string): string {
  const attrs = el.attributes ? Array.from(el.attributes) : []
  const origSrc = el.getAttribute?.('data-booksmith-src') ?? null
  const hasOrigAlt = el.hasAttribute?.('data-booksmith-orig-alt') ?? false
  const origAlt = el.getAttribute?.('data-booksmith-orig-alt') ?? ''
  const hadNoAlt = el.hasAttribute?.('data-booksmith-no-alt') ?? false
  const addedTabindex = el.hasAttribute?.('data-booksmith-tabindex') ?? false

  const parts: string[] = []
  let emittedSrc = false
  let emittedAlt = false

  for (const attr of attrs) {
    const name = attr.name
    const lower = name.toLowerCase()
    if (EDITOR_ONLY_ATTRS.has(lower)) continue
    if (addedTabindex && lower === 'tabindex') continue

    if (tag === 'img' && lower === 'src') {
      const finalSrc = origSrc ?? (attr.value.startsWith('blob:') ? null : attr.value)
      if (finalSrc !== null) {
        parts.push(`src="${escapeAttr(finalSrc)}"`)
        emittedSrc = true
      }
      continue
    }

    if (tag === 'img' && lower === 'alt') {
      if (hadNoAlt) continue
      const finalAlt = hasOrigAlt ? origAlt : attr.value
      parts.push(`alt="${escapeAttr(finalAlt)}"`)
      emittedAlt = true
      continue
    }

    parts.push(`${name}="${escapeAttr(attr.value)}"`)
  }

  if (tag === 'img' && !emittedSrc && origSrc !== null) {
    parts.unshift(`src="${escapeAttr(origSrc)}"`)
  }
  if (tag === 'img' && !emittedAlt && !hadNoAlt && hasOrigAlt) {
    parts.push(`alt="${escapeAttr(origAlt)}"`)
  }

  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

function serializeNode(node: EditableNodeLike, originalIslands: string[]): string {
  if (node.nodeType === 3) {
    return escapeText(node.nodeValue ?? node.data ?? '')
  }
  if (node.nodeType === 8) {
    const raw = (node.nodeValue ?? node.data ?? '').replace(/--/g, '- -')
    return `<!--${raw}-->`
  }
  if (node.nodeType !== 1 || !node.tagName) return ''

  if (node.hasAttribute?.('data-booksmith-ui')) return ''

  const islandAttr = node.getAttribute?.('data-booksmith-island')
  if (islandAttr !== null && islandAttr !== undefined) {
    const index = Number(islandAttr)
    const raw = Number.isInteger(index) ? originalIslands[index] : undefined
    if (raw !== undefined) return raw
  }

  const tag = node.tagName.toLowerCase()
  const attrs = serializeAttributes(node, tag)

  if (VOID_ELEMENTS.has(tag)) {
    return `<${tag}${attrs} />`
  }

  const children = Array.from(node.childNodes)
    .map((child) => serializeNode(child, originalIslands))
    .join('')

  return `<${tag}${attrs}>${children}</${tag}>`
}

/**
 * Serializes the edited `iframe` `<body>` back to clean XHTML while keeping `<body>` attributes,
 * restoring original relative image paths and protection islands, and stripping editor artifacts.
 * See ADR 2026-11-20-wysiwyg-editing-mode.
 */
export function serializeEditableBody(
  editableBody: EditableNodeLike,
  originalXhtml: string,
  originalIslands: string[],
): string {
  const range = extractBodyRange(originalXhtml)
  const openTag = range ? range.openTag : '<body>'
  const children = Array.from(editableBody.childNodes)
    .map((child) => serializeNode(child, originalIslands))
    .join('')
  return `${openTag}${children}</body>`
}

/** Splices a serialized `<body>...</body>` back into `originalXhtml` without altering `<head>`. */
export function replaceBodyInXhtml(originalXhtml: string, serializedBody: string): string {
  const range = extractBodyRange(originalXhtml)
  if (!range) return originalXhtml
  // Preserve the chapter's original dominant line-ending style so visual edits on CRLF chapters
  // do not turn the entire body into an EOL diff. See ADR 2026-11-20-baseline-derived-dirty-state.
  const alignedBody = applyEol(serializedBody, detectEol(originalXhtml))
  return `${originalXhtml.slice(0, range.openStart)}${alignedBody}${originalXhtml.slice(range.closeEnd)}`
}

export function isIslandTagName(tagName: string): boolean {
  return ISLAND_TAG_NAMES.has(tagName.toLowerCase())
}
