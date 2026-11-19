import type { XmlCodec } from './xml'

export const OPF_NS = 'http://www.idpf.org/2007/opf'
export const DC_NS = 'http://purl.org/dc/elements/1.1/'

export interface MetadataDraft {
  title: string
  creators: string[]
  language: string
  identifier: string
  publisher: string
  date: string
  description: string
  subjects: string[]
  rights: string
}

function metadataElement(doc: Document): Element | null {
  return doc.getElementsByTagNameNS(OPF_NS, 'metadata')[0] ?? null
}

function single(doc: Document, metadata: Element, name: string): Element {
  const existing = doc.getElementsByTagNameNS(DC_NS, name)[0]
  if (existing) return existing
  const created = doc.createElementNS(DC_NS, `dc:${name}`)
  metadata.appendChild(created)
  return created
}

/** Replaces a repeated dc element (creator/subject) set, keeping ids and refines for kept entries. */
function repeated(doc: Document, metadata: Element, name: string, values: string[]): void {
  const nodes = Array.from(doc.getElementsByTagNameNS(DC_NS, name))
  const trimmed = values.map((value) => value.trim()).filter(Boolean)

  for (let index = 0; index < Math.max(nodes.length, trimmed.length); index += 1) {
    const node = nodes[index]
    const value = trimmed[index]
    if (node && value === undefined) {
      const id = node.getAttribute('id')
      if (id) {
        for (const meta of Array.from(doc.getElementsByTagNameNS(OPF_NS, 'meta'))) {
          if (meta.getAttribute('refines') === `#${id}`) meta.parentNode?.removeChild(meta)
        }
      }
      node.parentNode?.removeChild(node)
      continue
    }
    if (node && value !== undefined) {
      node.textContent = value
      continue
    }
    if (!node && value !== undefined) {
      const created = doc.createElementNS(DC_NS, `dc:${name}`)
      created.textContent = value
      metadata.appendChild(created)
    }
  }
}

export interface ManifestItemDraft {
  id: string
  href: string
  mediaType: string
}

/** Appends a manifest item (imported image, font…) without touching existing entries. */
export function addManifestItem(xml: string, item: ManifestItemDraft, codec: XmlCodec): string {
  const doc = codec.parse(xml)
  const manifest = doc.getElementsByTagNameNS(OPF_NS, 'manifest')[0]
  if (!manifest) throw new Error('OPF has no <manifest> element')

  const existing = Array.from(doc.getElementsByTagNameNS(OPF_NS, 'item')).map((entry) => entry.getAttribute('id'))
  let id = item.id
  let suffix = 1
  while (existing.includes(id)) {
    id = `${item.id}_${suffix}`
    suffix += 1
  }

  const element = doc.createElementNS(OPF_NS, 'item')
  element.setAttribute('id', id)
  element.setAttribute('href', item.href)
  element.setAttribute('media-type', item.mediaType)
  manifest.appendChild(element)

  return codec.serialize(doc)
}

/**
 * Rewrites only the dc:* values the form owns. Everything else in the OPF —
 * unique-identifier, manifest order, spine, refines metadata — is left untouched,
 * so editing a title never reshuffles the package document.
 * See ADR 2026-11-19-epub-editor-mvp.
 */
export function writeOpfMetadata(xml: string, draft: MetadataDraft, codec: XmlCodec): string {
  const doc = codec.parse(xml)
  const metadata = metadataElement(doc)
  if (!metadata) throw new Error('OPF has no <metadata> element')

  single(doc, metadata, 'title').textContent = draft.title
  single(doc, metadata, 'language').textContent = draft.language
  single(doc, metadata, 'identifier').textContent = draft.identifier
  single(doc, metadata, 'publisher').textContent = draft.publisher
  single(doc, metadata, 'date').textContent = draft.date
  single(doc, metadata, 'description').textContent = draft.description
  single(doc, metadata, 'rights').textContent = draft.rights

  repeated(doc, metadata, 'creator', draft.creators)
  repeated(doc, metadata, 'subject', draft.subjects)

  return codec.serialize(doc)
}
