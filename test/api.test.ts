import { readFileSync } from 'node:fs'
import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createApi } from '../src/server/api'
import { createApple, type AppleToken } from '../src/server/apple'
import { openDb } from '../src/server/db'
import { createMonitor } from '../src/server/monitor'
import { createTelegram, type OutgoingMessage, type SendResult, type Telegram } from '../src/server/telegram'
import type { StateDto } from '../src/shared/types'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const NOW = Date.parse('2026-10-23T12:00:00Z')
const HOUR = 3_600_000
const SILVER = 'MJQ84LL/A'
const BURGUNDY = 'MJQ94LL/A'
const BLACK = 'MJQ74LL/A'
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop'
const PORT = 4319
const LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }

const DSSID2 = 'SECRET-DSSID2-VALUE'
const BOT_TOKEN = '123456:SECRET-BOT-TOKEN'
const shld = (expiresAtMs: number, tag = 'a') => `id${tag}|${expiresAtMs / 1000}|payload==|sig`
const pair = (expiresAtMs: number, tag = 'a') => ({
  dssid2: DSSID2,
  shld_bt_ck: shld(expiresAtMs, tag),
  userAgent: 'Mozilla/5.0 test',
})
const curlFor = (expiresAtMs: number) =>
  `curl 'https://www.apple.com/shop/fulfillment-messages' -H 'user-agent: Mozilla/5.0 test' -b 'dssid2=${DSSID2}; shld_bt_ck=${shld(expiresAtMs, 'c')}'`
const STORED: AppleToken = { dssid2: DSSID2, shldBtCk: shld(NOW + HOUR, 's'), userAgent: 'Mozilla/5.0 test', expiresAt: NOW + HOUR }

type Stock = 'Today' | 'Tomorrow'

function fulfillmentBody(file: string, stock: Record<string, Stock>): string {
  const body = JSON.parse(fixture(file))
  for (const store of body.body.content.pickupMessage.stores) {
    for (const [part, availability] of Object.entries<{ pickupDisplay: string; pickupSearchQuote: string }>(
      store.partsAvailability,
    )) {
      const state = stock[`${part}@${store.storeNumber}`]
      if (state) {
        availability.pickupDisplay = 'available'
        availability.pickupSearchQuote = `Available ${state}`
      }
    }
  }
  return JSON.stringify(body)
}

type Interfaces = Record<string, NetworkInterfaceInfo[]>
const iface = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4'): NetworkInterfaceInfo[] => [
  { address, family, internal: false, netmask: '', mac: '', cidr: null } as NetworkInterfaceInfo,
]

async function setup(options: { lanEnabled?: boolean; telegram?: Telegram | null } = {}) {
  let t = NOW
  const now = () => t

  let storesBody = fixture('stores-10001.json')
  let storesDown = false
  let fulfillmentFile = 'fulfillment-all-out.json'
  let stock: Record<string, Stock> = {}
  const storeLookups: string[] = []
  const fetchFake = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('product-locator-meta')) {
      return new Response(fixture(url.includes('family=iphoneduo') ? 'locator-duo.json' : 'locator-18pro.json'))
    }
    if (url.includes('pickup-message-recommendations')) {
      storeLookups.push(url)
      if (storesDown) throw new TypeError('fetch failed')
      return new Response(storesBody)
    }
    return new Response(fulfillmentBody(fulfillmentFile, stock))
  }) as typeof fetch
  const apple = createApple({ fetch: fetchFake, now })

  const sent: OutgoingMessage[] = []
  let reply: SendResult = { ok: true }
  const fakeTelegram: Telegram = {
    async sendMessage(message) {
      sent.push(message)
      return reply
    },
  }
  const telegram = options.telegram === undefined ? fakeTelegram : options.telegram

  const db = openDb(':memory:')
  const monitor = createMonitor({ apple, telegram: telegram ?? fakeTelegram, db, now, sleep: async () => {} })
  await monitor.loadCatalog()

  let interfaces: Interfaces = { en0: iface('192.168.1.20') }
  const api = createApi({
    db,
    monitor,
    apple,
    telegram,
    lanEnabled: options.lanEnabled ?? false,
    extensionId: EXTENSION_ID,
    port: PORT,
    now,
    hostname: () => 'fabs-mac.local',
    networkInterfaces: () => interfaces,
  })

  async function call(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string>; remote?: string; raw?: string } = {},
  ) {
    const method = init.method ?? 'GET'
    const headers: Record<string, string> = { host: `localhost:${PORT}`, ...init.headers }
    const hasBody = init.body !== undefined || init.raw !== undefined
    if (method !== 'GET' && !('content-type' in headers)) headers['content-type'] = 'application/json'
    const res = await api.request(
      path,
      { method, headers, ...(hasBody && { body: init.raw ?? JSON.stringify(init.body) }) },
      init.remote ? { incoming: { socket: { remoteAddress: init.remote } } } : LOOPBACK,
    )
    const text = await res.text()
    return {
      status: res.status,
      headers: res.headers,
      text,
      json: (text ? JSON.parse(text) : undefined) as any,
    }
  }

  const state = async () => (await call('/api/state')).json as StateDto

  const saveZip = async () => {
    const res = await call('/api/zip', { method: 'PUT', body: { zip: '10001' } })
    expect(res.status).toBe(200)
  }

  return {
    api,
    db,
    monitor,
    call,
    state,
    saveZip,
    sent,
    storeLookups,
    advance: (ms: number) => {
      t += ms
    },
    setStoresBody: (body: unknown) => {
      storesBody = JSON.stringify(body)
    },
    setStoresDown: (down: boolean) => {
      storesDown = down
    },
    setReply: (next: SendResult) => {
      reply = next
    },
    setInterfaces: (next: Interfaces) => {
      interfaces = next
    },
    setFulfillment: (file: string, nextStock: Record<string, Stock> = {}) => {
      fulfillmentFile = file
      stock = nextStock
    },
    storedToken: () => db.getSettings().token,
    watch: (part: string, otherColors = true) => db.addWatch(part, otherColors, NOW),
    withToken: () => db.setToken(STORED),
    enabledStores: () => db.listStores().filter((s) => s.enabled).map((s) => s.store),
  }
}

