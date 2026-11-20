import { readFileSync } from 'node:fs'
import { openEpub, unzipArchive } from '@booksmith/core'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createDb } from '../src/db/client'
import { books, sessions, users } from '../src/db/schema'
import { nodeXmlParser } from '../src/epub/ingest'
import { TEST_URL } from './global-setup'

const FIXTURE = new Uint8Array(readFileSync(new URL('../../../fixtures/马克思经济学与数理分析.epub', import.meta.url)))
const FIXTURE_BUFFER = Buffer.from(FIXTURE)
const FIXTURE_OPENED = openEpub(FIXTURE, nodeXmlParser)
const FIXTURE_UNPACKED_BYTES = [...FIXTURE_OPENED.archive.entries.values()].reduce(
  (sum, bytes) => sum + bytes.byteLength,
  0,
)
const ALLOWED = ['lib@booksmith.test', 'other@booksmith.test']
const PASSWORD = 'correct horse battery'

const EDITED_CHAPTER_HTML =
  '<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>改过的章节</title></head><body><p>改过的章节</p></body></html>\n'

let app: FastifyInstance
let store: ReturnType<typeof createDb>
let libCookie: string
let otherCookie: string

async function registerAndLogin(email: string): Promise<string> {
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: PASSWORD } })
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } })
  const cookie = login.cookies.find((entry) => entry.name === 'bs_session')
  if (!cookie) throw new Error('missing session cookie')
  return `bs_session=${cookie.value}`
}

async function uploadBook(cookie: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/books',
    headers: { cookie, 'content-type': 'application/epub+zip' },
    payload: FIXTURE_BUFFER,
  })
  expect(response.statusCode).toBe(201)
  return (response.json() as { book: { id: string } }).book.id
}

async function serializeFormData(fd: FormData): Promise<{ contentType: string; payload: Buffer }> {
  const req = new Request('http://localhost/entries', { method: 'PATCH', body: fd })
  const contentType = req.headers.get('content-type')!
  const payload = Buffer.from(await req.arrayBuffer())
  return { contentType, payload }
}

beforeAll(async () => {
  app = await createApp({
    databaseUrl: TEST_URL,
    config: { databaseUrl: TEST_URL, allowedEmails: ALLOWED, sessionTtlDays: 30, cookieSecure: false },
  })
  store = createDb(TEST_URL)
})

afterAll(async () => {
  await app.close()
  await store.sql.end()
})

beforeEach(async () => {
  await store.db.delete(books)
  await store.db.delete(sessions)
  await store.db.delete(users)
  libCookie = await registerAndLogin('lib@booksmith.test')
  otherCookie = await registerAndLogin('other@booksmith.test')
})

describe('library access', () => {
  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/books' })
    expect(response.statusCode).toBe(401)
  })

  it('starts empty for a fresh account', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/books', headers: { cookie: libCookie } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ books: [] })
  })
})

