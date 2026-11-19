import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import EmbeddedPostgres from 'embedded-postgres'

const PORT = Number(process.env.DEV_DB_PORT ?? 55432)
const DIR = fileURLToPath(new URL('../../../.pgdata', import.meta.url))

const pg = new EmbeddedPostgres({
  databaseDir: DIR,
  user: 'booksmith',
  password: 'booksmith',
  port: PORT,
  persistent: true,
  onLog: () => {},
})

console.log(`starting postgres on port ${PORT} (data: ${DIR})`)
// initdb refuses a non-empty directory, so only initialise on first run.
if (!existsSync(`${DIR}/PG_VERSION`)) {
  await pg.initialise()
}
await pg.start()
await pg.createDatabase('booksmith').catch(() => {
  console.log('database booksmith already exists')
})

console.log(`postgres ready: postgres://booksmith:booksmith@127.0.0.1:${PORT}/booksmith`)
console.log('press Ctrl+C to stop')

const shutdown = async () => {
  await pg.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
