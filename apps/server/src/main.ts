import { createApp } from './app'
import { loadConfig } from './config'

const port = Number(process.env.PORT ?? 8787)
const app = await createApp()

try {
  await app.listen({ port, host: '127.0.0.1' })
  const config = loadConfig()
  console.log(`booksmith server on http://127.0.0.1:${port}`)
  console.log(`allowed signup emails: ${config.allowedEmails.join(', ') || '(none)'}`)
} catch (error) {
  console.error(error)
  process.exit(1)
}