describe('upload, workspace, entry fetch, and download', () => {
  it('ingests the real book with metadata, chapter count, unpacked size, and cover', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/books',
      headers: { cookie: libCookie, 'content-type': 'application/epub+zip' },
      payload: FIXTURE_BUFFER,
    })
    expect(response.statusCode).toBe(201)
    const book = (response.json() as { book: Record<string, unknown> }).book
    expect(book.title).toBe('马克思经济学与数理分析')
    expect(book.chapterCount).toBe(28)
    expect(book.byteSize).toBe(FIXTURE_UNPACKED_BYTES)
    expect(book.hasCover).toBe(true)
    expect(book.currentVersion).toBe(1)
  })

  it('returns workspace entries and texts without binary payloads, and honors 304', async () => {
    const id = await uploadBook(libCookie)
    const response = await app.inject({
      method: 'GET',
      url: `/api/books/${id}/workspace`,
      headers: { cookie: libCookie },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['etag']).toBe('"1"')
    expect(response.headers['cache-control']).toBe('private, no-cache')

    const body = response.json() as {
      version: number
      entries: Array<{ path: string; position: number; isText: boolean; mediaType: string; byteSize: number; sha256: string }>
      texts: Record<string, string>
    }
    expect(body.version).toBe(1)
    expect(body.entries.length).toBe(FIXTURE_OPENED.archive.order.length)
    expect(body.entries[0]?.path).toBe('mimetype')
    expect(body.texts['mimetype']).toBe('application/epub+zip')
    expect(body.texts['EPUB/text/ch003.xhtml']).toBeTruthy()

    const binaryEntries = body.entries.filter((entry) => !entry.isText && entry.path !== 'mimetype')
    expect(binaryEntries.length).toBeGreaterThan(0)
    for (const bin of binaryEntries) {
      expect(body.texts[bin.path]).toBeUndefined()
    }

    const cached = await app.inject({
      method: 'GET',
      url: `/api/books/${id}/workspace`,
      headers: { cookie: libCookie, 'if-none-match': '"1"' },
    })
    expect(cached.statusCode).toBe(304)
  })

  it('serves individual binary entries with immutable sha caching, 304, and nosniff', async () => {
    const id = await uploadBook(libCookie)
    const ws = (
      await app.inject({ method: 'GET', url: `/api/books/${id}/workspace`, headers: { cookie: libCookie } })
    ).json() as { entries: Array<{ path: string; isText: boolean; mediaType: string; sha256: string }> }
    const bin = ws.entries.find((entry) => !entry.isText && entry.path !== 'mimetype')!

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/books/${id}/entry?path=${encodeURIComponent(bin.path)}&sha=${bin.sha256}`,
      headers: { cookie: libCookie },
    })
    expect(fetched.statusCode).toBe(200)
    expect(fetched.headers['content-type']).toBe(bin.mediaType)
    expect(fetched.headers['etag']).toBe(`"${bin.sha256}"`)
    expect(fetched.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(fetched.headers['x-content-type-options']).toBe('nosniff')
    expect(new Uint8Array(fetched.rawPayload)).toEqual(FIXTURE_OPENED.archive.entries.get(bin.path))

    const notModified = await app.inject({
      method: 'GET',
      url: `/api/books/${id}/entry?path=${encodeURIComponent(bin.path)}&sha=${bin.sha256}`,
      headers: { cookie: libCookie, 'if-none-match': `"${bin.sha256}"` },
    })
    expect(notModified.statusCode).toBe(304)
  })

  it('retires legacy /epub endpoints', async () => {
    const id = await uploadBook(libCookie)
    const getLegacy = await app.inject({ method: 'GET', url: `/api/books/${id}/epub`, headers: { cookie: libCookie } })
    expect(getLegacy.statusCode).toBe(404)
    const putLegacy = await app.inject({
      method: 'PUT',
      url: `/api/books/${id}/epub`,
      headers: { cookie: libCookie, 'content-type': 'application/epub+zip', 'if-match': '"1"' },
      payload: FIXTURE_BUFFER,
    })
    expect(putLegacy.statusCode).toBe(404)
  })

  it('serves the cover image', async () => {
    const id = await uploadBook(libCookie)
    const response = await app.inject({
      method: 'GET',
      url: `/api/books/${id}/cover`,
      headers: { cookie: libCookie },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('image/jpeg')
    expect(response.rawPayload.byteLength).toBeGreaterThan(1000)
  })

  it('downloads an on-demand packed epub with byte-identical entries and original order', async () => {
    const id = await uploadBook(libCookie)
    const response = await app.inject({
      method: 'GET',
      url: `/api/books/${id}/download`,
      headers: { cookie: libCookie },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/epub+zip')

    const disposition = String(response.headers['content-disposition'])
    expect(disposition).toContain('attachment;')
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1] ?? '')).toBe('马克思经济学与数理分析.epub')

    const downloaded = unzipArchive(new Uint8Array(response.rawPayload))
    expect(downloaded.order).toEqual(FIXTURE_OPENED.archive.order)
    for (const [path, bytes] of FIXTURE_OPENED.archive.entries) {
      expect(downloaded.entries.get(path), path).toEqual(bytes)
    }
  })

  it('requires a session to download', async () => {
    const id = await uploadBook(libCookie)
    const response = await app.inject({ method: 'GET', url: `/api/books/${id}/download` })
    expect(response.statusCode).toBe(401)
  })

  it('rejects uploads that are not epubs', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/books',
      headers: { cookie: libCookie, 'content-type': 'application/epub+zip' },
      payload: Buffer.from('definitely not a zip'),
    })
    expect(response.statusCode).toBe(400)
    expect((response.json() as { error: string }).error).toBe('invalid_epub')
  })

  it('hides other users books behind 404', async () => {
    const id = await uploadBook(otherCookie)
    const read = await app.inject({
      method: 'GET',
      url: `/api/books/${id}/workspace`,
      headers: { cookie: libCookie },
    })
    expect(read.statusCode).toBe(404)
    const list = await app.inject({ method: 'GET', url: '/api/books', headers: { cookie: libCookie } })
    expect((list.json() as { books: unknown[] }).books).toHaveLength(0)
  })

  it('rejects a malformed book id without touching the database', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/books/not-a-uuid/workspace',
      headers: { cookie: libCookie },
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('incremental saving via PATCH /entries', () => {
  it('increments the version when If-Match matches a JSON text delta', async () => {
    const id = await uploadBook(libCookie)
    const save = await app.inject({
      method: 'PATCH',
      url: `/api/books/${id}/entries`,
      headers: { cookie: libCookie, 'content-type': 'application/json', 'if-match': '"1"' },
      payload: { textUpserts: { 'EPUB/text/ch003.xhtml': EDITED_CHAPTER_HTML } },
    })
    expect(save.statusCode).toBe(200)
    expect((save.json() as { version: number }).version).toBe(2)

    const list = await app.inject({ method: 'GET', url: '/api/books', headers: { cookie: libCookie } })
    const book = (list.json() as { books: Array<{ currentVersion: number }> }).books[0]
    expect(book?.currentVersion).toBe(2)
  })

  it('applies binary upsert via multipart FormData and zero-byte binary rename atomically', async () => {
    const id = await uploadBook(libCookie)
    const ws = (
      await app.inject({ method: 'GET', url: `/api/books/${id}/workspace`, headers: { cookie: libCookie } })
    ).json() as { texts: Record<string, string>; entries: Array<{ path: string; isText: boolean }> }

    const opfPath = FIXTURE_OPENED.pkg.opfPath
    const opf = ws.texts[opfPath]!
    const addedBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    const updatedOpf = opf.replace(
      '</manifest>',
      '  <item id="added_img" href="media/added.png" media-type="image/png"/>\n  </manifest>',
    )

    const fd = new FormData()
    fd.append(
      'ops',
      JSON.stringify({
        textUpserts: { [opfPath]: updatedOpf },
        binaryMediaTypes: { 'EPUB/media/added.png': 'image/png' },
      }),
    )
    fd.append('bin:EPUB/media/added.png', new Blob([addedBytes], { type: 'image/png' }), 'added.png')

    const { contentType, payload } = await serializeFormData(fd)
    const addedRes = await app.inject({
      method: 'PATCH',
      url: `/api/books/${id}/entries`,
      headers: { cookie: libCookie, 'content-type': contentType, 'if-match': '"1"' },
      payload,
    })
    expect(addedRes.statusCode).toBe(200)
    expect((addedRes.json() as { version: number }).version).toBe(2)

    // Rename the binary without uploading its bytes again.
    const renamedOpf = updatedOpf.replace('href="media/added.png"', 'href="media/moved.png"')
    const renameRes = await app.inject({
      method: 'PATCH',
      url: `/api/books/${id}/entries`,
      headers: { cookie: libCookie, 'content-type': 'application/json', 'if-match': '"2"' },
      payload: {
        renames: [{ from: 'EPUB/media/added.png', to: 'EPUB/media/moved.png' }],
        textUpserts: { [opfPath]: renamedOpf },
      },
    })
    expect(renameRes.statusCode).toBe(200)
    expect((renameRes.json() as { version: number }).version).toBe(3)

    const moved = await app.inject({
      method: 'GET',
      url: `/api/books/${id}/entry?path=${encodeURIComponent('EPUB/media/moved.png')}`,
      headers: { cookie: libCookie },
    })
    expect(moved.statusCode).toBe(200)
    expect(new Uint8Array(moved.rawPayload)).toEqual(addedBytes)
  })

  it('rolls back the entire delta when structural validation fails', async () => {
    const id = await uploadBook(libCookie)
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/books/${id}/entries`,
      headers: { cookie: libCookie, 'content-type': 'application/json', 'if-match': '"1"' },
      payload: {
        // Deleting a file still referenced by OPF manifest must fail validateStructure and roll back.
        deletes: ['EPUB/text/ch003.xhtml'],
      },
    })
    expect(response.statusCode).toBe(400)
    expect((response.json() as { error: string }).error).toBe('invalid_epub')

    const ws = (
      await app.inject({ method: 'GET', url: `/api/books/${id}/workspace`, headers: { cookie: libCookie } })
    ).json() as { version: number; texts: Record<string, string> }
    expect(ws.version).toBe(1)
    expect(ws.texts['EPUB/text/ch003.xhtml']).toBeTruthy()
  })

  it('keeps the version when the bytes are unchanged', async () => {
    const id = await uploadBook(libCookie)
    const unchanged = new TextDecoder().decode(FIXTURE_OPENED.archive.entries.get('EPUB/text/ch003.xhtml'))
    const save = await app.inject({
      method: 'PATCH',
      url: `/api/books/${id}/entries`,
      headers: { cookie: libCookie, 'content-type': 'application/json', 'if-match': '"1"' },
      payload: { textUpserts: { 'EPUB/text/ch003.xhtml': unchanged } },
    })
    expect(save.statusCode).toBe(200)
    expect((save.json() as { version: number }).version).toBe(1)
  })

  it('rejects a stale If-Match with 409', async () => {
    const id = await uploadBook(libCookie)
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/books/${id}/entries`,
      headers: { cookie: libCookie, 'content-type': 'application/json', 'if-match': '"99"' },
      payload: { textUpserts: { 'EPUB/text/ch003.xhtml': EDITED_CHAPTER_HTML } },
    })
    expect(response.statusCode).toBe(409)
    expect((response.json() as { currentVersion: number }).currentVersion).toBe(1)
  })

  it('requires If-Match', async () => {
    const id = await uploadBook(libCookie)
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/books/${id}/entries`,
      headers: { cookie: libCookie, 'content-type': 'application/json' },
      payload: { textUpserts: { 'EPUB/text/ch003.xhtml': EDITED_CHAPTER_HTML } },
    })
    expect(response.statusCode).toBe(428)
  })
})

