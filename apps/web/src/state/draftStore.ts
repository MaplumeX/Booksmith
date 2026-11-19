/**
 * The local half of durability: unsaved edits live in IndexedDB, so a crash or a closed tab costs
 * at most `DRAFT_DEBOUNCE_MS` of typing. Only the changed files are stored, never the whole pack.
 * See ADR 2026-11-19-autosave.
 */

export const DRAFT_DEBOUNCE_MS = 1000
const DB_NAME = 'booksmith'
const STORE = 'drafts'

export interface LocalDraft {
  /** Server version the draft was written against; a mismatch means the book moved on. */
  baseVersion: number
  savedAt: number
  files: Record<string, string>
}

export interface DraftRestore {
  /** Paths to write back into the editor, in draft order. */
  files: Array<[string, string]>
  /** Draft paths the book no longer has; they cannot be applied. */
  dropped: string[]
  /** The book changed on the server since the draft was written. */
  stale: boolean
}

/** Decides what a draft would do to the freshly loaded book, without touching either side. */
export function planDraftRestore(draft: LocalDraft, serverVersion: number, paths: Set<string>): DraftRestore {
  const files: Array<[string, string]> = []
  const dropped: string[] = []
  for (const [path, text] of Object.entries(draft.files)) {
    if (paths.has(path)) files.push([path, text])
    else dropped.push(path)
  }
  return { files, dropped, stale: draft.baseVersion !== serverVersion }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

/** Every call is best-effort: a browser that refuses IndexedDB must not break editing. */
export async function readDraft(bookId: string): Promise<LocalDraft | null> {
  try {
    return ((await withStore<LocalDraft | undefined>('readonly', (store) => store.get(bookId))) ?? null)
  } catch {
    return null
  }
}

export async function writeDraft(bookId: string, draft: LocalDraft): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.put(draft, bookId))
  } catch {
    /* editing continues on the server-backed layer alone */
  }
}

export async function clearDraft(bookId: string): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.delete(bookId))
  } catch {
    /* nothing to clear if the database is unavailable */
  }
}
