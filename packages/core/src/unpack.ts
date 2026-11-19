import { dirname, resolvePath } from './path'
import { textOf, unzipArchive } from './zip'
import {
  InvalidEpubError,
  type EpubArchive,
  type EpubPackage,
  type ManifestItem,
  type XmlDocumentParser,
} from './types'

export const CONTAINER_PATH = 'META-INF/container.xml'
const CONTAINER_NS = 'urn:oasis:names:tc:opendocument:xmlns:container'
const OPF_NS = 'http://www.idpf.org/2007/opf'
const DC_NS = 'http://purl.org/dc/elements/1.1/'

export function unpackEpub(bytes: Uint8Array): EpubArchive {
  const archive = unzipArchive(bytes)
  const mimetype = textOf(archive, 'mimetype')
  if (mimetype !== 'application/epub+zip') {
    throw new InvalidEpubError('mimetype entry is missing or not application/epub+zip')
  }
  if (archive.order[0] !== 'mimetype') {
    throw new InvalidEpubError('mimetype must be the first zip entry')
  }
  if (!archive.entries.has(CONTAINER_PATH)) {
    throw new InvalidEpubError('missing META-INF/container.xml')
  }
  return archive
}

export function readOpfPath(archive: EpubArchive, parse: XmlDocumentParser): string {
  const xml = textOf(archive, CONTAINER_PATH)
  if (!xml) throw new InvalidEpubError('missing META-INF/container.xml')
  const doc = parse(xml)
  const rootfile = doc.getElementsByTagNameNS(CONTAINER_NS, 'rootfile')[0]
  const fullPath = rootfile?.getAttribute('full-path')
  if (!fullPath) throw new InvalidEpubError('container.xml has no rootfile full-path')
  return fullPath
}

function firstText(doc: Document, ns: string, name: string): string {
  const node = doc.getElementsByTagNameNS(ns, name)[0]
  return node?.textContent?.trim() ?? ''
}

function allText(doc: Document, ns: string, name: string): string[] {
  return Array.from(doc.getElementsByTagNameNS(ns, name))
    .map((node) => node.textContent?.trim() ?? '')
    .filter(Boolean)
}

export function parsePackage(xml: string, opfPath: string, parse: XmlDocumentParser): EpubPackage {
  const doc = parse(xml)
  const packageElement = doc.getElementsByTagNameNS(OPF_NS, 'package')[0]
  if (!packageElement) throw new InvalidEpubError('OPF has no <package> element')

  const version = packageElement.getAttribute('version') ?? ''
  const uniqueIdentifierId = packageElement.getAttribute('unique-identifier') ?? ''
  const baseDir = dirname(opfPath)

  const items: ManifestItem[] = Array.from(doc.getElementsByTagNameNS(OPF_NS, 'item')).map(
    (element) => {
      const href = element.getAttribute('href') ?? ''
      return {
        id: element.getAttribute('id') ?? '',
        href,
        mediaType: element.getAttribute('media-type') ?? '',
        properties: (element.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean),
        path: resolvePath(baseDir, href),
      }
    },
  )

  const spineElement = doc.getElementsByTagNameNS(OPF_NS, 'spine')[0]
  const spine = Array.from(spineElement?.getElementsByTagNameNS(OPF_NS, 'itemref') ?? []).map(
    (element) => element.getAttribute('idref') ?? '',
  )

  const ncxId = spineElement?.getAttribute('toc') ?? ''
  const navItem = items.find((item) => item.properties.includes('nav'))

  let identifier = ''
  if (uniqueIdentifierId) {
    const nodes = Array.from(doc.getElementsByTagNameNS(DC_NS, 'identifier'))
    const target = nodes.find((node) => node.getAttribute('id') === uniqueIdentifierId)
    identifier = target?.textContent?.trim() ?? ''
  }
  if (!identifier) identifier = firstText(doc, DC_NS, 'identifier')

  return {
    version,
    uniqueIdentifierId,
    metadata: {
      title: firstText(doc, DC_NS, 'title'),
      language: firstText(doc, DC_NS, 'language'),
      identifier,
      creators: allText(doc, DC_NS, 'creator'),
      publisher: firstText(doc, DC_NS, 'publisher'),
      date: firstText(doc, DC_NS, 'date'),
      description: firstText(doc, DC_NS, 'description'),
      subjects: allText(doc, DC_NS, 'subject'),
      rights: firstText(doc, DC_NS, 'rights'),
    },
    manifest: items,
    spine,
    opfPath,
    navPath: navItem?.path,
    ncxPath: items.find((item) => item.id === ncxId)?.path,
  }
}

export interface OpenedEpub {
  archive: EpubArchive
  pkg: EpubPackage
}

/** Full read path: archive → container → package. */
export function openEpub(bytes: Uint8Array, parse: XmlDocumentParser): OpenedEpub {
  const archive = unpackEpub(bytes)
  const opfPath = readOpfPath(archive, parse)
  const xml = textOf(archive, opfPath)
  if (!xml) throw new InvalidEpubError(`OPF not found at ${opfPath}`)
  return { archive, pkg: parsePackage(xml, opfPath, parse) }
}

/** Browser DOMParser adapter. */
export const browserXmlParser: XmlDocumentParser = (xml) =>
  new DOMParser().parseFromString(xml, 'application/xml')
