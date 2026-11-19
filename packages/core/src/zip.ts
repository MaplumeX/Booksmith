import { unzipSync, zipSync } from 'fflate'
import { InvalidEpubError, type EpubArchive } from './types'

export function unzipArchive(bytes: Uint8Array): EpubArchive {
  let unzipped: Record<string, Uint8Array>
  try {
    unzipped = unzipSync(bytes)
  } catch (error) {
    throw new InvalidEpubError(`not a readable zip archive: ${(error as Error).message}`)
  }

  const order = Object.keys(unzipped)
  const entries = new Map<string, Uint8Array>()
  for (const path of order) {
    const data = unzipped[path]
    if (data) entries.set(path, data)
  }
  return { order, entries }
}

/**
 * Repacks the archive in its original entry order.
 * `mimetype` is forced first and stored uncompressed, as the EPUB spec requires.
 */
export function zipArchive(archive: EpubArchive): Uint8Array {
  const mimetype = archive.entries.get('mimetype')
  if (!mimetype) throw new InvalidEpubError('archive has no mimetype entry')

  const zippable: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
    mimetype: [mimetype, { level: 0 }],
  }
  for (const path of archive.order) {
    if (path === 'mimetype') continue
    const data = archive.entries.get(path)
    if (data) zippable[path] = [data, { level: 6 }]
  }
  // Entries added after unpacking keep their insertion order at the end.
  for (const [path, data] of archive.entries) {
    if (path === 'mimetype' || zippable[path]) continue
    zippable[path] = [data, { level: 6 }]
  }

  return zipSync(zippable)
}

export function textOf(archive: EpubArchive, path: string): string | undefined {
  const bytes = archive.entries.get(path)
  return bytes ? new TextDecoder('utf-8').decode(bytes) : undefined
}
