import { isIslandTagName } from './wysiwygXhtml'

export type BlockTag = 'p' | 'h1' | 'h2' | 'h3' | 'h4'
export type InlineTag = 'strong' | 'em' | 'code' | 'sup' | 'sub'

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'blockquote', 'li', 'pre'])
const CONVERTIBLE_BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div'])
const INLINE_FORMAT_TAGS = new Set(['strong', 'b', 'em', 'i', 'code', 'sup', 'sub', 'u', 's'])
const INLINE_EQUIVALENTS: Record<InlineTag, string[]> = {
  strong: ['strong', 'b'],
  em: ['em', 'i'],
  code: ['code'],
  sup: ['sup'],
  sub: ['sub'],
}

export function findAncestor(
  node: Node | null,
  boundary: Element,
  predicate: (el: Element) => boolean,
): Element | null {
  let current: Node | null = node
  while (current && current !== boundary) {
    if (current.nodeType === 1 && predicate(current as Element)) {
      return current as Element
    }
    current = current.parentNode
  }
  return null
}

export function findIslandAncestor(node: Node | null, body: Element): Element | null {
  return findAncestor(
    node,
    body,
    (el) => el.hasAttribute('data-booksmith-island') || isIslandTagName(el.tagName),
  )
}

export function findBlockAncestor(node: Node | null, body: Element): Element | null {
  return findAncestor(node, body, (el) => BLOCK_TAGS.has(el.tagName.toLowerCase()))
}

