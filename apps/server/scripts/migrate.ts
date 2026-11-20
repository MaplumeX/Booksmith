import { loadConfig } from '../src/config'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'

const { db, sql } = createDb(loadConfig().databaseUrl)

console.log(`migrating ${loadConfig().databaseUrl}`)
const result = await runMigrations(db, sql)
await sql.end()
console.log(
  `migrations applied (backfilled ${result.migratedBooks} legacy book(s), droppedLegacyTable=${result.droppedLegacyTable})`,
)
