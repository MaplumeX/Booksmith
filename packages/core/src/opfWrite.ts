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

export interface OpfMetaRow {
  /** `property` for EPUB 3 (`dcterms:modified`), `name` for legacy (`cover`). */
  property: string
  /** `#id` this row refines, or empty. */
  refines: string
  value: string
}

function metaProperty(element: Element): string {
  return element.getAttribute('property') ?? element.getAttribute('name') ?? ''
}

function isLegacyRow(property: string): boolean {
  return !property.includes(':')
}

/** Every `<meta>` in the package document, in document order. */
export function readOpfMeta(xml: string, codec: XmlCodec): OpfMetaRow[] {
  const doc = codec.parse(xml)
  return Array.from(doc.getElementsByTagNameNS(OPF_NS, 'meta')).map((element) => ({
    property: metaProperty(element),
    refines: element.getAttribute('refines') ?? '',
    value: element.getAttribute('content') ?? element.textContent?.trim() ?? '',
  }))
}

/**
 * Rewrites the `<meta>` set from an edited table. Rows are paired with existing elements by
 * `property` + `refines`, so untouched rows keep their attributes and document position.
 * See ADR 2026-11-19-opf-meta-editing.
 */
export function writeOpfMeta(xml: string, rows: OpfMetaRow[], codec: XmlCodec): string {
  const doc = codec.parse(xml)
  const metadata = metadataElement(doc)
  if (!metadata) throw new Error('OPF has no <metadata> element')

  const existing = Array.from(doc.getElementsByTagNameNS(OPF_NS, 'meta'))
  const used = new Set<Element>()

  for (const row of rows) {
    const property = row.property.trim()
    if (!property) continue
    const refines = row.refines.trim()

    const match = existing.find(
      (element) =>
        !used.has(element) && metaProperty(element) === property && (element.getAttribute('refines') ?? '') === refines,
    )

    if (match) {
      used.add(match)
      if (match.getAttribute('name') && !match.getAttribute('property')) match.setAttribute('content', row.value)
      else match.textContent = row.value
      continue
    }

    const created = doc.createElementNS(OPF_NS, 'meta')
    if (isLegacyRow(property)) {
      created.setAttribute('name', property)
      created.setAttribute('content', row.value)
    } else {
      created.setAttribute('property', property)
      created.textContent = row.value
    }
    if (refines) created.setAttribute('refines', refines)
    metadata.appendChild(created)
  }

  for (const element of existing) {
    if (!used.has(element)) element.parentNode?.removeChild(element)
  }

  return codec.serialize(doc)
}

/**
 * Sets `dcterms:modified`, the one metadata field EPUB 3 expects to track the last edit.
 * Called only when the package document itself is being saved: touching it on every save would
 * make an unchanged book a new revision and push real history out of the snapshot cap.
 * See ADR 2026-11-19-opf-meta-editing.
 */
export function touchOpfModified(xml: string, timestamp: string, codec: XmlCodec): string {
  const doc = codec.parse(xml)
  const meta = Array.from(doc.getElementsByTagNameNS(OPF_NS, 'meta')).find(
    (element) => metaProperty(element) === 'dcterms:modified',
  )
  if (!meta) return xml
  if (meta.textContent?.trim() === timestamp) return xml
  meta.textContent = timestamp
  return codec.serialize(doc)
}