async function withZipAndToken() {
  const s = await setup()
  await s.saveZip()
  s.withToken()
  return s
}

describe('GET /api/state', () => {
  it('lists the catalog parts for the Model, Storage, Color picker', async () => {
    const s = await setup()

    const state = await s.state()

    expect(state.zip).toBeNull()
    expect(state.stores).toEqual([])
    expect(state.parts).toHaveLength(40)
    expect(state.parts.find((p) => p.part === SILVER)).toMatchObject({
      modelName: 'iPhone 18 Pro',
      capacity: '512gb',
      colorName: 'Silver',
    })
  })

  it('shows Today, Tomorrow and Unavailable per watched part and enabled store, with the last successful check time', async () => {
    const s = await withZipAndToken()
    s.watch(SILVER)
    s.setFulfillment('fulfillment-all-out.json', { [`${SILVER}@R250`]: 'Today', [`${SILVER}@R415`]: 'Tomorrow' })

    await s.monitor.runCheck()
    const state = await s.state()

    const [watch] = state.watches
    expect(watch?.part).toBe(SILVER)
    expect(watch?.otherColors).toBe(true)
    const badge = (store: string) => watch?.cells.find((c) => c.store === store)?.badge
    expect(badge('R250')).toBe('Today')
    expect(badge('R415')).toBe('Tomorrow')
    expect(badge('R032')).toBe('Unavailable')
    expect(watch?.cells.filter((c) => c.part === SILVER)).toHaveLength(12)
    expect(state.lastCheckAt).toBe(NOW)
    expect(state.lastSuccessAt).toBe(NOW)
  })

  it('adds the other-color siblings of a watch with the switch on to its cells, at every enabled store', async () => {
    const s = await withZipAndToken()
    s.watch(SILVER)
    s.setFulfillment('fulfillment-other-color-today.json')

    await s.monitor.runCheck()
    const state = await s.state()

    const siblings = state.parts.filter(
      (p) => p.part !== SILVER && p.modelName === 'iPhone 18 Pro' && p.capacity === '512gb',
    )
    const [watch] = state.watches
    expect(siblings.length).toBeGreaterThan(0)
    expect(watch?.cells.filter((c) => c.part === SILVER)).toHaveLength(12)
    expect(watch?.cells.filter((c) => c.part !== SILVER).map((c) => c.part)).toEqual(
      siblings.flatMap((p) => Array<string>(12).fill(p.part)),
    )
    const badge = (part: string, store: string) => watch?.cells.find((c) => c.part === part && c.store === store)?.badge
    expect(badge(BURGUNDY, 'R250')).toBe('Today')
    expect(badge(BURGUNDY, 'R032')).toBe('Unavailable')
  })

  it('keeps only the watched part in the cells of a watch with the switch off', async () => {
    const s = await withZipAndToken()
    s.watch(SILVER, false)

    const state = await s.state()

    expect(state.watches[0]?.cells.every((c) => c.part === SILVER)).toBe(true)
  })

  it('leaves a sibling that is itself watched out of the other-color cells', async () => {
    const s = await withZipAndToken()
    s.watch(SILVER)
    s.watch(BURGUNDY, false)

    const state = await s.state()

    const silver = state.watches.find((w) => w.part === SILVER)
    expect(silver?.cells.some((c) => c.part === BURGUNDY)).toBe(false)
    expect(state.watches.find((w) => w.part === BURGUNDY)?.cells.every((c) => c.part === BURGUNDY)).toBe(true)
  })

  it('leaves the siblings past the cap of 20 out of the cells, as they are listed as unchecked', async () => {
    const s = await setup()
    await s.saveZip()
    const parts = seedModel(s, 'Cap B', 22)
    s.watch(parts[0] ?? '')

    const state = await s.state()

    expect(state.partsCount.unchecked).toEqual(parts.slice(20))
    const cellParts = new Set(state.watches[0]?.cells.map((c) => c.part))
    expect(parts.slice(0, 20).every((p) => cellParts.has(p))).toBe(true)
    expect(parts.slice(20).some((p) => cellParts.has(p))).toBe(false)
  })

  it('shows Not checked for an enabled store Apple left out of the response', async () => {
    const s = await withZipAndToken()
    s.watch(SILVER)
    s.setFulfillment('fulfillment-missing-store.json')

    await s.monitor.runCheck()
    const state = await s.state()

    const badge = (store: string) => state.watches[0]?.cells.find((c) => c.store === store)?.badge
    expect(badge('R753')).toBe('Not checked')
    expect(badge('R250')).toBe('Unavailable')
  })

  it('shows Not checked before any check has run', async () => {
    const s = await withZipAndToken()
    s.watch(SILVER)

    const state = await s.state()

    expect(state.watches[0]?.cells.every((c) => c.badge === 'Not checked')).toBe(true)
    expect(state.lastCheckAt).toBeNull()
    expect(state.lastSuccessAt).toBeNull()
  })

  it('leaves disabled stores out of the grid but keeps them in the store list', async () => {
    const s = await withZipAndToken()
    s.watch(SILVER)
    s.db.setStoreEnabled('R250', false)

    const state = await s.state()

    expect(state.watches[0]?.cells.some((c) => c.store === 'R250')).toBe(false)
    expect(state.stores.find((x) => x.store === 'R250')).toMatchObject({ enabled: false, name: 'West 14th Street' })
  })

  it('reports no tracked parts against the cap of 20 before any watch', async () => {
    const s = await setup()

    expect((await s.state()).partsCount).toEqual({ tracked: 0, cap: 20, unchecked: [] })
  })

  it('lists the tracked parts past the cut of 20 as unchecked, in catalog order', async () => {
    const s = await setup()
    const parts = seedModel(s, 'Cap A', 22)
    s.watch(parts[0] ?? '')

    expect((await s.state()).partsCount).toEqual({ tracked: 22, cap: 20, unchecked: parts.slice(20) })
  })

  it('reports the interval, token status and Telegram status', async () => {
    const s = await withZipAndToken()

    const state = await s.state()

    expect(state.intervalSec).toBe(60)
    expect(state.token).toEqual({ status: 'untested', expiresAt: NOW + HOUR })
    expect(state.telegram).toEqual({ configured: true, lastError: null })
    expect(state.health).toEqual({ status: 'healthy', failures: 0, cause: null })
  })

  it('reports Telegram as not configured when there is no Telegram client', async () => {
    const s = await setup({ telegram: null })

    expect((await s.state()).telegram.configured).toBe(false)
  })

  it('reports Wi-Fi access as off with no URLs by default', async () => {
    const s = await setup()

    expect((await s.state()).lan).toEqual({ enabled: false, restartRequired: false, urls: [] })
  })
})

