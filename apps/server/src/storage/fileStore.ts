import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { bookVersions } from '../db/schema'

export interface FileStore {
  put(bookId: string, versionNo: number, bytes: Buffer, sha256: string, note?: string): Promise<void>
  get(bookId: string, versionNo: number): Promise<Buffer | null>
  list(bookId: string): Promise<Array<{ versionNo: number; byteSize: number; sha256: string; pinned: boolean; createdAt: Date }>>
  markPinned(bookId: string, versionNo: number, pinned: boolean): Promise<void>
  prune(bookId: string, keep: number): Promise<number>
}

/** Postgres-backed storage. Everything the app needs from a file layer lives here,
 * so swapping in an object store later is one implementation plus a migration.
 * See ADR 2026-11-19-server-backed-epub-editor. */
export function createPostgresFileStore(db: Db): FileStore {
  return {
    async put(bookId, versionNo, bytes, sha256, note) {
      await db.insert(bookVersions).values({
        bookId,
        versionNo,
        bytes,
        byteSize: bytes.byteLength,
        sha256,
        note: note ?? null,
      })
    },

    async get(bookId, versionNo) {
      const rows = await db
        .select({ bytes: bookVersions.bytes })
        .from(bookVersions)
        .where(and(eq(bookVersions.bookId, bookId), eq(bookVersions.versionNo, versionNo)))
        .limit(1)
      return rows[0]?.bytes ?? null
    },

    async list(bookId) {
      return db
        .select({
          versionNo: bookVersions.versionNo,
          byteSize: bookVersions.byteSize,
          sha256: bookVersions.sha256,
          pinned: bookVersions.pinned,
          createdAt: bookVersions.createdAt,
        })
        .from(bookVersions)
        .where(eq(bookVersions.bookId, bookId))
        .orderBy(sql`${bookVersions.versionNo} desc`)
    },

    async markPinned(bookId, versionNo, pinned) {
      await db
        .update(bookVersions)
        .set({ pinned })
        .where(and(eq(bookVersions.bookId, bookId), eq(bookVersions.versionNo, versionNo)))
    },

    /** Keeps the newest `keep` versions plus every pinned one. Returns rows removed. */
    async prune(bookId, keep) {
      const rows = await db
        .select({ versionNo: bookVersions.versionNo, pinned: bookVersions.pinned })
        .from(bookVersions)
        .where(eq(bookVersions.bookId, bookId))
        .orderBy(sql`${bookVersions.versionNo} desc`)

      const removable = rows
        .slice(keep)
        .filter((row) => !row.pinned)
        .map((row) => row.versionNo)
      if (removable.length === 0) return 0

      await db
        .delete(bookVersions)
        .where(and(eq(bookVersions.bookId, bookId), inArray(bookVersions.versionNo, removable)))
      return removable.length
    },
  }
}
