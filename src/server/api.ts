import { networkInterfaces as osNetworkInterfaces, hostname as osHostname } from 'node:os'
import { getConnInfo } from '@hono/node-server/conninfo'
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import type { GridCell, HealthDto, StateDto, TelegramError } from '../shared/types'
import { parseCurl, parseTokenBody, type Apple } from './apple'
import type { Db } from './db'
import { PARTS_CAP, trackedParts, type Watch } from './domain'
import type { Monitor } from './monitor'
import { testMessage, type Telegram } from './telegram'

const HOST_CACHE_MS = 5000
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']
const LOOPBACK_ADDRESS = /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/
const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[^[\]:/@\s]+)(?::\d+)?$/i
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const DOWN_AFTER_FAILURES = 3

const ZipBody = z.object({ zip: z.string().regex(/^\d{5}$/) })
const EnabledBody = z.object({ enabled: z.boolean() })
const WatchesBody = z.object({ parts: z.array(z.string()).min(1) })
const OtherColorsBody = z.object({ otherColors: z.boolean() })
const IntervalBody = z.object({ seconds: z.number() })
const CurlBody = z.object({ curl: z.string() })

export type ApiDeps = {
  db: Db
  monitor: Monitor
  apple: Apple
  telegram: Telegram | null
  lanEnabled: boolean
  extensionId: string
  port: number
  now: () => number
  hostname?: () => string
  networkInterfaces?: typeof osNetworkInterfaces
}

function fail(c: Context, status: ContentfulStatusCode, error: string, extra: object = {}): never {
  throw new HTTPException(status, { res: c.json({ error, ...extra }, status) })
}

async function readBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await readJson(c))
  if (!parsed.success) {
    fail(c, 400, 'invalid-request', { fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))] })
  }
  return parsed.data
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return fail(c, 400, 'invalid-json')
  }
}

const telegramErrorDto = (e: TelegramError): TelegramError => ({
  kind: e.kind,
  ...(e.status !== undefined && { status: e.status }),
  ...(e.description !== undefined && { description: e.description }),
})

function healthDto({ failures, downAnnounced, cause }: ReturnType<Db['getHealth']>): HealthDto {
  const down = failures >= DOWN_AFTER_FAILURES || (failures > 0 && downAnnounced)
  return { status: failures === 0 ? 'healthy' : down ? 'down' : 'failing', failures, cause }
}

