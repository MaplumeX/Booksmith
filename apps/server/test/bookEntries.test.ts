import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createEmptyEpub, openEpub } from '@booksmith/core'
import { createDb } from '../src/db/client'
import { backfillBookEntries } from '../src/db/migrate'
import { books, users } from '../src/db/schema'
import { archiveToStoredEntries, nodeXmlParser, sha256Hex } from '../src/epub/ingest'
import { createPostgresFileStore } from '../src/storage/fileStore'
import { TEST_URL } from './global-setup'

const FIXTURE = readFileSync(fileURLToPath(new URL('../../../fixtures/马克思经济学与数理分析.epub', import.meta.url)))

describe('entry-level FileStore & legacy backfill', () => {
  const { db, sql } = createDb(TEST_URL)
  const fileStore = createPostgresFileStore(db)
  let userId = ''

  beforeAll(async () => {
    const email = `entries-${crypto.randomUUID()}@example.com`
    const [user] = await db.insert(users).values({ email, passwordHash: 'x' }).returning()
    userId = user!.id
  })

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, userId))
    await sql.end()
  })

  async function seedEmptyBookRow(): Promise<string> {
    const [row] = await db
      .insert(books)
      .values({
        ownerId: userId,
        title: 'Entry Test Book',
        byteSize: 0,
        sha256: 'init',
        currentVersion: 1,
      })
      .returning()
    return row!.id
  }

  it('stores unpacked entries, skips binary bytes in workspace queries, and preserves order for pack', async () => {
    const bookId = await seedEmptyBookRow()
    const opened = openEpub(new Uint8Array(FIXTURE), nodeXmlParser)
    const stored = archiveToStoredEntries(opened.archive, opened.pkg)

    await fileStore.replaceAllEntries(bookId, stored)

    const workspace = await fileStore.listWorkspaceEntries(bookId)
    expect(workspace.length).toBe(stored.length)
    expect(workspace[0]?.path).toBe('mimetype')
    expect(workspace[0]?.bytes?.toString('utf8')).toBe('application/epub+zip')

    const binaryRows = workspace.filter((row) => !row.isText && row.path !== 'mimetype')
    expect(binaryRows.length).toBeGreaterThan(0)
    for (const bin of binaryRows) {
      expect(bin.bytes).toBeNull()
      expect(bin.byteSize).toBeGreaterThan(0)
    }

    const textRows = workspace.filter((row) => row.isText)
    expect(textRows.length).toBeGreaterThan(0)
    for (const txt of textRows) {
      expect(txt.bytes).not.toBeNull()
      expect(txt.bytes?.byteLength).toBe(txt.byteSize)
    }

    const firstBin = binaryRows[0]!
    const fetchedBin = await fileStore.getEntry(bookId, firstBin.path)
    expect(fetchedBin?.bytes).toEqual(Buffer.from(opened.archive.entries.get(firstBin.path)!))

    const forPack = await fileStore.getAllEntriesForPack(bookId)
    expect(forPack.map((row) => row.path)).toEqual(stored.map((entry) => entry.path))
  })

  it('applies atomic deletes, two-phase swap renames, binary renames, and upserts with mimetype at 0', async () => {
    const bookId = await seedEmptyBookRow()
    const imgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    const ch1 = Buffer.from('<html/>')
    const ch2 = Buffer.from('<html id="2"/>')
    const drop = Buffer.from('<html id="drop"/>')

    await fileStore.replaceAllEntries(bookId, [
      { path: 'mimetype', position: 0, isText: false, mediaType: 'text/plain', bytes: Buffer.from('application/epub+zip'), sha256: sha256Hex(Buffer.from('application/epub+zip')) },
      { path: 'EPUB/ch1.xhtml', position: 1, isText: true, mediaType: 'application/xhtml+xml', bytes: ch1, sha256: sha256Hex(ch1) },
      { path: 'EPUB/ch2.xhtml', position: 2, isText: true, mediaType: 'application/xhtml+xml', bytes: ch2, sha256: sha256Hex(ch2) },
      { path: 'EPUB/drop.xhtml', position: 3, isText: true, mediaType: 'application/xhtml+xml', bytes: drop, sha256: sha256Hex(drop) },
      { path: 'EPUB/img/a.png', position: 4, isText: false, mediaType: 'image/png', bytes: imgBytes, sha256: sha256Hex(imgBytes) },
    ])

    const added = Buffer.from('<html id="new"/>')
    await db.transaction(async (tx) => {
      await fileStore.applyEntryDelta(
        bookId,
        {
          deletes: ['EPUB/drop.xhtml'],
          renames: [
            { from: 'EPUB/ch1.xhtml', to: 'EPUB/ch2.xhtml' },
            { from: 'EPUB/ch2.xhtml', to: 'EPUB/ch1.xhtml' },
            { from: 'EPUB/img/a.png', to: 'EPUB/img/renamed.png' },
          ],
          upserts: [
            {
              path: 'EPUB/new.xhtml',
              isText: true,
              mediaType: 'application/xhtml+xml',
              bytes: added,
              sha256: sha256Hex(added),
            },
          ],
          order: ['EPUB/new.xhtml', 'mimetype', 'EPUB/ch1.xhtml', 'EPUB/ch2.xhtml', 'EPUB/img/renamed.png'],
        },
        tx,
      )
    })

    const after = await fileStore.getAllEntriesForPack(bookId)
    expect(after.map((r) => r.path)).toEqual([
      'mimetype',
      'EPUB/new.xhtml',
      'EPUB/ch1.xhtml',
      'EPUB/ch2.xhtml',
      'EPUB/img/renamed.png',
    ])
    expect(after.find((r) => r.path === 'EPUB/ch1.xhtml')?.bytes).toEqual(ch2)
    expect(after.find((r) => r.path === 'EPUB/ch2.xhtml')?.bytes).toEqual(ch1)
    expect(after.find((r) => r.path === 'EPUB/img/renamed.png')?.bytes).toEqual(imgBytes)
    expect(after.find((r) => r.path === 'EPUB/drop.xhtml')).toBeUndefined()
  })

  it('backfills legacy book_files losslessly and drops book_files only on complete success', async () => {
    const bookId = await seedEmptyBookRow()
    const rawPack = Buffer.from(createEmptyEpub({ title: 'Legacy Book' }))
    const rawSha = createHash('sha256').update(rawPack).digest('hex')

    await sql`
      CREATE TABLE IF NOT EXISTS "book_files" (
        "book_id" uuid PRIMARY KEY NOT NULL REFERENCES "books"("id") ON DELETE cascade,
        "bytes" bytea NOT NULL,
        "byte_size" integer NOT NULL,
        "sha256" text NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `
    await sql`
      INSERT INTO "book_files" ("book_id", "bytes", "byte_size", "sha256")
      VALUES (${bookId}, ${rawPack}, ${rawPack.byteLength}, ${rawSha})
    `

    const res = await backfillBookEntries(db, sql)
    expect(res).toEqual({ migratedBooks: 1, droppedLegacyTable: true })

    const tableCheck = await sql<{ exists: boolean }[]>`SELECT to_regclass('public.book_files') IS NOT NULL AS exists`
    expect(tableCheck[0]?.exists).toBe(false)

    const entries = await fileStore.getAllEntriesForPack(bookId)
    const opened = openEpub(new Uint8Array(rawPack), nodeXmlParser)
    expect(entries.map((e) => e.path)).toEqual(opened.archive.order)
    for (const entry of entries) {
      expect(entry.bytes).toEqual(Buffer.from(opened.archive.entries.get(entry.path)!))
    }
  })

  it('aborts backfill and keeps book_files intact when a legacy row is corrupt', async () => {
    const bookId = await seedEmptyBookRow()
    const corrupt = Buffer.from('not-a-zip')

    await sql`
      CREATE TABLE IF NOT EXISTS "book_files" (
        "book_id" uuid PRIMARY KEY NOT NULL REFERENCES "books"("id") ON DELETE cascade,
        "bytes" bytea NOT NULL,
        "byte_size" integer NOT NULL,
        "sha256" text NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `
    await sql`
      INSERT INTO "book_files" ("book_id", "bytes", "byte_size", "sha256")
      VALUES (${bookId}, ${corrupt}, ${corrupt.byteLength}, 'bad')
    `

    try {
      await expect(backfillBookEntries(db, sql)).rejects.toThrow(/Aborting migration without dropping book_files/)

      const tableCheck = await sql<{ exists: boolean }[]>`SELECT to_regclass('public.book_files') IS NOT NULL AS exists`
      expect(tableCheck[0]?.exists).toBe(true)
    } finally {
      await sql`DROP TABLE IF EXISTS "book_files"`
    }
  })
})
