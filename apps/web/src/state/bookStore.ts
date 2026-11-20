import {
  browserXmlParser,
  isTextEntry,
  parsePackage,
  readOpfPath,
  type EpubArchive,
  type EpubPackage,
} from '@booksmith/core'
import { api, entryAssetUrl, type WorkspaceEntryDto } from '../api/client'
import type { PreviewAsset } from '../preview/render'

export type FileGroup = 'Text' | 'Styles' | 'Images' | 'Other'

/** Shared zero-byte marker placed in `archive.entries` for unmodified remote binaries so
 * `packages/core` validators see every path without loading binary assets into browser RAM.
 * See ADR 2026-11-20-entry-level-book-storage. */
export const REMOTE_BINARY_SENTINEL = new Uint8Array(0)

export interface BookEntryMeta {
  path: string
  isText: boolean
  mediaType: string
  byteSize: number
  sha256: string | null
}

export interface LoadedBook {
  id: string
  version: number
  archive: EpubArchive
  pkg: EpubPackage
  texts: Map<string, string>
  groups: Array<{ group: FileGroup; label: string; paths: string[] }>
  /** Paths present in the last saved server archive, so unsaved deletions can be sent to the Agent.
   * See ADR 2026-11-20-builtin-epub-agent. */
  serverPaths: Set<string>
  /** Per-entry metadata (size, mediaType, sha256) for both text and remote binary entries. */
  entryMeta: Map<string, BookEntryMeta>
  /** Maps each current path to its original server path when renamed locally before saving. */
  entryOrigins: Map<string, string>
  /** Server entry snapshot at `version`, used to compute minimal incremental save deltas. */
  serverEntries: Map<string, WorkspaceEntryDto>
  /** Binary assets added or replaced locally since the last save. */
  localBinaries: Map<string, { bytes: Uint8Array; mediaType: string }>
}

const encoder = new TextEncoder()

export function extensionOf(path: string): string {
  const index = path.lastIndexOf('.')
  return index < 0 ? '' : path.slice(index + 1).toLowerCase()
}

export function basename(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(index + 1)
}

function groupOf(path: string, mediaType: string | undefined): FileGroup {
  if (mediaType === 'application/xhtml+xml' || mediaType === 'text/html') return 'Text'
  if (mediaType === 'text/css') return 'Styles'
  if (mediaType?.startsWith('image/')) return 'Images'
  if (mediaType) return 'Other'

  const extension = extensionOf(path)
  if (extension === 'xhtml' || extension === 'html' || extension === 'htm') return 'Text'
  if (extension === 'css') return 'Styles'
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(extension)) return 'Images'
  return 'Other'
}

const GROUP_LABELS: Record<FileGroup, string> = {
  Text: 'TEXT',
  Styles: 'STYLES',
  Images: 'IMAGES',
  Other: 'OTHER',
}

export function groupFiles(pkg: EpubPackage, archive: EpubArchive): LoadedBook['groups'] {
  const mediaTypes = new Map(pkg.manifest.map((item) => [item.path, item.mediaType]))
  const spineOrder = new Map<string, number>()
  pkg.spine.forEach((id, index) => {
    const item = pkg.manifest.find((entry) => entry.id === id)
    if (item) spineOrder.set(item.path, index)
  })

  const buckets: Record<FileGroup, string[]> = { Text: [], Styles: [], Images: [], Other: [] }
  for (const path of archive.order) {
    if (path === 'mimetype' || path.endsWith('/')) continue
    if (path.startsWith('META-INF/')) {
      if (path !== 'META-INF/container.xml') continue
    }
    buckets[groupOf(path, mediaTypes.get(path))].push(path)
  }

  const bySpineThenName = (a: string, b: string): number => {
    const ai = spineOrder.get(a) ?? Number.MAX_SAFE_INTEGER
    const bi = spineOrder.get(b) ?? Number.MAX_SAFE_INTEGER
    if (ai !== bi) return ai - bi
    return basename(a).localeCompare(basename(b), 'en')
  }

  buckets.Text.sort(bySpineThenName)
  buckets.Styles.sort(bySpineThenName)
  buckets.Images.sort(bySpineThenName)
  buckets.Other.sort(bySpineThenName)

  return (Object.keys(buckets) as FileGroup[])
    .filter((group) => buckets[group].length > 0)
    .map((group) => ({ group, label: GROUP_LABELS[group], paths: buckets[group] }))
}

/** Resolves a referenced book asset to either in-memory bytes (local edit or inline SVG) or a
 * cacheable same-origin server URL for lazy binary loading. */
export function resolveBookAsset(book: LoadedBook, targetPath: string): PreviewAsset | null {
  if (!book.archive.entries.has(targetPath)) return null

  const localBin = book.localBinaries.get(targetPath)
  if (localBin) {
    return { kind: 'bytes', bytes: localBin.bytes, mime: localBin.mediaType }
  }

  const raw = book.archive.entries.get(targetPath)
  const meta = book.entryMeta.get(targetPath)
  const mime =
    book.pkg.manifest.find((item) => item.path === targetPath)?.mediaType ||
    meta?.mediaType ||
    'application/octet-stream'

  if (raw && raw !== REMOTE_BINARY_SENTINEL) {
    return { kind: 'bytes', bytes: raw, mime }
  }

  const originPath = book.entryOrigins.get(targetPath) ?? targetPath
  const sha = meta?.sha256 ?? book.serverEntries.get(originPath)?.sha256 ?? null
  return {
    kind: 'url',
    url: entryAssetUrl(book.id, originPath, sha),
    key: `remote:${book.id}:${originPath}:${sha ?? ''}`,
    mime,
  }
}

export async function loadBook(id: string): Promise<LoadedBook> {
  const workspace = await api.workspace(id)

  const order: string[] = []
  const entries = new Map<string, Uint8Array>()
  const texts = new Map<string, string>()
  const entryMeta = new Map<string, BookEntryMeta>()
  const entryOrigins = new Map<string, string>()
  const serverEntries = new Map<string, WorkspaceEntryDto>()

  for (const item of workspace.entries) {
    order.push(item.path)
    entryMeta.set(item.path, {
      path: item.path,
      isText: item.isText,
      mediaType: item.mediaType,
      byteSize: item.byteSize,
      sha256: item.sha256,
    })
    entryOrigins.set(item.path, item.path)
    serverEntries.set(item.path, item)

    const text = workspace.texts[item.path]
    if (text !== undefined) {
      entries.set(item.path, encoder.encode(text))
      if (isTextEntry(item.path)) texts.set(item.path, text)
    } else {
      entries.set(item.path, REMOTE_BINARY_SENTINEL)
    }
  }

  const archive: EpubArchive = { order, entries }
  const opfPath = readOpfPath(archive, browserXmlParser)
  const opfXml = texts.get(opfPath) ?? workspace.texts[opfPath]
  if (!opfXml) throw new Error(`OPF not found at ${opfPath}`)
  const pkg = parsePackage(opfXml, opfPath, browserXmlParser)

  return {
    id,
    version: workspace.version,
    archive,
    pkg,
    texts,
    groups: groupFiles(pkg, archive),
    serverPaths: new Set(order),
    entryMeta,
    entryOrigins,
    serverEntries,
    localBinaries: new Map(),
  }
}

/** Rough character count for the status bar; strips markup so XHTML reads as prose. */
export function proseLength(path: string, text: string): number {
  const extension = extensionOf(path)
  if (extension === 'xhtml' || extension === 'html') {
    return text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, '')
      .length
  }
  return text.length
}
