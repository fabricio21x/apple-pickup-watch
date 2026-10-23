import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApi } from './api'
import { createApple } from './apple'
import { bindHost, prepareDataDir, readEnv } from './boot'
import { openDb } from './db'
import { createMonitor } from './monitor'
import { createTelegram, type Telegram } from './telegram'

const root = fileURLToPath(new URL('../..', import.meta.url))

const die = (what: string) => (err: unknown) => {
  console.error(`${what}:`, err instanceof Error ? err.name : 'non-error')
  process.exit(1)
}
process.on('unhandledRejection', die('unhandled rejection'))
process.on('uncaughtException', die('uncaught exception'))

const envFile = `${root}.env`
if (existsSync(envFile)) process.loadEnvFile(envFile)
const { port, telegram: telegramEnv, extensionId } = readEnv(process.env)

const db = openDb(prepareDataDir(`${root}data`))
const now = Date.now
const apple = createApple({ fetch, now })
const telegram = telegramEnv && createTelegram({ fetch, ...telegramEnv })
const unconfigured: Telegram = {
  sendMessage: async () => ({ ok: false, error: { kind: 'http', description: 'Telegram is not configured' } }),
}
const monitor = createMonitor({ apple, telegram: telegram ?? unconfigured, db, now })
const lanEnabled = db.getSettings().lanEnabled

const app = createApi({ db, monitor, apple, telegram, lanEnabled, extensionId, port, now })
app.use('/*', serveStatic({ root: `${root}dist` }))

serve({ fetch: app.fetch, hostname: bindHost(lanEnabled), port }, (info) => {
  console.log(`pickup-watch listening on ${info.address}:${info.port}`)
})

await monitor.loadCatalog()
monitor.start()
