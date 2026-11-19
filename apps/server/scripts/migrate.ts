import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { loadConfig } from '../src/config'
import { createDb } from '../src/db/client'

const { db, sql } = createDb(loadConfig().databaseUrl)
const folder = new URL('../drizzle', import.meta.url).pathname

console.log(`migrating ${loadConfig().databaseUrl}`)
await migrate(db, { migrationsFolder: folder })
await sql.end()
console.log('migrations applied')
