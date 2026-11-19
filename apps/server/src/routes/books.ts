import { and, desc, eq, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../db/client'
import { books, type Book, type User } from '../db/schema'
import { IngestError, ingestEpub } from '../epub/ingest'
import type { FileStore } from '../storage/fileStore'

const KEEP_VERSIONS = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

    await fileStore.put(book.id, 1, body, ingested.sha256, 'initial import')

    return reply.code(201).send({ book: toBookDto(book) })
  })

  app.get('/api/books/:id/epub', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    const book = await findOwnedBook(db, id, user.id)
    if (!book) return reply.code(404).send({ error: 'not_found' })

    const bytes = await fileStore.get(book.id, book.currentVersion)
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

    const nextVersion = book.currentVersion + 1

    await fileStore.put(book.id, nextVersion, body, ingested.sha256)

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

    await fileStore.prune(book.id, KEEP_VERSIONS)

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