describe('PUT /api/zip', () => {
  it('lists the stores Apple returns for the zip with name and distance, all enabled', async () => {
    const s = await setup()

    const res = await s.call('/api/zip', { method: 'PUT', body: { zip: '10001' } })
    const state = await s.state()

    expect(res.status).toBe(200)
    expect(state.zip).toBe('10001')
    expect(state.stores).toHaveLength(12)
    expect(state.stores[0]).toEqual({
      store: 'R250',
      name: 'West 14th Street',
      city: 'New York',
      state: 'NY',
      distanceMi: expect.any(Number),
      enabled: true,
    })
    expect(state.stores.every((x) => x.enabled)).toBe(true)
  })

  it.each(['1000', '100011', 'abcde', '10 01', ''])('rejects the zip %j without calling Apple or changing anything', async (zip) => {
    const s = await setup()

    const res = await s.call('/api/zip', { method: 'PUT', body: { zip } })

    expect(res.status).toBe(400)
    expect(s.storeLookups).toEqual([])
    expect((await s.state()).zip).toBeNull()
  })

  it('changes nothing when the store lookup fails', async () => {
    const s = await setup()
    await s.saveZip()
    s.db.setStoreEnabled('R250', false)
    s.setStoresDown(true)

    const res = await s.call('/api/zip', { method: 'PUT', body: { zip: '11201' } })
    const state = await s.state()

    expect(res.status).toBe(502)
    expect(res.json).toEqual({ error: 'network' })
    expect(state.zip).toBe('10001')
    expect(state.stores).toHaveLength(12)
    expect(state.stores.find((x) => x.store === 'R250')?.enabled).toBe(false)
  })

  it('changes nothing when Apple returns no stores', async () => {
    const s = await setup()
    await s.saveZip()
    const empty = JSON.parse(fixture('stores-10001.json'))
    empty.body.PickupMessage.stores = []
    s.setStoresBody(empty)

    const res = await s.call('/api/zip', { method: 'PUT', body: { zip: '99999' } })

    expect(res.status).toBe(422)
    expect((await s.state()).zip).toBe('10001')
    expect(s.db.listStores()).toHaveLength(12)
  })

  it('keeps the toggle of a store still listed when the zip is saved again', async () => {
    const s = await setup()
    await s.saveZip()
    s.db.setStoreEnabled('R250', false)

    await s.saveZip()

    expect(s.enabledStores()).not.toContain('R250')
    expect(s.enabledStores()).toHaveLength(11)
  })

  it('adds new stores as enabled and deletes stores no longer listed', async () => {
    const s = await setup()
    await s.saveZip()
    const next = JSON.parse(fixture('stores-10001.json'))
    const [first, second] = next.body.PickupMessage.stores
    next.body.PickupMessage.stores = [first, { ...second, storeNumber: 'R999', storeName: 'Brand New' }]
    s.setStoresBody(next)

    await s.call('/api/zip', { method: 'PUT', body: { zip: '10002' } })
    const state = await s.state()

    expect(state.stores.map((x) => x.store)).toEqual(['R250', 'R999'])
    expect(state.stores.find((x) => x.store === 'R999')).toMatchObject({ name: 'Brand New', enabled: true })
  })

  it('prunes alerted rows of stores that left the list', async () => {
    const s = await setup()
    await s.saveZip()
    s.watch(SILVER)
    s.db.insertAlerted({ part: SILVER, store: 'R415' })
    s.db.insertAlerted({ part: SILVER, store: 'R250' })
    const next = JSON.parse(fixture('stores-10001.json'))
    next.body.PickupMessage.stores = next.body.PickupMessage.stores.filter((x: { storeNumber: string }) => x.storeNumber !== 'R415')
    s.setStoresBody(next)

    await s.saveZip()

    expect(s.db.listAlerted()).toEqual([{ part: SILVER, store: 'R250' }])
  })
})

