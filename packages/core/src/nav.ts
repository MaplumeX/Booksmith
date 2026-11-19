import { elementChildrenOf, type TocEntry } from './toc'
import type { XmlCodec } from './xml'

function isTocNav(nav: Element): boolean {
  const type = nav.getAttribute('epub:type') ?? nav.getAttribute('type') ?? ''
  return type.split(/\s+/).includes('toc')
}

function readOl(ol: Element, codec: XmlCodec): TocEntry[] {
  return elementChildrenOf(ol)
    .filter((child) => child.tagName === 'li')
    .map((li) => {
      const kids = elementChildrenOf(li)
      const anchor = kids.find((child) => child.tagName === 'a')
      const sublist = kids.find((child) => child.tagName === 'ol')
      return {
        label: anchor?.textContent?.trim() ?? '',
        href: anchor?.getAttribute('href') ?? '',
        rawHtml: anchor ? innerXml(anchor, codec) : '',
        children: sublist ? readOl(sublist, codec) : [],
      }
    })
}

function innerXml(node: Element, codec: XmlCodec): string {
  let out = ''
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes.item(index)
    if (child) out += codec.serialize(child)
  }
  return out
}

export function readNavToc(xhtml: string, codec: XmlCodec): TocEntry[] {
  const doc = codec.parse(xhtml)
  const navs = Array.from(doc.getElementsByTagName('nav'))
  const tocNav = navs.find(isTocNav) ?? navs[0]
  if (!tocNav) return []
  const ol = elementChildrenOf(tocNav).find((child) => child.tagName === 'ol')
  return ol ? readOl(ol, codec) : []
}

function parseFragment(markup: string, codec: XmlCodec): Node[] {
  const wrapped = codec.parse(
    `<wrapper xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:m="http://www.w3.org/1998/Math/MathML">${markup}</wrapper>`,
  )
  const root = wrapped.documentElement
  if (!root) return []
  const nodes: Node[] = []
  for (let index = 0; index < root.childNodes.length; index += 1) {
    const child = root.childNodes.item(index)
    if (child) nodes.push(child)
  }
  return nodes
}

function buildOl(doc: Document, entries: TocEntry[], codec: XmlCodec, clone: (node: Node) => Node): Element {
  const ol = doc.createElement('ol')
  ol.setAttribute('class', 'toc')

  for (const entry of entries) {
    const li = doc.createElement('li')
    const anchor = doc.createElement('a')
    anchor.setAttribute('href', entry.href)

    const keepMarkup = entry.rawHtml && entry.rawHtml.trim().length > 0 && entry.rawHtml.includes('<')
    if (keepMarkup) {
      for (const child of parseFragment(entry.rawHtml ?? '', codec)) anchor.appendChild(clone(child))
    } else {
      anchor.textContent = entry.label
    }

    li.appendChild(anchor)
    if (entry.children.length > 0) li.appendChild(buildOl(doc, entry.children, codec, clone))
    ol.appendChild(li)
  }

  return ol
}

/**
 * Rebuilds the toc nav from an edited tree. Other navs (landmarks) and the head are
 * left alone; only the toc list is replaced.
 */
export function writeNavToc(xhtml: string, entries: TocEntry[], codec: XmlCodec): string {
  const doc = codec.parse(xhtml)
  const navs = Array.from(doc.getElementsByTagName('nav'))
  const tocNav = navs.find(isTocNav) ?? navs[0]
  if (!tocNav) throw new Error('nav document has no <nav>')

  const existing = elementChildrenOf(tocNav).find((child) => child.tagName === 'ol')
  const built = buildOl(doc, entries, codec, (node) => doc.importNode(node, true))

  if (existing) tocNav.replaceChild(built, existing)
  else tocNav.appendChild(built)

  return codec.serialize(doc)
}
