import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createDb } from '../src/db/client'
import { sessions, users } from '../src/db/schema'
import { TEST_URL } from './global-setup'

const ALLOWED = ['ok@booksmith.test', 'rate@booksmith.test']

let app: FastifyInstance
let store: ReturnType<typeof createDb>

beforeAll(async () => {
  app = await createApp({
    databaseUrl: TEST_URL,
    config: {
      databaseUrl: TEST_URL,
      allowedEmails: ALLOWED,
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
  await store.db.delete(sessions)
  await store.db.delete(users)
})

async function register(email: string, password = 'correct horse battery'): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password },
  })
  expect(response.statusCode).toBe(201)
}

function sessionCookie(response: { cookies: Array<{ name: string; value: string }> }): string {
  const cookie = response.cookies.find((entry) => entry.name === 'bs_session')
  if (!cookie) throw new Error('missing session cookie')
  return `bs_session=${cookie.value}`
}

describe('registration', () => {
  it('rejects emails outside the allowlist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'stranger@booksmith.test', password: 'correct horse battery' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'not_allowed' })
  })

  it('rejects weak passwords and malformed emails', async () => {
    const weak = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'ok@booksmith.test', password: 'short' },
    })
    expect(weak.statusCode).toBe(400)

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'not-an-email', password: 'correct horse battery' },
    })
    expect(malformed.statusCode).toBe(400)
  })

  it('creates a user without leaking the password hash', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'OK@booksmith.test', password: 'correct horse battery' },
    })
    expect(response.statusCode).toBe(201)
    const body = response.json() as { user: Record<string, unknown> }
    expect(body.user.email).toBe('ok@booksmith.test')
    expect(JSON.stringify(body)).not.toContain('password')
  })

  it('rejects a duplicate email', async () => {
    await register('ok@booksmith.test')
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'ok@booksmith.test', password: 'correct horse battery' },
    })
    expect(response.statusCode).toBe(409)
  })
})

describe('login and session', () => {
  it('issues a session cookie and keeps /me authenticated', async () => {
    await register('ok@booksmith.test')
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ok@booksmith.test', password: 'correct horse battery' },
    })
    expect(login.statusCode).toBe(200)
    const cookie = sessionCookie(login)

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    })
    expect(me.statusCode).toBe(200)
    expect((me.json() as { user: { email: string } }).user.email).toBe('ok@booksmith.test')
  })

  it('rejects a wrong password', async () => {
    await register('ok@booksmith.test')
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ok@booksmith.test', password: 'wrong password here' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.cookies).toHaveLength(0)
  })

  it('returns a null user without a cookie and after logout', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/auth/me' })
    expect(anonymous.statusCode).toBe(200)
    expect(anonymous.json()).toEqual({ user: null })

    await register('ok@booksmith.test')
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ok@booksmith.test', password: 'correct horse battery' },
    })
    const cookie = sessionCookie(login)

    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })
    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(after.json()).toEqual({ user: null })
  })

  it('rate limits repeated failures', async () => {
    await register('rate@booksmith.test')
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'rate@booksmith.test', password: 'definitely wrong' },
      })

    for (let i = 0; i < 5; i += 1) {
      const response = await attempt()
      expect(response.statusCode).toBe(401)
    }
    const blocked = await attempt()
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json()).toEqual({ error: 'too_many_attempts' })
  })
})
