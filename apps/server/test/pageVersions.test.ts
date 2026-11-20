import type { FastifyInstance } from 'fastify'
import { createEmptyEpub, unzipArchive, zipArchive } from '@booksmith/core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createDb } from '../src/db/client'
import { books, pageVersions, sessions, users } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { createPostgresFileStore } from '../src/storage/fileStore'
import { TEST_URL } from './global-setup'

const PASSWORD = 'correct horse battery'
const ALLOWED = ['pages@booksmith.test']
const encoder = new TextEncoder()
const decoder = new TextDecoder()

let app: FastifyInstance
let store: ReturnType<typeof createDb>
let fileStore: ReturnType<typeof createPostgresFileStore>
let cookie: string

/**
 * A small but structurally valid EPUB, built on the fly. The real fixture is a copyrighted book
 * that never enters the repository, so anything that only needs *an* epub builds one here.
 */
function syntheticBook(bodies: string[]): Buffer {
  const archive = unzipArchive(createEmptyEpub({ title: '快照测试书' }))
  const names = bodies.map((_, index) => `ch${String(index + 1).padStart(3, '0')}`)

  for (const [index, name] of names.entries()) {
    archive.entries.set(
      `EPUB/text/${name}.xhtml`,
      encoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${name}</title></head><body><p>${bodies[index]}</p></body></html>\n`,
      ),
    )
  }

  const opf = decoder.decode(archive.entries.get('EPUB/content.opf'))
  const items = names
    .slice(1)
    .map((name) => `    <item id="${name}" href="text/${name}.xhtml" media-type="application/xhtml+xml"/>\n`)
    .join('')
  const spine = names
    .slice(1)
    .map((name) => `    <itemref idref="${name}"/>\n`)
    .join('')
  const patched = opf.replace('  </manifest>', `${items}  </manifest>`).replace('  </spine>', `${spine}  </spine>`)
  archive.entries.set('EPUB/content.opf', encoder.encode(patched))

  return Buffer.from(zipArchive(archive))
}

/** A book row without going through the upload route, so storage tests stay independent of it. */
async function seedBook(): Promise<string> {
  const [owner] = await store.db.select().from(users).limit(1)
  const rows = await store.db
    .insert(books)
    .values({ ownerId: owner!.id, title: '快照测试书', byteSize: 0, sha256: 'sha-upload' })
    .returning({ id: books.id })
  return rows[0]!.id
}

async function registerAndLogin(email: string): Promise<string> {
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: PASSWORD } })
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } })
  const session = login.cookies.find((entry) => entry.name === 'bs_session')
  if (!session) throw new Error('missing session cookie')
  return `bs_session=${session.value}`
}

beforeAll(async () => {
  app = await createApp({
    databaseUrl: TEST_URL,
    config: { databaseUrl: TEST_URL, allowedEmails: ALLOWED, sessionTtlDays: 30, cookieSecure: false },
  })
  store = createDb(TEST_URL)
  fileStore = createPostgresFileStore(store.db)
})

afterAll(async () => {
  await app.close()
  await store.sql.end()
})

beforeEach(async () => {
  await store.db.delete(books)
  await store.db.delete(sessions)
  await store.db.delete(users)
  cookie = await registerAndLogin('pages@booksmith.test')
})

describe('page snapshots', () => {
  it('lists snapshots newest first and finds the newest one per entry', async () => {
    const id = await seedBook()
    await fileStore.putPageVersion(id, 'EPUB/text/ch001.xhtml', Buffer.from('a'), 'sha-a')
    await fileStore.putPageVersion(id, 'EPUB/text/ch002.xhtml', Buffer.from('bb'), 'sha-b')
    await fileStore.putPageVersion(id, 'EPUB/text/ch001.xhtml', Buffer.from('ccc'), 'sha-c')

    const all = await fileStore.listPageVersions(id)
    expect(all).toHaveLength(3)
    expect(all[0]?.path).toBe('EPUB/text/ch001.xhtml')
    expect(all[0]?.sha256).toBe('sha-c')

    expect((await fileStore.newestFor(id, 'EPUB/text/ch001.xhtml'))?.sha256).toBe('sha-c')
    expect(await fileStore.newestFor(id, 'EPUB/text/missing.xhtml')).toBeNull()
  })

  it('reads one snapshot back by id, scoped to its book', async () => {
    const id = await seedBook()
    const other = await seedBook()
    await fileStore.putPageVersion(id, 'EPUB/text/ch001.xhtml', Buffer.from('内容'), 'sha-content')

    const [snapshot] = await fileStore.listPageVersions(id)
    const loaded = await fileStore.getPageVersion(id, snapshot!.id)
    expect(loaded?.path).toBe('EPUB/text/ch001.xhtml')
    expect(loaded?.bytes.toString()).toBe('内容')
    expect(await fileStore.getPageVersion(other, snapshot!.id)).toBeNull()
  })
})

describe('pruning', () => {
  async function seed(bookId: string, path: string, count: number, stepMs: number): Promise<string[]> {
    const base = Date.now()
    const rows = Array.from({ length: count }, (_, index) => ({
      bookId,
      path,
      bytes: Buffer.from(`v${index}`),
      byteSize: 2,
      sha256: `sha-${index}`,
      createdAt: new Date(base - index * stepMs),
    }))
    const inserted = await store.db
      .insert(pageVersions)
      .values(rows)
      .returning({ id: pageVersions.id, sha256: pageVersions.sha256 })
    return inserted.map((row) => row.sha256)
  }

  it('collapses a same-day run to the newest ten', async () => {
    const id = await seedBook()
    const shas = await seed(id, 'EPUB/text/ch001.xhtml', 120, 60_000)

    const removed = await fileStore.prunePages(id)
    expect(removed).toBe(110)

    const kept = await fileStore.listPageVersions(id)
    expect(kept).toHaveLength(10)
    expect(new Set(kept.map((row) => row.sha256))).toEqual(new Set(shas.slice(0, 10)))
  })

  it('keeps one snapshot per older day, capped at 100 per entry', async () => {
    const id = await seedBook()
    await seed(id, 'EPUB/text/ch001.xhtml', 150, 24 * 60 * 60 * 1000)

    await fileStore.prunePages(id)
    const kept = await fileStore.listPageVersions(id)
    expect(kept).toHaveLength(100)
  })

  it('never prunes a pinned snapshot and does not spend a slot on it', async () => {
    const id = await seedBook()
    await seed(id, 'EPUB/text/ch001.xhtml', 120, 60_000)
    const oldest = (await fileStore.listPageVersions(id)).at(-1)!
    await fileStore.setPinned(id, oldest.id, true)

    // One row survives only because it is pinned, so one fewer is removed than the cap implies.
    const removed = await fileStore.prunePages(id)
    expect(removed).toBe(109)

    const kept = await fileStore.listPageVersions(id)
    expect(kept).toHaveLength(11)
    expect(kept.find((row) => row.id === oldest.id)?.pinned).toBe(true)
  })

  it('prunes a snapshot again once it is unpinned', async () => {
    const id = await seedBook()
    await seed(id, 'EPUB/text/ch001.xhtml', 120, 60_000)
    const oldest = (await fileStore.listPageVersions(id)).at(-1)!
    await fileStore.setPinned(id, oldest.id, true)
    await fileStore.prunePages(id)
    expect(await fileStore.listPageVersions(id)).toHaveLength(11)

    await fileStore.setPinned(id, oldest.id, false)
    expect(await fileStore.prunePages(id)).toBe(1)
  })

  it('prunes each entry independently', async () => {
    const id = await seedBook()
    await seed(id, 'EPUB/text/ch001.xhtml', 40, 60_000)
    await seed(id, 'EPUB/text/ch002.xhtml', 3, 60_000)

    await fileStore.prunePages(id)
    expect(await fileStore.listPageVersions(id)).toHaveLength(13)
  })
})

async function upload(payload: Buffer): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/books',
    headers: { cookie, 'content-type': 'application/epub+zip' },
    payload,
  })
  expect(response.statusCode).toBe(201)
  return (response.json() as { book: { id: string } }).book.id
}

function saveText(
  id: string,
  version: number,
  textUpserts: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'PATCH',
    url: `/api/books/${id}/entries`,
    headers: { cookie, 'content-type': 'application/json', 'if-match': `"${version}"`, ...headers },
    payload: { textUpserts },
  })
}

async function currentText(id: string, path: string): Promise<string> {
  const ws = await app.inject({ method: 'GET', url: `/api/books/${id}/workspace`, headers: { cookie } })
  const body = ws.json() as { texts: Record<string, string> }
  return body.texts[path] ?? ''
}

describe('saving', () => {
  it('records a baseline snapshot per text entry on import', async () => {
    const id = await upload(syntheticBook(['第一章', '第二章']))
    const snapshots = await fileStore.listPageVersions(id)
    const paths = snapshots.map((entry) => entry.path).sort()
    expect(paths).toEqual([
      'EPUB/content.opf',
      'EPUB/nav.xhtml',
      'EPUB/styles/stylesheet1.css',
      'EPUB/text/ch001.xhtml',
      'EPUB/text/ch002.xhtml',
    ])
  })

  it('bumps the version and records only the entry that changed', async () => {
    const id = await upload(syntheticBook(['第一章', '第二章']))
    const before = await fileStore.listPageVersions(id)

    const response = await saveText(
      id,
      1,
      { 'EPUB/text/ch002.xhtml': '改过的第二章' },
      { 'x-booksmith-checkpoint': 'manual' },
    )
    expect(response.statusCode).toBe(200)
    expect((response.json() as { version: number }).version).toBe(2)

    const after = await fileStore.listPageVersions(id)
    expect(after).toHaveLength(before.length + 1)
    expect(after[0]?.path).toBe('EPUB/text/ch002.xhtml')
  })

  it('does not write anything when the bytes are unchanged', async () => {
    const id = await upload(syntheticBook(['第一章']))
    const before = await fileStore.listPageVersions(id)
    const bookBefore = await store.db.select().from(books).where(eq(books.id, id)).limit(1)
    const original = await currentText(id, 'EPUB/text/ch001.xhtml')

    const response = await saveText(id, 1, { 'EPUB/text/ch001.xhtml': original })
    expect(response.statusCode).toBe(200)
    expect((response.json() as { version: number }).version).toBe(1)

    const bookAfter = await store.db.select().from(books).where(eq(books.id, id)).limit(1)
    expect(bookAfter[0]?.currentVersion).toBe(bookBefore[0]?.currentVersion)
    expect(await fileStore.listPageVersions(id)).toHaveLength(before.length)
  })

  it('skips a second snapshot for the same entry inside the ten minute window', async () => {
    const id = await upload(syntheticBook(['第一章']))
    const baseline = await fileStore.listPageVersions(id)

    const first = await saveText(id, 1, { 'EPUB/text/ch001.xhtml': '第一次改' })
    expect(first.statusCode).toBe(200)
    expect((first.json() as { version: number }).version).toBe(2)
    expect(await fileStore.listPageVersions(id)).toHaveLength(baseline.length)

    // The content still landed in book_entries even though no snapshot row was written.
    expect(await currentText(id, 'EPUB/text/ch001.xhtml')).toContain('第一次改')
  })

  it('records a snapshot for a manual checkpoint even inside the window', async () => {
    const id = await upload(syntheticBook(['第一章']))
    const baseline = await fileStore.listPageVersions(id)

    const response = await saveText(
      id,
      1,
      { 'EPUB/text/ch001.xhtml': '手动保存' },
      { 'x-booksmith-checkpoint': 'manual' },
    )
    expect(response.statusCode).toBe(200)
    expect(await fileStore.listPageVersions(id)).toHaveLength(baseline.length + 1)
  })

  it('rejects a stale If-Match without touching history', async () => {
    const id = await upload(syntheticBook(['第一章']))
    const baseline = await fileStore.listPageVersions(id)

    const response = await saveText(
      id,
      7,
      { 'EPUB/text/ch001.xhtml': '过期' },
      { 'x-booksmith-checkpoint': 'manual' },
    )
    expect(response.statusCode).toBe(409)
    expect(await fileStore.listPageVersions(id)).toHaveLength(baseline.length)
  })
})

describe('pinning a snapshot', () => {
  it('flips the flag and reports it in the list', async () => {
    const id = await upload(syntheticBook(['第一章']))
    const list = (await app.inject({ method: 'GET', url: `/api/books/${id}/page-versions`, headers: { cookie } })).json() as {
      snapshots: Array<{ id: string; path: string; pinned: boolean }>
    }
    const target = list.snapshots.find((row) => row.path === 'EPUB/text/ch001.xhtml')!
    expect(target.pinned).toBe(false)

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/books/${id}/page-versions/${target.id}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { pinned: true },
    })
    expect(response.statusCode).toBe(200)
    expect((response.json() as { snapshot: { pinned: boolean } }).snapshot.pinned).toBe(true)

    const after = (await app.inject({ method: 'GET', url: `/api/books/${id}/page-versions`, headers: { cookie } })).json() as {
      snapshots: Array<{ id: string; pinned: boolean }>
    }
    expect(after.snapshots.find((row) => row.id === target.id)?.pinned).toBe(true)
  })

  it('rejects a body that is not a boolean', async () => {
    const id = await upload(syntheticBook(['第一章']))
    const list = (await app.inject({ method: 'GET', url: `/api/books/${id}/page-versions`, headers: { cookie } })).json() as {
      snapshots: Array<{ id: string }>
    }
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/books/${id}/page-versions/${list.snapshots[0]!.id}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { pinned: 'yes' },
    })
    expect(response.statusCode).toBe(400)
  })

  it('answers 404 for an unknown snapshot and 401 without a session', async () => {
    const id = await upload(syntheticBook(['第一章']))
    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/books/${id}/page-versions/00000000-0000-0000-0000-000000000000`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { pinned: true },
    })
    expect(missing.statusCode).toBe(404)

    const list = (await app.inject({ method: 'GET', url: `/api/books/${id}/page-versions`, headers: { cookie } })).json() as {
      snapshots: Array<{ id: string }>
    }
    const anonymous = await app.inject({
      method: 'PATCH',
      url: `/api/books/${id}/page-versions/${list.snapshots[0]!.id}`,
      headers: { 'content-type': 'application/json' },
      payload: { pinned: true },
    })
    expect(anonymous.statusCode).toBe(401)
  })
})