export function createApi(deps: ApiDeps) {
  const { db, monitor, apple, telegram, now } = deps
  const hostname = deps.hostname ?? osHostname
  const networkInterfaces = deps.networkInterfaces ?? osNetworkInterfaces

  const lanHosts = () => {
    const addresses = Object.values(networkInterfaces())
      .flatMap((list) => list ?? [])
      .filter((i) => i.family === 'IPv4' && !i.internal)
      .map((i) => i.address)
    return [...addresses, `${hostname().toLowerCase().replace(/\.local$/, '')}.local`]
  }
  let lanCache: { at: number; hosts: string[] } | undefined
  const allowedHosts = () => {
    if (!deps.lanEnabled) return LOOPBACK_HOSTS
    if (!lanCache || now() - lanCache.at >= HOST_CACHE_MS) lanCache = { at: now(), hosts: lanHosts() }
    return [...LOOPBACK_HOSTS, ...lanCache.hosts]
  }

  const app = new Hono()

  app.use('*', async (c, next) => {
    const host = c.req.header('host')
    const name = host === undefined ? undefined : HOST_HEADER.exec(host)?.[1]?.toLowerCase()
    if (name === undefined || !allowedHosts().includes(name)) return c.json({ error: 'forbidden-host' }, 403)

    if (MUTATING.has(c.req.method)) {
      const type = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (type !== 'application/json') return c.json({ error: 'json-required' }, 415)
      const origin = c.req.header('origin')?.toLowerCase()
      const own = `http://${host?.toLowerCase()}`
      if (origin !== undefined && origin !== own && origin !== `chrome-extension://${deps.extensionId}`.toLowerCase()) {
        return c.json({ error: 'forbidden-origin' }, 403)
      }
    }
    await next()
  })

  const loopbackOnly = async (c: Context, next: () => Promise<void>) => {
    const address = getConnInfo(c).remote.address
    if (address === undefined || !LOOPBACK_ADDRESS.test(address)) return c.json({ error: 'loopback-only' }, 403)
    await next()
  }
  app.use('/api/token', loopbackOnly)
  app.use('/api/lan', loopbackOnly)

  app.notFound((c) => c.json({ error: 'not-found' }, 404))

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    console.error('api error:', err.name)
    return c.json({ error: 'internal' }, 500)
  })

  app.get('/api/state', (c) => {
    const snapshot = monitor.snapshot()
    const settings = db.getSettings()
    const stores = db.listStores()
    const enabled = stores.filter((s) => s.enabled)
    const observed = new Map(snapshot.observations.map((o) => [`${o.part}/${o.store}`, o.pickup]))
    const badge = (part: string, store: string): GridCell['badge'] => {
      const pickup = observed.get(`${part}/${store}`)
      if (!pickup) return 'Not checked'
      return pickup.kind === 'in' ? pickup.label : 'Unavailable'
    }
    const tracked = trackedParts(db.listWatches(), db.listParts())
    const lanUrls = settings.lanEnabled ? lanHosts().map((h) => `http://${h}:${deps.port}`) : []

    const state: StateDto = {
      zip: settings.zip,
      stores: stores.map((s) => ({
        store: s.store,
        name: s.name,
        city: s.city,
        state: s.state,
        distanceMi: s.distanceMi,
        enabled: s.enabled,
      })),
      parts: db.listParts(),
      watches: db.listWatches().map((w) => ({
        part: w.part,
        otherColors: w.otherColors,
        cells: enabled.map((s) => ({ part: w.part, store: s.store, badge: badge(w.part, s.store) })),
      })),
      lastCheckAt: snapshot.lastCheckAt,
      lastSuccessAt: snapshot.lastSuccessAt,
      intervalSec: settings.intervalSec,
      lan: { enabled: settings.lanEnabled, restartRequired: settings.lanEnabled !== deps.lanEnabled, urls: lanUrls },
      token: { status: snapshot.token.status, expiresAt: snapshot.token.expiresAt },
      telegram: {
        configured: telegram !== null,
        lastError: snapshot.telegramLastError && telegramErrorDto(snapshot.telegramLastError),
      },
      health: healthDto(snapshot.health),
      partsCount: { tracked: tracked.length, cap: PARTS_CAP, unchecked: tracked.slice(PARTS_CAP) },
    }
    return c.json(state)
  })

  app.put('/api/zip', async (c) => {
    const { zip } = await readBody(c, ZipBody)
    const [anyPart] = db.listParts()
    if (!anyPart) return fail(c, 503, 'catalog-unavailable')
    const lookup = await apple.fetchStores(zip, anyPart.part)
    if (!lookup.ok) return fail(c, 502, lookup.reason)
    if (lookup.value.length === 0) return fail(c, 422, 'no-stores')
    db.transaction(() => {
      db.replaceStores(lookup.value)
      db.setZip(zip)
    })
    monitor.reconcile()
    return c.json({ ok: true })
  })

  app.put('/api/stores/:store', async (c) => {
    const { enabled } = await readBody(c, EnabledBody)
    const store = c.req.param('store')
    if (!db.listStores().some((s) => s.store === store)) return fail(c, 404, 'unknown-store')
    db.setStoreEnabled(store, enabled)
    monitor.reconcile()
    return c.json({ ok: true })
  })

  const refuseOverCap = (c: Context, after: Watch[]) => {
    const catalog = db.listParts()
    const before = trackedParts(db.listWatches(), catalog).length
    const tracked = trackedParts(after, catalog).length
    if (tracked > PARTS_CAP && tracked > before) {
      fail(c, 409, 'parts-cap', { cap: PARTS_CAP, tracked, adding: tracked - before })
    }
  }

  app.post('/api/watches', async (c) => {
    const { parts } = await readBody(c, WatchesBody)
    const catalog = new Set(db.listParts().map((p) => p.part))
    if (!parts.every((p) => catalog.has(p))) return fail(c, 400, 'unknown-part')
    const watched = new Set(db.listWatches().map((w) => w.part))
    const added = [...new Set(parts)].filter((p) => !watched.has(p))
    refuseOverCap(c, [...db.listWatches(), ...added.map((part) => ({ part, otherColors: true }))])
    db.transaction(() => added.forEach((p) => db.addWatch(p, true, now())))
    monitor.reconcile({ newlyWatched: added })
    return c.json({ ok: true })
  })

  const requireWatch = (c: Context) => {
    const part = c.req.param('part') ?? ''
    if (!db.listWatches().some((w) => w.part === part)) return fail(c, 404, 'unknown-watch')
    return part
  }

  app.delete('/api/watches/:part', (c) => {
    db.removeWatch(requireWatch(c))
    monitor.reconcile()
    return c.json({ ok: true })
  })

  app.patch('/api/watches/:part', async (c) => {
    const { otherColors } = await readBody(c, OtherColorsBody)
    const part = requireWatch(c)
    if (otherColors) refuseOverCap(c, db.listWatches().map((w) => (w.part === part ? { ...w, otherColors } : w)))
    db.setOtherColors(part, otherColors)
    monitor.reconcile()
    return c.json({ ok: true })
  })

  app.put('/api/interval', async (c) => {
    const { seconds } = await readBody(c, IntervalBody)
    try {
      monitor.setInterval(seconds)
    } catch (e) {
      if (e instanceof RangeError) return fail(c, 400, 'invalid-interval')
      throw e
    }
    return c.json({ ok: true })
  })

  app.put('/api/lan', async (c) => {
    const { enabled } = await readBody(c, EnabledBody)
    db.setLanEnabled(enabled)
    return c.json({ ok: true })
  })

  app.post('/api/token', async (c) => {
    const body = await readJson(c)
    const pasted = CurlBody.safeParse(body)
    const result = pasted.success ? parseCurl(pasted.data.curl, now()) : parseTokenBody(body, now())
    if (!result.ok) return fail(c, 400, 'token-rejected', { reason: result.reason })

    const stored = db.getSettings().token
    const stores = pasted.success || stored === null || result.token.expiresAt > stored.expiresAt
    if (stores) db.setToken(result.token)
    return c.json({ stored: stores, token: monitor.snapshot().token })
  })

  app.post('/api/telegram/test', async (c) => {
    if (!telegram) return fail(c, 409, 'not-configured')
    const result = await telegram.sendMessage(testMessage())
    if (result.ok) return c.json({ ok: true })
    return c.json({ ok: false, error: telegramErrorDto(result.error) }, 502)
  })

  return app
}