describe('PUT /api/stores/:store', () => {
  it('toggles a store off and back on', async () => {
    const s = await setup()
    await s.saveZip()

    await s.call('/api/stores/R250', { method: 'PUT', body: { enabled: false } })
    expect(s.enabledStores()).not.toContain('R250')

    await s.call('/api/stores/R250', { method: 'PUT', body: { enabled: true } })
    expect(s.enabledStores()).toContain('R250')
  })

  it('prunes the alerted rows of a store switched off, so no out-of-stock message follows', async () => {
    const s = await setup()
    await s.saveZip()
    s.watch(SILVER)
    s.db.insertAlerted({ part: SILVER, store: 'R250' })

    await s.call('/api/stores/R250', { method: 'PUT', body: { enabled: false } })

    expect(s.db.listAlerted()).toEqual([])
  })

  it('answers 404 for a store that is not listed', async () => {
    const s = await setup()
    await s.saveZip()

    const res = await s.call('/api/stores/R999', { method: 'PUT', body: { enabled: false } })

    expect(res.status).toBe(404)
  })

  it('rejects a body without a boolean enabled', async () => {
    const s = await setup()
    await s.saveZip()

    const res = await s.call('/api/stores/R250', { method: 'PUT', body: { enabled: 'no' } })

    expect(res.status).toBe(400)
    expect(s.enabledStores()).toContain('R250')
  })
})

