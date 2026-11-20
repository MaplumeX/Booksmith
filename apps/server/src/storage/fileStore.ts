import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { isTextEntry } from '@booksmith/core'
import type { Db } from '../db/client'
import { bookEntries, pageVersions } from '../db/schema'

const RECENT_KEEP = 10
const PAGE_CAP = 100
const ENTRY_BATCH_SIZE = 50

export type DbExecutor = Pick<Db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>

export interface PageVersionMeta {
  id: string
  path: string
  byteSize: number
  sha256: string
  pinned: boolean
  createdAt: Date
}

export interface StoredEntryInput {
  path: string
  position: number
  isText: boolean
  mediaType: string
  bytes: Buffer
  sha256: string
}

export interface WorkspaceEntryRow {
  path: string
  position: number
  isText: boolean
  mediaType: string
  byteSize: number
  sha256: string
  /** Populated only for text entries and `mimetype`; null for binaries so Postgres never detoasts them. */
  bytes: Buffer | null
}

export interface StoredEntryRow {
  path: string
  position: number
  isText: boolean
  mediaType: string
  bytes: Buffer
  byteSize: number
  sha256: string
}

export interface EntryDelta {
  deletes: string[]
  renames: Array<{ from: string; to: string }>
  upserts: Array<{
    path: string
    isText: boolean
    mediaType: string
    bytes: Buffer
    sha256: string
  }>
  order?: string[]
}

export interface FileStore {
  replaceAllEntries(bookId: string, entries: ReadonlyArray<StoredEntryInput>, executor?: DbExecutor): Promise<void>
  listWorkspaceEntries(bookId: string, executor?: DbExecutor): Promise<WorkspaceEntryRow[]>
  getEntry(bookId: string, path: string, executor?: DbExecutor): Promise<StoredEntryRow | null>
  getAllEntriesForPack(bookId: string, executor?: DbExecutor): Promise<StoredEntryRow[]>
  applyEntryDelta(bookId: string, delta: EntryDelta, executor?: DbExecutor): Promise<void>

  listPageVersions(bookId: string): Promise<PageVersionMeta[]>
  getPageVersion(bookId: string, id: string): Promise<{ path: string; bytes: Buffer } | null>
  /** Newest snapshot of one entry, used to decide whether the throttle window is still open. */
  newestFor(bookId: string, path: string, executor?: DbExecutor): Promise<{ sha256: string; createdAt: Date } | null>
  putPageVersion(
    bookId: string,
    path: string,
    bytes: Buffer,
    sha256: string,
    executor?: DbExecutor,
  ): Promise<void>
  /** Marks a snapshot as protected from pruning. Returns null when the snapshot is not in this book. */
  setPinned(bookId: string, id: string, pinned: boolean): Promise<PageVersionMeta | null>
  prunePages(bookId: string, executor?: DbExecutor): Promise<number>
}

