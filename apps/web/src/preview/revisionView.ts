import { diffChars, type LineDiff } from '../diff/document'
import { normalizeEol } from '../editor/eol'
import { extractBodyRange } from '../editor/wysiwygXhtml'
import {
  getHunkDecision,
  type FileDiffModel,
  type FileHunkDecisions,
  type HunkDecision,
  type ProposalHunk,
} from '../state/proposalReview'

/**
 * Pure XHTML revision annotator for real book-page review rendering.
 *
 * Maps source-level `ProposalHunk`s directly onto the chapter's rendered `<body>` with
 * Cursor-style 3-state approval (`pending | accepted | rejected`), recursive container
 * in-place diffing, inline formatting highlights, semantic structural comparison with
 * island-safe text-node diffing, and inline expandable mini-source diffs.
 * Feeds back into `buildPreviewDocument` to preserve author CSS, images, fonts, MathML islands,
 * and dark-mode adaptation.
 * See ADR 2026-11-21-in-canvas-agent-proposal-review, ADR 2026-11-22-live-streaming-agent-review,
 * ADR 2026-11-22-contiguous-quote-and-structural-revision-preview.
 */

export interface RevisionXhtmlOptions {
  model: FileDiffModel
  decisions?: FileHunkDecisions
  skippedHunkIds?: ReadonlySet<string>
  allowHunkToggle: boolean
  activeHunkId?: string | null
  /** Hunk IDs whose inline mini-source diff drawer is currently expanded. */
  expandedDiffHunkIds?: ReadonlySet<string>
}

export interface RevisionXhtmlResult {
  xhtml: string
  /** Hunks outside `<body>` (e.g. `<head>` stylesheet links or title changes). */
  headHunkIds: string[]
  /** Mapping of every hunkId to its display surface. */
  hunkLocations: Map<string, 'body' | 'head'>
}

const SIMPLE_BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'figcaption',
  'dt',
  'dd',
  'pre',
  'div',
])

const CONTAINER_BLOCK_TAGS = new Set([
  'blockquote',
  'div',
  'section',
  'article',
  'aside',
  'ul',
  'ol',
  'li',
  'dl',
  'figure',
])

/** Tags where injecting a `<div>` directly inside would violate HTML5 content model and auto-close the block. */
const NO_NESTED_DIV_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'dt', 'ul', 'ol', 'dl'])

const INLINE_SAFE_TAGS = new Set([
  'em',
  'strong',
  'i',
  'b',
  'span',
  'a',
  'sup',
  'sub',
  'code',
  'small',
  'u',
  's',
  'cite',
  'q',
  'abbr',
  'mark',
  'br',
  'ruby',
  'rt',
  'rp',
])

const VOID_TAGS = new Set([
  'br',
  'hr',
  'img',
  'meta',
  'link',
  'input',
  'col',
  'source',
  'wbr',
  'area',
  'base',
  'embed',
  'param',
  'track',
])

const ISLAND_TAG_NAMES = new Set(['math', 'svg', 'img', 'video', 'audio', 'table'])
const ISLAND_TAG_RE = /<(?:math|svg|img|video|audio|table)\b/i

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

const TAG_LABELS_ZH: Record<string, string> = {
  blockquote: '引用块',
  p: '段落',
  h1: '一级标题',
  h2: '二级标题',
  h3: '三级标题',
  h4: '四级标题',
  h5: '五级标题',
  h6: '六级标题',
  ul: '无序列表',
  ol: '有序列表',
  li: '列表项',
  div: '区块',
  section: '章节区块',
  article: '文章区块',
  aside: '旁注区块',
  figure: '插图块',
  figcaption: '题注',
  pre: '代码块',
  dl: '定义列表',
}

const MAX_MINI_DIFF_LINES = 24

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function unescapeBasicEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&amp;/g, '&')
}

function stripTags(html: string): string {
  return unescapeBasicEntities(html.replace(/<!--[\s\S]*?-->|<[^>]+>/g, ''))
}

function normalizeVisibleText(html: string): string {
  return stripTags(html).replace(/\s+/g, ' ').trim()
}

function hasAnyTag(fragment: string): boolean {
  return /<[^>]+>/.test(fragment)
}

function tagLabelZh(tag: string): string {
  return TAG_LABELS_ZH[tag.toLowerCase()] ?? `<${tag.toLowerCase()}>`
}

function isBalancedMarkup(fragment: string): boolean {
  const stack: string[] = []
  const tagRe = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)(?:\s[^<>]*?)?(\/?)>/g
  for (const match of fragment.matchAll(tagRe)) {
    const full = match[0]!
    if (full.startsWith('<!--')) continue
    const name = match[1]!.toLowerCase()
    const selfClosing = match[2] === '/' || VOID_TAGS.has(name)
    if (full.startsWith('</')) {
      if (stack.pop() !== name) return false
    } else if (!selfClosing) {
      stack.push(name)
    }
  }
  return stack.length === 0
}

interface SingleElementParts {
  tag: string
  openTag: string
  inner: string
  closeTag: string
}

/** Parses a fragment if and only if it is a single balanced element `<tag ...>...</tag>`. */
function parseSingleElement(raw: string): SingleElementParts | null {
  const trimmed = raw.trim()
  const openMatch = /^<([a-zA-Z][\w:-]*)(?:\s[^<>]*?)?>/.exec(trimmed)
  if (!openMatch || openMatch[0]!.endsWith('/>')) return null
  const tag = openMatch[1]!.toLowerCase()
  const openTag = openMatch[0]!
  const closeTag = `</${tag}>`
  if (!trimmed.toLowerCase().endsWith(closeTag)) return null
  const inner = trimmed.slice(openTag.length, trimmed.length - closeTag.length)
  if (!isBalancedMarkup(inner)) return null
  // Verify the opening tag does not close early before the end (e.g., `<p>a</p><p>b</p>`).
  let depth = 1
  const tagRe = new RegExp(`<(\\/)?${tag}(?=[\\s/>])[^>]*>`, 'gi')
  let m: RegExpExecArray | null
  tagRe.lastIndex = openTag.length
  while ((m = tagRe.exec(trimmed)) !== null) {
    const full = m[0]!
    if (full.endsWith('/>')) continue
    if (m[1] === '/') depth -= 1
    else depth += 1
    if (depth === 0 && m.index + full.length < trimmed.length) {
      return null
    }
  }
  return depth === 0 ? { tag, openTag, inner, closeTag: trimmed.slice(trimmed.length - closeTag.length) } : null
}

/** Splits a fragment consisting of consecutive balanced top-level elements into an array. */
function splitTopLevelElements(raw: string): SingleElementParts[] | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('<')) return null
  const results: SingleElementParts[] = []
  let pos = 0
  while (pos < trimmed.length) {
    while (pos < trimmed.length && /\s/.test(trimmed[pos]!)) pos += 1
    if (pos >= trimmed.length) break
    if (trimmed[pos] !== '<') return null
    const openMatch = /^<([a-zA-Z][\w:-]*)(?:\s[^<>]*?)?>/.exec(trimmed.slice(pos))
    if (!openMatch || openMatch[0]!.endsWith('/>')) return null
    const tag = openMatch[1]!.toLowerCase()
    const openTag = openMatch[0]!
    const start = pos
    pos += openTag.length
    let depth = 1
    const tagRe = new RegExp(`<(\\/)?${tag}(?=[\\s/>])[^>]*>`, 'gi')
    tagRe.lastIndex = pos
    let end = -1
    let m: RegExpExecArray | null
    while ((m = tagRe.exec(trimmed)) !== null) {
      const full = m[0]!
      if (full.endsWith('/>')) continue
      if (m[1] === '/') depth -= 1
      else depth += 1
      if (depth === 0) {
        end = m.index + full.length
        break
      }
    }
    if (end < 0) return null
    const slice = trimmed.slice(start, end)
    const parsed = parseSingleElement(slice)
    if (!parsed) return null
    results.push(parsed)
    pos = end
  }
  return results.length > 0 ? results : null
}

function rawOfElement(el: SingleElementParts): string {
  return `${el.openTag}${el.inner}${el.closeTag}`
}

function injectAttrsIntoOpenTag(openTag: string, attrs: string): string {
  if (openTag.endsWith('/>')) {
    return `${openTag.slice(0, -2)} ${attrs} />`
  }
  return `${openTag.slice(0, -1)} ${attrs}>`
}

function parseAttributes(openTag: string): Map<string, string> {
  const attrs = new Map<string, string>()
  const inner = openTag.replace(/^<[a-zA-Z][\w:-]*/, '').replace(/\/?>$/, '')
  const attrRe = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  for (const match of inner.matchAll(attrRe)) {
    const name = match[1]!.toLowerCase()
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    attrs.set(name, value)
  }
  return attrs
}

function describeAttrChange(beforeOpen: string, afterOpen: string): string {
  const beforeAttrs = parseAttributes(beforeOpen)
  const afterAttrs = parseAttributes(afterOpen)
  const keys = new Set([...beforeAttrs.keys(), ...afterAttrs.keys()])
  const changed: string[] = []
  for (const key of keys) {
    if (beforeAttrs.get(key) !== afterAttrs.get(key)) {
      changed.push(key)
    }
  }
  if (changed.length === 0) return '标签/样式变更'
  const summary = changed.length <= 3 ? changed.join(', ') : `${changed.slice(0, 3).join(', ')} 等`
  return `标签/样式变更 (${summary})`
}

function renderInlineCharDiff(beforeText: string, afterText: string): string {
  const segments = diffChars(unescapeBasicEntities(beforeText), unescapeBasicEntities(afterText))
  return segments
    .map((seg) => {
      const safe = escapeHtml(seg.text)
      if (seg.kind === 'removed') return `<del class="bs-rev-del">${safe}</del>`
      if (seg.kind === 'added') return `<ins class="bs-rev-ins">${safe}</ins>`
      return safe
    })
    .join('')
}

