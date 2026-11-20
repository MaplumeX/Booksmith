import { isTextEntry } from '@booksmith/core'
import type { EntryDeltaPayload, WorkspaceEntryDto } from '../api/client'
import { groupFiles, REMOTE_BINARY_SENTINEL, type BookEntryMeta, type LoadedBook } from './bookStore'

const encoder = new TextEncoder()

export interface BuiltEntryDelta extends EntryDeltaPayload {
  hasChanges: boolean
}

/**
 * Computes the minimal atomic delta between the browser's current workspace and the last saved
 * server snapshot so unmodified binaries are never uploaded and binary renames send zero bytes.
 * See ADR 2026-11-20-entry-level-book-storage.
 */
export function buildEntryDelta(args: {
  book: LoadedBook
  texts: Map<string, string>
  dirty: Set<string>
}): BuiltEntryDelta {
  const { book, texts, dirty } = args
  const usedOrigins = new Set<string>()
  const renames: Array<{ from: string; to: string }> = []

  for (const path of book.archive.entries.keys()) {
    const origin = book.entryOrigins.get(path)
    if (origin && book.serverEntries.has(origin)) {
      usedOrigins.add(origin)
      if (origin !== path) {
        renames.push({ from: origin, to: path })
      }
    }
  }

  const deletes: string[] = []
  for (const serverPath of book.serverEntries.keys()) {
    if (!usedOrigins.has(serverPath)) deletes.push(serverPath)
  }

  const textUpserts: Record<string, string> = {}
  for (const [path, text] of texts) {
    if (!book.archive.entries.has(path)) continue
    const origin = book.entryOrigins.get(path)
    const isNew = !origin || !book.serverEntries.has(origin)
    if (dirty.has(path) || isNew) {
      textUpserts[path] = text
    }
  }

  const binaryUpserts = new Map<string, { bytes: Uint8Array; mediaType: string }>()
  for (const [path, bin] of book.localBinaries) {
    if (book.archive.entries.has(path)) {
      binaryUpserts.set(path, bin)
    }
  }

  const order = [
    ...book.archive.order.filter((path) => book.archive.entries.has(path)),
    ...[...book.archive.entries.keys()].filter((path) => !book.archive.order.includes(path)),
  ]

  const hasChanges =
    deletes.length > 0 ||
    renames.length > 0 ||
    Object.keys(textUpserts).length > 0 ||
    binaryUpserts.size > 0

  return {
    textUpserts,
    binaryUpserts,
    renames,
    deletes,
    order,
    hasChanges,
  }
}

/**
 * Reconciles `LoadedBook` after a successful `PATCH /entries` save: refreshes server metadata and
 * releases locally buffered binary bytes so saved images/fonts switch back to lazy HTTP caching.
 */
export function applySavedEntriesToBook(
  book: LoadedBook,
  version: number,
  savedEntries: WorkspaceEntryDto[],
  texts: Map<string, string>,
): LoadedBook {
  const order: string[] = []
  const entries = new Map<string, Uint8Array>()
  const entryMeta = new Map<string, BookEntryMeta>()
  const entryOrigins = new Map<string, string>()
  const serverEntries = new Map<string, WorkspaceEntryDto>()

  for (const item of savedEntries) {
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

    if (item.path === 'mimetype') {
      entries.set(item.path, book.archive.entries.get('mimetype') ?? encoder.encode('application/epub+zip'))
    } else if (isTextEntry(item.path)) {
      const text = texts.get(item.path)
      entries.set(item.path, text !== undefined ? encoder.encode(text) : (book.archive.entries.get(item.path) ?? REMOTE_BINARY_SENTINEL))
    } else {
      entries.set(item.path, REMOTE_BINARY_SENTINEL)
    }
  }

  const archive = { order, entries }
  return {
    ...book,
    version,
    archive,
    texts: new Map(texts),
    groups: groupFiles(book.pkg, archive),
    serverPaths: new Set(order),
    entryMeta,
    entryOrigins,
    serverEntries,
    localBinaries: new Map(),
  }
}
