import { createHash } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { hasPageHistory, openEpub, type EpubArchive } from '@booksmith/core'
import type { Db } from '../db/client'
import { books, type Book, type User } from '../db/schema'
import { IngestError, ingestEpub, nodeXmlParser } from '../epub/ingest'
import type { FileStore } from '../storage/fileStore'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Same entry re-saved inside this window keeps its single snapshot: autosave fires far more often
 * than an edit phase changes. Manual checkpoints (`x-booksmith-checkpoint: manual`) bypass it.
 * See ADR 2026-11-19-autosave. */
const SNAPSHOT_WINDOW_MS = 10 * 60 * 1000

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false
  return true
}

/**
 * Text entries whose bytes differ from the pack we are replacing. Binaries and zip metadata are
 * excluded, so adding an image does not create a page snapshot.
 * See ADR 2026-11-19-page-level-snapshots.
 */
export function changedTextEntries(previous: Buffer | null, next: EpubArchive): Array<[string, Uint8Array]> {
  const before = previous ? openEpub(new Uint8Array(previous), nodeXmlParser).archive.entries : new Map<string, Uint8Array>()
  const changed: Array<[string, Uint8Array]> = []
  for (const [path, bytes] of next.entries) {
    if (!hasPageHistory(path)) continue
    if (sameBytes(before.get(path), bytes)) continue
    changed.push([path, bytes])
  }
  return changed
}

interface BookDeps {
  db: Db
  fileStore: FileStore
}

export function toBookDto(book: Book) {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    language: book.language,
    identifier: book.identifier,
    chapterCount: book.chapterCount,
    byteSize: book.byteSize,
    currentVersion: book.currentVersion,
    updatedAt: book.updatedAt.toISOString(),
    hasCover: book.cover !== null,
  }
}

function requireUser(request: FastifyRequest, reply: FastifyReply): User | null {
  if (!request.currentUser) {
    reply.code(401).send({ error: 'unauthenticated' })
    return null
  }
  return request.currentUser
}

async function findOwnedBook(db: Db, id: string | undefined, ownerId: string): Promise<Book | null> {
  if (!id || !UUID.test(id)) return null
  const rows = await db
    .select()
    .from(books)
    .where(and(eq(books.id, id), eq(books.ownerId, ownerId)))
    .limit(1)
  return rows[0] ?? null
}

function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null
  const match = header.replace(/W\//, '').replace(/"/g, '').trim()
  const value = Number(match)
  return Number.isInteger(value) && value > 0 ? value : null
}