describe('deletion', () => {
  it('removes the book and its entries', async () => {
    const id = await uploadBook(libCookie)
    const response = await app.inject({ method: 'DELETE', url: `/api/books/${id}`, headers: { cookie: libCookie } })
    expect(response.statusCode).toBe(204)

    const list = await app.inject({ method: 'GET', url: '/api/books', headers: { cookie: libCookie } })
    expect((list.json() as { books: unknown[] }).books).toHaveLength(0)

    const read = await app.inject({ method: 'GET', url: `/api/books/${id}/epub`, headers: { cookie: libCookie } })
    expect(read.statusCode).toBe(404)
  })

  it('refuses unauthenticated deletion and hides other users books behind 404', async () => {
    const id = await uploadBook(otherCookie)

    const unauth = await app.inject({ method: 'DELETE', url: `/api/books/${id}` })
    expect(unauth.statusCode).toBe(401)

    const foreign = await app.inject({ method: 'DELETE', url: `/api/books/${id}`, headers: { cookie: libCookie } })
    expect(foreign.statusCode).toBe(404)

    const stillThere = await app.inject({ method: 'GET', url: '/api/books', headers: { cookie: otherCookie } })
    expect((stillThere.json() as { books: unknown[] }).books).toHaveLength(1)
  })
})
