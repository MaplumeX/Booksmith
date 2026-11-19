import { randomBytes } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import type { Db } from '../db/client'
import { sessions, users, type User } from '../db/schema'

export const SESSION_COOKIE = 'bs_session'

export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly ttlDays: number,
  ) {}

  async create(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + this.ttlDays * 24 * 60 * 60 * 1000)
    await this.db.insert(sessions).values({ id: token, userId, expiresAt })
    return { token, expiresAt }
  }

  async resolve(token: string | undefined): Promise<User | null> {
    if (!token) return null
    const rows = await this.db
      .select({ user: users, expiresAt: sessions.expiresAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, token))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.destroy(token)
      return null
    }
    return row.user
  }

  async destroy(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, token))
  }

  async purgeExpired(): Promise<void> {
    await this.db.delete(sessions).where(lt(sessions.expiresAt, new Date()))
  }
}