export function currentBlockTag(selection: Selection | null, body: Element): BlockTag | 'other' {
  if (!selection || selection.rangeCount === 0) return 'p'
  const block = findBlockAncestor(selection.anchorNode, body)
  if (!block) return 'p'
  const tag = block.tagName.toLowerCase()
  if (tag === 'p' || tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') return tag
  return 'other'
}

export function isInlineActive(selection: Selection | null, body: Element, tag: InlineTag): boolean {
  if (!selection || selection.rangeCount === 0) return false
  const names = INLINE_EQUIVALENTS[tag]
  return Boolean(findAncestor(selection.anchorNode, body, (el) => names.includes(el.tagName.toLowerCase())))
}

/** Converts the block containing the caret/selection to `p` or `h1`–`h4`, keeping existing attributes. */
export function setBlockTag(doc: Document, selection: Selection, body: Element, targetTag: BlockTag): boolean {
  if (selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  const block = findBlockAncestor(range.startContainer, body)

  if (!block) {
    // Bare inline text directly inside <body> or <section>: wrap current line/node cleanly.
    const container = doc.createElement(targetTag)
    if (!range.collapsed) {
      container.appendChild(range.extractContents())
      range.insertNode(container)
    } else {
      container.appendChild(doc.createElement('br'))
      range.insertNode(container)
    }
    const nextRange = doc.createRange()
    nextRange.selectNodeContents(container)
    nextRange.collapse(false)
    selection.removeAllRanges()
    selection.addRange(nextRange)
    return true
  }

  const currentTag = block.tagName.toLowerCase()
  if (currentTag === targetTag) return false
  if (!CONVERTIBLE_BLOCK_TAGS.has(currentTag)) return false

  const replacement = doc.createElement(targetTag)
  for (const attr of Array.from(block.attributes)) {
    replacement.setAttribute(attr.name, attr.value)
  }
  while (block.firstChild) {
    replacement.appendChild(block.firstChild)
  }
  block.parentNode?.replaceChild(replacement, block)

  const nextRange = doc.createRange()
  nextRange.selectNodeContents(replacement)
  nextRange.collapse(false)
  selection.removeAllRanges()
  selection.addRange(nextRange)
  return true
}

function unwrapElement(el: Element): void {
  const parent = el.parentNode
  if (!parent) return
  while (el.firstChild) {
    parent.insertBefore(el.firstChild, el)
  }
  parent.removeChild(el)
}

/** Splits an inline ancestor at the range boundary when only a slice of it should be unwrapped. */
function unwrapRangeFromTag(doc: Document, selection: Selection, body: Element, tagNames: string[]): boolean {
  if (selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  const ancestor = findAncestor(range.commonAncestorContainer, body, (el) =>
    tagNames.includes(el.tagName.toLowerCase()),
  )
  if (!ancestor) return false

  if (range.collapsed) {
    unwrapElement(ancestor)
    return true
  }

  const beforeRange = doc.createRange()
  beforeRange.setStart(ancestor, 0)
  beforeRange.setEnd(range.startContainer, range.startOffset)
  const beforeFrag = beforeRange.extractContents()

  const selectedFrag = range.extractContents()

  const afterRange = doc.createRange()
  afterRange.selectNodeContents(ancestor)
  const afterFrag = afterRange.extractContents()

  const parent = ancestor.parentNode
  if (!parent) return false

  if (beforeFrag.textContent || beforeFrag.querySelector?.('*')) {
    const beforeEl = doc.createElement(ancestor.tagName.toLowerCase())
    beforeEl.appendChild(beforeFrag)
    parent.insertBefore(beforeEl, ancestor)
  }

  const insertedNodes = Array.from(selectedFrag.childNodes)
  parent.insertBefore(selectedFrag, ancestor)

  if (afterFrag.textContent || afterFrag.querySelector?.('*')) {
    const afterEl = doc.createElement(ancestor.tagName.toLowerCase())
    afterEl.appendChild(afterFrag)
    parent.insertBefore(afterEl, ancestor)
  }

  parent.removeChild(ancestor)

  if (insertedNodes.length > 0) {
    const nextRange = doc.createRange()
    nextRange.setStartBefore(insertedNodes[0]!)
    nextRange.setEndAfter(insertedNodes[insertedNodes.length - 1]!)
    selection.removeAllRanges()
    selection.addRange(nextRange)
  }
  return true
}

export function toggleInlineFormat(doc: Document, selection: Selection, body: Element, tag: InlineTag): boolean {
  if (selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  if (findIslandAncestor(range.commonAncestorContainer, body)) return false

  const equivalents = INLINE_EQUIVALENTS[tag]
  const existing = findAncestor(range.commonAncestorContainer, body, (el) =>
    equivalents.includes(el.tagName.toLowerCase()),
  )
  if (existing) {
    return unwrapRangeFromTag(doc, selection, body, equivalents)
  }

  if (range.collapsed) return false

  // Remove nested duplicates of the same tag before wrapping.
  const fragment = range.extractContents()
  const wrapper = doc.createElement(tag)
  wrapper.appendChild(fragment)
  for (const nested of Array.from(wrapper.querySelectorAll(equivalents.join(',')))) {
    unwrapElement(nested)
  }
  range.insertNode(wrapper)

  const nextRange = doc.createRange()
  nextRange.selectNodeContents(wrapper)
  selection.removeAllRanges()
  selection.addRange(nextRange)
  return true
}

export function clearInlineFormatting(selection: Selection, body: Element): boolean {
  if (selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  if (findIslandAncestor(range.commonAncestorContainer, body)) return false

  if (range.collapsed) {
    let changed = false
    let ancestor = findAncestor(range.startContainer, body, (el) =>
      INLINE_FORMAT_TAGS.has(el.tagName.toLowerCase()),
    )
    while (ancestor) {
      unwrapElement(ancestor)
      changed = true
      ancestor = findAncestor(range.startContainer, body, (el) =>
        INLINE_FORMAT_TAGS.has(el.tagName.toLowerCase()),
      )
    }
    return changed
  }

  const fragment = range.extractContents()
  const scratch = body.ownerDocument.createElement('div')
  scratch.appendChild(fragment)
  for (const el of Array.from(scratch.querySelectorAll(Array.from(INLINE_FORMAT_TAGS).join(',')))) {
    unwrapElement(el)
  }
  const cleanFrag = body.ownerDocument.createDocumentFragment()
  while (scratch.firstChild) cleanFrag.appendChild(scratch.firstChild)
  const first = cleanFrag.firstChild
  const last = cleanFrag.lastChild
  range.insertNode(cleanFrag)

  if (first && last) {
    const nextRange = body.ownerDocument.createRange()
    nextRange.setStartBefore(first)
    nextRange.setEndAfter(last)
    selection.removeAllRanges()
    selection.addRange(nextRange)
  }
  return true
}

export function applyLink(doc: Document, selection: Selection, body: Element, href: string): boolean {
  const trimmed = href.trim()
  if (!trimmed) return false
  if (selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  if (findIslandAncestor(range.commonAncestorContainer, body)) return false

  const existing = findAncestor(range.commonAncestorContainer, body, (el) => el.tagName.toLowerCase() === 'a')
  if (existing) {
    existing.setAttribute('href', trimmed)
    return true
  }

  const anchor = doc.createElement('a')
  anchor.setAttribute('href', trimmed)
  if (range.collapsed) {
    anchor.textContent = trimmed
    range.insertNode(anchor)
  } else {
    anchor.appendChild(range.extractContents())
    range.insertNode(anchor)
  }

  const nextRange = doc.createRange()
  nextRange.selectNodeContents(anchor)
  selection.removeAllRanges()
  selection.addRange(nextRange)
  return true
}

export function removeAnchor(anchor: Element): boolean {
  if (!anchor.parentNode) return false
  unwrapElement(anchor)
  return true
}

export function insertImageAtRange(
  doc: Document,
  range: Range,
  blobUrl: string,
  relativeSrc: string,
  alt: string,
): HTMLImageElement {
  const img = doc.createElement('img')
  img.setAttribute('src', blobUrl)
  img.setAttribute('data-booksmith-src', relativeSrc)
  img.setAttribute('alt', alt)
  range.deleteContents()
  range.insertNode(img)
  const nextRange = doc.createRange()
  nextRange.setStartAfter(img)
  nextRange.collapse(true)
  const selection = doc.defaultView?.getSelection()
  if (selection) {
    selection.removeAllRanges()
    selection.addRange(nextRange)
  }
  return img
}

/** Keeps Enter at the end of a heading creating a clean `<p>` rather than a bare `<div>`. */
export function splitHeadingOnEnter(doc: Document, selection: Selection, body: Element): boolean {
  if (selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  if (!range.collapsed) return false
  const block = findBlockAncestor(range.startContainer, body)
  if (!block || !/^h[1-6]$/i.test(block.tagName)) return false

  const tailRange = doc.createRange()
  tailRange.setStart(range.startContainer, range.startOffset)
  tailRange.setEnd(block, block.childNodes.length)
  if (tailRange.toString().length > 0) return false

  const paragraph = doc.createElement('p')
  paragraph.appendChild(doc.createElement('br'))
  block.parentNode?.insertBefore(paragraph, block.nextSibling)

  const nextRange = doc.createRange()
  nextRange.setStart(paragraph, 0)
  nextRange.collapse(true)
  selection.removeAllRanges()
  selection.addRange(nextRange)
  return true
}
