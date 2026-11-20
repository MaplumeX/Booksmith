const HTML_NS = 'http://www.w3.org/1999/xhtml'

function syncAttributes(target: Element, next: Element): void {
  for (const attr of Array.from(target.attributes)) {
    const kept = attr.namespaceURI
      ? next.hasAttributeNS(attr.namespaceURI, attr.localName)
      : next.hasAttribute(attr.name)
    if (!kept) {
      if (attr.namespaceURI) target.removeAttributeNS(attr.namespaceURI, attr.localName)
      else target.removeAttribute(attr.name)
    }
  }

  for (const attr of Array.from(next.attributes)) {
    const current = attr.namespaceURI
      ? target.getAttributeNS(attr.namespaceURI, attr.localName)
      : target.getAttribute(attr.name)
    if (current !== attr.value) {
      if (attr.namespaceURI) target.setAttributeNS(attr.namespaceURI, attr.name, attr.value)
      else target.setAttribute(attr.name, attr.value)
    }
  }
}

function patchNode(targetDoc: Document, target: ChildNode, next: ChildNode): void {
  if (target.isEqualNode(next)) return

  if (target.nodeType === next.nodeType) {
    if (target.nodeType === Node.TEXT_NODE || target.nodeType === Node.COMMENT_NODE) {
      if (target.nodeValue !== next.nodeValue) {
        target.nodeValue = next.nodeValue
      }
      return
    }

    if (target.nodeType === Node.ELEMENT_NODE) {
      const targetEl = target as Element
      const nextEl = next as Element
      if (
        targetEl.namespaceURI === HTML_NS &&
        nextEl.namespaceURI === HTML_NS &&
        targetEl.localName === nextEl.localName
      ) {
        syncAttributes(targetEl, nextEl)
        syncChildren(targetDoc, targetEl, nextEl)
        return
      }
    }
  }

  target.replaceWith(targetDoc.importNode(next, true))
}

/**
 * Morphs `targetParent`'s child list to match `nextParent` in place.
 *
 * Trimming the shared prefix and suffix keeps untouched paragraphs, images,
 * stylesheets, and MathML/SVG islands at their existing DOM nodes so edits
 * never trigger a full repaint, image reload, or scroll jump.
 */
export function syncChildren(targetDoc: Document, targetParent: Node, nextParent: Node): void {
  const targetChildren = Array.from(targetParent.childNodes)
  const nextChildren = Array.from(nextParent.childNodes)

  let start = 0
  let targetEnd = targetChildren.length - 1
  let nextEnd = nextChildren.length - 1

  while (start <= targetEnd && start <= nextEnd && targetChildren[start]!.isEqualNode(nextChildren[start]!)) {
    start += 1
  }

  while (targetEnd >= start && nextEnd >= start && targetChildren[targetEnd]!.isEqualNode(nextChildren[nextEnd]!)) {
    targetEnd -= 1
    nextEnd -= 1
  }

  const overlap = Math.min(targetEnd - start + 1, nextEnd - start + 1)
  for (let i = 0; i < overlap; i += 1) {
    patchNode(targetDoc, targetChildren[start + i]!, nextChildren[start + i]!)
  }

  const anchor = targetChildren[targetEnd + 1] ?? null
  for (let i = start + overlap; i <= nextEnd; i += 1) {
    targetParent.insertBefore(targetDoc.importNode(nextChildren[i]!, true), anchor)
  }

  for (let i = start + overlap; i <= targetEnd; i += 1) {
    targetChildren[i]!.remove()
  }
}

/** Patches only `<head>` (stylesheets, meta, title) inside an existing iframe document. */
export function patchHead(targetDoc: Document, nextDoc: Document): void {
  if (!targetDoc.head || !nextDoc.head) return
  syncAttributes(targetDoc.head, nextDoc.head)
  syncChildren(targetDoc, targetDoc.head, nextDoc.head)
}

/**
 * Patches an existing iframe document in place to match `nextDoc` without
 * reassigning `iframe.srcDoc`, eliminating full-document navigation flashes.
 */
export function patchDocument(targetDoc: Document, nextDoc: Document): void {
  if (targetDoc.documentElement && nextDoc.documentElement) {
    syncAttributes(targetDoc.documentElement, nextDoc.documentElement)
  }
  patchHead(targetDoc, nextDoc)
  if (targetDoc.body && nextDoc.body) {
    syncAttributes(targetDoc.body, nextDoc.body)
    syncChildren(targetDoc, targetDoc.body, nextDoc.body)
  }
}