describe('watches', () => {
  it('creates one watch per posted part with other colors on', async () => {
    const s = await setup()

    const res = await s.call('/api/watches', { method: 'POST', body: { parts: [SILVER, BLACK] } })
    const state = await s.state()

    expect(res.status).toBe(200)
    expect(state.watches.map((w) => [w.part, w.otherColors]).sort()).toEqual([
      [BLACK, true],
      [SILVER, true],
    ])
  })

  it('clears the alerted rows of a newly watched part so its watched alert still comes', async () => {
    const s = await setup()
    await s.saveZip()
    s.watch(SILVER)
    s.db.insertAlerted({ part: BURGUNDY, store: 'R250' })
    s.db.insertAlerted({ part: SILVER, store: 'R250' })

    await s.call('/api/watches', { method: 'POST', body: { parts: [BURGUNDY] } })

    expect(s.db.listAlerted()).toEqual([{ part: SILVER, store: 'R250' }])
  })

  it('rejects a part that is not in the catalog and creates none of the batch', async () => {
    const s = await setup()

    const res = await s.call('/api/watches', { method: 'POST', body: { parts: [SILVER, 'ZZZZZLL/A'] } })

    expect(res.status).toBe(400)
    expect(s.db.listWatches()).toEqual([])
  })

  it('rejects an empty parts list', async () => {
    const s = await setup()

    expect((await s.call('/api/watches', { method: 'POST', body: { parts: [] } })).status).toBe(400)
  })

  it('creates a watch once when the same part is posted twice', async () => {
    const s = await setup()

    await s.call('/api/watches', { method: 'POST', body: { parts: [SILVER, SILVER] } })
    const res = await s.call('/api/watches', { method: 'POST', body: { parts: [SILVER] } })

    expect(res.status).toBe(200)
    expect(s.db.listWatches()).toEqual([{ part: SILVER, otherColors: true }])
  })

  it('removes a watch addressed by its URL-encoded part number and prunes its alerted rows', async () => {
    const s = await setup()
    await s.saveZip()
    s.watch(SILVER)
    s.watch(BLACK, false)
    s.db.insertAlerted({ part: SILVER, store: 'R250' })

    const res = await s.call(`/api/watches/${encodeURIComponent(SILVER)}`, { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(s.db.listWatches().map((w) => w.part)).toEqual([BLACK])
    expect(s.db.listAlerted()).toEqual([])
  })

  it('answers 404 when removing a part that is not watched', async () => {
    const s = await setup()

    const res = await s.call(`/api/watches/${encodeURIComponent(SILVER)}`, { method: 'DELETE' })

    expect(res.status).toBe(404)
  })

  it('switching other colors off prunes the alerted rows of the sibling colors', async () => {
    const s = await setup()
    await s.saveZip()
    s.watch(SILVER)
    s.db.insertAlerted({ part: BURGUNDY, store: 'R250' })
    s.db.insertAlerted({ part: SILVER, store: 'R250' })

    const res = await s.call(`/api/watches/${encodeURIComponent(SILVER)}`, {
      method: 'PATCH',
      body: { otherColors: false },
    })

    expect(res.status).toBe(200)
    expect(s.db.listWatches()).toEqual([{ part: SILVER, otherColors: false }])
    expect(s.db.listAlerted()).toEqual([{ part: SILVER, store: 'R250' }])
  })

  it('answers 404 when switching other colors for a part that is not watched', async () => {
    const s = await setup()

    const res = await s.call(`/api/watches/${encodeURIComponent(SILVER)}`, { method: 'PATCH', body: { otherColors: false } })

    expect(res.status).toBe(404)
  })
})

function seedModel(s: Awaited<ReturnType<typeof setup>>, model: string, count: number): string[] {
  const parts = Array.from({ length: count }, (_, i) => ({
    part: `${model}-${i}`,
    modelName: model,
    capacity: '1tb',
    colorName: `Color ${i}`,
    title: `${model} 1TB Color ${i}`,
    buyUrl: 'https://www.apple.com/shop/buy-iphone/iphone-18-pro',
  }))
  s.db.upsertParts([...s.db.listParts(), ...parts])
  return parts.map((p) => p.part)
}

const post = (s: Awaited<ReturnType<typeof setup>>, parts: string[]) =>
  s.call('/api/watches', { method: 'POST', body: { parts } })

describe('parts cap', () => {
  it('accepts a watch that brings the tracked parts to exactly 20', async () => {
    const s = await setup()
    const [first] = seedModel(s, 'Cap A', 20)

    const res = await post(s, [first ?? ''])

    expect(res.status).toBe(200)
    expect((await s.state()).partsCount.tracked).toBe(20)
  })

  it('refuses a watch that would take the tracked parts to 21 and writes nothing', async () => {
    const s = await setup()
    const [first] = seedModel(s, 'Cap A', 21)

    const res = await post(s, [first ?? ''])

    expect(res.status).toBe(409)
    expect(res.json).toEqual({ error: 'parts-cap', cap: 20, tracked: 21, adding: 21 })
    expect(s.db.listWatches()).toEqual([])
  })

  it('counts only the parts the change adds to what is already tracked', async () => {
    const s = await setup()
    const [b] = seedModel(s, 'Cap B', 3)
    const [a] = seedModel(s, 'Cap A', 19)
    s.watch(b ?? '')

    const res = await post(s, [a ?? ''])

    expect(res.status).toBe(409)
    expect(res.json).toEqual({ error: 'parts-cap', cap: 20, tracked: 22, adding: 19 })
    expect(s.db.listWatches()).toEqual([{ part: b, otherColors: true }])
  })

  it('refuses turning other colors on when it would go past 20 and leaves the switch off', async () => {
    const s = await setup()
    const [a] = seedModel(s, 'Cap A', 1)
    const [b] = seedModel(s, 'Cap B', 20)
    s.watch(a ?? '', false)
    s.watch(b ?? '', false)

    const res = await s.call(`/api/watches/${encodeURIComponent(b ?? '')}`, { method: 'PATCH', body: { otherColors: true } })

    expect(res.status).toBe(409)
    expect(res.json).toEqual({ error: 'parts-cap', cap: 20, tracked: 21, adding: 19 })
    expect(s.db.listWatches().find((w) => w.part === b)?.otherColors).toBe(false)
  })

  it('lets other colors be switched on up to exactly 20', async () => {
    const s = await setup()
    const [a] = seedModel(s, 'Cap A', 20)
    s.watch(a ?? '', false)

    const res = await s.call(`/api/watches/${encodeURIComponent(a ?? '')}`, { method: 'PATCH', body: { otherColors: true } })

    expect(res.status).toBe(200)
    expect((await s.state()).partsCount.tracked).toBe(20)
  })

  it('never refuses removing a watch or switching other colors off, even over the cap', async () => {
    const s = await setup()
    const [a] = seedModel(s, 'Cap A', 20)
    const [b] = seedModel(s, 'Cap B', 20)
    s.watch(a ?? '')
    s.watch(b ?? '')

    const off = await s.call(`/api/watches/${encodeURIComponent(a ?? '')}`, { method: 'PATCH', body: { otherColors: false } })
    const removed = await s.call(`/api/watches/${encodeURIComponent(b ?? '')}`, { method: 'DELETE' })

    expect([off.status, removed.status]).toEqual([200, 200])
    expect(s.db.listWatches()).toEqual([{ part: a, otherColors: false }])
  })

  it('answers ok when a watch already tracked is posted again over the cap', async () => {
    const s = await setup()
    const [a] = seedModel(s, 'Cap A', 22)
    s.watch(a ?? '')

    expect((await post(s, [a ?? ''])).status).toBe(200)
  })

  it('inserts nothing and deletes no alerted row when an already watched part is posted again', async () => {
    const s = await setup()
    await s.saveZip()
    s.watch(SILVER, false)
    s.db.insertAlerted({ part: SILVER, store: 'R250' })

    const res = await post(s, [SILVER])

    expect(res.status).toBe(200)
    expect(s.db.listWatches()).toEqual([{ part: SILVER, otherColors: false }])
    expect(s.db.listAlerted()).toEqual([{ part: SILVER, store: 'R250' }])
  })
})

describe('PUT /api/interval', () => {
  it('saves a valid interval', async () => {
    const s = await setup()

    const res = await s.call('/api/interval', { method: 'PUT', body: { seconds: 120 } })

    expect(res.status).toBe(200)
    expect((await s.state()).intervalSec).toBe(120)
  })

  it.each([29, 3601, 60.5, '60'])('rejects the interval %j with 400 and keeps the saved one', async (seconds) => {
    const s = await setup()

    const res = await s.call('/api/interval', { method: 'PUT', body: { seconds } })

    expect(res.status).toBe(400)
    expect((await s.state()).intervalSec).toBe(60)
  })
})

describe('PUT /api/lan', () => {
  it('saves the setting and reports that a restart applies it', async () => {
    const s = await setup()

    const res = await s.call('/api/lan', { method: 'PUT', body: { enabled: true } })
    const { lan } = await s.state()

    expect(res.status).toBe(200)
    expect(lan.enabled).toBe(true)
    expect(lan.restartRequired).toBe(true)
  })

  it('lists the LAN URLs once Wi-Fi access is saved on', async () => {
    const s = await setup({ lanEnabled: true })
    s.db.setLanEnabled(true)

    const { lan } = await s.state()

    expect(lan).toEqual({
      enabled: true,
      restartRequired: false,
      urls: [`http://192.168.1.20:${PORT}`, `http://fabs-mac.local:${PORT}`],
    })
  })

  it('does not list a loopback interface among the LAN URLs', async () => {
    const s = await setup({ lanEnabled: true })
    s.db.setLanEnabled(true)
    s.setInterfaces({ lo0: [{ ...iface('127.0.0.1')[0]!, internal: true }], en0: iface('192.168.1.20') })

    const { lan } = await s.state()

    expect(lan.urls).toEqual([`http://192.168.1.20:${PORT}`, `http://fabs-mac.local:${PORT}`])
  })

  it('reports a restart is needed when the saved value is switched off while the server booted with it on', async () => {
    const s = await setup({ lanEnabled: true })
    s.db.setLanEnabled(true)

    await s.call('/api/lan', { method: 'PUT', body: { enabled: false } })
    const { lan } = await s.state()

    expect(lan).toEqual({ enabled: false, restartRequired: true, urls: [] })
  })

  it('rejects a body without a boolean enabled', async () => {
    const s = await setup()

    expect((await s.call('/api/lan', { method: 'PUT', body: { enabled: 1 } })).status).toBe(400)
  })
})

describe('POST /api/token', () => {
  it('stores a pasted cURL and reports status and expiry only', async () => {
    const s = await setup()

    const res = await s.call('/api/token', { method: 'POST', body: { curl: curlFor(NOW + HOUR) } })

    expect(res.status).toBe(200)
    expect(res.json).toEqual({ stored: true, token: { status: 'untested', expiresAt: NOW + HOUR } })
    expect(s.storedToken()).toMatchObject({ dssid2: DSSID2, expiresAt: NOW + HOUR })
  })

  it('stores an extension pair when nothing is stored', async () => {
    const s = await setup()

    const res = await s.call('/api/token', { method: 'POST', body: pair(NOW + HOUR) })

    expect(res.status).toBe(200)
    expect(res.json.stored).toBe(true)
    expect(s.storedToken()?.expiresAt).toBe(NOW + HOUR)
  })

  it('stores an extension pair whose timestamp is strictly newer and resets the expiry warning', async () => {
    const s = await setup()
    s.withToken()
    s.db.setTokenWarned(true)

    const res = await s.call('/api/token', { method: 'POST', body: pair(NOW + HOUR + 60_000, 'n') })

    expect(res.json.stored).toBe(true)
    expect(s.storedToken()?.expiresAt).toBe(NOW + HOUR + 60_000)
    expect(s.db.getSettings().tokenWarned).toBe(false)
  })

  it('answers 200 and stores nothing for an extension pair with an equal timestamp, keeping the expiry warning', async () => {
    const s = await setup()
    s.withToken()
    s.db.setTokenWarned(true)

    const res = await s.call('/api/token', { method: 'POST', body: pair(NOW + HOUR, 'other') })

    expect(res.status).toBe(200)
    expect(res.json.stored).toBe(false)
    expect(s.storedToken()).toEqual(STORED)
    expect(s.db.getSettings().tokenWarned).toBe(true)
  })

  it('answers 200 and stores nothing for an extension pair older than the stored one', async () => {
    const s = await setup()
    s.withToken()

    const res = await s.call('/api/token', { method: 'POST', body: pair(NOW + HOUR - 60_000, 'old') })

    expect(res.status).toBe(200)
    expect(res.json.stored).toBe(false)
    expect(s.storedToken()).toEqual(STORED)
  })

  it('replaces the stored pair with a pasted cURL whatever its timestamp', async () => {
    const s = await setup()
    s.withToken()

    const res = await s.call('/api/token', { method: 'POST', body: { curl: curlFor(NOW + HOUR - 60_000) } })

    expect(res.json.stored).toBe(true)
    expect(s.storedToken()?.expiresAt).toBe(NOW + HOUR - 60_000)
  })

  it.each([
    ['an expired pair', pair(NOW - 1000), 'expired'],
    ['a pair too far ahead', pair(NOW + 3 * HOUR), 'too-far-ahead'],
    ['a pair with a malformed shld_bt_ck', { ...pair(NOW + HOUR), shld_bt_ck: 'garbage' }, 'malformed'],
    ['a pair without dssid2', { ...pair(NOW + HOUR), dssid2: undefined }, 'missing-cookie'],
    ['a pair without a user agent', { ...pair(NOW + HOUR), userAgent: undefined }, 'missing-user-agent'],
    ['a cURL without cookies', { curl: "curl 'https://www.apple.com' -H 'user-agent: x'" }, 'missing-cookie'],
  ])('rejects %s with 400 and leaves the stored pair alone', async (_name, body, reason) => {
    const s = await setup()
    s.withToken()

    const res = await s.call('/api/token', { method: 'POST', body })

    expect(res.status).toBe(400)
    expect(res.json).toEqual({ error: 'token-rejected', reason })
    expect(s.storedToken()).toEqual(STORED)
  })

  it('rejects a body that is not JSON with 400', async () => {
    const s = await setup()

    const res = await s.call('/api/token', { method: 'POST', raw: '{not json' })

    expect(res.status).toBe(400)
  })
})

describe('POST /api/telegram/test', () => {
  it('sends a test message and answers ok', async () => {
    const s = await setup()

    const res = await s.call('/api/telegram/test', { method: 'POST', body: {} })

    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true })
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]?.text).toContain('<b>Test message</b>')
  })

  it('returns the classified Telegram error', async () => {
    const s = await setup()
    s.setReply({ ok: false, error: { kind: 'http', status: 401, description: 'Unauthorized' } })

    const res = await s.call('/api/telegram/test', { method: 'POST', body: {} })

    expect(res.status).toBe(502)
    expect(res.json).toEqual({ ok: false, error: { kind: 'http', status: 401, description: 'Unauthorized' } })
  })

  it('answers 409 when Telegram is not configured', async () => {
    const s = await setup({ telegram: null })

    const res = await s.call('/api/telegram/test', { method: 'POST', body: {} })

    expect(res.status).toBe(409)
  })
})

