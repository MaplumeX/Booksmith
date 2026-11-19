import { createHash } from 'node:crypto'
import { DOMParser } from '@xmldom/xmldom'
import { openEpub, validateStructure, type EpubArchive, type EpubPackage, type XmlDocumentParser } from '@booksmith/core'

export const nodeXmlParser: XmlDocumentParser = (xml) =>
  new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document

export interface IngestedCover {
  bytes: Buffer
  mimeType: string
}

export interface IngestedBook {
  title: string
  author: string
  language: string
  identifier: string
  chapterCount: number
  byteSize: number
  sha256: string
  cover: IngestedCover | null
  pkg: EpubPackage
  /** Unpacked entries, so callers can diff one save against the previous pack without re-inflating. */
  archive: EpubArchive
}

export class IngestError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message)
    this.name = 'IngestError'
  }
}

function findCover(pkg: EpubPackage, bytes: (path: string) => Uint8Array | undefined): IngestedCover | null {
  const candidates = [
    ...pkg.manifest.filter((item) => item.properties.includes('cover-image')),
    ...pkg.manifest.filter((item) => item.mediaType.startsWith('image/') && /cover/i.test(item.href)),
  ]

  for (const item of candidates) {
    const data = bytes(item.path)
    if (data) return { bytes: Buffer.from(data), mimeType: item.mediaType }
  }
  return null
}

/** Validates an uploaded epub and extracts the fields the library needs. */
export function ingestEpub(input: Buffer, parse: XmlDocumentParser = nodeXmlParser): IngestedBook {
  if (input.byteLength === 0) throw new IngestError('empty upload')

  let opened: ReturnType<typeof openEpub>
  try {
    opened = openEpub(new Uint8Array(input), parse)
  } catch (error) {
    throw new IngestError((error as Error).message)
  }

  const issues = validateStructure(opened.archive, opened.pkg)
  if (issues.length > 0) {
    throw new IngestError('epub failed structural validation', issues.map((issue) => issue.message))
  }

  const { pkg, archive } = opened
  const metadata = pkg.metadata

  return {
    title: metadata.title || '未命名',
    author: metadata.creators.join(', '),
    language: metadata.language,
    identifier: metadata.identifier,
    chapterCount: pkg.spine.length,
    byteSize: input.byteLength,
    sha256: createHash('sha256').update(input).digest('hex'),
    cover: findCover(pkg, (path) => archive.entries.get(path)),
    pkg,
    archive,
  }
}
