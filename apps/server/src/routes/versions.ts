import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../db/client'
import { books, type User } from '../db/schema'
import { IngestError, ingestEpub } from '../epub/ingest'
import type { FileStore } from '../storage/fileStore'
import { toBookDto } from './books'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface VersionDeps {
  db: Db
  fileStore: FileStore
}

function requireUser(request: FastifyRequest, reply: FastifyReply): User | null {
  if (!request.currentUser) {
    reply.code(401).send({ error: 'unauthenticated' })
    return null
  }
  return request.currentUser
}

export function registerVersionRoutes(app: FastifyInstance, deps: VersionDeps): void {
  const { db, fileStore } = deps

  app.get('/api/books/:id/versions', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    if (!UUID.test(id)) return reply.code(404).send({ error: 'not_found' })

    const rows = await db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.id, id), eq(books.ownerId, user.id)))
      .limit(1)
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' })

    const versions = await fileStore.list(id)
    return reply.send({
      versions: versions.map((entry) => ({
        versionNo: entry.versionNo,
        byteSize: entry.byteSize,
        sha256: entry.sha256,
        createdAt: entry.createdAt.toISOString(),
      })),
    })
  })

  app.get('/api/books/:id/versions/:version/epub', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id, version } = request.params as { id: string; version: string }
    if (!UUID.test(id)) return reply.code(404).send({ error: 'not_found' })

    const rows = await db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.id, id), eq(books.ownerId, user.id)))
      .limit(1)
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' })

    const versionNo = Number(version)
    if (!Number.isInteger(versionNo) || versionNo < 1) {
      return reply.code(400).send({ error: 'invalid_version' })
    }

    const bytes = await fileStore.get(id, versionNo)
    if (!bytes) return reply.code(404).send({ error: 'version_not_found' })

    return reply.header('content-type', 'application/epub+zip').send(bytes)
  })

  app.post('/api/books/:id/versions/:version/restore', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id, version } = request.params as { id: string; version: string }
    if (!UUID.test(id)) return reply.code(404).send({ error: 'not_found' })

    const rows = await db
      .select()
      .from(books)
      .where(and(eq(books.id, id), eq(books.ownerId, user.id)))
      .limit(1)
    const book = rows[0]
    if (!book) return reply.code(404).send({ error: 'not_found' })

    const versionNo = Number(version)
    if (!Number.isInteger(versionNo) || versionNo < 1) {
      return reply.code(400).send({ error: 'invalid_version' })
    }

    const bytes = await fileStore.get(book.id, versionNo)
    if (!bytes) return reply.code(404).send({ error: 'version_not_found' })

    let ingested: ReturnType<typeof ingestEpub>
    try {
      ingested = ingestEpub(bytes)
    } catch (error) {
      if (error instanceof IngestError) {
        return reply.code(400).send({ error: 'invalid_epub', message: error.message, issues: error.issues })
      }
      throw error
    }

    const nextVersion = book.currentVersion + 1
    await fileStore.put(book.id, nextVersion, bytes, ingested.sha256, `restored from v${versionNo}`)

    const updated = await db.transaction(async (tx) => {
      const result = await tx
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

      const row = result[0]
      if (!row) throw new Error('concurrent update detected')
      return row
    })

    await fileStore.prune(book.id)

    return reply.send({ book: toBookDto(updated), version: nextVersion, restoredFrom: versionNo })
  })
}
