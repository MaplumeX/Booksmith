import { resolvePath } from './path'
import { addManifestItem, OPF_NS, type ManifestItemDraft } from './opfWrite'
import type { XmlCodec } from './xml'

/**
 * Structural edits to the package document: adding, renaming, removing and reordering entries.
 *
 * These touch `<manifest>` and `<spine>` only. Rewriting references inside chapters and the TOC
 * is a separate concern (see `references.ts`), because the OPF is not the only file that names a
 * path. See ADR 2026-11-19-file-structure-editing.
 */

function manifestItems(doc: Document): Element[] {
  return Array.from(doc.getElementsByTagNameNS(OPF_NS, 'item'))
}

function itemrefs(doc: Document): Element[] {
  return Array.from(doc.getElementsByTagNameNS(OPF_NS, 'itemref'))
}

function pathOf(item: Element, baseDir: string): string {
  return resolvePath(baseDir, item.getAttribute('href') ?? '')
}

function spineElement(doc: Document): Element {
  const spine = doc.getElementsByTagNameNS(OPF_NS, 'spine')[0]
  if (!spine) throw new Error('OPF has no <spine> element')
  return spine
}

/** Appends a document to the manifest and to the end of the reading order. The table of contents
 * is left alone: a new chapter should not invent a TOC entry nobody asked for. */
export function addSpineDocument(xml: string, item: ManifestItemDraft, codec: XmlCodec): string {
  const doc = codec.parse(addManifestItem(xml, item, codec))
  const created = manifestItems(doc).find((entry) => entry.getAttribute('href') === item.href)
  if (!created) throw new Error('manifest item was not added')

  const ref = doc.createElementNS(OPF_NS, 'itemref')
  ref.setAttribute('idref', created.getAttribute('id') ?? '')
  spineElement(doc).appendChild(ref)
  return codec.serialize(doc)
}

/** Corrects the declared media type, e.g. after a resource was replaced with a differently encoded file. */
export function setManifestMediaType(
  xml: string,
  path: string,
  mediaType: string,
  baseDir: string,
  codec: XmlCodec,
): string {
  const doc = codec.parse(xml)
  const matches = manifestItems(doc).filter((item) => pathOf(item, baseDir) === path)
  if (matches.length === 0) throw new Error(`manifest has no entry for ${path}`)
  // Skip re-serializing when the media-type already matches so replacing a binary asset does not
  // introduce XML serializer formatting noise and spuriously dirty OPF.
  // See ADR 2026-11-20-baseline-derived-dirty-state.
  if (matches.every((item) => item.getAttribute('media-type') === mediaType)) return xml
  for (const item of matches) item.setAttribute('media-type', mediaType)
  return codec.serialize(doc)
}

/** Points a manifest entry at a new href. The spine refers to the item by id, so it needs no edit. */
export function renameManifestEntry(
  xml: string,
  path: string,
  href: string,
  baseDir: string,
  codec: XmlCodec,
): string {
  const doc = codec.parse(xml)
  const matches = manifestItems(doc).filter((item) => pathOf(item, baseDir) === path)
  if (matches.length === 0) throw new Error(`manifest has no entry for ${path}`)
  for (const item of matches) item.setAttribute('href', href)
  return codec.serialize(doc)
}

/** Removes a manifest entry and every spine reference to it, plus a `spine@toc` pointing at it. */
export function removeManifestEntry(xml: string, path: string, baseDir: string, codec: XmlCodec): string {
  const doc = codec.parse(xml)
  const removedIds = new Set<string>()
  for (const item of manifestItems(doc).filter((entry) => pathOf(entry, baseDir) === path)) {
    removedIds.add(item.getAttribute('id') ?? '')
    item.parentNode?.removeChild(item)
  }
  if (removedIds.size === 0) throw new Error(`manifest has no entry for ${path}`)

  for (const ref of itemrefs(doc)) {
    if (removedIds.has(ref.getAttribute('idref') ?? '')) ref.parentNode?.removeChild(ref)
  }
  const spine = spineElement(doc)
  if (removedIds.has(spine.getAttribute('toc') ?? '')) spine.removeAttribute('toc')
  return codec.serialize(doc)
}

/**
 * Rewrites `<spine>` so its itemrefs follow `orderedPaths`. Paths not listed keep their relative
 * order and land at the end, so a caller can pass only the documents it actually reordered.
 */
export function reorderSpine(
  xml: string,
  orderedPaths: string[],
  baseDir: string,
  codec: XmlCodec,
): string {
  const doc = codec.parse(xml)
  const spine = spineElement(doc)
  const idByPath = new Map(manifestItems(doc).map((item) => [pathOf(item, baseDir), item.getAttribute('id') ?? '']))
  const existing = itemrefs(doc)
  const refByIdref = new Map(existing.map((ref) => [ref.getAttribute('idref') ?? '', ref]))

  const ordered: Element[] = []
  for (const path of orderedPaths) {
    const idref = idByPath.get(path)
    const ref = idref === undefined ? undefined : refByIdref.get(idref)
    if (ref && !ordered.includes(ref)) ordered.push(ref)
  }
  for (const ref of existing) if (!ordered.includes(ref)) ordered.push(ref)
  // appendChild moves an existing node, so this rewrites the order in place.
  for (const ref of ordered) spine.appendChild(ref)
  return codec.serialize(doc)
}

/** Sets `<spine toc="...">` so EPUB 2 readers locate the registered NCX document. */
export function setSpineToc(xml: string, ncxId: string, codec: XmlCodec): string {
  const doc = codec.parse(xml)
  spineElement(doc).setAttribute('toc', ncxId)
  return codec.serialize(doc)
}
