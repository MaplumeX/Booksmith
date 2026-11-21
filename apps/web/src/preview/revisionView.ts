import { diffChars } from '../diff/document'
import { normalizeEol } from '../editor/eol'
import { extractBodyRange } from '../editor/wysiwygXhtml'
import type { FileDiffModel, ProposalHunk } from '../state/proposalReview'

/**
 * Pure XHTML revision annotator for real book-page review rendering.
 *
 * Maps source-level `ProposalHunk`s directly onto the chapter's rendered `<body>` so the
 * book-page "修订" view and source diff view share identical hunk IDs and skip states,
 * while feeding back into `buildPreviewDocument` to preserve author CSS, images, fonts,
 * MathML islands, and dark-mode adaptation.
 * See ADR 2026-11-21-in-canvas-agent-proposal-review.
 */

export interface RevisionXhtmlOptions {
  model: FileDiffModel
  skippedHunkIds?: ReadonlySet<string>
  allowHunkToggle: boolean
  activeHunkId?: string | null
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

const ISLAND_TAG_RE = /<(?:math|svg|img|video|audio|table)\b/i

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
  return unescapeBasicEntities(html.replace(/<[^>]+>/g, ''))
}

function hasAnyTag(fragment: string): boolean {
  return /<[^>]+>/.test(fragment)
}

