import EmbeddedPostgres from 'embedded-postgres'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'

export const TEST_PORT = 55433
export const TEST_URL = `postgres://booksmith:booksmith@127.0.0.1:${TEST_PORT}/booksmith_test`

export default async function setup() {
  const databaseDir = fileURLToPath(new URL('../../../.pgdata-test', import.meta.url))
  rmSync(databaseDir, { recursive: true, force: true })

  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'booksmith',
    password: 'booksmith',
    port: TEST_PORT,
    persistent: false,
    onLog: () => {},
  })

  await pg.initialise()
  await pg.start()
  await pg.createDatabase('booksmith_test')

  const { db, sql } = createDb(TEST_URL)
  await runMigrations(db, sql)
  await sql.end()

  return async () => {
    await pg.stop()
  }
}