function tokenizeHtml(html: string): Array<{ kind: 'tag' | 'comment' | 'text'; value: string }> {
  const out: Array<{ kind: 'tag' | 'comment' | 'text'; value: string }> = []
  let last = 0
  const re = /<!--[\s\S]*?-->|<[^>]+>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) out.push({ kind: 'text', value: html.slice(last, m.index) })
    const full = m[0]!
    out.push({ kind: full.startsWith('<!--') ? 'comment' : 'tag', value: full })
    last = m.index + full.length
  }
  if (last < html.length) out.push({ kind: 'text', value: html.slice(last) })
  return out
}

function allTagsAreInlineSafe(html: string): boolean {
  const tagRe = /<\/?([a-zA-Z][\w:-]*)(?:\s[^<>]*?)?\/?>/g
  for (const match of html.matchAll(tagRe)) {
    const name = match[1]!.toLowerCase()
    if (!INLINE_SAFE_TAGS.has(name)) return false
  }
  return true
}

/**
 * Attempts structure-preserving inline diff when both fragments share identical inline tag sequences
 * (e.g., `<p>见<em>旧词</em>说明</p>` -> `<p>见<em>新词</em>说明</p>`).
 */
function tryInlineTagAlignedDiff(beforeInner: string, afterInner: string): string | null {
  if (ISLAND_TAG_RE.test(beforeInner) || ISLAND_TAG_RE.test(afterInner)) return null

  const aTokens = tokenizeHtml(beforeInner)
  const bTokens = tokenizeHtml(afterInner)

  const aTags = aTokens.filter((t) => t.kind !== 'text').map((t) => t.value)
  const bTags = bTokens.filter((t) => t.kind !== 'text').map((t) => t.value)

  // Every inline tag must be safe and the tag sequence must match identically.
  if (aTags.length !== bTags.length) return null
  for (let i = 0; i < aTags.length; i += 1) {
    if (aTags[i] !== bTags[i]) return null
    if (aTags[i]!.startsWith('<!--')) return null
    const nameMatch = /^<\/?([a-zA-Z][\w:-]*)/.exec(aTags[i]!)
    if (!nameMatch || !INLINE_SAFE_TAGS.has(nameMatch[1]!.toLowerCase())) return null
  }

  // Split into interleaved text slots around identical tags.
  const collectSlots = (tokens: Array<{ kind: 'tag' | 'comment' | 'text'; value: string }>): string[] => {
    const slots: string[] = ['']
    for (const tok of tokens) {
      if (tok.kind !== 'text') slots.push('')
      else slots[slots.length - 1] += tok.value
    }
    return slots
  }

  const aSlots = collectSlots(aTokens)
  const bSlots = collectSlots(bTokens)
  let out = ''
  for (let i = 0; i < aSlots.length; i += 1) {
    out += renderInlineCharDiff(aSlots[i]!, bSlots[i]!)
    if (i < aTags.length) out += aTags[i]!
  }
  return out
}

interface LogicalChar {
  raw: string
  ch: string
}

/** Splits an HTML text token into logical characters while keeping `&entity;` intact. */
function splitLogicalChars(rawText: string): LogicalChar[] {
  const out: LogicalChar[] = []
  const entityRe = /&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g
  let pos = 0
  let match: RegExpExecArray | null
  while ((match = entityRe.exec(rawText)) !== null) {
    if (match.index > pos) {
      for (const ch of Array.from(rawText.slice(pos, match.index))) {
        out.push({ raw: ch, ch })
      }
    }
    const rawEntity = match[0]!
    const decoded = unescapeBasicEntities(rawEntity)
    out.push({ raw: rawEntity, ch: decoded.length === 1 ? decoded : '\uFFFD' })
    pos = match.index + rawEntity.length
  }
  if (pos < rawText.length) {
    for (const ch of Array.from(rawText.slice(pos))) {
      out.push({ raw: ch, ch })
    }
  }
  return out
}

function collectCharTagSignatures(inner: string): string[] {
  const sigs: string[] = []
  const stack: string[] = []
  for (const tok of tokenizeHtml(inner)) {
    if (tok.kind === 'comment') continue
    if (tok.kind === 'tag') {
      const match = /^<(\/)?([a-zA-Z][\w:-]*)(?:\s[^<>]*?)?(\/?)>$/.exec(tok.value)
      if (!match) continue
      const isClose = match[1] === '/'
      const name = match[2]!.toLowerCase()
      const isSelf = match[3] === '/' || VOID_TAGS.has(name)
      if (isClose) {
        if (stack.length > 0) stack.pop()
      } else if (!isSelf) {
        stack.push(tok.value.replace(/\s+/g, ' ').trim())
      }
      continue
    }
    const sig = stack.join('>')
    for (let i = 0; i < splitLogicalChars(tok.value).length; i += 1) {
      sigs.push(sig)
    }
  }
  return sigs
}

function describeInlineTagDelta(beforeInner: string, afterInner: string): string {
  const countOpenTags = (html: string): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const m of html.matchAll(/<([a-zA-Z][\w:-]*)(?:\s[^<>]*?)?(?<!\/)>/g)) {
      const tag = m[1]!.toLowerCase()
      if (VOID_TAGS.has(tag)) continue
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return counts
  }
  const beforeCounts = countOpenTags(beforeInner)
  const afterCounts = countOpenTags(afterInner)
  const added: string[] = []
  const removed: string[] = []
  for (const tag of new Set([...beforeCounts.keys(), ...afterCounts.keys()])) {
    const diff = (afterCounts.get(tag) ?? 0) - (beforeCounts.get(tag) ?? 0)
    if (diff > 0) added.push(`+${tag}`)
    else if (diff < 0) removed.push(`-${tag}`)
  }
  if (added.length > 0 && removed.length === 0) {
    return `行内格式变更 (${added.slice(0, 3).join(', ')})`
  }
  if (removed.length > 0 && added.length === 0) {
    return `行内格式变更 (${removed.slice(0, 3).join(', ')})`
  }
  if (added.length === 1 && removed.length === 1) {
    return `行内格式变更 (${removed[0]!.slice(1)} → ${added[0]!.slice(1)})`
  }
  if (added.length > 0 || removed.length > 0) {
    return `行内格式变更 (${[...removed, ...added].slice(0, 3).join(', ')})`
  }
  return '行内标签属性变更'
}

/**
 * Highlights inline-formatting-only changes in place when plain prose is identical
 * and all nested tags are safe inline tags (e.g. `<p>重点</p>` -> `<p><strong>重点</strong></p>`).
 * See ADR 2026-11-22-contiguous-quote-and-structural-revision-preview.
 */
function tryInlineFormatOnlyDiff(
  beforeInner: string,
  afterInner: string,
): { html: string; label: string } | null {
  if (ISLAND_TAG_RE.test(beforeInner) || ISLAND_TAG_RE.test(afterInner)) return null
  if (!allTagsAreInlineSafe(beforeInner) || !allTagsAreInlineSafe(afterInner)) return null
  if (beforeInner === afterInner) return null
  if (stripTags(beforeInner) !== stripTags(afterInner)) return null

  const beforeSigs = collectCharTagSignatures(beforeInner)
  const afterSigs = collectCharTagSignatures(afterInner)
  if (beforeSigs.length !== afterSigs.length) return null

  let cursor = 0
  let out = ''
  for (const tok of tokenizeHtml(afterInner)) {
    if (tok.kind !== 'text') {
      out += tok.value
      continue
    }
    const chars = splitLogicalChars(tok.value)
    let inChanged = false
    let buf = ''
    const flush = () => {
      if (!buf) return
      out += inChanged ? `<span class="bs-rev-fmt-changed">${buf}</span>` : buf
      buf = ''
    }
    for (const item of chars) {
      const changed = beforeSigs[cursor] !== afterSigs[cursor]
      if (changed !== inChanged) {
        flush()
        inChanged = changed
      }
      buf += item.raw
      cursor += 1
    }
    flush()
  }

  return { html: out, label: describeInlineTagDelta(beforeInner, afterInner) }
}

/**
 * Annotates text nodes inside a balanced HTML fragment with `<del>` or `<ins>` highlights
 * derived from `diffChars`, skipping island subtrees (`math`, `svg`, `img`, `video`, `audio`, `table`).
 * See ADR 2026-11-22-contiguous-quote-and-structural-revision-preview.
 */
