import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isTextEntry } from '@booksmith/core'
import type { Db } from '../db/client'
import { books, type User } from '../db/schema'
import {
  IngestError,
  inferMediaType,
  nodeXmlParser,
  sha256Hex,
  validateEntriesAndExtractMeta,
} from '../epub/ingest'
import type { FileStore } from '../storage/fileStore'
import { toBookDto } from './books'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface PageVersionDeps {
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

function findOwnedBook(db: Db, id: string | undefined, ownerId: string) {
  if (!id || !UUID.test(id)) return Promise.resolve(null)
  return db
    .select()
    .from(books)
    .where(and(eq(books.id, id), eq(books.ownerId, ownerId)))
    .limit(1)
    .then((rows) => rows[0] ?? null)
}

/**
 * Page-level snapshot history: one list per book, restored one entry at a time directly into
 * `book_entries` without unpacking or repacking any zip.
 * See ADR 2026-11-19-page-level-snapshots and ADR 2026-11-20-entry-level-book-storage.
 */
export function registerPageVersionRoutes(app: FastifyInstance, deps: PageVersionDeps): void {
  const { db, fileStore } = deps

  app.get('/api/books/:id/page-versions', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    const book = await findOwnedBook(db, id, user.id)
    if (!book) return reply.code(404).send({ error: 'not_found' })

    const snapshots = await fileStore.listPageVersions(book.id)
    return reply.send({
      snapshots: snapshots.map((entry) => ({
        id: entry.id,
        path: entry.path,
        byteSize: entry.byteSize,
        sha256: entry.sha256,
        pinned: entry.pinned,
        createdAt: entry.createdAt.toISOString(),
      })),
    })
  })

  app.get('/api/books/:id/page-versions/:snapshot', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id, snapshot } = request.params as { id: string; snapshot: string }
    if (!UUID.test(snapshot)) return reply.code(404).send({ error: 'not_found' })
    const book = await findOwnedBook(db, id, user.id)
    if (!book) return reply.code(404).send({ error: 'not_found' })

    const stored = await fileStore.getPageVersion(book.id, snapshot)
    if (!stored) return reply.code(404).send({ error: 'snapshot_not_found' })

    return reply.header('content-type', 'text/plain; charset=utf-8').send(stored.bytes)
  })

  /**
   * Protects a snapshot from the per-entry cap. Pinned snapshots cost no slot and are never
   * thinned by the sparse-day rule. See ADR 2026-11-19-snapshot-pinning.
   */
  app.patch('/api/books/:id/page-versions/:snapshot', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id, snapshot } = request.params as { id: string; snapshot: string }
    if (!UUID.test(snapshot)) return reply.code(404).send({ error: 'not_found' })
    const book = await findOwnedBook(db, id, user.id)
    if (!book) return reply.code(404).send({ error: 'not_found' })

    const body = request.body as { pinned?: unknown } | null
    if (typeof body?.pinned !== 'boolean') return reply.code(400).send({ error: 'invalid_body' })

    const updated = await fileStore.setPinned(book.id, snapshot, body.pinned)
    if (!updated) return reply.code(404).send({ error: 'snapshot_not_found' })

    return reply.send({
      snapshot: {
        id: updated.id,
        path: updated.path,
        byteSize: updated.byteSize,
        sha256: updated.sha256,
        pinned: updated.pinned,
        createdAt: updated.createdAt.toISOString(),
      },
    })
  })

  app.post('/api/books/:id/page-versions/:snapshot/restore', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id, snapshot } = request.params as { id: string; snapshot: string }
    if (!UUID.test(snapshot)) return reply.code(404).send({ error: 'not_found' })
    const book = await findOwnedBook(db, id, user.id)
    if (!book) return reply.code(404).send({ error: 'not_found' })

    const stored = await fileStore.getPageVersion(book.id, snapshot)
    if (!stored) return reply.code(404).send({ error: 'snapshot_not_found' })

    const hash = sha256Hex(stored.bytes)

    try {
      const result = await db.transaction(async (tx) => {
        const existing = await fileStore.listWorkspaceEntries(book.id, tx)
        if (existing.length === 0) return { missing: true as const }

        await fileStore.applyEntryDelta(
          book.id,
          {
            deletes: [],
            renames: [],
            upserts: [
              {
                path: stored.path,
                isText: isTextEntry(stored.path),
                mediaType: inferMediaType(stored.path),
                bytes: stored.bytes,
                sha256: hash,
              },
            ],
          },
          tx,
        )

        const afterRows = await fileStore.listWorkspaceEntries(book.id, tx)
        const validated = validateEntriesAndExtractMeta(afterRows, nodeXmlParser)

        let coverBytes: Buffer | null = null
        let coverMime: string | null = null
        if (validated.coverPath) {
          const coverRow = await fileStore.getEntry(book.id, validated.coverPath, tx)
          if (coverRow) {
            coverBytes = coverRow.bytes
            coverMime = validated.coverMime
          }
        }

        const nextVersion = book.currentVersion + 1
        const rows = await tx
          .update(books)
          .set({
            title: validated.title,
            author: validated.author,
            language: validated.language,
            identifier: validated.identifier,
            chapterCount: validated.chapterCount,
            byteSize: validated.byteSize,
            sha256: validated.sha256,
            cover: coverBytes,
            coverMime,
            currentVersion: nextVersion,
            updatedAt: new Date(),
          })
          .where(and(eq(books.id, book.id), eq(books.currentVersion, book.currentVersion)))
          .returning()

        const updated = rows[0]
        if (!updated) throw new Error('concurrent update detected')

        await fileStore.putPageVersion(book.id, stored.path, stored.bytes, hash, tx)
        await fileStore.prunePages(book.id, tx)

        return { missing: false as const, updated, nextVersion }
      })

      if (result.missing) return reply.code(410).send({ error: 'version_missing' })
      return reply.send({ book: toBookDto(result.updated), version: result.nextVersion, path: stored.path })
    } catch (error) {
      if (error instanceof IngestError) {
        return reply.code(400).send({ error: 'invalid_epub', message: error.message, issues: error.issues })
      }
      throw error
    }
  })
}
