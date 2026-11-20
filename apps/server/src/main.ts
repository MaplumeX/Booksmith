import { createApp } from './app'
import { loadConfig } from './config'

const port = Number(process.env.PORT ?? 8787)
const app = await createApp()

try {
  await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' })
  const config = loadConfig()
  console.log(`booksmith server on http://${process.env.HOST ?? '0.0.0.0'}:${port}`)
  console.log(`allowed signup emails: ${config.allowedEmails.join(', ') || '(none)'}`)
} catch (error) {
  console.error(error)
  process.exit(1)
}