export function registerBookRoutes(app: FastifyInstance, deps: BookDeps): void {
  const { db, fileStore } = deps

  app.get('/api/books', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const rows = await db
      .select({
        id: books.id,
        title: books.title,
        author: books.author,
        language: books.language,
        identifier: books.identifier,
        chapterCount: books.chapterCount,
        byteSize: books.byteSize,
        currentVersion: books.currentVersion,
        updatedAt: books.updatedAt,
        hasCover: sql<boolean>`${books.cover} is not null`,
      })
      .from(books)
      .where(eq(books.ownerId, user.id))
      .orderBy(desc(books.updatedAt))

    return reply.send({
      books: rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
    })
  })

  app.post('/api/books', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const body = Buffer.isBuffer(request.body) ? request.body : null
    if (!body) return reply.code(415).send({ error: 'expected_epub_body' })

    let ingested: ReturnType<typeof ingestEpub>
    try {
      ingested = ingestEpub(body)
    } catch (error) {
      if (error instanceof IngestError) {
        return reply.code(400).send({ error: 'invalid_epub', message: error.message, issues: error.issues })
      }
      throw error
    }

    const book = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(books)
        .values({
          ownerId: user.id,
          title: ingested.title,
          author: ingested.author,
          language: ingested.language,
          identifier: ingested.identifier,
          chapterCount: ingested.chapterCount,
          byteSize: ingested.byteSize,
          sha256: ingested.sha256,
          cover: ingested.cover?.bytes ?? null,
          coverMime: ingested.cover?.mimeType ?? null,
          currentVersion: 1,
        })
        .returning()

      const created = inserted[0]
      if (!created) throw new Error('insert returned no row')
      return created
    })

    await fileStore.putCurrent(book.id, body, ingested.sha256)
    // The import is the baseline of every entry's history, so the first snapshot is not the first edit.
    for (const [path, bytes] of ingested.archive.entries) {
      if (hasPageHistory(path)) await fileStore.putPageVersion(book.id, path, Buffer.from(bytes), sha256(bytes))
    }

    return reply.code(201).send({ book: toBookDto(book) })
  })

  app.get('/api/books/:id/epub', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    const book = await findOwnedBook(db, id, user.id)
    if (!book) return reply.code(404).send({ error: 'not_found' })

    const bytes = await fileStore.getCurrent(book.id)
    if (!bytes) return reply.code(410).send({ error: 'version_missing' })

    return reply
      .header('content-type', 'application/epub+zip')
      .header('etag', `"${book.currentVersion}"`)
      .send(bytes)
  })

  app.put('/api/books/:id/epub', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    const book = await findOwnedBook(db, id, user.id)
    if (!book) return reply.code(404).send({ error: 'not_found' })

    const ifMatch = parseIfMatch(request.headers['if-match'] as string | undefined)
    if (ifMatch === null) return reply.code(428).send({ error: 'if_match_required' })
    if (ifMatch !== book.currentVersion) {
      return reply.code(409).send({ error: 'version_conflict', currentVersion: book.currentVersion })
    }

    const body = Buffer.isBuffer(request.body) ? request.body : null
    if (!body) return reply.code(415).send({ error: 'expected_epub_body' })

    let ingested: ReturnType<typeof ingestEpub>
    try {
      ingested = ingestEpub(body)
    } catch (error) {
      if (error instanceof IngestError) {
        return reply.code(400).send({ error: 'invalid_epub', message: error.message, issues: error.issues })
      }
      throw error
    }

    // Nothing changed byte-wise: return the current version instead of writing a row and bumping it.
    if (ingested.sha256 === book.sha256) {
      return reply.send({ book: toBookDto(book), version: book.currentVersion })
    }

    const previous = await fileStore.getCurrent(book.id)
    const nextVersion = book.currentVersion + 1

    await fileStore.putCurrent(book.id, body, ingested.sha256)

    const updated = await db.transaction(async (tx) => {
      const rows = await tx
        .update(books)
        .set({
          title: ingested.title,
          author: ingested.author,
          language: ingested.language,
          identifier: ingested.identifier,
          chapterCount: ingested.chapterCount,
          byteSize: ingested.byteSize,
          sha256: ingested.sha256,
          cover: ingested.cover?.bytes ?? null,
          coverMime: ingested.cover?.mimeType ?? null,
          currentVersion: nextVersion,
          updatedAt: new Date(),
        })
        .where(and(eq(books.id, book.id), eq(books.currentVersion, book.currentVersion)))
        .returning()

      const row = rows[0]
      if (!row) throw new Error('concurrent update detected')
      return row
    })

    const force = request.headers['x-booksmith-checkpoint'] === 'manual'
    for (const [path, bytes] of changedTextEntries(previous, ingested.archive)) {
      const hash = sha256(bytes)
      const newest = await fileStore.newestFor(book.id, path)
      if (newest?.sha256 === hash) continue
      if (!force && newest && Date.now() - newest.createdAt.getTime() < SNAPSHOT_WINDOW_MS) continue
      await fileStore.putPageVersion(book.id, path, Buffer.from(bytes), hash)
    }

    await fileStore.prunePages(book.id)

    return reply.send({ book: toBookDto(updated), version: nextVersion })
  })

  app.get('/api/books/:id/cover', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    const book = await findOwnedBook(db, id, user.id)
    if (!book?.cover) return reply.code(404).send({ error: 'not_found' })

    return reply.header('content-type', book.coverMime ?? 'application/octet-stream').send(book.cover)
  })

  app.delete('/api/books/:id', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    const book = await findOwnedBook(db, id, user.id)
    if (!book) return reply.code(404).send({ error: 'not_found' })

    await db.delete(books).where(eq(books.id, book.id))
    return reply.code(204).send()
  })
}