describe('Host guard', () => {
  it.each(['localhost', 'localhost:4319', '127.0.0.1', '127.0.0.1:4319', '[::1]', '[::1]:4319', 'LOCALHOST:4319'])(
    'accepts the loopback Host %s',
    async (host) => {
      const s = await setup()

      expect((await s.call('/api/state', { headers: { host } })).status).toBe(200)
    },
  )

  it.each(['evil.example', 'evil.example:4319', 'localhost.evil.example', '192.168.1.20:4319', 'fabs-mac.local'])(
    'rejects the Host %s while Wi-Fi access is off',
    async (host) => {
      const s = await setup()

      const res = await s.call('/api/state', { headers: { host } })

      expect(res.status).toBe(403)
    },
  )

  it('rejects a request without a Host header', async () => {
    const s = await setup()

    const res = await s.api.request('/api/state', {}, LOOPBACK)

    expect(res.status).toBe(403)
  })

  it('rejects a forged Host on a mutation too', async () => {
    const s = await setup()

    const res = await s.call('/api/zip', { method: 'PUT', body: { zip: '10001' }, headers: { host: 'evil.example' } })

    expect(res.status).toBe(403)
    expect(s.storeLookups).toEqual([])
  })

  it("accepts the Mac's IPv4 address and <hostname>.local when Wi-Fi access was on at boot", async () => {
    const s = await setup({ lanEnabled: true })

    for (const host of ['192.168.1.20:4319', 'fabs-mac.local:4319']) {
      expect((await s.call('/api/state', { headers: { host } })).status).toBe(200)
    }
    expect((await s.call('/api/state', { headers: { host: '192.168.1.99' } })).status).toBe(403)
  })

  it('picks up a changed network address after the 5 s cache expires, not before', async () => {
    const s = await setup({ lanEnabled: true })
    await s.call('/api/state', { headers: { host: '192.168.1.20' } })
    s.setInterfaces({ en0: iface('10.0.0.7'), en1: iface('fe80::1', 'IPv6') })

    s.advance(4000)
    expect((await s.call('/api/state', { headers: { host: '10.0.0.7' } })).status).toBe(403)

    s.advance(1500)
    expect((await s.call('/api/state', { headers: { host: '10.0.0.7' } })).status).toBe(200)
    expect((await s.call('/api/state', { headers: { host: '192.168.1.20' } })).status).toBe(403)
  })
})

