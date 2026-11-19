import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { bookVersions } from '../db/schema'

const RECENT_KEEP = 10
const TOTAL_CAP = 40

export interface FileStore {
  put(bookId: string, versionNo: number, bytes: Buffer, sha256: string, note?: string): Promise<void>
  get(bookId: string, versionNo: number): Promise<Buffer | null>
  list(bookId: string): Promise<Array<{ versionNo: number; byteSize: number; sha256: string; createdAt: Date }>>
  prune(bookId: string): Promise<number>
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
          createdAt: bookVersions.createdAt,
        })
        .from(bookVersions)
        .where(eq(bookVersions.bookId, bookId))
        .orderBy(sql`${bookVersions.versionNo} desc`)
    },

    /**
     * Keeps the newest `RECENT_KEEP` snapshots, then one more per UTC day for everything
     * older, capped at `TOTAL_CAP`.
     *
     * Counting snapshots alone let a run of typo fixes evict the only history of a quiet
     * period; keeping the last save of each day preserves that shape. Returns rows removed.
     * See ADR 2026-11-19-snapshot-history.
     */
    async prune(bookId) {
      const rows = await db
        .select({ versionNo: bookVersions.versionNo, createdAt: bookVersions.createdAt })
        .from(bookVersions)
        .where(eq(bookVersions.bookId, bookId))
        .orderBy(sql`${bookVersions.versionNo} desc`)

      const keep = new Set<number>()
      const seenDays = new Set<string>()
      for (const [index, row] of rows.entries()) {
        const day = row.createdAt.toISOString().slice(0, 10)
        if (index < RECENT_KEEP) {
          keep.add(row.versionNo)
          seenDays.add(day)
          continue
        }
        if (seenDays.has(day)) continue
        seenDays.add(day)
        if (keep.size >= TOTAL_CAP) continue
        keep.add(row.versionNo)
      }

      const removable = rows.filter((row) => !keep.has(row.versionNo)).map((row) => row.versionNo)
      if (removable.length === 0) return 0

      await db
        .delete(bookVersions)
        .where(and(eq(bookVersions.bookId, bookId), inArray(bookVersions.versionNo, removable)))
      return removable.length
    },
  }
}