describe('reading and restoring snapshots', () => {
  it('lists snapshots and serves one entry as text', async () => {
    const id = await upload(syntheticBook(['第一章', '第二章']))
    const list = await app.inject({ method: 'GET', url: `/api/books/${id}/page-versions`, headers: { cookie } })
    expect(list.statusCode).toBe(200)

    const { snapshots } = list.json() as { snapshots: Array<{ id: string; path: string }> }
    const target = snapshots.find((entry) => entry.path === 'EPUB/text/ch002.xhtml')!
    const content = await app.inject({ method: 'GET', url: `/api/books/${id}/page-versions/${target.id}`, headers: { cookie } })
    expect(content.statusCode).toBe(200)
    expect(content.body).toContain('第二章')
  })

  it('restores one entry directly into book_entries and bumps the version', async () => {
    const id = await upload(syntheticBook(['第一章', '第二章']))
    const origin = (await fileStore.listPageVersions(id)).find((entry) => entry.path === 'EPUB/text/ch002.xhtml')!

    const saved = await saveText(
      id,
      1,
      { 'EPUB/text/ch002.xhtml': '改坏了的第二章' },
      { 'x-booksmith-checkpoint': 'manual' },
    )
    expect((saved.json() as { version: number }).version).toBe(2)

    const restored = await app.inject({
      method: 'POST',
      url: `/api/books/${id}/page-versions/${origin.id}/restore`,
      headers: { cookie },
    })
    expect(restored.statusCode).toBe(200)
    expect((restored.json() as { version: number }).version).toBe(3)

    const chapter = await currentText(id, 'EPUB/text/ch002.xhtml')
    expect(chapter).toContain('第二章')
    expect(chapter).not.toContain('改坏了的第二章')

    const newest = await fileStore.newestFor(id, 'EPUB/text/ch002.xhtml')
    expect(newest?.sha256).toBe(origin.sha256)
  })

  it('refuses a snapshot that belongs to another book', async () => {
    const id = await upload(syntheticBook(['第一章']))
    const other = await upload(syntheticBook(['别的书']))
    const [snapshot] = await fileStore.listPageVersions(id)

    const response = await app.inject({
      method: 'POST',
      url: `/api/books/${other}/page-versions/${snapshot!.id}/restore`,
      headers: { cookie },
    })
    expect(response.statusCode).toBe(404)
  })
})
