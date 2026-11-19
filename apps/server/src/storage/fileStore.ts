import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { bookFiles, pageVersions } from '../db/schema'

const RECENT_KEEP = 10
const PAGE_CAP = 100

export interface PageVersionMeta {
  id: string
  path: string
  byteSize: number
  sha256: string
  pinned: boolean
  createdAt: Date
}

export interface FileStore {
  getCurrent(bookId: string): Promise<Buffer | null>
  putCurrent(bookId: string, bytes: Buffer, sha256: string): Promise<void>
  listPageVersions(bookId: string): Promise<PageVersionMeta[]>
  getPageVersion(bookId: string, id: string): Promise<{ path: string; bytes: Buffer } | null>
  /** Newest snapshot of one entry, used to decide whether the throttle window is still open. */
  newestFor(bookId: string, path: string): Promise<{ sha256: string; createdAt: Date } | null>
  putPageVersion(bookId: string, path: string, bytes: Buffer, sha256: string): Promise<void>
  /** Marks a snapshot as protected from pruning. Returns null when the snapshot is not in this book. */
  setPinned(bookId: string, id: string, pinned: boolean): Promise<PageVersionMeta | null>
  prunePages(bookId: string): Promise<number>
}

/** Postgres-backed storage: one row for the current pack, one table of per-entry snapshots.
 * See ADR 2026-11-19-page-level-snapshots. */
export function createPostgresFileStore(db: Db): FileStore {
  return {
    async getCurrent(bookId) {
      const rows = await db
        .select({ bytes: bookFiles.bytes })
        .from(bookFiles)
        .where(eq(bookFiles.bookId, bookId))
        .limit(1)
      return rows[0]?.bytes ?? null
    },

    /** Overwrites in place: the pack is the current state, never history. */
    async putCurrent(bookId, bytes, sha256) {
      await db
        .insert(bookFiles)
        .values({ bookId, bytes, byteSize: bytes.byteLength, sha256, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: bookFiles.bookId,
          set: { bytes, byteSize: bytes.byteLength, sha256, updatedAt: new Date() },
        })
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

    async newestFor(bookId, path) {
      const rows = await db
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

    async putPageVersion(bookId, path, bytes, sha256) {
      await db.insert(pageVersions).values({
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
    async prunePages(bookId) {
      const rows = await db
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

      await db
        .delete(pageVersions)
        .where(and(eq(pageVersions.bookId, bookId), inArray(pageVersions.id, removable)))
      return removable.length
    },
  }
}