async function insertEntriesBatched(
  executor: DbExecutor,
  bookId: string,
  entries: ReadonlyArray<StoredEntryInput>,
): Promise<void> {
  const now = new Date()
  for (let offset = 0; offset < entries.length; offset += ENTRY_BATCH_SIZE) {
    const chunk = entries.slice(offset, offset + ENTRY_BATCH_SIZE)
    await executor
      .insert(bookEntries)
      .values(
        chunk.map((entry) => ({
          bookId,
          path: entry.path,
          position: entry.position,
          isText: entry.isText,
          mediaType: entry.mediaType,
          bytes: entry.bytes,
          byteSize: entry.bytes.byteLength,
          sha256: entry.sha256,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [bookEntries.bookId, bookEntries.path],
        set: {
          position: sql`excluded.position`,
          isText: sql`excluded.is_text`,
          mediaType: sql`excluded.media_type`,
          bytes: sql`excluded.bytes`,
          byteSize: sql`excluded.byte_size`,
          sha256: sql`excluded.sha256`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
  }
}

/** Postgres-backed entry-level storage: `book_entries` holds current unpacked state, `page_versions`
 * holds per-entry text snapshots. See ADR 2026-11-20-entry-level-book-storage. */
export function createPostgresFileStore(db: Db): FileStore {
  const store: FileStore = {
    async replaceAllEntries(bookId, entries, executor = db) {
      await executor.delete(bookEntries).where(eq(bookEntries.bookId, bookId))
      if (entries.length === 0) return
      await insertEntriesBatched(executor, bookId, entries)
    },

    async listWorkspaceEntries(bookId, executor = db) {
      // Skip selecting binary `bytes` via CASE so Postgres never detoasts large images or fonts
      // during editor opens, incremental saves, or Agent turns.
      // See ADR 2026-11-20-entry-level-book-storage.
      const rows = await executor
        .select({
          path: bookEntries.path,
          position: bookEntries.position,
          isText: bookEntries.isText,
          mediaType: bookEntries.mediaType,
          byteSize: bookEntries.byteSize,
          sha256: bookEntries.sha256,
          bytes: sql<Buffer | null>`CASE WHEN ${bookEntries.isText} OR ${bookEntries.path} = 'mimetype' THEN ${bookEntries.bytes} ELSE NULL END`,
        })
        .from(bookEntries)
        .where(eq(bookEntries.bookId, bookId))
        .orderBy(asc(bookEntries.position), asc(bookEntries.path))

      return rows
    },

    async getEntry(bookId, path, executor = db) {
      const rows = await executor
        .select({
          path: bookEntries.path,
          position: bookEntries.position,
          isText: bookEntries.isText,
          mediaType: bookEntries.mediaType,
          bytes: bookEntries.bytes,
          byteSize: bookEntries.byteSize,
          sha256: bookEntries.sha256,
        })
        .from(bookEntries)
        .where(and(eq(bookEntries.bookId, bookId), eq(bookEntries.path, path)))
        .limit(1)
      return rows[0] ?? null
    },

    async getAllEntriesForPack(bookId, executor = db) {
      return executor
        .select({
          path: bookEntries.path,
          position: bookEntries.position,
          isText: bookEntries.isText,
          mediaType: bookEntries.mediaType,
          bytes: bookEntries.bytes,
          byteSize: bookEntries.byteSize,
          sha256: bookEntries.sha256,
        })
        .from(bookEntries)
        .where(eq(bookEntries.bookId, bookId))
        .orderBy(asc(bookEntries.position), asc(bookEntries.path))
    },

    async applyEntryDelta(bookId, delta, executor = db) {
      const now = new Date()

      // 1. Apply deletes first so renamed paths can move into vacated slots cleanly.
      if (delta.deletes.length > 0) {
        await executor
          .delete(bookEntries)
          .where(and(eq(bookEntries.bookId, bookId), inArray(bookEntries.path, delta.deletes)))
      }

      // 2. Two-phase temp-path renames avoid PK collisions on swaps (a <-> b) and chains
      // without transferring binary bytes out of Postgres.
      // See ADR 2026-11-20-entry-level-book-storage.
      const effectiveRenames = delta.renames.filter((item) => item.from !== item.to)
      if (effectiveRenames.length > 0) {
        const nonce = randomUUID()
        const staged: Array<{ tmp: string; to: string }> = []
        for (let i = 0; i < effectiveRenames.length; i += 1) {
          const item = effectiveRenames[i]!
          const tmp = `__booksmith_rename_${nonce}_${i}`
          const updated = await executor
            .update(bookEntries)
            .set({ path: tmp, updatedAt: now })
            .where(and(eq(bookEntries.bookId, bookId), eq(bookEntries.path, item.from)))
            .returning({ path: bookEntries.path })
          if (updated.length === 0) {
            throw new Error(`rename source not found: ${item.from}`)
          }
          staged.push({ tmp, to: item.to })
        }

        for (const item of staged) {
          await executor
            .update(bookEntries)
            .set({
              path: item.to,
              isText: isTextEntry(item.to),
              updatedAt: now,
            })
            .where(and(eq(bookEntries.bookId, bookId), eq(bookEntries.path, item.tmp)))
        }
      }

      // 3. Apply upserts in chunks to stay well under Postgres parameter limits.
      if (delta.upserts.length > 0) {
        const existingPos = await executor
          .select({ path: bookEntries.path, position: bookEntries.position })
          .from(bookEntries)
          .where(eq(bookEntries.bookId, bookId))
        const posByPath = new Map(existingPos.map((row) => [row.path, row.position]))
        let nextPos = existingPos.reduce((max, row) => Math.max(max, row.position), -1) + 1

        const inputs: StoredEntryInput[] = delta.upserts.map((item) => {
          const position = posByPath.get(item.path) ?? nextPos++
          return {
            path: item.path,
            position,
            isText: item.isText,
            mediaType: item.mediaType,
            bytes: item.bytes,
            sha256: item.sha256,
          }
        })
        await insertEntriesBatched(executor, bookId, inputs)
      }

      // 4. Normalize `position` so `mimetype` stays at 0 and caller-provided order is preserved.
      const currentRows = await executor
        .select({ path: bookEntries.path, position: bookEntries.position })
        .from(bookEntries)
        .where(eq(bookEntries.bookId, bookId))
        .orderBy(asc(bookEntries.position), asc(bookEntries.path))

      const existingSet = new Set(currentRows.map((row) => row.path))
      const desiredOrder: string[] = []
      const seen = new Set<string>()
      const pushPath = (path: string) => {
        if (seen.has(path) || !existingSet.has(path)) return
        seen.add(path)
        desiredOrder.push(path)
      }

      pushPath('mimetype')
      if (delta.order) {
        for (const path of delta.order) pushPath(path)
      }
      for (const row of currentRows) pushPath(row.path)

      const currentPos = new Map(currentRows.map((row) => [row.path, row.position]))
      for (let idx = 0; idx < desiredOrder.length; idx += 1) {
        const path = desiredOrder[idx]!
        if (currentPos.get(path) === idx) continue
        await executor
          .update(bookEntries)
          .set({ position: idx })
          .where(and(eq(bookEntries.bookId, bookId), eq(bookEntries.path, path)))
      }
    },

    async listPageVersions(bookId) {
      return db
        .select({
          id: pageVersions.id,
          path: pageVersions.path,
          byteSize: pageVersions.byteSize,
          sha256: pageVersions.sha256,
          pinned: pageVersions.pinned,
          createdAt: pageVersions.createdAt,
        })
        .from(pageVersions)
        .where(eq(pageVersions.bookId, bookId))
        .orderBy(sql`${pageVersions.createdAt} desc`)
    },

    async getPageVersion(bookId, id) {
      const rows = await db
        .select({ path: pageVersions.path, bytes: pageVersions.bytes })
        .from(pageVersions)
        .where(and(eq(pageVersions.bookId, bookId), eq(pageVersions.id, id)))
        .limit(1)
      return rows[0] ?? null
    },

    async newestFor(bookId, path, executor = db) {
      const rows = await executor
        .select({ sha256: pageVersions.sha256, createdAt: pageVersions.createdAt })
        .from(pageVersions)
        .where(and(eq(pageVersions.bookId, bookId), eq(pageVersions.path, path)))
        .orderBy(sql`${pageVersions.createdAt} desc`)
        .limit(1)
      return rows[0] ?? null
    },

    async setPinned(bookId, id, pinned) {
      const rows = await db
        .update(pageVersions)
        .set({ pinned })
        .where(and(eq(pageVersions.bookId, bookId), eq(pageVersions.id, id)))
        .returning({
          id: pageVersions.id,
          path: pageVersions.path,
          byteSize: pageVersions.byteSize,
          sha256: pageVersions.sha256,
          pinned: pageVersions.pinned,
          createdAt: pageVersions.createdAt,
        })
      return rows[0] ?? null
    },

    async putPageVersion(bookId, path, bytes, sha256, executor = db) {
      await executor.insert(pageVersions).values({
        bookId,
        path,
        bytes,
        byteSize: bytes.byteLength,
        sha256,
        createdAt: new Date(),
      })
    },

    /**
     * Keeps up to `PAGE_CAP` snapshots per entry: the newest `RECENT_KEEP` unconditionally, then
     * one more per UTC day for everything older.
     *
     * Per entry, not per book: a chapter under heavy revision keeps its own history instead of
     * evicting the quiet chapters around it. Returns rows removed.
     * See ADR 2026-11-19-page-level-snapshots.
     */
    async prunePages(bookId, executor = db) {
      const rows = await executor
        .select({
          id: pageVersions.id,
          path: pageVersions.path,
          pinned: pageVersions.pinned,
          createdAt: pageVersions.createdAt,
        })
        .from(pageVersions)
        .where(eq(pageVersions.bookId, bookId))
        .orderBy(sql`${pageVersions.path} asc, ${pageVersions.createdAt} desc`)

      const keep = new Set<string>()
      let path = ''
      let index = 0
      let seenDays = new Set<string>()

      for (const row of rows) {
        if (row.path !== path) {
          path = row.path
          index = 0
          seenDays = new Set<string>()
        }

        // A pinned snapshot costs no slot in the cap and is never a sparse-day victim.
        if (row.pinned) {
          keep.add(row.id)
          continue
        }

        const day = row.createdAt.toISOString().slice(0, 10)
        const withinRecent = index < RECENT_KEEP
        index += 1

        if (withinRecent) {
          keep.add(row.id)
          seenDays.add(day)
          continue
        }
        if (seenDays.has(day)) continue
        seenDays.add(day)
        if (index > PAGE_CAP) continue
        keep.add(row.id)
      }

      const removable = rows.filter((row) => !row.pinned && !keep.has(row.id)).map((row) => row.id)
      if (removable.length === 0) return 0

      await executor
        .delete(pageVersions)
        .where(and(eq(pageVersions.bookId, bookId), inArray(pageVersions.id, removable)))
      return removable.length
    },
  }

  return store
}
