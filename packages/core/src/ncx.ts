import { elementChildrenOf, type TocEntry } from './toc'
import type { XmlCodec } from './xml'

const NCX_NS = 'http://www.daisy.org/z3986/2005/ncx/'

function readNavPoints(parent: Element): TocEntry[] {
  return elementChildrenOf(parent)
    .filter((child) => child.tagName === 'navPoint')
    .map((navPoint) => {
      const kids = elementChildrenOf(navPoint)
      const label = kids.find((child) => child.tagName === 'navLabel')
      const text = label ? elementChildrenOf(label).find((child) => child.tagName === 'text') : undefined
      const content = kids.find((child) => child.tagName === 'content')
      return {
        label: text?.textContent?.trim() ?? '',
        href: content?.getAttribute('src') ?? '',
        children: readNavPoints(navPoint),
      }
    })
}

export function readNcxToc(xml: string, codec: XmlCodec): TocEntry[] {
  const doc = codec.parse(xml)
  const navMap = doc.getElementsByTagNameNS(NCX_NS, 'navMap')[0] ?? doc.getElementsByTagName('navMap')[0]
  return navMap ? readNavPoints(navMap) : []
}

function buildNavPoints(doc: Document, entries: TocEntry[], counter: { value: number }): Element[] {
  return entries.map((entry) => {
    counter.value += 1
    const navPoint = doc.createElementNS(NCX_NS, 'navPoint')
    navPoint.setAttribute('id', `navPoint-${counter.value}`)
    navPoint.setAttribute('playOrder', String(counter.value))

    const navLabel = doc.createElementNS(NCX_NS, 'navLabel')
    const text = doc.createElementNS(NCX_NS, 'text')
    text.textContent = entry.label
    navLabel.appendChild(text)
    navPoint.appendChild(navLabel)

    const content = doc.createElementNS(NCX_NS, 'content')
    content.setAttribute('src', entry.href)
    navPoint.appendChild(content)

    for (const child of buildNavPoints(doc, entry.children, counter)) navPoint.appendChild(child)
    return navPoint
  })
}

/** Rebuilds navMap to mirror the nav document. */
export function writeNcxToc(xml: string, entries: TocEntry[], codec: XmlCodec): string {
  const doc = codec.parse(xml)
  const navMap = doc.getElementsByTagNameNS(NCX_NS, 'navMap')[0] ?? doc.getElementsByTagName('navMap')[0]
  if (!navMap) throw new Error('ncx document has no <navMap>')

  while (navMap.firstChild) navMap.removeChild(navMap.firstChild)
  const counter = { value: 0 }
  for (const navPoint of buildNavPoints(doc, entries, counter)) navMap.appendChild(navPoint)

  return codec.serialize(doc)
}
