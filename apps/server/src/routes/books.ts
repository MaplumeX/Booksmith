import { and, desc, eq, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { hasPageHistory, isTextEntry, zipArchive } from '@booksmith/core'
import type { Db } from '../db/client'
import { books, type Book, type User } from '../db/schema'
import {
  IngestError,
  inferMediaType,
  ingestEpub,
  nodeXmlParser,
  sha256Hex,
  validateEntriesAndExtractMeta,
} from '../epub/ingest'
import type { EntryDelta, FileStore, WorkspaceEntryRow } from '../storage/fileStore'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Same entry re-saved inside this window keeps its single snapshot: autosave fires far more often
 * than an edit phase changes. Manual checkpoints (`x-booksmith-checkpoint: manual`) bypass it.
 * See ADR 2026-11-19-autosave. */
const SNAPSHOT_WINDOW_MS = 10 * 60 * 1000

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8')

export function sha256(bytes: Uint8Array): string {
  return sha256Hex(bytes)
}

interface BookDeps {
  db: Db
  fileStore: FileStore
}

export interface WorkspaceEntryDto {
  path: string
  position: number
  isText: boolean
  mediaType: string
  byteSize: number
  sha256: string
}

function toEntryDto(row: WorkspaceEntryRow): WorkspaceEntryDto {
  return {
    path: row.path,
    position: row.position,
    isText: row.isText,
    mediaType: row.mediaType,
    byteSize: row.byteSize,
    sha256: row.sha256,
  }
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

/** `filename` must stay latin-1 representable, so non-ASCII titles fall back to `book.epub`. */
export function downloadName(title: string): { ascii: string; encoded: string } {
  const cleaned = title.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'book'
  const ascii = /^[\x20-\x7E]+$/.test(cleaned) ? cleaned : 'book'
  return { ascii: `${ascii}.epub`, encoded: encodeURIComponent(`${cleaned}.epub`) }
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

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false
  return header
    .split(',')
    .map((part) => part.trim())
    .some((part) => part === '*' || part === etag || part === `W/${etag}`)
}

class InvalidDeltaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidDeltaError'
  }
}

function assertValidPath(path: unknown, label: string): string {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) {
    throw new InvalidDeltaError(`invalid ${label} path`)
  }
  return path
}

interface ParsedDeltaRequest {
  delta: EntryDelta
}

function parseOpsObject(
  raw: Record<string, unknown>,
  binaryUpserts: Map<string, { bytes: Buffer; mediaType?: string }>,
): ParsedDeltaRequest {
  const deletes: string[] = []
  if (raw.deletes !== undefined) {
    if (!Array.isArray(raw.deletes)) throw new InvalidDeltaError('deletes must be an array')
    for (const item of raw.deletes) {
      const path = assertValidPath(item, 'delete')
      if (path === 'mimetype') throw new InvalidDeltaError('cannot delete mimetype')
      deletes.push(path)
    }
  }

  const renames: Array<{ from: string; to: string }> = []
  if (raw.renames !== undefined) {
    if (!Array.isArray(raw.renames)) throw new InvalidDeltaError('renames must be an array')
    for (const item of raw.renames) {
      if (!item || typeof item !== 'object') throw new InvalidDeltaError('rename item must be an object')
      const pair = item as { from?: unknown; to?: unknown }
      const from = assertValidPath(pair.from, 'rename.from')
      const to = assertValidPath(pair.to, 'rename.to')
      if (from === 'mimetype' || to === 'mimetype') throw new InvalidDeltaError('cannot rename mimetype')
      renames.push({ from, to })
    }
  }

  const upserts: EntryDelta['upserts'] = []
  const seenUpsertPaths = new Set<string>()
  const binaryMediaTypes =
    raw.binaryMediaTypes && typeof raw.binaryMediaTypes === 'object'
      ? (raw.binaryMediaTypes as Record<string, unknown>)
      : {}

  if (raw.textUpserts !== undefined) {
    if (!raw.textUpserts || typeof raw.textUpserts !== 'object' || Array.isArray(raw.textUpserts)) {
      throw new InvalidDeltaError('textUpserts must be a record')
    }
    for (const [rawPath, text] of Object.entries(raw.textUpserts as Record<string, unknown>)) {
      const path = assertValidPath(rawPath, 'textUpsert')
      if (typeof text !== 'string') throw new InvalidDeltaError(`textUpsert for ${path} must be a string`)
      const buf = Buffer.from(textEncoder.encode(text))
      upserts.push({
        path,
        isText: isTextEntry(path),
        mediaType: inferMediaType(path),
        bytes: buf,
        sha256: sha256Hex(buf),
      })
      seenUpsertPaths.add(path)
    }
  }

  for (const [path, file] of binaryUpserts) {
    if (seenUpsertPaths.has(path)) continue
    const explicitMime = typeof binaryMediaTypes[path] === 'string' ? (binaryMediaTypes[path] as string) : ''
    const mediaType = explicitMime || file.mediaType || inferMediaType(path)
    upserts.push({
      path,
      isText: isTextEntry(path),
      mediaType,
      bytes: file.bytes,
      sha256: sha256Hex(file.bytes),
    })
  }

  let order: string[] | undefined
  if (raw.order !== undefined) {
    if (!Array.isArray(raw.order)) throw new InvalidDeltaError('order must be an array')
    order = raw.order.map((item) => assertValidPath(item, 'order'))
  }

  return { delta: { deletes, renames, upserts, order } }
}

