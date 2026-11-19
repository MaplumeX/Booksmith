import { eq } from 'drizzle-orm'
import { hashPassword } from '../src/auth/password'
import { loadConfig } from '../src/config'
import { createDb } from '../src/db/client'
import { users } from '../src/db/schema'

const email = process.argv[2]?.trim().toLowerCase()
if (!email) {
  console.error('usage: pnpm --filter @booksmith/server reset-password <email>  (password on stdin)')
  process.exit(1)
}

const password = await new Promise<string>((resolve) => {
  let data = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    data += chunk
  })
  process.stdin.on('end', () => resolve(data.split('\n')[0]?.trim() ?? ''))
})

if (password.length < 8) {
  console.error('password must be at least 8 characters')
  process.exit(1)
}

const { db, sql } = createDb(loadConfig().databaseUrl)
const updated = await db
  .update(users)
  .set({ passwordHash: await hashPassword(password) })
  .where(eq(users.email, email))
  .returning({ id: users.id })

await sql.end()

if (updated.length === 0) {
  console.error(`no user with email ${email}`)
  process.exit(1)
}
console.log(`password updated for ${email}`)
