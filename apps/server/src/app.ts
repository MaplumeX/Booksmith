import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { createRateLimiter } from './auth/rateLimit'
import { SESSION_COOKIE, SessionStore } from './auth/session'
import { loadConfig, type Config } from './config'
import { createDb } from './db/client'
import type { User } from './db/schema'
import { registerAuthRoutes } from './routes/auth'
import { registerBookRoutes } from './routes/books'
import { registerVersionRoutes } from './routes/versions'
import { createPostgresFileStore } from './storage/fileStore'

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: User | null
  }
}

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

export interface CreateAppOptions {
  config?: Config
  databaseUrl?: string
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig()
  const { db, sql } = createDb(options.databaseUrl ?? config.databaseUrl)
  const sessions = new SessionStore(db, config.sessionTtlDays)
  const loginLimiter = createRateLimiter({ max: 5, windowMs: 15 * 60 * 1000 })
  const fileStore = createPostgresFileStore(db)

  const app = Fastify({ logger: false, bodyLimit: MAX_UPLOAD_BYTES })
  await app.register(cookie)

  app.addContentTypeParser('application/epub+zip', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body)
  })

  app.decorateRequest('currentUser', null)

  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE]
    request.currentUser = await sessions.resolve(token)
  })

  app.addHook('onClose', async () => {
    await sql.end()
  })

  app.get('/api/health', async () => ({ ok: true }))

  // Single-container deployments serve the built SPA from here; in dev Vite proxies /api.
  const webDist = process.env.WEB_DIST
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false })
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' })
      return reply.sendFile('index.html')
    })
  }

  registerAuthRoutes(app, { db, config, sessions, loginLimiter })
  registerBookRoutes(app, { db, fileStore })
  registerVersionRoutes(app, { db, fileStore })

  return app
}