function isBalancedMarkup(fragment: string): boolean {
  const stack: string[] = []
  const voidTags = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'col', 'source', 'wbr', 'area', 'base'])
  const tagRe = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)(?:\s[^<>]*?)?(\/?)>/g
  for (const match of fragment.matchAll(tagRe)) {
    const full = match[0]!
    if (full.startsWith('<!--')) continue
    const name = match[1]!.toLowerCase()
    const selfClosing = match[2] === '/' || voidTags.has(name)
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

function injectAttrsIntoOpenTag(openTag: string, attrs: string): string {
  if (openTag.endsWith('/>')) {
    return `${openTag.slice(0, -2)} ${attrs} />`
  }
  return `${openTag.slice(0, -1)} ${attrs}>`
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

/**
 * Attempts structure-preserving inline diff when both fragments share identical inline tag sequences
 * (e.g., `<p>见<em>旧词</em>说明</p>` -> `<p>见<em>新词</em>说明</p>`).
 */
function tryInlineTagAlignedDiff(beforeInner: string, afterInner: string): string | null {
  if (ISLAND_TAG_RE.test(beforeInner) || ISLAND_TAG_RE.test(afterInner)) return null

  const tokenize = (html: string): Array<{ kind: 'tag' | 'text'; value: string }> => {
    const out: Array<{ kind: 'tag' | 'text'; value: string }> = []
    let last = 0
    const re = /<[^>]+>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null) {
      if (m.index > last) out.push({ kind: 'text', value: html.slice(last, m.index) })
      out.push({ kind: 'tag', value: m[0]! })
      last = m.index + m[0]!.length
    }
    if (last < html.length) out.push({ kind: 'text', value: html.slice(last) })
    return out
  }

  const aTokens = tokenize(beforeInner)
  const bTokens = tokenize(afterInner)

  const aTags = aTokens.filter((t) => t.kind === 'tag').map((t) => t.value)
  const bTags = bTokens.filter((t) => t.kind === 'tag').map((t) => t.value)

  // Every inline tag must be safe and the tag sequence must match identically.
  if (aTags.length !== bTags.length) return null
  for (let i = 0; i < aTags.length; i += 1) {
    if (aTags[i] !== bTags[i]) return null
    const nameMatch = /^<\/?([a-zA-Z][\w:-]*)/.exec(aTags[i]!)
    if (!nameMatch || !INLINE_SAFE_TAGS.has(nameMatch[1]!.toLowerCase())) return null
  }

  // Split into interleaved text slots around identical tags.
  const collectSlots = (tokens: Array<{ kind: 'tag' | 'text'; value: string }>): string[] => {
    const slots: string[] = ['']
    for (const tok of tokens) {
      if (tok.kind === 'tag') slots.push('')
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

function renderControlCluster(
  hunkId: string,
  options: { allowToggle: boolean; skipped?: boolean; badge?: { kind: string; label: string }; showSourceBtn?: boolean },
): string {
  const parts: string[] = []
  if (options.badge) {
    parts.push(`<span class="bs-rev-badge is-${options.badge.kind}">${options.badge.label}</span>`)
  }
  if (options.showSourceBtn) {
    parts.push(
      `<button type="button" class="bs-rev-btn is-source" data-bs-action="goto-source" data-bs-target-hunk="${hunkId}">看源码</button>`,
    )
  }
  if (options.allowToggle) {
    parts.push(
      options.skipped
        ? `<button type="button" class="bs-rev-btn is-restore" data-bs-action="toggle-hunk" data-bs-target-hunk="${hunkId}">恢复保留</button>`
        : `<button type="button" class="bs-rev-btn is-skip" data-bs-action="toggle-hunk" data-bs-target-hunk="${hunkId}">跳过</button>`,
    )
  }
  if (parts.length === 0) return ''
  return `<span class="bs-rev-controls" data-bs-ui="true">${parts.join('')}</span>`
}

function renderSingleElementPair(
  beforeEl: SingleElementParts,
  afterEl: SingleElementParts,
  hunkId: string,
  activeAttr: string,
  allowToggle: boolean,
  emitControls: boolean,
): string | null {
  if (beforeEl.tag !== afterEl.tag || !SIMPLE_BLOCK_TAGS.has(beforeEl.tag)) return null
  if (ISLAND_TAG_RE.test(beforeEl.inner) || ISLAND_TAG_RE.test(afterEl.inner)) return null

  // Pure attribute / class / style change where visible prose is unchanged.
  if (stripTags(beforeEl.inner) === stripTags(afterEl.inner) && beforeEl.openTag !== afterEl.openTag) {
    const taggedOpen = injectAttrsIntoOpenTag(
      afterEl.openTag,
      `data-bs-hunk="${hunkId}" data-bs-rev="attr"${activeAttr}`,
    )
    const controls = emitControls
      ? renderControlCluster(hunkId, {
          allowToggle,
          badge: { kind: 'attr', label: '标签/样式变更' },
          showSourceBtn: true,
        })
      : ''
    return `${taggedOpen}${afterEl.inner}${controls}${afterEl.closeTag}`
  }

  const inlineDiff = tryInlineTagAlignedDiff(beforeEl.inner, afterEl.inner)
  if (inlineDiff === null) return null

  const attrAlsoChanged = beforeEl.openTag !== afterEl.openTag
  const taggedOpen = injectAttrsIntoOpenTag(
    afterEl.openTag,
    `data-bs-hunk="${hunkId}" data-bs-rev="inline"${activeAttr}`,
  )
  const controls = emitControls
    ? renderControlCluster(hunkId, {
        allowToggle,
        badge: attrAlsoChanged ? { kind: 'attr', label: '含属性变更' } : undefined,
        showSourceBtn: attrAlsoChanged,
      })
    : ''
  return `${taggedOpen}${inlineDiff}${controls}${afterEl.closeTag}`
}

function renderHunkInBody(
  hunk: ProposalHunk,
  options: { skipped: boolean; allowToggle: boolean; isActive: boolean },
): string {
  const { skipped, allowToggle, isActive } = options
  const beforeFrag = hunk.beforeLines.join('\n')
  const afterFrag = hunk.afterLines.join('\n')
  const activeAttr = isActive ? ' data-bs-active="true"' : ''

  // Skipped state: restore original book prose with a subtle restore pill.
  if (skipped) {
    if (!beforeFrag.trim()) {
      return `<div class="bs-rev-skipped-placeholder" data-bs-hunk="${hunk.id}"${activeAttr} data-bs-ui="true"><span>已跳过此处新增内容</span>${renderControlCluster(hunk.id, { allowToggle, skipped: true })}</div>`
    }
    const singleBefore = parseSingleElement(beforeFrag)
    if (singleBefore && SIMPLE_BLOCK_TAGS.has(singleBefore.tag)) {
      const open = injectAttrsIntoOpenTag(
        singleBefore.openTag,
        `data-bs-hunk="${hunk.id}" data-bs-rev="skipped"${activeAttr}`,
      )
      const controls = renderControlCluster(hunk.id, {
        allowToggle,
        skipped: true,
        badge: { kind: 'skipped', label: '已跳过' },
      })
      return `${open}${singleBefore.inner}${controls}${singleBefore.closeTag}`
    }
    if (isBalancedMarkup(beforeFrag) && !/^<tr[\s>]/i.test(beforeFrag.trim())) {
      return `<div class="bs-rev-block is-skipped" data-bs-hunk="${hunk.id}"${activeAttr}><div class="bs-rev-block-bar" data-bs-ui="true">${renderControlCluster(hunk.id, { allowToggle, skipped: true, badge: { kind: 'skipped', label: '已跳过 · 保留原文' } })}</div>${beforeFrag}</div>`
    }
    return beforeFrag
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
        return `${open}${single.inner}${controls}${single.closeTag}`
      }
      return `<div class="bs-rev-block is-removed" data-bs-hunk="${hunk.id}"${activeAttr}><div class="bs-rev-block-bar" data-bs-ui="true">${renderControlCluster(hunk.id, { allowToggle, badge: { kind: 'del', label: '- 删除内容' } })}</div>${trimmedBefore}</div>`
    }
    if (!hasAnyTag(beforeFrag)) {
      return `<span class="bs-rev-inline-wrap" data-bs-hunk="${hunk.id}"${activeAttr}><del class="bs-rev-del">${escapeHtml(beforeFrag)}</del>${renderControlCluster(hunk.id, { allowToggle })}</span>`
    }
  }

  // Try single-block or equal-count multi-block inline revision.
  const beforeEls = splitTopLevelElements(beforeFrag)
  const afterEls = splitTopLevelElements(afterFrag)
  if (beforeEls && afterEls && beforeEls.length === afterEls.length) {
    const renderedPairs: string[] = []
    let allMatched = true
    for (let i = 0; i < beforeEls.length; i += 1) {
      const rendered = renderSingleElementPair(
        beforeEls[i]!,
        afterEls[i]!,
        hunk.id,
        activeAttr,
        allowToggle,
        i === 0,
      )
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

  // Balanced complex blocks (e.g., MathML / images / tables / tag-level restructure):
  // show clean before-vs-after rendered comparison without corrupting islands.
  if (
    isBalancedMarkup(beforeFrag) &&
    isBalancedMarkup(afterFrag) &&
    !/^<tr[\s>]/i.test(beforeFrag.trim()) &&
    !/^<tr[\s>]/i.test(afterFrag.trim())
  ) {
    const hasIsland = ISLAND_TAG_RE.test(beforeFrag) || ISLAND_TAG_RE.test(afterFrag)
    const label = hasIsland ? '公式/媒体结构变更' : '段落结构变更'
    return [
      `<div class="bs-rev-block is-replaced" data-bs-hunk="${hunk.id}"${activeAttr}>`,
      `<div class="bs-rev-block-bar" data-bs-ui="true">${renderControlCluster(hunk.id, { allowToggle, badge: { kind: 'attr', label }, showSourceBtn: true })}</div>`,
      `<div class="bs-rev-compare-before"><span class="bs-rev-side-tag is-del" data-bs-ui="true">原</span><div class="bs-rev-side-body">${beforeFrag}</div></div>`,
      `<div class="bs-rev-compare-after"><span class="bs-rev-side-tag is-add" data-bs-ui="true">新</span><div class="bs-rev-side-body">${afterFrag}</div></div>`,
      `</div>`,
    ].join('')
  }

  // Fallback for unbalanced partial-tag cross-line edits: keep valid `afterFrag` + jump marker.
  return `${afterFrag}<span class="bs-rev-controls" data-bs-hunk="${hunk.id}"${activeAttr} data-bs-ui="true">${renderControlCluster(hunk.id, { allowToggle, badge: { kind: 'attr', label: '跨行标签变更' }, showSourceBtn: true })}</span>`
}

function lineNumberAtOffset(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

export function buildRevisionXhtml(options: RevisionXhtmlOptions): RevisionXhtmlResult {
  const { model, skippedHunkIds, allowHunkToggle, activeHunkId = null } = options
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
        skipped: Boolean(skippedHunkIds?.has(hunk.id)),
        allowToggle: allowHunkToggle,
        isActive: activeHunkId === hunk.id,
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
        skipped: Boolean(skippedHunkIds?.has(hunk.id)),
        allowToggle: allowHunkToggle,
        isActive: activeHunkId === hunk.id,
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
 * See ADR 2026-11-21-in-canvas-agent-proposal-review.
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
[data-bs-rev="skipped"] {
  background: ${c.surfaceRaised};
  border-radius: 6px;
  padding: 4px 8px !important;
  color: ${c.textMuted};
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
.bs-rev-block.is-replaced {
  background: ${c.surfaceRaised};
  border-color: ${c.borderStrong};
}
.bs-rev-block-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
  font-size: 12px;
  line-height: 1.4;
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
.bs-rev-badge.is-skipped {
  background: ${c.surfaceRaised};
  color: ${c.textMuted};
  border: 1px solid ${c.border};
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
.bs-rev-btn.is-restore {
  background: ${c.accentSubtle};
  border-color: ${c.accent};
  color: ${c.accent};
}
.bs-rev-skipped-placeholder {
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
`
}
