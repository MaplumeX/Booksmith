import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { RateLimiter } from '../auth/rateLimit'
import { hashPassword, verifyPassword } from '../auth/password'
import { SESSION_COOKIE, type SessionStore } from '../auth/session'
import type { Config } from '../config'
import type { Db } from '../db/client'
import { users } from '../db/schema'

const MIN_PASSWORD_LENGTH = 8

interface AuthDeps {
  db: Db
  config: Config
  sessions: SessionStore
  loginLimiter: RateLimiter
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db, config, sessions, loginLimiter } = deps

  app.post('/api/auth/register', async (request, reply) => {
    const body = (request.body ?? {}) as { email?: unknown; password?: unknown }
    const email = normalizeEmail(body.email)
    const password = typeof body.password === 'string' ? body.password : ''

    if (!email) return reply.code(400).send({ error: 'invalid_email' })
    if (password.length < MIN_PASSWORD_LENGTH) return reply.code(400).send({ error: 'weak_password' })
    if (!config.allowedEmails.includes(email)) return reply.code(403).send({ error: 'not_allowed' })

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
    if (existing[0]) return reply.code(409).send({ error: 'email_taken' })

    const passwordHash = await hashPassword(password)
    const inserted = await db
      .insert(users)
      .values({ email, passwordHash })
      .returning({ id: users.id, email: users.email, role: users.role })

    return reply.code(201).send({ user: inserted[0] })
  })

  app.post('/api/auth/login', async (request, reply) => {
    const body = (request.body ?? {}) as { email?: unknown; password?: unknown }
    const email = normalizeEmail(body.email)
    const password = typeof body.password === 'string' ? body.password : ''
    if (!email) return reply.code(400).send({ error: 'invalid_email' })

    const rateKey = `${request.ip}:${email}`
    if (!loginLimiter.hit(rateKey)) return reply.code(429).send({ error: 'too_many_attempts' })

    const rows = await db.select().from(users).where(eq(users.email, email)).limit(1)
    const user = rows[0]
    const valid = user ? await verifyPassword(user.passwordHash, password) : false
    if (!user || !valid) return reply.code(401).send({ error: 'invalid_credentials' })

    loginLimiter.reset(rateKey)
    const { token, expiresAt } = await sessions.create(user.id)
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: config.cookieSecure,
      expires: expiresAt,
    })

    return reply.send({ user: { id: user.id, email: user.email, role: user.role } })
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE]
    if (token) await sessions.destroy(token)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return reply.code(204).send()
  })

  // Anonymous callers get `user: null`, not 401: the client polls this on load and a
  // 401 would surface as a console error on every visit.
  app.get('/api/auth/me', async (request, reply) => {
    if (!request.currentUser) return reply.send({ user: null })
    const { id, email, role } = request.currentUser
    return reply.send({ user: { id, email, role } })
  })
}
