import { parseAgentSecretKey } from './agent/crypto'

export interface Config {
  databaseUrl: string
  allowedEmails: string[]
  sessionTtlDays: number
  cookieSecure: boolean
  /** 32-byte AES-256-GCM key for encrypting user LLM API keys, or null when unconfigured.
   * See ADR 2026-11-20-builtin-epub-agent. */
  agentSecretKey?: Buffer | null
}

export const DEFAULT_DATABASE_URL = 'postgres://booksmith:booksmith@127.0.0.1:55432/booksmith'

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const allowed = (env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)

  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    allowedEmails: allowed,
    sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 30),
    cookieSecure: env.COOKIE_SECURE === 'true',
    agentSecretKey: parseAgentSecretKey(env.AGENT_SECRET_KEY),
  }
}
