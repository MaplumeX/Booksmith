import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createDb } from '../src/db/client'
import { books, sessions, users } from '../src/db/schema'
import { TEST_URL } from './global-setup'

const FIXTURE = new Uint8Array(readFileSync(new URL('../../../fixtures/马克思经济学与数理分析.epub', import.meta.url)))
const FIXTURE_BUFFER = Buffer.from(FIXTURE)
const FIXTURE_SHA = createHash('sha256').update(FIXTURE).digest('hex')
const ALLOWED = ['lib@booksmith.test', 'other@booksmith.test']
const PASSWORD = 'correct horse battery'

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

describe('upload and read', () => {
  it('ingests the real book with metadata, chapter count and cover', async () => {
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
    expect(book.byteSize).toBe(FIXTURE_BUFFER.byteLength)
    expect(book.hasCover).toBe(true)
    expect(book.currentVersion).toBe(1)
  })

  it('returns the exact uploaded bytes', async () => {
    const id = await uploadBook(libCookie)
    const response = await app.inject({
      method: 'GET',
      url: `/api/books/${id}/epub`,
      headers: { cookie: libCookie },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['etag']).toBe('"1"')
    expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(FIXTURE_SHA)
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
    const read = await app.inject({ method: 'GET', url: `/api/books/${id}/epub`, headers: { cookie: libCookie } })
    expect(read.statusCode).toBe(404)
    const list = await app.inject({ method: 'GET', url: '/api/books', headers: { cookie: libCookie } })
    expect((list.json() as { books: unknown[] }).books).toHaveLength(0)
  })

  it('rejects a malformed book id without touching the database', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/books/not-a-uuid/epub',
      headers: { cookie: libCookie },
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('saving a new version', () => {
  it('increments the version when If-Match matches', async () => {
    const id = await uploadBook(libCookie)
    const save = await app.inject({
      method: 'PUT',
      url: `/api/books/${id}/epub`,
      headers: { cookie: libCookie, 'content-type': 'application/epub+zip', 'if-match': '"1"' },
      payload: FIXTURE_BUFFER,
    })
    expect(save.statusCode).toBe(200)
    expect((save.json() as { version: number }).version).toBe(2)

    const list = await app.inject({ method: 'GET', url: '/api/books', headers: { cookie: libCookie } })
    const book = (list.json() as { books: Array<{ currentVersion: number }> }).books[0]
    expect(book?.currentVersion).toBe(2)
  })

  it('rejects a stale If-Match with 409', async () => {
    const id = await uploadBook(libCookie)
    const response = await app.inject({
      method: 'PUT',
      url: `/api/books/${id}/epub`,
      headers: { cookie: libCookie, 'content-type': 'application/epub+zip', 'if-match': '"99"' },
      payload: FIXTURE_BUFFER,
    })
    expect(response.statusCode).toBe(409)
    expect((response.json() as { currentVersion: number }).currentVersion).toBe(1)
  })

  it('requires If-Match', async () => {
    const id = await uploadBook(libCookie)
    const response = await app.inject({
      method: 'PUT',
      url: `/api/books/${id}/epub`,
      headers: { cookie: libCookie, 'content-type': 'application/epub+zip' },
      payload: FIXTURE_BUFFER,
    })
    expect(response.statusCode).toBe(428)
  })
})

describe('deletion', () => {
  it('removes the book and its versions', async () => {
    const id = await uploadBook(libCookie)
    const response = await app.inject({ method: 'DELETE', url: `/api/books/${id}`, headers: { cookie: libCookie } })
    expect(response.statusCode).toBe(204)

    const list = await app.inject({ method: 'GET', url: '/api/books', headers: { cookie: libCookie } })
    expect((list.json() as { books: unknown[] }).books).toHaveLength(0)
  })
})
