import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createDb } from '../src/db/client'
import { books, bookVersions, sessions, users } from '../src/db/schema'
import { createPostgresFileStore } from '../src/storage/fileStore'
import { TEST_URL } from './global-setup'

const FIXTURE = Buffer.from(readFileSync(new URL('../../../fixtures/马克思经济学与数理分析.epub', import.meta.url)))
const PASSWORD = 'correct horse battery'

let app: FastifyInstance
let store: ReturnType<typeof createDb>
let cookie: string

async function upload(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/books',
    headers: { cookie, 'content-type': 'application/epub+zip' },
    payload: FIXTURE,
  })
  expect(response.statusCode).toBe(201)
  return (response.json() as { book: { id: string } }).book.id
}

function save(id: string, version: number, payload: Buffer = FIXTURE) {
  return app.inject({
    method: 'PUT',
    url: `/api/books/${id}/epub`,
    headers: { cookie, 'content-type': 'application/epub+zip', 'if-match': `"${version}"` },
    payload,
  })
}

beforeAll(async () => {
  app = await createApp({
    databaseUrl: TEST_URL,
    config: {
      databaseUrl: TEST_URL,
      allowedEmails: ['versions@booksmith.test'],
      sessionTtlDays: 30,
      cookieSecure: false,
    },
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
  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'versions@booksmith.test', password: PASSWORD },
  })
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'versions@booksmith.test', password: PASSWORD },
  })
  const session = login.cookies.find((entry) => entry.name === 'bs_session')
  if (!session) throw new Error('missing session cookie')
  cookie = `bs_session=${session.value}`
})

describe('version history', () => {
  it('lists versions newest first and keeps every save', async () => {
    const id = await upload()
    await save(id, 1)
    await save(id, 2)

    const response = await app.inject({ method: 'GET', url: `/api/books/${id}/versions`, headers: { cookie } })
    expect(response.statusCode).toBe(200)
    const versions = (response.json() as { versions: Array<{ versionNo: number }> }).versions
    expect(versions.map((entry) => entry.versionNo)).toEqual([3, 2, 1])
  })

  it('restores an older version as a new version', async () => {
    const id = await upload()
    await save(id, 1)

    const restore = await app.inject({
      method: 'POST',
      url: `/api/books/${id}/versions/1/restore`,
      headers: { cookie },
    })
    expect(restore.statusCode).toBe(200)
    const body = restore.json() as { version: number; restoredFrom: number }
    expect(body.version).toBe(3)
    expect(body.restoredFrom).toBe(1)

    const download = await app.inject({ method: 'GET', url: `/api/books/${id}/epub`, headers: { cookie } })
    expect(download.headers['etag']).toBe('"3"')
    expect(createHash('sha256').update(download.rawPayload).digest('hex')).toBe(
      createHash('sha256').update(FIXTURE).digest('hex'),
    )
  })

  it('serves a specific snapshot byte-for-byte', async () => {
    const id = await upload()
    await save(id, 1)

    const response = await app.inject({
      method: 'GET',
      url: `/api/books/${id}/versions/1/epub`,
      headers: { cookie },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/epub+zip')
    expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(
      createHash('sha256').update(FIXTURE).digest('hex'),
    )
  })

  it('rejects unknown versions and other users', async () => {
    const id = await upload()
    const missing = await app.inject({
      method: 'POST',
      url: `/api/books/${id}/versions/99/restore`,
      headers: { cookie },
    })
    expect(missing.statusCode).toBe(404)

    const missingDownload = await app.inject({
      method: 'GET',
      url: `/api/books/${id}/versions/99/epub`,
      headers: { cookie },
    })
    expect(missingDownload.statusCode).toBe(404)

    const stranger = await app.inject({ method: 'GET', url: `/api/books/${id}/versions` })
    expect(stranger.statusCode).toBe(401)

    const strangerDownload = await app.inject({ method: 'GET', url: `/api/books/${id}/versions/1/epub` })
    expect(strangerDownload.statusCode).toBe(401)
  })

  it('keeps the recent snapshots plus the last of each older day', async () => {
    const id = await upload()
    await store.db.delete(bookVersions)

    const DAY = 24 * 60 * 60 * 1000
    const base = Date.UTC(2026, 10, 1)
    const rows = Array.from({ length: 25 }, (_, index) => {
      const versionNo = index + 1
      // v1-v15 spread three per day over five days; v16-v25 all share one later day.
      const day = versionNo <= 15 ? Math.floor((versionNo - 1) / 3) : 9
      return {
        bookId: id,
        versionNo,
        bytes: Buffer.alloc(0),
        byteSize: 0,
        sha256: 'x',
        createdAt: new Date(base + day * DAY),
      }
    })
    await store.db.insert(bookVersions).values(rows)

    await createPostgresFileStore(store.db).prune(id)

    const kept = await store.db
      .select({ versionNo: bookVersions.versionNo })
      .from(bookVersions)
      .orderBy(bookVersions.versionNo)
    expect(kept.map((row) => row.versionNo)).toEqual([
      3, 6, 9, 12, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
    ])
  })

  it('caps the total snapshot count', async () => {
    const id = await upload()
    await store.db.delete(bookVersions)

    const DAY = 24 * 60 * 60 * 1000
    const base = Date.UTC(2026, 10, 1)
    await store.db.insert(bookVersions).values(
      Array.from({ length: 45 }, (_, index) => ({
        bookId: id,
        versionNo: index + 1,
        bytes: Buffer.alloc(0),
        byteSize: 0,
        sha256: 'x',
        createdAt: new Date(base + index * DAY),
      })),
    )

    await createPostgresFileStore(store.db).prune(id)

    const kept = await store.db
      .select({ versionNo: bookVersions.versionNo })
      .from(bookVersions)
      .orderBy(bookVersions.versionNo)
    expect(kept).toHaveLength(40)
    expect(kept[0]?.versionNo).toBe(6)
    expect(kept.at(-1)?.versionNo).toBe(45)
  })
})