describe('mutation guard', () => {
  it.each([undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'])(
    'rejects a mutation with Content-Type %s',
    async (contentType) => {
      const s = await setup()
      const headers: Record<string, string> = contentType ? { 'content-type': contentType } : { 'content-type': '' }

      const res = await s.call('/api/zip', { method: 'PUT', body: { zip: '10001' }, headers })

      expect(res.status).toBe(415)
      expect(s.storeLookups).toEqual([])
    },
  )

  it('accepts application/json with a charset', async () => {
    const s = await setup()

    const res = await s.call('/api/zip', {
      method: 'PUT',
      body: { zip: '10001' },
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })

    expect(res.status).toBe(200)
  })

  it('accepts a mutation without an Origin header', async () => {
    const s = await setup()

    expect((await s.call('/api/zip', { method: 'PUT', body: { zip: '10001' } })).status).toBe(200)
  })

  it("accepts the page's own origin", async () => {
    const s = await setup()

    const res = await s.call('/api/zip', {
      method: 'PUT',
      body: { zip: '10001' },
      headers: { origin: `http://localhost:${PORT}` },
    })

    expect(res.status).toBe(200)
  })

  it.each(['https://evil.example', `http://localhost:${PORT + 1}`, 'null', 'http://127.0.0.1:4319'])(
    'rejects a mutation from the origin %s',
    async (origin) => {
      const s = await setup()

      const res = await s.call('/api/zip', { method: 'PUT', body: { zip: '10001' }, headers: { origin } })

      expect(res.status).toBe(403)
      expect(s.storeLookups).toEqual([])
    },
  )

  it('accepts a token post from exactly the pinned extension origin', async () => {
    const s = await setup()

    const res = await s.call('/api/token', {
      method: 'POST',
      body: pair(NOW + HOUR),
      headers: { origin: `chrome-extension://${EXTENSION_ID}` },
    })

    expect(res.status).toBe(200)
    expect(s.storedToken()).not.toBeNull()
  })

  it.each(['chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', `chrome-extension://${EXTENSION_ID}x`, 'moz-extension://abc'])(
    'rejects a token post from the origin %s',
    async (origin) => {
      const s = await setup()

      const res = await s.call('/api/token', { method: 'POST', body: pair(NOW + HOUR), headers: { origin } })

      expect(res.status).toBe(403)
      expect(s.storedToken()).toBeNull()
    },
  )

  it('sends no CORS headers on any response, preflight included', async () => {
    const s = await setup()
    const origin = `chrome-extension://${EXTENSION_ID}`

    const responses = [
      await s.call('/api/state', { headers: { origin } }),
      await s.call('/api/token', { method: 'POST', body: pair(NOW + HOUR), headers: { origin } }),
      await s.call('/api/state', { headers: { host: 'evil.example', origin } }),
      await s.call('/api/zip', { method: 'PUT', body: {}, headers: { origin: 'https://evil.example' } }),
      await s.call('/api/token', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'content-type': 'application/json' },
      }),
    ]

    for (const res of responses) {
      expect([...res.headers.keys()].filter((h) => h.startsWith('access-control-'))).toEqual([])
    }
  })
})

