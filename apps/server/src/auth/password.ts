import { hash, verify } from '@node-rs/argon2'

// OWASP 2024 baseline for argon2id.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 }

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS)
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password)
}
