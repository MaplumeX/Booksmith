import { createHash } from 'node:crypto'
import { DOMParser } from '@xmldom/xmldom'
import {
  isTextEntry,
  openEpub,
  parsePackage,
  readOpfPath,
  validateStructure,
  type EpubArchive,
  type EpubPackage,
  type XmlDocumentParser,
} from '@booksmith/core'
import type { StoredEntryInput } from '../storage/fileStore'

export const nodeXmlParser: XmlDocumentParser = (xml) =>
  new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document

const MIME_BY_EXTENSION: Record<string, string> = {
  xhtml: 'application/xhtml+xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  opf: 'application/oebps-package+xml',
  ncx: 'application/x-dtbncx+xml',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  js: 'text/javascript',
  txt: 'text/plain',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  otf: 'font/otf',
  ttf: 'font/ttf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  webm: 'video/webm',
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function inferMediaType(path: string, pkg?: EpubPackage): string {
  if (path === 'mimetype') return 'text/plain'
  const manifestItem = pkg?.manifest.find((item) => item.path === path)
  if (manifestItem?.mediaType) return manifestItem.mediaType
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
}

/** Canonical digest of all entry paths and content hashes, so unchanged saves can be detected
 * without repacking a zip. See ADR 2026-11-20-entry-level-book-storage. */
export function computeManifestSha256(entries: ReadonlyArray<{ path: string; sha256: string }>): string {
  const hash = createHash('sha256')
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const entry of sorted) {
    hash.update(entry.path)
    hash.update('\0')
    hash.update(entry.sha256)
    hash.update('\n')
  }
  return hash.digest('hex')
}

export function archiveToStoredEntries(archive: EpubArchive, pkg: EpubPackage): StoredEntryInput[] {
  const seen = new Set<string>()
  const orderedPaths: string[] = []
  if (archive.entries.has('mimetype')) {
    orderedPaths.push('mimetype')
    seen.add('mimetype')
  }
  for (const path of archive.order) {
    if (seen.has(path) || !archive.entries.has(path)) continue
    orderedPaths.push(path)
    seen.add(path)
  }
  for (const path of archive.entries.keys()) {
    if (seen.has(path)) continue
    orderedPaths.push(path)
    seen.add(path)
  }

  return orderedPaths.map((path, position) => {
    const raw = archive.entries.get(path)!
    const buf = Buffer.from(raw)
    return {
      path,
      position,
      isText: isTextEntry(path),
      mediaType: inferMediaType(path, pkg),
      bytes: buf,
      sha256: sha256Hex(buf),
    }
  })
}

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
  archive: EpubArchive
  entries: StoredEntryInput[]
}

export interface ValidatedBookMeta {
  title: string
  author: string
  language: string
  identifier: string
  chapterCount: number
  byteSize: number
  sha256: string
  coverPath: string | null
  coverMime: string | null
  pkg: EpubPackage
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

export function findCoverCandidate(
  pkg: EpubPackage,
  hasPath: (path: string) => boolean,
): { path: string; mimeType: string } | null {
  const candidates = [
    ...pkg.manifest.filter((item) => item.properties.includes('cover-image')),
    ...pkg.manifest.filter((item) => item.mediaType.startsWith('image/') && /cover/i.test(item.href)),
  ]
  for (const item of candidates) {
    if (hasPath(item.path)) return { path: item.path, mimeType: item.mediaType }
  }
  return null
}

function findCover(pkg: EpubPackage, bytes: (path: string) => Uint8Array | undefined): IngestedCover | null {
  const candidate = findCoverCandidate(pkg, (path) => bytes(path) !== undefined)
  if (!candidate) return null
  const data = bytes(candidate.path)
  return data ? { bytes: Buffer.from(data), mimeType: candidate.mimeType } : null
}

/** Validates an uploaded epub and extracts entries + library metadata. */
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
  const entries = archiveToStoredEntries(archive, pkg)
  const byteSize = entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0)

  return {
    title: metadata.title || '未命名',
    author: metadata.creators.join(', '),
    language: metadata.language,
    identifier: metadata.identifier,
    chapterCount: pkg.spine.length,
    byteSize,
    sha256: computeManifestSha256(entries),
    cover: findCover(pkg, (path) => archive.entries.get(path)),
    pkg,
    archive,
    entries,
  }
}

/**
 * Validates the current unpacked entry set without loading binary entry bytes from Postgres.
 * Binary entries are represented by empty byte placeholders; only text entries and `mimetype`
 * carry real bytes. See ADR 2026-11-20-entry-level-book-storage.
 */
export function validateEntriesAndExtractMeta(
  rows: ReadonlyArray<{
    path: string
    position: number
    byteSize: number
    sha256: string
    bytes: Buffer | null
  }>,
  parse: XmlDocumentParser = nodeXmlParser,
): ValidatedBookMeta {
  const ordered = [...rows].sort((a, b) => a.position - b.position)
  const placeholder = new Uint8Array(0)
  const order: string[] = []
  const entries = new Map<string, Uint8Array>()

  for (const row of ordered) {
    order.push(row.path)
    entries.set(row.path, row.bytes ? new Uint8Array(row.bytes) : placeholder)
  }

  const archive: EpubArchive = { order, entries }
  let opfPath: string
  let pkg: EpubPackage
  try {
    opfPath = readOpfPath(archive, parse)
    const opfBytes = entries.get(opfPath)
    if (!opfBytes || opfBytes.byteLength === 0) {
      throw new Error(`OPF not found at ${opfPath}`)
    }
    const opfXml = new TextDecoder('utf-8').decode(opfBytes)
    pkg = parsePackage(opfXml, opfPath, parse)
  } catch (error) {
    throw new IngestError((error as Error).message)
  }

  const issues = validateStructure(archive, pkg)
  if (issues.length > 0) {
    throw new IngestError('epub failed structural validation', issues.map((issue) => issue.message))
  }

  const cover = findCoverCandidate(pkg, (path) => entries.has(path))
  const byteSize = ordered.reduce((sum, row) => sum + row.byteSize, 0)

  return {
    title: pkg.metadata.title || '未命名',
    author: pkg.metadata.creators.join(', '),
    language: pkg.metadata.language,
    identifier: pkg.metadata.identifier,
    chapterCount: pkg.spine.length,
    byteSize,
    sha256: computeManifestSha256(ordered),
    coverPath: cover?.path ?? null,
    coverMime: cover?.mimeType ?? null,
    pkg,
  }
}