function highlightCompareFragments(
  beforeFrag: string,
  afterFrag: string,
): { beforeHtml: string; afterHtml: string; isTextUnchanged: boolean } {
  if (normalizeVisibleText(beforeFrag) === normalizeVisibleText(afterFrag)) {
    return { beforeHtml: beforeFrag, afterHtml: afterFrag, isTextUnchanged: true }
  }

  const extractVisibleChars = (html: string): LogicalChar[] => {
    const chars: LogicalChar[] = []
    let islandDepth = 0
    for (const tok of tokenizeHtml(html)) {
      if (tok.kind === 'comment') continue
      if (tok.kind === 'tag') {
        const match = /^<(\/)?([a-zA-Z][\w:-]*)(?:\s[^<>]*?)?(\/?)>$/.exec(tok.value)
        if (!match) continue
        const isClose = match[1] === '/'
        const name = match[2]!.toLowerCase()
        const isSelf = match[3] === '/' || VOID_TAGS.has(name)
        if (ISLAND_TAG_NAMES.has(name) && !isSelf) {
          if (isClose) islandDepth = Math.max(0, islandDepth - 1)
          else islandDepth += 1
        }
        continue
      }
      if (islandDepth > 0) continue
      chars.push(...splitLogicalChars(tok.value))
    }
    return chars
  }

  const beforeChars = extractVisibleChars(beforeFrag)
  const afterChars = extractVisibleChars(afterFrag)
  const beforeStr = beforeChars.map((c) => c.ch).join('')
  const afterStr = afterChars.map((c) => c.ch).join('')
  if (beforeStr === afterStr) {
    return { beforeHtml: beforeFrag, afterHtml: afterFrag, isTextUnchanged: true }
  }

  const segments = diffChars(beforeStr, afterStr)
  const beforeFlags = new Uint8Array(beforeChars.length)
  const afterFlags = new Uint8Array(afterChars.length)
  let bi = 0
  let ai = 0
  for (const seg of segments) {
    const len = Array.from(seg.text).length
    if (seg.kind === 'same') {
      bi += len
      ai += len
    } else if (seg.kind === 'removed') {
      for (let k = 0; k < len && bi < beforeFlags.length; k += 1) {
        beforeFlags[bi] = 1
        bi += 1
      }
    } else {
      for (let k = 0; k < len && ai < afterFlags.length; k += 1) {
        afterFlags[ai] = 1
        ai += 1
      }
    }
  }

  const injectHighlights = (html: string, flags: Uint8Array, wrapTag: 'del' | 'ins', cls: string): string => {
    let cursor = 0
    let islandDepth = 0
    let out = ''
    for (const tok of tokenizeHtml(html)) {
      if (tok.kind === 'comment') {
        out += tok.value
        continue
      }
      if (tok.kind === 'tag') {
        const match = /^<(\/)?([a-zA-Z][\w:-]*)(?:\s[^<>]*?)?(\/?)>$/.exec(tok.value)
        if (match) {
          const isClose = match[1] === '/'
          const name = match[2]!.toLowerCase()
          const isSelf = match[3] === '/' || VOID_TAGS.has(name)
          if (ISLAND_TAG_NAMES.has(name) && !isSelf) {
            if (isClose) islandDepth = Math.max(0, islandDepth - 1)
            else islandDepth += 1
          }
        }
        out += tok.value
        continue
      }
      if (islandDepth > 0) {
        out += tok.value
        continue
      }
      const chars = splitLogicalChars(tok.value)
      let inMark = false
      let buf = ''
      const flush = () => {
        if (!buf) return
        if (inMark && buf.trim().length > 0) {
          out += `<${wrapTag} class="${cls}">${buf}</${wrapTag}>`
        } else {
          out += buf
        }
        buf = ''
      }
      for (const item of chars) {
        const marked = flags[cursor] === 1
        if (marked !== inMark) {
          flush()
          inMark = marked
        }
        buf += item.raw
        cursor += 1
      }
      flush()
    }
    return out
  }

  return {
    beforeHtml: injectHighlights(beforeFrag, beforeFlags, 'del', 'bs-rev-del'),
    afterHtml: injectHighlights(afterFrag, afterFlags, 'ins', 'bs-rev-ins'),
    isTextUnchanged: false,
  }
}

function describeStructuralChange(beforeFrag: string, afterFrag: string): string {
  if (ISLAND_TAG_RE.test(beforeFrag) || ISLAND_TAG_RE.test(afterFrag)) {
    return '公式/媒体结构变更'
  }

  const beforeEls = splitTopLevelElements(beforeFrag)
  const afterEls = splitTopLevelElements(afterFrag)
  if (!beforeEls || !afterEls) return '段落结构变更'

  const beforeTags = beforeEls.map((e) => e.tag)
  const afterTags = afterEls.map((e) => e.tag)
  const allBeforeQuote = beforeTags.every((t) => t === 'blockquote')
  const allAfterQuote = afterTags.every((t) => t === 'blockquote')

  if (afterEls.length === 1 && afterTags[0] === 'blockquote' && !allBeforeQuote) {
    const src = beforeTags.length === 1 ? beforeTags[0]! : `${beforeTags[0]!}×${beforeTags.length}`
    return `包裹为引用 (${src} → blockquote)`
  }
  if (beforeEls.length === 1 && beforeTags[0] === 'blockquote' && !allAfterQuote) {
    const dst = afterTags.length === 1 ? afterTags[0]! : `${afterTags[0]!}×${afterTags.length}`
    return `取消引用 (blockquote → ${dst})`
  }
  if (allBeforeQuote && allAfterQuote && beforeEls.length > 1 && afterEls.length === 1) {
    return `合并相邻引用块 (${beforeEls.length} → 1)`
  }
  if (allBeforeQuote && allAfterQuote && beforeEls.length === 1 && afterEls.length > 1) {
    return `拆分引用块 (1 → ${afterEls.length})`
  }

  if (beforeEls.length === 1 && afterEls.length === 1) {
    const bTag = beforeTags[0]!
    const aTag = afterTags[0]!
    if (bTag !== aTag) {
      if (HEADING_TAGS.has(bTag) && HEADING_TAGS.has(aTag)) {
        return `标题层级变更 (${bTag} → ${aTag})`
      }
      return `标签变更 (${bTag} → ${aTag})`
    }
    return '文本与行内格式变更'
  }

  if (beforeTags.every((t) => t === 'p') && afterTags.every((t) => t === 'p')) {
    if (beforeEls.length > afterEls.length) {
      return `合并段落 (${beforeEls.length} → ${afterEls.length})`
    }
    if (beforeEls.length < afterEls.length) {
      return `拆分段落 (${beforeEls.length} → ${afterEls.length})`
    }
  }

  if (afterEls.length === 1 && CONTAINER_BLOCK_TAGS.has(afterTags[0]!) && !beforeTags.includes(afterTags[0]!)) {
    return `包裹容器 (+${afterTags[0]!})`
  }
  if (beforeEls.length === 1 && CONTAINER_BLOCK_TAGS.has(beforeTags[0]!) && !afterTags.includes(beforeTags[0]!)) {
    return `移除容器 (-${beforeTags[0]!})`
  }

  const beforeUnique = Array.from(new Set(beforeTags)).slice(0, 2).join('/')
  const afterUnique = Array.from(new Set(afterTags)).slice(0, 2).join('/')
  if (beforeUnique && afterUnique && beforeUnique !== afterUnique) {
    return `结构变更 (${beforeUnique} → ${afterUnique})`
  }
  return `段落结构变更 (${beforeEls.length} → ${afterEls.length})`
}

function renderMiniDiffLine(line: LineDiff): string {
  if (line.kind === 'changed') {
    const body = line.segments
      .map((seg) => {
        const safe = escapeHtml(seg.text)
        if (seg.kind === 'removed') return `<span class="bs-rev-minidiff-del">${safe}</span>`
        if (seg.kind === 'added') return `<span class="bs-rev-minidiff-ins">${safe}</span>`
        return safe
      })
      .join('')
    return `<div class="bs-rev-minidiff-line is-chg"><span class="bs-rev-minidiff-sign">~</span><span class="bs-rev-minidiff-code">${body || ' '}</span></div>`
  }
  const sign = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '
  const cls = line.kind === 'added' ? 'is-add' : line.kind === 'removed' ? 'is-del' : 'is-same'
  return `<div class="bs-rev-minidiff-line ${cls}"><span class="bs-rev-minidiff-sign">${sign}</span><span class="bs-rev-minidiff-code">${escapeHtml(line.text) || ' '}</span></div>`
}

function renderMiniSourceDiff(hunk: ProposalHunk): string {
  const sourceLines: LineDiff[] =
    hunk.lines.length > 0
      ? hunk.lines
      : [
          ...hunk.beforeLines.map((text): LineDiff => ({ kind: 'removed', text })),
          ...hunk.afterLines.map((text): LineDiff => ({ kind: 'added', text })),
        ]
  const visible = sourceLines.slice(0, MAX_MINI_DIFF_LINES)
  const omitted = sourceLines.length - visible.length
  const rows = visible.map(renderMiniDiffLine).join('')
  const footer =
    omitted > 0
      ? `<div class="bs-rev-minidiff-more">已省略其余 ${omitted} 行，点击「看源码」查看完整上下文</div>`
      : ''
  return `<div class="bs-rev-minidiff" data-bs-minidiff="${hunk.id}" data-bs-ui="true">${rows}${footer}</div>`
}

function renderControlCluster(
  hunkId: string,
  options: {
    allowToggle: boolean
    decision?: HunkDecision
    badge?: { kind: string; label: string }
    note?: string
    showDiffBtn?: boolean
    isDiffExpanded?: boolean
    showSourceBtn?: boolean
  },
): string {
  const decision = options.decision ?? 'pending'
  const parts: string[] = []
  if (options.badge) {
    parts.push(`<span class="bs-rev-badge is-${options.badge.kind}">${escapeHtml(options.badge.label)}</span>`)
  }
  if (options.note) {
    parts.push(`<span class="bs-rev-note">${escapeHtml(options.note)}</span>`)
  }
  if (options.showDiffBtn) {
    parts.push(
      `<button type="button" class="bs-rev-btn is-diff${options.isDiffExpanded ? ' on' : ''}" data-bs-action="toggle-diff" data-bs-target-hunk="${hunkId}">${options.isDiffExpanded ? '收起对比' : '标签对比'}</button>`,
    )
  }
  if (options.showSourceBtn) {
    parts.push(
      `<button type="button" class="bs-rev-btn is-source" data-bs-action="goto-source" data-bs-target-hunk="${hunkId}">看源码</button>`,
    )
  }
  if (options.allowToggle) {
    if (decision === 'accepted') {
      parts.push(
        `<button type="button" class="bs-rev-btn is-undo" data-bs-action="reset-hunk" data-bs-target-hunk="${hunkId}">撤销</button>`,
      )
    } else if (decision === 'rejected') {
      parts.push(
        `<button type="button" class="bs-rev-btn is-restore" data-bs-action="reset-hunk" data-bs-target-hunk="${hunkId}">恢复</button>`,
      )
    } else {
      parts.push(
        `<button type="button" class="bs-rev-btn is-accept" data-bs-action="accept-hunk" data-bs-target-hunk="${hunkId}">保留</button>`,
        `<button type="button" class="bs-rev-btn is-reject" data-bs-action="reject-hunk" data-bs-target-hunk="${hunkId}">拒绝</button>`,
      )
    }
  }
  if (parts.length === 0) return ''
  return `<span class="bs-rev-controls" data-bs-ui="true">${parts.join('')}</span>`
}