async function parseDeltaRequest(request: FastifyRequest): Promise<ParsedDeltaRequest | null> {
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase()
  if (contentType.startsWith('application/json')) {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      throw new InvalidDeltaError('expected JSON object')
    }
    return parseOpsObject(request.body as Record<string, unknown>, new Map())
  }

  if (contentType.startsWith('multipart/form-data')) {
    const rawBuf = Buffer.isBuffer(request.body) ? request.body : null
    if (!rawBuf) return null
    let formData: FormData
    try {
      const bytes = new Uint8Array(rawBuf.byteLength)
      bytes.set(rawBuf)
      formData = await new Response(bytes, {
        headers: { 'content-type': String(request.headers['content-type']) },
      }).formData()
    } catch (error) {
      throw new InvalidDeltaError(`malformed multipart body: ${(error as Error).message}`)
    }

    const opsField = formData.get('ops')
    if (typeof opsField !== 'string') throw new InvalidDeltaError('missing ops JSON field')
    let ops: Record<string, unknown>
    try {
      const parsed = JSON.parse(opsField) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('ops must be an object')
      }
      ops = parsed as Record<string, unknown>
    } catch (error) {
      throw new InvalidDeltaError(`invalid ops JSON: ${(error as Error).message}`)
    }

    const binaryUpserts = new Map<string, { bytes: Buffer; mediaType?: string }>()
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith('bin:')) continue
      const path = assertValidPath(key.slice(4), 'binaryUpsert')
      if (typeof value === 'string') {
        throw new InvalidDeltaError(`binary part for ${path} must be a file`)
      }
      const bytes = Buffer.from(await value.arrayBuffer())
      binaryUpserts.set(path, {
        bytes,
        mediaType: value.type && value.type !== 'application/octet-stream' ? value.type : undefined,
      })
    }

    return parseOpsObject(ops, binaryUpserts)
  }

  return null
}

class ConcurrentUpdateError extends Error {
  constructor() {
    super('concurrent update detected')
    this.name = 'ConcurrentUpdateError'
  }
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

    // Unpack once on import into `book_entries` + baseline `page_versions` inside one transaction.
    // See ADR 2026-11-20-entry-level-book-storage.
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

      await fileStore.replaceAllEntries(created.id, ingested.entries, tx)
      for (const entry of ingested.entries) {
        if (hasPageHistory(entry.path)) {
          await fileStore.putPageVersion(created.id, entry.path, entry.bytes, entry.sha256, tx)
        }
      }

