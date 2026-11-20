import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { openEpub } from '@booksmith/core'
import { archiveToStoredEntries, computeManifestSha256, nodeXmlParser } from '../epub/ingest'
import { createPostgresFileStore } from '../storage/fileStore'
import type { Db, Sql } from './client'
import { books } from './schema'

export interface BackfillResult {
  migratedBooks: number
  droppedLegacyTable: boolean
}

/**
 * Losslessly unpacks any legacy whole-zip rows from `book_files` into `book_entries`, then drops
 * `book_files` only once every legacy row has been migrated cleanly. Any unpack failure aborts
 * immediately and leaves `book_files` intact. See ADR 2026-11-20-entry-level-book-storage.
 */
export async function backfillBookEntries(db: Db, sql: Sql): Promise<BackfillResult> {
  const existsRows = await sql<{ exists: boolean }[]>`
    SELECT to_regclass('public.book_files') IS NOT NULL AS exists
  `
  if (!existsRows[0]?.exists) {
    return { migratedBooks: 0, droppedLegacyTable: false }
  }

  const pending = await sql<{ book_id: string; bytes: Buffer }[]>`
    SELECT bf.book_id, bf.bytes
    FROM book_files bf
    WHERE NOT EXISTS (
      SELECT 1 FROM book_entries be WHERE be.book_id = bf.book_id
    )
    ORDER BY bf.book_id ASC
  `

  const fileStore = createPostgresFileStore(db)
  let migratedBooks = 0

  for (const row of pending) {
    let opened: ReturnType<typeof openEpub>
    try {
      opened = openEpub(new Uint8Array(row.bytes), nodeXmlParser)
    } catch (error) {
      throw new Error(
        `Failed to unpack legacy book_files row for book ${row.book_id}: ${(error as Error).message}. Aborting migration without dropping book_files.`,
      )
    }

    const entries = archiveToStoredEntries(opened.archive, opened.pkg)
    const byteSize = entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0)
    const manifestSha = computeManifestSha256(entries)

    await db.transaction(async (tx) => {
      await fileStore.replaceAllEntries(row.book_id, entries, tx)
      await tx
        .update(books)
        .set({ byteSize, sha256: manifestSha })
        .where(eq(books.id, row.book_id))
    })
    migratedBooks += 1
  }

  const remainingRows = await sql<{ remaining: number }[]>`
    SELECT COUNT(*)::int AS remaining
    FROM book_files bf
    WHERE NOT EXISTS (
      SELECT 1 FROM book_entries be WHERE be.book_id = bf.book_id
    )
  `
  const remaining = remainingRows[0]?.remaining ?? 0
  if (remaining > 0) {
    throw new Error(`Refusing to drop book_files: ${remaining} book(s) still lack book_entries rows.`)
  }

  await sql`DROP TABLE IF EXISTS "book_files"`
  return { migratedBooks, droppedLegacyTable: true }
}

/** Runs Drizzle SQL migrations followed by the idempotent `book_files` -> `book_entries` backfill. */
export async function runMigrations(
  db: Db,
  sql: Sql,
  migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url)),
): Promise<BackfillResult> {
  await migrate(db, { migrationsFolder })
  return backfillBookEntries(db, sql)
}