interface ElementPairContext {
  hunk: ProposalHunk
  activeAttr: string
  allowToggle: boolean
  emitControls: boolean
  isDiffExpanded: boolean
}

/**
 * Recursively aligns and diffs children of matching container blocks (e.g. `<blockquote><p>...</p></blockquote>`)
 * so typo fixes inside quotes or lists render in-place instead of degrading to stacked before/after blocks.
 * See ADR 2026-11-22-contiguous-quote-and-structural-revision-preview.
 */
function renderContainerElementPair(
  beforeEl: SingleElementParts,
  afterEl: SingleElementParts,
  ctx: ElementPairContext,
): string | null {
  if (beforeEl.tag !== afterEl.tag || !CONTAINER_BLOCK_TAGS.has(beforeEl.tag)) return null
  const beforeChildren = splitTopLevelElements(beforeEl.inner)
  const afterChildren = splitTopLevelElements(afterEl.inner)
  if (!beforeChildren || !afterChildren) return null

  const beforeRaws = beforeChildren.map(rawOfElement)
  const afterRaws = afterChildren.map(rawOfElement)

  // LCS align identical child elements first so untouched paragraphs inside a container stay quiet.
  const n = beforeRaws.length
  const m = afterRaws.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        beforeRaws[i] === afterRaws[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  type Step =
    | { kind: 'same'; bi: number; ai: number }
    | { kind: 'removed'; bi: number }
    | { kind: 'added'; ai: number }
  const steps: Step[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (beforeRaws[i] === afterRaws[j]) {
      steps.push({ kind: 'same', bi: i, ai: j })
      i += 1
      j += 1
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      steps.push({ kind: 'removed', bi: i })
      i += 1
    } else {
      steps.push({ kind: 'added', ai: j })
      j += 1
    }
  }
  while (i < n) {
    steps.push({ kind: 'removed', bi: i })
    i += 1
  }
  while (j < m) {
    steps.push({ kind: 'added', ai: j })
    j += 1
  }

  const renderedChildren: string[] = []
  let stepIdx = 0
  let hadFormatOrAttrChild = false

  while (stepIdx < steps.length) {
    const step = steps[stepIdx]!
    if (step.kind === 'same') {
      renderedChildren.push(afterRaws[step.ai]!)
      stepIdx += 1
      continue
    }

    const removedBatch: SingleElementParts[] = []
    const addedBatch: SingleElementParts[] = []
    while (stepIdx < steps.length && steps[stepIdx]!.kind !== 'same') {
      const cur = steps[stepIdx]!
      if (cur.kind === 'removed') removedBatch.push(beforeChildren[cur.bi]!)
      else addedBatch.push(afterChildren[cur.ai]!)
      stepIdx += 1
    }

    const pairCount = Math.min(removedBatch.length, addedBatch.length)
    for (let k = 0; k < pairCount; k += 1) {
      const bChild = removedBatch[k]!
      const aChild = addedBatch[k]!
      if (bChild.tag !== aChild.tag) return null
      if (bChild.openTag !== aChild.openTag) hadFormatOrAttrChild = true
      const rendered = renderSingleElementPair(bChild, aChild, {
        ...ctx,
        activeAttr: '',
        emitControls: false,
        isDiffExpanded: false,
      })
      if (rendered === null) return null
      renderedChildren.push(rendered)
    }

    for (let k = pairCount; k < removedBatch.length; k += 1) {
      const removedEl = removedBatch[k]!
      if (!SIMPLE_BLOCK_TAGS.has(removedEl.tag) || ISLAND_TAG_RE.test(removedEl.inner)) return null
      renderedChildren.push(
        `${injectAttrsIntoOpenTag(removedEl.openTag, 'data-bs-rev="removed"')}${removedEl.inner}${removedEl.closeTag}`,
      )
    }

    for (let k = pairCount; k < addedBatch.length; k += 1) {
      const addedEl = addedBatch[k]!
      if (!SIMPLE_BLOCK_TAGS.has(addedEl.tag) || ISLAND_TAG_RE.test(addedEl.inner)) return null
      renderedChildren.push(
        `${injectAttrsIntoOpenTag(addedEl.openTag, 'data-bs-rev="added"')}${addedEl.inner}${addedEl.closeTag}`,
      )
    }
  }

  const attrAlsoChanged = beforeEl.openTag !== afterEl.openTag
  const taggedOpen = injectAttrsIntoOpenTag(
    afterEl.openTag,
    `data-bs-hunk="${ctx.hunk.id}" data-bs-rev="${attrAlsoChanged ? 'attr' : 'inline'}"${ctx.activeAttr}`,
  )
  const needsDiffToggle = attrAlsoChanged || hadFormatOrAttrChild
  const controls = ctx.emitControls
    ? renderControlCluster(ctx.hunk.id, {
        allowToggle: ctx.allowToggle,
        badge: attrAlsoChanged ? { kind: 'attr', label: describeAttrChange(beforeEl.openTag, afterEl.openTag) } : undefined,
        showDiffBtn: needsDiffToggle,
        isDiffExpanded: ctx.isDiffExpanded,
        showSourceBtn: needsDiffToggle,
      })
    : ''
  const miniDiff = ctx.emitControls && needsDiffToggle && ctx.isDiffExpanded ? renderMiniSourceDiff(ctx.hunk) : ''

  if (NO_NESTED_DIV_TAGS.has(afterEl.tag)) {
    const bar = controls ? `<div class="bs-rev-container-bar" data-bs-ui="true">${controls}</div>` : ''
    return `${bar}${miniDiff}${taggedOpen}\n${renderedChildren.join('\n')}\n${afterEl.closeTag}`
  }

  const bar = controls ? `<div class="bs-rev-container-bar" data-bs-ui="true">${controls}</div>` : ''
  return `${taggedOpen}${bar}${miniDiff}\n${renderedChildren.join('\n')}\n${afterEl.closeTag}`
}

function renderSingleElementPair(
  beforeEl: SingleElementParts,
  afterEl: SingleElementParts,
  ctx: ElementPairContext,
): string | null {
  if (beforeEl.tag !== afterEl.tag) return null

  // 1. Recursive container alignment (e.g. `<blockquote><p>...</p></blockquote>`, `<ul><li>...</li></ul>`).
  if (CONTAINER_BLOCK_TAGS.has(beforeEl.tag)) {
    const containerRendered = renderContainerElementPair(beforeEl, afterEl, ctx)
    if (containerRendered !== null) return containerRendered
  }

  if (!SIMPLE_BLOCK_TAGS.has(beforeEl.tag)) return null
  if (ISLAND_TAG_RE.test(beforeEl.inner) || ISLAND_TAG_RE.test(afterEl.inner)) return null

  // 2. Pure attribute / class / style change where inner markup is identical.
  if (beforeEl.inner === afterEl.inner && beforeEl.openTag !== afterEl.openTag) {
    const taggedOpen = injectAttrsIntoOpenTag(
      afterEl.openTag,
      `data-bs-hunk="${ctx.hunk.id}" data-bs-rev="attr"${ctx.activeAttr}`,
    )
    const controls = ctx.emitControls
      ? renderControlCluster(ctx.hunk.id, {
          allowToggle: ctx.allowToggle,
          badge: { kind: 'attr', label: describeAttrChange(beforeEl.openTag, afterEl.openTag) },
          showDiffBtn: true,
          isDiffExpanded: ctx.isDiffExpanded,
          showSourceBtn: true,
        })
      : ''
    const miniDiff = ctx.emitControls && ctx.isDiffExpanded ? renderMiniSourceDiff(ctx.hunk) : ''
    return `${taggedOpen}${afterEl.inner}${controls}${afterEl.closeTag}${miniDiff}`
  }

  // 3. Inline-tag-aligned character diff.
  const inlineDiff = tryInlineTagAlignedDiff(beforeEl.inner, afterEl.inner)
  if (inlineDiff !== null) {
    const attrAlsoChanged = beforeEl.openTag !== afterEl.openTag
    const taggedOpen = injectAttrsIntoOpenTag(
      afterEl.openTag,
      `data-bs-hunk="${ctx.hunk.id}" data-bs-rev="inline"${ctx.activeAttr}`,
    )
    const controls = ctx.emitControls
      ? renderControlCluster(ctx.hunk.id, {
          allowToggle: ctx.allowToggle,
          badge: attrAlsoChanged ? { kind: 'attr', label: describeAttrChange(beforeEl.openTag, afterEl.openTag) } : undefined,
          showDiffBtn: attrAlsoChanged,
          isDiffExpanded: ctx.isDiffExpanded,
          showSourceBtn: attrAlsoChanged,
        })
      : ''
    const miniDiff = ctx.emitControls && attrAlsoChanged && ctx.isDiffExpanded ? renderMiniSourceDiff(ctx.hunk) : ''
    return `${taggedOpen}${inlineDiff}${controls}${afterEl.closeTag}${miniDiff}`
  }

  // 4. Inline-formatting-only change with identical visible prose (e.g. adding `<strong>` / `<em>` / `<a>`).
  const fmtDiff = tryInlineFormatOnlyDiff(beforeEl.inner, afterEl.inner)
  if (fmtDiff !== null) {
    const taggedOpen = injectAttrsIntoOpenTag(
      afterEl.openTag,
      `data-bs-hunk="${ctx.hunk.id}" data-bs-rev="inline"${ctx.activeAttr}`,
    )
    const controls = ctx.emitControls
      ? renderControlCluster(ctx.hunk.id, {
          allowToggle: ctx.allowToggle,
          badge: { kind: 'attr', label: fmtDiff.label },
          showDiffBtn: true,
          isDiffExpanded: ctx.isDiffExpanded,
          showSourceBtn: true,
        })
      : ''
    const miniDiff = ctx.emitControls && ctx.isDiffExpanded ? renderMiniSourceDiff(ctx.hunk) : ''
    return `${taggedOpen}${fmtDiff.html}${controls}${afterEl.closeTag}${miniDiff}`
  }

  return null
}

interface SeamHunkInfo {
  kind: 'merge' | 'split'
  tag: string
  openTag: string
  closeTag: string
}

/** Detects adjacent-container merge (`</blockquote>\n<blockquote>` removed) or split (inserted). */
function detectSeamHunk(beforeFrag: string, afterFrag: string): SeamHunkInfo | null {
  const seamRe = /^<\/([a-zA-Z][\w:-]*)>\s*(<\1(?:\s[^<>]*?)?>)$/i
  const bTrim = beforeFrag.trim()
  const aTrim = afterFrag.trim()
  if (bTrim && !aTrim) {
    const m = seamRe.exec(bTrim)
    if (m) {
      const tag = m[1]!.toLowerCase()
      return { kind: 'merge', tag, closeTag: `</${tag}>`, openTag: m[2]! }
    }
  }
  if (!bTrim && aTrim) {
    const m = seamRe.exec(aTrim)
    if (m) {
      const tag = m[1]!.toLowerCase()
      return { kind: 'split', tag, closeTag: `</${tag}>`, openTag: m[2]! }
    }
  }
  return null
}

interface OpeningTagAttrChangeInfo {
  tag: string
  beforeOpen: string
  afterOpen: string
}

/** Detects a single-line opening-tag attribute edit on a multi-line container (`<blockquote class="a">` -> `<blockquote class="b">`). */
function detectOpeningTagAttrChange(beforeFrag: string, afterFrag: string): OpeningTagAttrChangeInfo | null {
  const openRe = /^<([a-zA-Z][\w:-]*)(?:\s[^<>]*?)?>$/
  const bTrim = beforeFrag.trim()
  const aTrim = afterFrag.trim()
  if (bTrim.endsWith('/>') || aTrim.endsWith('/>')) return null
  const bm = openRe.exec(bTrim)
  const am = openRe.exec(aTrim)
  if (!bm || !am) return null
  const bTag = bm[1]!.toLowerCase()
  const aTag = am[1]!.toLowerCase()
  if (bTag !== aTag || VOID_TAGS.has(bTag) || bTrim === aTrim) return null
  return { tag: bTag, beforeOpen: bTrim, afterOpen: aTrim }
}

/** Produces a directional Chinese label for remaining giant-span unbalanced tag hunks (>40 lines). */
function describeUnbalancedTagHunk(beforeFrag: string, afterFrag: string): string {
  const bTrim = beforeFrag.trim()
  const aTrim = afterFrag.trim()
  const openRe = /^<([a-zA-Z][\w:-]*)(?:\s[^<>]*?)?>$/
  const closeRe = /^<\/([a-zA-Z][\w:-]*)>$/

  if (!bTrim && aTrim) {
    const om = openRe.exec(aTrim)
    if (om && !aTrim.endsWith('/>')) return `+ 跨行开始 <${om[1]!.toLowerCase()}>`
    const cm = closeRe.exec(aTrim)
    if (cm) return `+ 跨行结束 </${cm[1]!.toLowerCase()}>`
  }
  if (bTrim && !aTrim) {
    const om = openRe.exec(bTrim)
    if (om && !bTrim.endsWith('/>')) return `- 移除开始 <${om[1]!.toLowerCase()}>`
    const cm = closeRe.exec(bTrim)
    if (cm) return `- 移除结束 </${cm[1]!.toLowerCase()}>`
  }
  return '跨行标签变更'
}

function renderHunkInBody(
  hunk: ProposalHunk,
  options: { decision: HunkDecision; allowToggle: boolean; isActive: boolean; isDiffExpanded: boolean },
): string {
  const { decision, allowToggle, isActive, isDiffExpanded } = options
  const beforeFrag = hunk.beforeLines.join('\n')
  const afterFrag = hunk.afterLines.join('\n')
  const activeAttr = isActive ? ' data-bs-active="true"' : ''
  const seamInfo = detectSeamHunk(beforeFrag, afterFrag)
  const openTagAttrInfo = detectOpeningTagAttrChange(beforeFrag, afterFrag)

  // Accepted state: collapse red/green highlights in-place into clean final prose with a quiet undo pill.
  if (decision === 'accepted') {
    if (seamInfo) {
      const label = seamInfo.kind === 'merge' ? `已保留 · 合并相邻${tagLabelZh(seamInfo.tag)}` : `已保留 · 拆分${tagLabelZh(seamInfo.tag)}`
      const bar = `<div class="bs-rev-seam is-accepted" data-bs-hunk="${hunk.id}" data-bs-rev="accepted"${activeAttr} data-bs-ui="true">${renderControlCluster(hunk.id, { allowToggle, decision: 'accepted', badge: { kind: 'accepted', label } })}</div>`
      return seamInfo.kind === 'split' ? `${seamInfo.closeTag}${bar}${seamInfo.openTag}` : bar
    }
    if (openTagAttrInfo) {
      const taggedOpen = injectAttrsIntoOpenTag(
        openTagAttrInfo.afterOpen,
        `data-bs-hunk="${hunk.id}" data-bs-rev="accepted"${activeAttr}`,
      )
      const controls = renderControlCluster(hunk.id, {
        allowToggle,
        decision: 'accepted',
        badge: { kind: 'accepted', label: '已保留' },
      })
      return `${taggedOpen}<div class="bs-rev-container-bar" data-bs-ui="true">${controls}</div>`
    }

    const controls = renderControlCluster(hunk.id, {
      allowToggle,
      decision: 'accepted',
      badge: { kind: 'accepted', label: '已保留' },
    })
    if (!afterFrag.trim()) {
      return `<div class="bs-rev-resolved-placeholder is-accepted" data-bs-hunk="${hunk.id}" data-bs-rev="accepted"${activeAttr} data-bs-ui="true"><span>已保留此处删除</span>${controls}</div>`
    }
    const singleAfter = parseSingleElement(afterFrag)
    if (singleAfter && SIMPLE_BLOCK_TAGS.has(singleAfter.tag) && !ISLAND_TAG_RE.test(singleAfter.inner)) {
      const open = injectAttrsIntoOpenTag(
        singleAfter.openTag,
        `data-bs-hunk="${hunk.id}" data-bs-rev="accepted"${activeAttr}`,
      )
      if (CONTAINER_BLOCK_TAGS.has(singleAfter.tag) && !NO_NESTED_DIV_TAGS.has(singleAfter.tag) && splitTopLevelElements(singleAfter.inner)) {
        return `${open}<div class="bs-rev-container-bar" data-bs-ui="true">${controls}</div>${singleAfter.inner}${singleAfter.closeTag}`
      }
      return `${open}${singleAfter.inner}${controls}${singleAfter.closeTag}`
    }
    if (isBalancedMarkup(afterFrag) && !/^<tr[\s>]/i.test(afterFrag.trim())) {
      return `<div class="bs-rev-block is-accepted" data-bs-hunk="${hunk.id}" data-bs-rev="accepted"${activeAttr}><div class="bs-rev-block-bar" data-bs-ui="true">${controls}</div>${afterFrag}</div>`
    }
    if (!hasAnyTag(afterFrag)) {
      return `<span class="bs-rev-inline-wrap" data-bs-hunk="${hunk.id}" data-bs-rev="accepted"${activeAttr}>${escapeHtml(afterFrag)}${controls}</span>`
    }
    return `${afterFrag}<span class="bs-rev-controls" data-bs-hunk="${hunk.id}" data-bs-rev="accepted"${activeAttr} data-bs-ui="true">${controls}</span>`
  }

  // Rejected state: restore original book prose with a subtle restore pill.
  if (decision === 'rejected') {
    if (seamInfo) {
      const label = seamInfo.kind === 'merge' ? `已拒绝 · 保持独立${tagLabelZh(seamInfo.tag)}` : `已拒绝 · 保持合并`
      const bar = `<div class="bs-rev-seam is-rejected" data-bs-hunk="${hunk.id}" data-bs-rev="rejected"${activeAttr} data-bs-ui="true">${renderControlCluster(hunk.id, { allowToggle, decision: 'rejected', badge: { kind: 'rejected', label } })}</div>`
      return seamInfo.kind === 'merge' ? `${seamInfo.closeTag}${bar}${seamInfo.openTag}` : bar
    }
    if (openTagAttrInfo) {
      const taggedOpen = injectAttrsIntoOpenTag(
        openTagAttrInfo.beforeOpen,
        `data-bs-hunk="${hunk.id}" data-bs-rev="rejected"${activeAttr}`,
      )
      const controls = renderControlCluster(hunk.id, {
        allowToggle,
        decision: 'rejected',
        badge: { kind: 'rejected', label: '已拒绝' },
      })
      return `${taggedOpen}<div class="bs-rev-container-bar" data-bs-ui="true">${controls}</div>`
    }

    if (!beforeFrag.trim()) {
      return `<div class="bs-rev-skipped-placeholder" data-bs-hunk="${hunk.id}" data-bs-rev="rejected"${activeAttr} data-bs-ui="true"><span>已拒绝此处新增内容</span>${renderControlCluster(hunk.id, { allowToggle, decision: 'rejected' })}</div>`
    }
    const singleBefore = parseSingleElement(beforeFrag)
    if (singleBefore && SIMPLE_BLOCK_TAGS.has(singleBefore.tag)) {
      const open = injectAttrsIntoOpenTag(
        singleBefore.openTag,
        `data-bs-hunk="${hunk.id}" data-bs-rev="rejected"${activeAttr}`,
      )
      const controls = renderControlCluster(hunk.id, {
        allowToggle,
        decision: 'rejected',
        badge: { kind: 'rejected', label: '已拒绝' },
      })
      if (CONTAINER_BLOCK_TAGS.has(singleBefore.tag) && !NO_NESTED_DIV_TAGS.has(singleBefore.tag) && splitTopLevelElements(singleBefore.inner)) {
        return `${open}<div class="bs-rev-container-bar" data-bs-ui="true">${controls}</div>${singleBefore.inner}${singleBefore.closeTag}`
      }
      return `${open}${singleBefore.inner}${controls}${singleBefore.closeTag}`
    }
    if (isBalancedMarkup(beforeFrag) && !/^<tr[\s>]/i.test(beforeFrag.trim())) {
      return `<div class="bs-rev-block is-skipped" data-bs-hunk="${hunk.id}" data-bs-rev="rejected"${activeAttr}><div class="bs-rev-block-bar" data-bs-ui="true">${renderControlCluster(hunk.id, { allowToggle, decision: 'rejected', badge: { kind: 'rejected', label: '已拒绝 · 保留原文' } })}</div>${beforeFrag}</div>`
    }
    // Keep restore controls reachable even for rejected unbalanced cross-line hunks.
    return `${beforeFrag}<span class="bs-rev-controls" data-bs-hunk="${hunk.id}" data-bs-rev="rejected"${activeAttr} data-bs-ui="true">${renderControlCluster(hunk.id, { allowToggle, decision: 'rejected', badge: { kind: 'rejected', label: '已拒绝' } })}</span>`
  }

  // Dedicated seam banner for merging or splitting consecutive containers (`</blockquote>\n<blockquote>`).
  if (seamInfo) {
    const label =
      seamInfo.kind === 'merge'
        ? `合并相邻${tagLabelZh(seamInfo.tag)}`
        : `拆分为两段${tagLabelZh(seamInfo.tag)}`
    const note =
      seamInfo.kind === 'merge'
        ? `移除 ${seamInfo.closeTag}${seamInfo.openTag} 分隔`
        : `插入 ${seamInfo.closeTag}${seamInfo.openTag} 分隔`
    const bar = [
      `<div class="bs-rev-seam is-${seamInfo.kind}" data-bs-hunk="${hunk.id}"${activeAttr} data-bs-ui="true">`,
      renderControlCluster(hunk.id, {
        allowToggle,
        badge: { kind: 'attr', label },
        note,
        showDiffBtn: true,
        isDiffExpanded,
        showSourceBtn: true,
      }),
      isDiffExpanded ? renderMiniSourceDiff(hunk) : '',
      `</div>`,
    ].join('')
    return seamInfo.kind === 'split' ? `${seamInfo.closeTag}${bar}${seamInfo.openTag}` : bar
  }

  // Dedicated attribute indicator for multi-line opening-tag edits (`<blockquote class="a">` -> `<blockquote class="b">`).
  if (openTagAttrInfo) {
    const taggedOpen = injectAttrsIntoOpenTag(
      openTagAttrInfo.afterOpen,
      `data-bs-hunk="${hunk.id}" data-bs-rev="attr"${activeAttr}`,
    )
    const controls = renderControlCluster(hunk.id, {
      allowToggle,
      badge: { kind: 'attr', label: describeAttrChange(openTagAttrInfo.beforeOpen, openTagAttrInfo.afterOpen) },
      showDiffBtn: true,
      isDiffExpanded,
      showSourceBtn: true,
    })
    const miniDiff = isDiffExpanded ? renderMiniSourceDiff(hunk) : ''
    return `${taggedOpen}<div class="bs-rev-container-bar" data-bs-ui="true">${controls}</div>${miniDiff}`
  }

  // Pure addition inside body.
  if (!beforeFrag.trim() && afterFrag.trim()) {
    const trimmedAfter = afterFrag.trim()
    if (/^<tr[\s>]/i.test(trimmedAfter)) {
      return trimmedAfter.replace(/^<tr\b/, `<tr data-bs-hunk="${hunk.id}" data-bs-rev="added"${activeAttr}`)
    }
    if (isBalancedMarkup(trimmedAfter)) {
      const single = parseSingleElement(trimmedAfter)
      if (single && SIMPLE_BLOCK_TAGS.has(single.tag) && !ISLAND_TAG_RE.test(single.inner)) {
        const open = injectAttrsIntoOpenTag(
          single.openTag,
          `data-bs-hunk="${hunk.id}" data-bs-rev="added"${activeAttr}`,
        )
        const controls = renderControlCluster(hunk.id, {
          allowToggle,
          badge: { kind: 'add', label: '+ 新增' },
        })
        if (CONTAINER_BLOCK_TAGS.has(single.tag) && !NO_NESTED_DIV_TAGS.has(single.tag) && splitTopLevelElements(single.inner)) {
          return `${open}<div class="bs-rev-container-bar" data-bs-ui="true">${controls}</div>${single.inner}${single.closeTag}`
        }
        return `${open}${single.inner}${controls}${single.closeTag}`
      }
      return `<div class="bs-rev-block is-added" data-bs-hunk="${hunk.id}"${activeAttr}><div class="bs-rev-block-bar" data-bs-ui="true">${renderControlCluster(hunk.id, { allowToggle, badge: { kind: 'add', label: '+ 新增内容' } })}</div>${trimmedAfter}</div>`
    }
    if (!hasAnyTag(afterFrag)) {
      return `<span class="bs-rev-inline-wrap" data-bs-hunk="${hunk.id}"${activeAttr}><ins class="bs-rev-ins">${escapeHtml(afterFrag)}</ins>${renderControlCluster(hunk.id, { allowToggle })}</span>`
    }
  }

  // Pure deletion inside body.
  if (beforeFrag.trim() && !afterFrag.trim()) {
    const trimmedBefore = beforeFrag.trim()
    if (/^<tr[\s>]/i.test(trimmedBefore)) {
      return trimmedBefore.replace(/^<tr\b/, `<tr data-bs-hunk="${hunk.id}" data-bs-rev="removed"${activeAttr}`)
    }
    if (isBalancedMarkup(trimmedBefore)) {
      const single = parseSingleElement(trimmedBefore)
      if (single && SIMPLE_BLOCK_TAGS.has(single.tag) && !ISLAND_TAG_RE.test(single.inner)) {
        const open = injectAttrsIntoOpenTag(
          single.openTag,
          `data-bs-hunk="${hunk.id}" data-bs-rev="removed"${activeAttr}`,
        )
        const controls = renderControlCluster(hunk.id, {
          allowToggle,
          badge: { kind: 'del', label: '- 删除' },
        })
        if (CONTAINER_BLOCK_TAGS.has(single.tag) && !NO_NESTED_DIV_TAGS.has(single.tag) && splitTopLevelElements(single.inner)) {
          return `${open}<div class="bs-rev-container-bar" data-bs-ui="true">${controls}</div>${single.inner}${single.closeTag}`
        }
        return `${open}${single.inner}${controls}${single.closeTag}`
      }
      return `<div class="bs-rev-block is-removed" data-bs-hunk="${hunk.id}"${activeAttr}><div class="bs-rev-block-bar" data-bs-ui="true">${renderControlCluster(hunk.id, { allowToggle, badge: { kind: 'del', label: '- 删除内容' } })}</div>${trimmedBefore}</div>`
    }
    if (!hasAnyTag(beforeFrag)) {
      return `<span class="bs-rev-inline-wrap" data-bs-hunk="${hunk.id}"${activeAttr}><del class="bs-rev-del">${escapeHtml(beforeFrag)}</del>${renderControlCluster(hunk.id, { allowToggle })}</span>`
    }
  }

  // Try single-block, recursive container, or equal-count multi-block in-place revision.
  const beforeEls = splitTopLevelElements(beforeFrag)
  const afterEls = splitTopLevelElements(afterFrag)
  if (beforeEls && afterEls && beforeEls.length === afterEls.length) {
    const renderedPairs: string[] = []
    let allMatched = true
    for (let i = 0; i < beforeEls.length; i += 1) {
      const rendered = renderSingleElementPair(beforeEls[i]!, afterEls[i]!, {
        hunk,
        activeAttr,
        allowToggle,
        emitControls: i === 0,
        isDiffExpanded: i === 0 && isDiffExpanded,
      })
      if (rendered === null) {
        allMatched = false
        break
      }
      renderedPairs.push(rendered)
    }
    if (allMatched) {
      return renderedPairs.join('\n')
    }
  }

  // Plain text lines inside an outer multi-line block (no tags on either side).
  if (!hasAnyTag(beforeFrag) && !hasAnyTag(afterFrag)) {
    return `<span class="bs-rev-inline-wrap" data-bs-hunk="${hunk.id}"${activeAttr}>${renderInlineCharDiff(beforeFrag, afterFrag)}${renderControlCluster(hunk.id, { allowToggle })}</span>`
  }

  // Balanced structural/complex blocks (e.g., wrap/unwrap blockquote, tag change, split/merge, MathML/media):
  // show semantic title + island-safe text-node diff highlights + optional inline mini-source diff.
  if (
    isBalancedMarkup(beforeFrag) &&
    isBalancedMarkup(afterFrag) &&
    !/^<tr[\s>]/i.test(beforeFrag.trim()) &&
    !/^<tr[\s>]/i.test(afterFrag.trim())
  ) {
    const label = describeStructuralChange(beforeFrag, afterFrag)
    const compared = highlightCompareFragments(beforeFrag, afterFrag)
    const note = compared.isTextUnchanged ? '文字未变 · 仅结构/标签调整' : undefined
    return [
      `<div class="bs-rev-block is-replaced" data-bs-hunk="${hunk.id}"${activeAttr}>`,
      `<div class="bs-rev-block-bar" data-bs-ui="true">${renderControlCluster(hunk.id, {
        allowToggle,
        badge: { kind: 'attr', label },
        note,
        showDiffBtn: true,
        isDiffExpanded,
        showSourceBtn: true,
      })}</div>`,
      isDiffExpanded ? renderMiniSourceDiff(hunk) : '',
      `<div class="bs-rev-compare-before"><span class="bs-rev-side-tag is-del" data-bs-ui="true">原</span><div class="bs-rev-side-body">${compared.beforeHtml}</div></div>`,
      `<div class="bs-rev-compare-after"><span class="bs-rev-side-tag is-add" data-bs-ui="true">新</span><div class="bs-rev-side-body">${compared.afterHtml}</div></div>`,
      `</div>`,
    ].join('')
  }

  // Fallback for giant-span unbalanced cross-line edits (>40 lines): keep valid `afterFrag` + directional label + mini-diff.
  const directionalLabel = describeUnbalancedTagHunk(beforeFrag, afterFrag)
  const miniDiff = isDiffExpanded ? renderMiniSourceDiff(hunk) : ''
  return `${afterFrag}<span class="bs-rev-controls" data-bs-hunk="${hunk.id}"${activeAttr} data-bs-ui="true">${renderControlCluster(hunk.id, {
    allowToggle,
    badge: { kind: 'attr', label: directionalLabel },
    showDiffBtn: true,
    isDiffExpanded,
    showSourceBtn: true,
  })}</span>${miniDiff}`
}

function lineNumberAtOffset(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

export function buildRevisionXhtml(options: RevisionXhtmlOptions): RevisionXhtmlResult {
  const {
    model,
    decisions,
    skippedHunkIds,
    allowHunkToggle,
    activeHunkId = null,
    expandedDiffHunkIds,
  } = options
  const activeDecisions = decisions ?? skippedHunkIds
  const hunkLocations = new Map<string, 'body' | 'head'>()
  const headHunkIds: string[] = []

  if (model.hunks.length === 0) {
    return {
      xhtml: model.file.afterText ?? model.file.beforeText ?? '',
      headHunkIds,
      hunkLocations,
    }
  }

  // Whole-chapter create or delete renders inside the real book template with a top revision frame.
  if (model.file.kind === 'create' || model.file.kind === 'delete') {
    const raw = normalizeEol(
      model.file.kind === 'create' ? (model.file.afterText ?? '') : (model.file.beforeText ?? ''),
    )
    const range = extractBodyRange(raw)
    const hunkId = model.hunks[0]!.id
    if (!range) {
      headHunkIds.push(hunkId)
      hunkLocations.set(hunkId, 'head')
      return { xhtml: raw, headHunkIds, hunkLocations }
    }
    hunkLocations.set(hunkId, 'body')
    const isAdded = model.file.kind === 'create'
    const activeAttr = activeHunkId === hunkId ? ' data-bs-active="true"' : ''
    const wrapped = [
      `<div class="bs-rev-block ${isAdded ? 'is-added' : 'is-removed'}" data-bs-hunk="${hunkId}"${activeAttr}>`,
      `<div class="bs-rev-block-bar" data-bs-ui="true"><span class="bs-rev-badge ${isAdded ? 'is-add' : 'is-del'}">${isAdded ? '+ 新增章节' : '- 删除章节'}</span></div>`,
      range.innerXml,
      `</div>`,
    ].join('')
    return {
      xhtml: `${raw.slice(0, range.openEnd)}${wrapped}${raw.slice(range.closeStart)}`,
      headHunkIds,
      hunkLocations,
    }
  }

  const beforeNorm = normalizeEol(model.file.beforeText ?? '')
  const afterNorm = normalizeEol(model.file.afterText ?? '')
  const afterRange = extractBodyRange(afterNorm)
  const beforeRange = extractBodyRange(beforeNorm)

  if (!afterRange || !beforeRange) {
    for (const h of model.hunks) {
      headHunkIds.push(h.id)
      hunkLocations.set(h.id, 'head')
    }
    return { xhtml: afterNorm, headHunkIds, hunkLocations }
  }

  const beforeOpenLine = lineNumberAtOffset(beforeNorm, beforeRange.openEnd)
  const beforeCloseLine = lineNumberAtOffset(beforeNorm, beforeRange.closeStart)
  const afterOpenLine = lineNumberAtOffset(afterNorm, afterRange.openEnd)
  const afterCloseLine = lineNumberAtOffset(afterNorm, afterRange.closeStart)

  // Handle single-line XHTML documents (e.g., `<html><head>...</head><body><p>...</p></body></html>`)
  // where `<head>` and `<body>` share line 1.
  if (beforeOpenLine === beforeCloseLine && afterOpenLine === afterCloseLine) {
    const bodyBefore = beforeRange.innerXml
    const bodyAfter = afterRange.innerXml
    const hunk = model.hunks[0]!
    if (bodyBefore !== bodyAfter) {
      hunkLocations.set(hunk.id, 'body')
      const syntheticHunk: ProposalHunk = {
        ...hunk,
        beforeLines: [bodyBefore],
        afterLines: [bodyAfter],
      }
      const renderedBody = renderHunkInBody(syntheticHunk, {
        decision: getHunkDecision(activeDecisions, hunk.id),
        allowToggle: allowHunkToggle,
        isActive: activeHunkId === hunk.id,
        isDiffExpanded: Boolean(expandedDiffHunkIds?.has(hunk.id)),
      })
      return {
        xhtml: `${afterNorm.slice(0, afterRange.openEnd)}${renderedBody}${afterNorm.slice(afterRange.closeStart)}`,
        headHunkIds,
        hunkLocations,
      }
    }
    headHunkIds.push(hunk.id)
    hunkLocations.set(hunk.id, 'head')
    return { xhtml: afterNorm, headHunkIds, hunkLocations }
  }

  const hunkById = new Map(model.hunks.map((h) => [h.id, h]))
  const bodyLinesOut: string[] = []
  const handledHunks = new Set<string>()

  const isInsideBody = (lineNo: number | null, openLine: number, closeLine: number): boolean => {
    if (lineNo === null) return false
    return lineNo > openLine && lineNo < closeLine
  }

  for (const row of model.allLines) {
    if (row.hunkId === null) {
      if (isInsideBody(row.afterLine, afterOpenLine, afterCloseLine) && row.diff.kind === 'same') {
        bodyLinesOut.push(row.diff.text)
      }
      continue
    }

    if (handledHunks.has(row.hunkId)) continue
    handledHunks.add(row.hunkId)

    const hunk = hunkById.get(row.hunkId)!
    const touchesAfterBody =
      hunk.afterCount > 0
        ? hunk.afterStart < afterCloseLine && hunk.afterStart + hunk.afterCount - 1 > afterOpenLine
        : hunk.afterStart > afterOpenLine && hunk.afterStart <= afterCloseLine
    const touchesBeforeBody =
      hunk.beforeCount > 0
        ? hunk.beforeStart < beforeCloseLine && hunk.beforeStart + hunk.beforeCount - 1 > beforeOpenLine
        : hunk.beforeStart > beforeOpenLine && hunk.beforeStart <= beforeCloseLine

    if (!touchesAfterBody && !touchesBeforeBody) {
      headHunkIds.push(hunk.id)
      hunkLocations.set(hunk.id, 'head')
      continue
    }

    hunkLocations.set(hunk.id, 'body')
    bodyLinesOut.push(
      renderHunkInBody(hunk, {
        decision: getHunkDecision(activeDecisions, hunk.id),
        allowToggle: allowHunkToggle,
        isActive: activeHunkId === hunk.id,
        isDiffExpanded: Boolean(expandedDiffHunkIds?.has(hunk.id)),
      }),
    )
  }

  const nextBodyInner = `\n${bodyLinesOut.join('\n')}\n`
  return {
    xhtml: `${afterNorm.slice(0, afterRange.openEnd)}${nextBodyInner}${afterNorm.slice(afterRange.closeStart)}`,
    headHunkIds,
    hunkLocations,
  }
}

/**
 * Theme-aligned CSS injected into the book-page review iframe.
 * Uses the exact semantic hex values verified >= 5.29:1 against `tokens.css` for both themes.
 * See ADR 2026-11-21-in-canvas-agent-proposal-review,
 * ADR 2026-11-22-contiguous-quote-and-structural-revision-preview.
 */
export function buildRevisionStyleCss(theme: 'light' | 'dark'): string {
  const isDark = theme === 'dark'
  const c = isDark
    ? {
        canvasBg: '#12131a',
        paperBg: '#1a1b24',
        paperShadow: '0 10px 28px -6px rgb(6 7 12 / 52%), 0 2px 6px rgb(6 7 12 / 34%)',
        border: '#2c2e3d',
        borderStrong: '#464655',
        surfaceRaised: '#222430',
        text: '#ececf2',
        textMuted: '#9e9fb3',
        accent: '#9c97f4',
        accentSubtle: '#1e1b4b',
        okBg: '#16301f',
        okFg: '#a8cdb4',
        errBg: '#3a1c17',
        errFg: '#e3a99b',
        warnBg: '#3a2c14',
        warnFg: '#dcb877',
      }
    : {
        canvasBg: '#f4f4f7',
        paperBg: '#ffffff',
        paperShadow: '0 10px 28px -6px rgb(18 19 26 / 9%), 0 2px 6px -1px rgb(18 19 26 / 5%)',
        border: '#e2e2ea',
        borderStrong: '#afb0bd',
        surfaceRaised: '#f4f4f6',
        text: '#202028',
        textMuted: '#5a5a6b',
        accent: '#4338ca',
        accentSubtle: '#edecfe',
        okBg: '#e6f2e8',
        okFg: '#2c5b39',
        errBg: '#fbeae6',
        errFg: '#8f2f21',
        warnBg: '#fdf1dc',
        warnFg: '#8a5a12',
      }

  return `
html {
  background: ${c.canvasBg} !important;
  min-height: 100%;
  padding: 20px 16px 48px;
  box-sizing: border-box;
}
body {
  max-width: 760px !important;
  min-height: calc(100vh - 68px);
  margin: 0 auto !important;
  padding: 36px 44px !important;
  background: ${c.paperBg} !important;
  border-radius: 14px;
  box-shadow: ${c.paperShadow};
  box-sizing: border-box;
}
@media (max-width: 640px) {
  html { padding: 10px 8px 32px; }
  body { padding: 20px 18px !important; border-radius: 10px; }
}
.bs-rev-del {
  background: ${c.errBg};
  color: ${c.errFg};
  text-decoration: line-through;
  text-decoration-thickness: 1.5px;
  padding: 0 3px;
  border-radius: 3px;
}
.bs-rev-ins {
  background: ${c.okBg};
  color: ${c.okFg};
  text-decoration: underline;
  text-decoration-thickness: 1.5px;
  text-underline-offset: 2px;
  padding: 0 3px;
  border-radius: 3px;
}
.bs-rev-fmt-changed {
  background: ${c.okBg};
  color: ${c.text};
  border-bottom: 1.5px dashed ${c.okFg};
  padding: 0 2px;
  border-radius: 3px;
}
[data-bs-rev="added"] {
  background: ${c.okBg};
  border-radius: 6px;
  padding: 6px 10px !important;
}
[data-bs-rev="removed"] {
  background: ${c.errBg};
  border-radius: 6px;
  padding: 6px 10px !important;
  text-decoration: line-through;
}
[data-bs-rev="attr"] {
  outline: 1.5px dashed ${c.warnFg};
  outline-offset: 3px;
  border-radius: 6px;
}
[data-bs-rev="skipped"],
[data-bs-rev="rejected"] {
  background: ${c.surfaceRaised};
  border-radius: 6px;
  padding: 4px 8px !important;
  color: ${c.textMuted};
}
[data-bs-rev="accepted"]:not(blockquote) {
  border-radius: 6px;
}
[data-bs-hunk][data-bs-active="true"] {
  outline: 2px solid ${c.accent} !important;
  outline-offset: 4px;
  border-radius: 6px;
}
.bs-rev-block {
  margin: 12px 0;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid ${c.border};
}
.bs-rev-block.is-added {
  background: ${c.okBg};
  border-color: ${c.okFg};
}
.bs-rev-block.is-removed {
  background: ${c.errBg};
  border-color: ${c.errFg};
}
.bs-rev-block.is-skipped {
  background: ${c.surfaceRaised};
  border-color: ${c.border};
  color: ${c.textMuted};
}
.bs-rev-block.is-accepted {
  background: ${c.paperBg};
  border-color: ${c.border};
}
.bs-rev-block.is-replaced {
  background: ${c.surfaceRaised};
  border-color: ${c.borderStrong};
}
.bs-rev-block-bar,
.bs-rev-container-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
  font-size: 12px;
  line-height: 1.4;
}
.bs-rev-container-bar .bs-rev-controls,
.bs-rev-block-bar .bs-rev-controls,
.bs-rev-seam .bs-rev-controls {
  margin-left: 0;
}
.bs-rev-seam {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 6px 0;
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px dashed ${c.warnFg};
  background: ${c.warnBg};
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
  font-size: 12px;
  line-height: 1.4;
}
.bs-rev-seam.is-accepted,
.bs-rev-seam.is-rejected {
  border-color: ${c.border};
  background: ${c.surfaceRaised};
}
.bs-rev-minidiff {
  margin: 6px 0 8px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid ${c.border};
  background: ${c.surfaceRaised};
  color: ${c.text};
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK SC", monospace;
  font-size: 11.5px;
  line-height: 1.5;
  max-height: 220px;
  overflow: auto;
  text-decoration: none !important;
}
.bs-rev-minidiff-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 1px 4px;
  border-radius: 3px;
  white-space: pre-wrap;
  word-break: break-all;
}
.bs-rev-minidiff-line.is-add {
  background: ${c.okBg};
  color: ${c.okFg};
}
.bs-rev-minidiff-line.is-del {
  background: ${c.errBg};
  color: ${c.errFg};
}
.bs-rev-minidiff-line.is-same {
  color: ${c.textMuted};
}
.bs-rev-minidiff-sign {
  flex: 0 0 10px;
  user-select: none;
  font-weight: 600;
}
.bs-rev-minidiff-code {
  flex: 1;
  min-width: 0;
}
.bs-rev-minidiff-del {
  background: ${c.errBg};
  color: ${c.errFg};
  text-decoration: line-through;
  border-radius: 2px;
  padding: 0 2px;
}
.bs-rev-minidiff-ins {
  background: ${c.okBg};
  color: ${c.okFg};
  text-decoration: underline;
  border-radius: 2px;
  padding: 0 2px;
}
.bs-rev-minidiff-more {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px dashed ${c.border};
  color: ${c.textMuted};
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
  font-size: 11px;
}
.bs-rev-note {
  font-size: 11px;
  color: ${c.textMuted};
  font-weight: 400;
}
.bs-rev-compare-before,
.bs-rev-compare-after {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
}
.bs-rev-compare-before {
  background: ${c.errBg};
  margin-bottom: 6px;
}
.bs-rev-compare-after {
  background: ${c.okBg};
}
.bs-rev-side-tag {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 4px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.5;
}
.bs-rev-side-tag.is-del {
  background: ${c.paperBg};
  color: ${c.errFg};
}
.bs-rev-side-tag.is-add {
  background: ${c.paperBg};
  color: ${c.okFg};
}
.bs-rev-side-body {
  flex: 1;
  min-width: 0;
}
.bs-rev-side-body > :first-child { margin-top: 0; }
.bs-rev-side-body > :last-child { margin-bottom: 0; }
.bs-rev-controls {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  margin-left: 8px;
  vertical-align: middle;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.3;
  text-decoration: none !important;
  user-select: none;
}
.bs-rev-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}
.bs-rev-badge.is-add {
  background: ${c.okBg};
  color: ${c.okFg};
}
.bs-rev-badge.is-del {
  background: ${c.errBg};
  color: ${c.errFg};
}
.bs-rev-badge.is-attr {
  background: ${c.warnBg};
  color: ${c.warnFg};
}
.bs-rev-badge.is-skipped,
.bs-rev-badge.is-rejected {
  background: ${c.surfaceRaised};
  color: ${c.textMuted};
  border: 1px solid ${c.border};
}
.bs-rev-badge.is-accepted {
  background: ${c.okBg};
  color: ${c.okFg};
}
.bs-rev-btn {
  appearance: none;
  border: 1px solid ${c.borderStrong};
  background: ${c.paperBg};
  color: ${c.text};
  border-radius: 999px;
  padding: 1px 8px;
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.5;
  cursor: pointer;
}
.bs-rev-btn:hover {
  border-color: ${c.accent};
  color: ${c.accent};
}
.bs-rev-btn.is-diff.on {
  background: ${c.accentSubtle};
  border-color: ${c.accent};
  color: ${c.accent};
}
.bs-rev-btn.is-accept {
  background: ${c.okBg};
  border-color: ${c.okFg};
  color: ${c.okFg};
  font-weight: 600;
}
.bs-rev-btn.is-accept:hover {
  filter: brightness(0.96);
}
.bs-rev-btn.is-reject {
  background: ${c.errBg};
  border-color: ${c.errFg};
  color: ${c.errFg};
}
.bs-rev-btn.is-reject:hover {
  filter: brightness(0.96);
}
.bs-rev-btn.is-restore {
  background: ${c.accentSubtle};
  border-color: ${c.accent};
  color: ${c.accent};
}
.bs-rev-btn.is-undo {
  background: ${c.surfaceRaised};
  border-color: ${c.border};
  color: ${c.textMuted};
}
.bs-rev-btn.is-undo:hover {
  border-color: ${c.accent};
  color: ${c.accent};
}
.bs-rev-skipped-placeholder,
.bs-rev-resolved-placeholder {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 8px 0;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px dashed ${c.borderStrong};
  background: ${c.surfaceRaised};
  color: ${c.textMuted};
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
  font-size: 12px;
}
.bs-rev-resolved-placeholder.is-accepted {
  border-style: solid;
  border-color: ${c.border};
  background: ${c.paperBg};
}
`
}
