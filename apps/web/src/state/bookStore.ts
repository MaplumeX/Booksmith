import { browserXmlParser, isTextEntry, openEpub, type EpubArchive, type EpubPackage } from '@booksmith/core'
import { api } from '../api/client'

export type FileGroup = 'Text' | 'Styles' | 'Images' | 'Other'

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
}

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

export async function loadBook(id: string): Promise<LoadedBook> {
  const { bytes, version } = await api.epub(id)
  const { archive, pkg } = openEpub(bytes, browserXmlParser)

  const texts = new Map<string, string>()
  const decoder = new TextDecoder('utf-8')
  for (const [path, data] of archive.entries) {
    if (isTextEntry(path)) texts.set(path, decoder.decode(data))
  }

  return {
    id,
    version,
    archive,
    pkg,
    texts,
    groups: groupFiles(pkg, archive),
    serverPaths: new Set(archive.entries.keys()),
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