      return created
    })

    return reply.code(201).send({ book: toBookDto(book) })
  })

  /**
   * Returns entry metadata for the whole book plus decoded text for all text entries and `mimetype`.
   * Binary assets (images, fonts, media) are excluded and fetched on demand via `/entry`.
   * See ADR 2026-11-20-entry-level-book-storage.
   */
  app.get('/api/books/:id/workspace', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    const book = await findOwnedBook(db, id, user.id)
    if (!book) return reply.code(404).send({ error: 'not_found' })

    const etag = `"${book.currentVersion}"`
    if (etagMatches(request.headers['if-none-match'] as string | undefined, etag)) {
      return reply
        .code(304)
        .header('etag', etag)
        .header('cache-control', 'private, no-cache')
        .send()
    }

    const rows = await fileStore.listWorkspaceEntries(book.id)
    if (rows.length === 0) return reply.code(410).send({ error: 'version_missing' })

    const texts: Record<string, string> = {}
    for (const row of rows) {
      if (row.bytes !== null) {
        texts[row.path] = textDecoder.decode(row.bytes)
      }
    }

    return reply
      .header('etag', etag)
      .header('cache-control', 'private, no-cache')
      .send({
        version: book.currentVersion,
        entries: rows.map(toEntryDto),
        texts,
      })
  })

  /**
   * Serves a single unpacked entry by query `path`, used for lazy binary asset delivery in preview,
   * WYSIWYG, and MediaPane. Supports ETag 304 and immutable caching when `sha` matches.
   * See ADR 2026-11-20-entry-level-book-storage.
   */
  app.get('/api/books/:id/entry', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    const query = (request.query ?? {}) as { path?: string; sha?: string }
    if (typeof query.path !== 'string' || !query.path.trim() || query.path.includes('\0')) {
      return reply.code(400).send({ error: 'invalid_path' })
    }

    const book = await findOwnedBook(db, id, user.id)
    if (!book) return reply.code(404).send({ error: 'not_found' })

    const entry = await fileStore.getEntry(book.id, query.path)
    if (!entry) return reply.code(404).send({ error: 'not_found' })

    const etag = `"${entry.sha256}"`
    const cacheControl =
      typeof query.sha === 'string' && query.sha === entry.sha256
        ? 'private, max-age=31536000, immutable'
        : 'private, no-cache'

    if (etagMatches(request.headers['if-none-match'] as string | undefined, etag)) {
      return reply
        .code(304)
        .header('etag', etag)
        .header('cache-control', cacheControl)
        .header('x-content-type-options', 'nosniff')
        .send()
    }

    reply
      .header('content-type', entry.mediaType || 'application/octet-stream')
      .header('etag', etag)
      .header('cache-control', cacheControl)
      .header('x-content-type-options', 'nosniff')

    if (entry.mediaType.toLowerCase().includes('svg')) {
      reply.header('content-security-policy', 'sandbox')
    }

    return reply.send(entry.bytes)
  })

  /**
   * Atomic incremental save: applies deletes, zero-byte renames, and text/binary upserts inside
   * one transaction, validates structure against the unpacked entries, updates metadata & cover,
   * and records page-level snapshots for changed text entries without repacking any zip.
   * See ADR 2026-11-20-entry-level-book-storage.
   */
  app.patch('/api/books/:id/entries', async (request, reply) => {
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

    let parsed: ParsedDeltaRequest | null
    try {
      parsed = await parseDeltaRequest(request)
    } catch (error) {
      if (error instanceof InvalidDeltaError) {
        return reply.code(400).send({ error: 'invalid_delta', message: error.message })
      }
      throw error
    }
    if (!parsed) return reply.code(415).send({ error: 'expected_delta_body' })

    const force = request.headers['x-booksmith-checkpoint'] === 'manual'

    try {
      const result = await db.transaction(async (tx) => {
        const beforeRows = await fileStore.listWorkspaceEntries(book.id, tx)
        if (beforeRows.length === 0) return { missing: true as const }

        const beforeTextSha = new Map<string, string>()
        for (const row of beforeRows) {
          if (hasPageHistory(row.path)) beforeTextSha.set(row.path, row.sha256)
        }

        await fileStore.applyEntryDelta(book.id, parsed.delta, tx)

        const afterRows = await fileStore.listWorkspaceEntries(book.id, tx)
        const validated = validateEntriesAndExtractMeta(afterRows, nodeXmlParser)

        if (validated.sha256 === book.sha256) {
          return {
            missing: false as const,
            book,
            version: book.currentVersion,
            entries: afterRows.map(toEntryDto),
          }
        }

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
        if (!updated) throw new ConcurrentUpdateError()

        for (const row of afterRows) {
          if (!hasPageHistory(row.path) || row.bytes === null) continue
          if (beforeTextSha.get(row.path) === row.sha256) continue
          const newest = await fileStore.newestFor(book.id, row.path, tx)
          if (newest?.sha256 === row.sha256) continue
          if (!force && newest && Date.now() - newest.createdAt.getTime() < SNAPSHOT_WINDOW_MS) continue
          await fileStore.putPageVersion(book.id, row.path, row.bytes, row.sha256, tx)
        }

        await fileStore.prunePages(book.id, tx)

        return {
          missing: false as const,
          book: updated,
          version: nextVersion,
          entries: afterRows.map(toEntryDto),
        }
      })

      if (result.missing) return reply.code(410).send({ error: 'version_missing' })
      return reply.send({
        book: toBookDto(result.book),
        version: result.version,
        entries: result.entries,
      })
    } catch (error) {
      if (error instanceof IngestError) {
        return reply.code(400).send({ error: 'invalid_epub', message: error.message, issues: error.issues })
      }
      if (error instanceof ConcurrentUpdateError) {
        const latest = await findOwnedBook(db, book.id, user.id)
        return reply.code(409).send({ error: 'version_conflict', currentVersion: latest?.currentVersion ?? book.currentVersion })
      }
      if (error instanceof Error && error.message.startsWith('rename source not found:')) {
        return reply.code(400).send({ error: 'invalid_delta', message: error.message })
      }
      throw error
    }
  })

  /**
   * The current saved book packed on demand from `book_entries` in original `position` order.
   * Unsaved editor changes are not included. See ADR 2026-11-19-epub-export and
   * ADR 2026-11-20-entry-level-book-storage.
   */
  app.get('/api/books/:id/download', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    const book = await findOwnedBook(db, id, user.id)
    if (!book) return reply.code(404).send({ error: 'not_found' })

    const rows = await fileStore.getAllEntriesForPack(book.id)
    if (rows.length === 0) return reply.code(410).send({ error: 'version_missing' })

    const order = rows.map((row) => row.path)
    const entries = new Map<string, Uint8Array>(rows.map((row) => [row.path, new Uint8Array(row.bytes)]))
    const bytes = Buffer.from(zipArchive({ order, entries }))

    const name = downloadName(book.title)
    return reply
      .header('content-type', 'application/epub+zip')
      .header('content-disposition', `attachment; filename="${name.ascii}"; filename*=UTF-8''${name.encoded}`)
      .send(bytes)
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