describe('loopback guard', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('lets POST /api/token and PUT /api/lan through from %s', async (remote) => {
    const s = await setup()

    expect((await s.call('/api/token', { method: 'POST', body: pair(NOW + HOUR), remote })).status).toBe(200)
    expect((await s.call('/api/lan', { method: 'PUT', body: { enabled: true }, remote })).status).toBe(200)
  })

  it('refuses POST /api/token and PUT /api/lan from a LAN address even with an allowed Host', async () => {
    const s = await setup({ lanEnabled: true })
    const headers = { host: '192.168.1.20:4319' }

    const token = await s.call('/api/token', { method: 'POST', body: pair(NOW + HOUR), remote: '192.168.1.50', headers })
    const lan = await s.call('/api/lan', { method: 'PUT', body: { enabled: true }, remote: '192.168.1.50', headers })

    expect(token.status).toBe(403)
    expect(lan.status).toBe(403)
    expect(s.storedToken()).toBeNull()
    expect(s.db.getSettings().lanEnabled).toBe(false)
  })

  it('lets a LAN device read the state and change watches when Wi-Fi access is on', async () => {
    const s = await setup({ lanEnabled: true })
    const headers = { host: '192.168.1.20:4319' }

    expect((await s.call('/api/state', { remote: '192.168.1.50', headers })).status).toBe(200)
    const res = await s.call('/api/watches', { method: 'POST', body: { parts: [SILVER] }, remote: '192.168.1.50', headers })
    expect(res.status).toBe(200)
  })
})

describe('no secrets in responses', () => {
  it('never returns the Apple cookie values or the bot token from any route, error paths included', async () => {
    const telegram = createTelegram({
      fetch: (async (url: string) => {
        throw new TypeError(`fetch failed for ${url}`)
      }) as unknown as typeof fetch,
      botToken: BOT_TOKEN,
      chatId: '42',
    })
    const s = await setup({ telegram })
    const storedShld = shld(NOW + HOUR, 'stored')
    s.db.setToken({ dssid2: DSSID2, shldBtCk: storedShld, userAgent: 'Mozilla/5.0 test', expiresAt: NOW + HOUR })
    await s.saveZip()
    s.watch(SILVER)
    s.setFulfillment('fulfillment-all-out.json')
    await s.monitor.runCheck()

    const responses = [
      await s.call('/api/state'),
      await s.call('/api/zip', { method: 'PUT', body: { zip: '10001' } }),
      await s.call('/api/zip', { method: 'PUT', body: { zip: DSSID2 } }),
      await s.call('/api/stores/R250', { method: 'PUT', body: { enabled: false } }),
      await s.call('/api/stores/R250', { method: 'PUT', body: { enabled: DSSID2 } }),
      await s.call('/api/watches', { method: 'POST', body: { parts: [BLACK, DSSID2] } }),
      await s.call('/api/watches', { method: 'POST', body: { parts: [BLACK] } }),
      await s.call(`/api/watches/${encodeURIComponent(BLACK)}`, { method: 'PATCH', body: { otherColors: false } }),
      await s.call(`/api/watches/${encodeURIComponent(BLACK)}`, { method: 'DELETE' }),
      await s.call('/api/interval', { method: 'PUT', body: { seconds: DSSID2 } }),
      await s.call('/api/interval', { method: 'PUT', body: { seconds: 90 } }),
      await s.call('/api/lan', { method: 'PUT', body: { enabled: true } }),
      await s.call('/api/token', { method: 'POST', body: { curl: curlFor(NOW - 1000) } }),
      await s.call('/api/token', { method: 'POST', body: { ...pair(NOW + 3 * HOUR), botToken: BOT_TOKEN } }),
      await s.call('/api/token', { method: 'POST', body: pair(NOW + HOUR, 'other') }),
      await s.call('/api/token', { method: 'POST', raw: `{${DSSID2}` }),
      await s.call('/api/telegram/test', { method: 'POST', body: {} }),
      await s.call('/api/state', { headers: { host: DSSID2 } }),
      await s.call('/api/zip', { method: 'PUT', body: { zip: '10001' }, headers: { origin: `https://${DSSID2}` } }),
      await s.call(`/api/${DSSID2}`),
      await s.state().then(() => s.call('/api/state')),
    ]

    const dump = responses.map((r) => `${r.text}\n${[...r.headers].join('\n')}`).join('\n')
    expect(responses.map((r) => r.status)).toContain(502)
    expect(dump).not.toContain(DSSID2)
    expect(dump).not.toContain(storedShld)
    expect(dump).not.toContain('Mozilla/5.0 test')
    expect(dump).not.toContain(BOT_TOKEN)
    expect(dump).not.toContain('SECRET')
    expect(dump).not.toContain('api.telegram.org')
  })

  it('shows Telegram last error as kind, status and description only', async () => {
    const s = await setup()
    s.setReply({ ok: false, error: { kind: 'http', status: 400, description: 'Bad Request: chat not found' } })
    await s.saveZip()
    s.withToken()
    s.watch(SILVER)
    s.setFulfillment('fulfillment-all-out.json', { [`${SILVER}@R250`]: 'Today' })

    await s.monitor.runCheck()
    const state = await s.state()

    expect(state.telegram).toEqual({
      configured: true,
      lastError: { kind: 'http', status: 400, description: 'Bad Request: chat not found' },
    })
  })
})
