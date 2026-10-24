import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApple, type Apple, type AppleToken } from '../src/server/apple'
import { openDb } from '../src/server/db'
import { PARTS_CAP } from '../src/server/domain'
import { createMonitor } from '../src/server/monitor'
import { createTelegram, type OutgoingMessage, type SendResult, type Telegram } from '../src/server/telegram'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const NOW = Date.parse('2026-10-23T12:00:00Z')
const HOUR = 3_600_000
const SILVER = 'MJQ84LL/A'
const BURGUNDY = 'MJQ94LL/A'
const SILVER_URL = 'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-512gb-silver-unlocked'
const BURGUNDY_URL = 'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-512gb-burgundy-unlocked'
const MAX_1TB = 'MJWE4LL/A'
const PRO_256_BLACK = 'MJQ34LL/A'
const PRO_256_SILVER = 'MJQ44LL/A'
const OTHER_GROUPS = ['MJQ34LL/A', 'MJQD4LL/A', 'MJQH4LL/A', 'MJW54LL/A', 'MJW94LL/A', MAX_1TB, 'MJWJ4LL/A']
const TOKEN: AppleToken = { dssid2: 'fake-dssid2', shldBtCk: 'id|1|payload|sig', userAgent: 'Mozilla/5.0 test', expiresAt: NOW + HOUR }

type Stock = 'Today' | 'Tomorrow' | 'unavailable' | 'default'

function fulfillmentBody(stock: Record<string, Stock>, requested: string[] = []): string {
  const body = JSON.parse(fixture('fulfillment-all-out.json'))
  for (const store of body.body.content.pickupMessage.stores) {
    const template = Object.values<{ pickupDisplay: string; pickupSearchQuote: string }>(store.partsAvailability)[0]
    for (const part of requested) store.partsAvailability[part] ??= { ...template }
    for (const [part, availability] of Object.entries<{ pickupDisplay: string; pickupSearchQuote: string }>(
      store.partsAvailability,
    )) {
      const state = stock[`${part}@${store.storeNumber}`]
      if (state === 'Today' || state === 'Tomorrow') {
        availability.pickupDisplay = 'available'
        availability.pickupSearchQuote = `Available ${state}`
      } else if (state === 'default') {
        availability.pickupDisplay = 'default'
      }
    }
  }
  return JSON.stringify(body)
}

const inStockAt = (part: string, stores: string[]) =>
  Object.fromEntries(stores.map((store) => [`${part}@${store}`, 'Today' as const]))

async function setup(options: { appleSeconds?: number } = {}) {
  let t = NOW
  const now = () => t
  const sleeps: number[] = []
  let duringSleep = () => {}
  const sleep = async (ms: number) => {
    sleeps.push(ms)
    t += ms
    duringSleep()
  }

  let stock: Record<string, Stock> = {}
  let fulfillmentStatus = 200
  let networkDown = false
  const fulfillmentUrls: string[] = []
  const fetchFake = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('product-locator-meta')) {
      return new Response(fixture(url.includes('family=iphoneduo') ? 'locator-duo.json' : 'locator-18pro.json'))
    }
    if (url.includes('pickup-message-recommendations')) return new Response(fixture('stores-10001.json'))
    fulfillmentUrls.push(url)
    t += (options.appleSeconds ?? 0) * 1000
    if (networkDown) throw new TypeError('fetch failed')
    if (fulfillmentStatus !== 200) return new Response(fixture('rejected-541.html'), { status: fulfillmentStatus })
    const requested = [...new URL(url).searchParams].filter(([k]) => k.startsWith('parts.')).map(([, v]) => v)
    return new Response(fulfillmentBody(stock, requested))
  }) as typeof fetch
  const apple = createApple({ fetch: fetchFake, now })

  const attempts: (OutgoingMessage & { at: number })[] = []
  let reply: (message: OutgoingMessage) => SendResult | Promise<SendResult> = () => ({ ok: true })
  const telegram: Telegram = {
    async sendMessage(message) {
      attempts.push({ ...message, at: now() })
      return reply(message)
    },
  }

  const db = openDb(':memory:')
  const monitor = createMonitor({ apple, telegram, db, now, sleep })
  await monitor.loadCatalog()
  const stores = await apple.fetchStores('10001', SILVER)
  if (stores.ok) db.replaceStores(stores.value)
  db.setZip('10001')
  db.setToken(TOKEN)

  return {
    apple,
    db,
    monitor,
    attempts,
    sleeps,
    fulfillmentUrls,
    now,
    advance: (ms: number) => {
      t += ms
    },
    setStock: (next: Record<string, Stock>) => {
      stock = next
    },
    setFulfillmentStatus: (status: number) => {
      fulfillmentStatus = status
    },
    setNetworkDown: (down: boolean) => {
      networkDown = down
    },
    onSend: (fn: typeof reply) => {
      reply = fn
    },
    onSleep: (fn: () => void) => {
      duringSleep = fn
    },
    texts: () => attempts.map((a) => a.text),
    watch: (part: string, otherColors = false) => db.addWatch(part, otherColors, NOW),
    alerted: () => db.listAlerted().map((a) => `${a.part}@${a.store}`),
  }
}

describe('in-stock and out-of-stock alerts', () => {
  it('sends one in-stock message with model, storage, color, store, distance, Today and a buy-page button', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.setStock({ [`${SILVER}@R250`]: 'Today' })

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(1)
    const [message] = s.attempts
    expect(message?.text).toContain('iPhone 18 Pro 512GB')
    expect(message?.text).toContain('Silver')
    expect(message?.text).toContain('West 14th Street')
    expect(message?.text).toContain('0.7 mi')
    expect(message?.text).toContain('Today')
    expect(message?.buttons?.[0]?.url).toBe(SILVER_URL)
    expect(message?.silent).toBeUndefined()
    expect(s.alerted()).toEqual([`${SILVER}@R250`])
  })

  it('sends one message with sound for two colors coming in at three stores, every store new', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.watch(BURGUNDY)
    s.setStock({ ...inStockAt(SILVER, ['R250', 'R415', 'R032']), ...inStockAt(BURGUNDY, ['R250', 'R415', 'R032']) })

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(1)
    const [message] = s.attempts
    for (const word of ['Silver', 'Burgundy', 'West 14th Street', 'Grand Central', 'SoHo']) expect(message?.text).toContain(word)
    expect(message?.text.match(/🆕/g)).toHaveLength(6)
    expect(message?.silent).toBeUndefined()
    expect(s.alerted()).toHaveLength(6)
  })

  it('lists all four stores when a fourth comes in later, with only the fourth marked new', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.setStock(inStockAt(SILVER, ['R250', 'R415', 'R032']))
    await s.monitor.runCheck()

    s.setStock(inStockAt(SILVER, ['R250', 'R415', 'R032', 'R095']))
    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(2)
    const text = s.texts()[1] ?? ''
    for (const word of ['West 14th Street', 'Grand Central', 'SoHo', 'Fifth Avenue']) expect(text).toContain(word)
    expect(text.match(/🆕/g)).toHaveLength(1)
    expect(text).toContain('🆕 Fifth Avenue')
  })

  it('sends one silent message with the stores left and the one that went out when a store goes out', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.setStock(inStockAt(SILVER, ['R250', 'R415']))
    await s.monitor.runCheck()

    s.setStock(inStockAt(SILVER, ['R250']))
    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(2)
    const message = s.attempts[1]
    expect(message?.silent).toBe(true)
    expect(message?.text).toContain('Today: West 14th Street')
    expect(message?.text).toContain('Gone: Silver at Grand Central')
    expect(message?.text).not.toMatch(/sold out/i)
    expect(s.alerted()).toEqual([`${SILVER}@R250`])
  })

  it('labels Tomorrow pickups with Tomorrow', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.setStock({ [`${SILVER}@R250`]: 'Tomorrow' })

    await s.monitor.runCheck()

    expect(s.texts()[0]).toContain('Tomorrow')
  })

  it('gives exactly one in-stock and one out-of-stock message over out, in, in, out', async () => {
    const s = await setup()
    s.watch(SILVER)

    await s.monitor.runCheck()
    s.setStock({ [`${SILVER}@R250`]: 'Today' })
    await s.monitor.runCheck()
    await s.monitor.runCheck()
    s.setStock({})
    await s.monitor.runCheck()

    expect(s.texts()).toHaveLength(2)
    expect(s.texts()[0]).toContain('Today: 🆕 West 14th Street')
    expect(s.texts()[1]).toMatch(/sold out everywhere/i)
    expect(s.texts()[1]).toContain('iPhone 18 Pro 512GB')
    expect(s.texts()[1]).toContain('West 14th Street')
    expect(s.attempts[1]?.silent).toBe(true)
    expect(s.alerted()).toEqual([])
  })

  it('sends nothing when the day label changes while the pair stays in stock', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.setStock({ [`${SILVER}@R250`]: 'Tomorrow' })
    await s.monitor.runCheck()

    s.setStock({ [`${SILVER}@R250`]: 'Today' })
    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(1)
  })

  it('sends nothing for an unchanged pair after a restart over the same database', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.setStock({ [`${SILVER}@R250`]: 'Today' })
    await s.monitor.runCheck()

    const restarted = createMonitor({
      apple: s.apple,
      telegram: { sendMessage: async (m) => (s.attempts.push({ ...m, at: s.now() }), { ok: true }) },
      db: s.db,
      now: s.now,
    })
    await restarted.runCheck()

    expect(s.attempts).toHaveLength(1)
  })

  it.each(['unavailable', 'default'] as const)('treats %s as not in stock: an alerted pair goes out', async (state) => {
    const s = await setup()
    s.watch(SILVER)
    s.setStock({ [`${SILVER}@R250`]: 'Today' })
    await s.monitor.runCheck()

    s.setStock({ [`${SILVER}@R250`]: state })
    await s.monitor.runCheck()

    expect(s.texts()).toHaveLength(2)
    expect(s.texts()[1]).toMatch(/sold out everywhere/i)
  })

  it('does not alert for a store that is toggled off', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.db.setStoreEnabled('R250', false)
    s.setStock({ [`${SILVER}@R250`]: 'Today' })

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(0)
    expect(s.alerted()).toEqual([])
  })
})

describe('other colors', () => {
  it('sends an "Other color" message with the same fields and the sibling buy-page button', async () => {
    const s = await setup()
    s.watch(SILVER, true)
    s.setStock({ [`${BURGUNDY}@R250`]: 'Today' })

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(1)
    const message = s.attempts[0]
    expect(message?.text).toContain('<b>Burgundy</b> · Other color')
    expect(message?.text).toContain('iPhone 18 Pro 512GB')
    expect(message?.text).toContain('West 14th Street')
    expect(message?.text).toContain('0.7 mi')
    expect(message?.text).toContain('Today')
    expect(message?.buttons?.[0]?.url).toBe(BURGUNDY_URL)
  })

  it('lists a watched color and its other color in one message, the other labelled "Other color"', async () => {
    const s = await setup()
    s.watch(SILVER, true)
    s.setStock({ [`${SILVER}@R250`]: 'Today', [`${BURGUNDY}@R250`]: 'Tomorrow' })

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(1)
    expect(s.texts()[0]).toContain('<b>Silver</b>')
    expect(s.texts()[0]).toContain('<b>Burgundy</b> · Other color')
    expect(s.alerted()).toEqual([`${SILVER}@R250`, `${BURGUNDY}@R250`])
  })

  it('sends one silent message naming the other color when it goes back out', async () => {
    const s = await setup()
    s.watch(SILVER, true)
    s.setStock({ [`${BURGUNDY}@R250`]: 'Today' })
    await s.monitor.runCheck()

    s.setStock({})
    await s.monitor.runCheck()

    expect(s.texts()).toHaveLength(2)
    expect(s.texts()[1]).toContain('Gone: Burgundy at West 14th Street')
    expect(s.attempts[1]?.silent).toBe(true)
  })

  it('sends no other-color message when the watch has the switch off', async () => {
    const s = await setup()
    s.watch(SILVER, false)
    s.setStock({ [`${BURGUNDY}@R250`]: 'Today' })

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(0)
  })

  it('turning the switch off prunes the other-color rows silently and no out-of-stock message follows', async () => {
    const s = await setup()
    s.watch(SILVER, true)
    s.setStock({ [`${BURGUNDY}@R250`]: 'Today' })
    await s.monitor.runCheck()
    expect(s.alerted()).toEqual([`${BURGUNDY}@R250`])

    s.db.setOtherColors(SILVER, false)
    s.monitor.reconcile()
    expect(s.alerted()).toEqual([])

    s.setStock({})
    await s.monitor.runCheck()
    expect(s.attempts).toHaveLength(1)
  })

  it('watching a color already alerted as another color sends a watched in-stock alert on the next check', async () => {
    const s = await setup()
    s.watch(SILVER, true)
    s.setStock({ [`${BURGUNDY}@R250`]: 'Today' })
    await s.monitor.runCheck()

    s.watch(BURGUNDY, true)
    s.monitor.reconcile({ newlyWatched: [BURGUNDY] })
    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(2)
    expect(s.texts()[1]).not.toContain('Other color')
    expect(s.texts()[1]).toContain('Burgundy')
    expect(s.alerted()).toEqual([`${BURGUNDY}@R250`])
  })
})

describe('reconcile', () => {
  it('prunes rows of a store that was switched off and of a removed watch, without sending anything', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.watch(BURGUNDY)
    s.setStock({ [`${SILVER}@R250`]: 'Today', [`${SILVER}@R415`]: 'Today', [`${BURGUNDY}@R250`]: 'Today' })
    await s.monitor.runCheck()
    expect(s.alerted()).toHaveLength(3)

    s.db.setStoreEnabled('R415', false)
    s.db.removeWatch(BURGUNDY)
    s.monitor.reconcile()

    expect(s.alerted()).toEqual([`${SILVER}@R250`])
    expect(s.attempts).toHaveLength(1)
  })
})

describe('check inputs', () => {
  it('sends one Apple request holding every tracked part and the zip', async () => {
    const s = await setup()
    s.watch(SILVER, true)
    await s.monitor.runCheck()

    expect(s.fulfillmentUrls).toHaveLength(1)
    const url = s.fulfillmentUrls[0] ?? ''
    expect(url).toContain(`parts.0=${encodeURIComponent(SILVER)}`)
    expect(url).toContain(encodeURIComponent(BURGUNDY))
    expect(url).toContain('location=10001')
  })

  it('never requests more than 20 parts and keeps every watched part ahead of the other colors', async () => {
    const s = await setup()
    const silver = s.db.listParts().find((p) => p.part === SILVER)
    if (!silver) throw new Error('fixture catalog lost the silver part')
    const extras = Array.from({ length: 25 }, (_, i) => ({ ...silver, part: `EXTRA${i}LL/A`, colorName: `Extra ${i}` }))
    s.db.upsertParts([...s.db.listParts(), ...extras])
    s.watch(SILVER, true)
    s.watch(BURGUNDY, false)

    await s.monitor.runCheck()

    const requested = [...(s.fulfillmentUrls[0] ?? '').matchAll(/parts\.\d+=([^&]+)/g)].map((m) => decodeURIComponent(m[1] ?? ''))
    expect(requested).toHaveLength(PARTS_CAP)
    expect(requested.slice(0, 2)).toEqual([SILVER, BURGUNDY])
    const others = s.db
      .listParts()
      .filter((p) => p.modelName === silver.modelName && p.capacity === silver.capacity && ![SILVER, BURGUNDY].includes(p.part))
    expect(requested.slice(2)).toEqual(others.slice(0, PARTS_CAP - 2).map((p) => p.part))
  })

  it.each([
    ['no token', (s: Awaited<ReturnType<typeof setup>>) => s.db.clearToken()],
    ['no zip', (s: Awaited<ReturnType<typeof setup>>) => s.db.setZip(null)],
    ['no watch', (s: Awaited<ReturnType<typeof setup>>) => s.db.removeWatch(SILVER)],
  ])('skips the check when there is %s', async (_name, undo) => {
    const s = await setup()
    s.watch(SILVER)
    undo(s)

    const result = await s.monitor.runCheck()

    expect(result).toEqual({ skipped: true })
    expect(s.fulfillmentUrls).toHaveLength(0)
  })
})

describe('snapshot', () => {
  it('keeps observations, store metadata and the check times after a successful check', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.setStock({ [`${SILVER}@R250`]: 'Today' })

    await s.monitor.runCheck()

    const snap = s.monitor.snapshot()
    expect(snap.lastCheckAt).toBe(NOW)
    expect(snap.lastSuccessAt).toBe(NOW)
    expect(snap.observations).toContainEqual({ part: SILVER, store: 'R250', pickup: { kind: 'in', label: 'Today' } })
    expect(snap.stores).toContainEqual({ store: 'R250', name: 'West 14th Street', distanceMi: 0.66 })
  })

  it('moves lastCheckAt but not lastSuccessAt when a check fails', async () => {
    const s = await setup()
    s.watch(SILVER)
    await s.monitor.runCheck()
    s.advance(60_000)
    s.setFulfillmentStatus(541)

    const result = await s.monitor.runCheck()

    expect(result).toEqual({ ok: false, cause: 'token-rejected' })
    expect(s.monitor.snapshot().lastCheckAt).toBe(NOW + 60_000)
    expect(s.monitor.snapshot().lastSuccessAt).toBe(NOW)
  })
})

describe('send pass', () => {
  const textStarts = (text: string | undefined, heading: string) => expect(text?.startsWith(heading)).toBe(true)

  it('sends one message at a time at least 1.1 s apart', async () => {
    const s = await setup()
    OTHER_GROUPS.slice(0, 3).forEach((part) => s.watch(part))
    s.setStock(Object.fromEntries(OTHER_GROUPS.slice(0, 3).map((part) => [`${part}@R250`, 'Today' as const])))

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(3)
    const [a, b, c] = s.attempts.map((m) => m.at)
    expect((b ?? 0) - (a ?? 0)).toBeGreaterThanOrEqual(1100)
    expect((c ?? 0) - (b ?? 0)).toBeGreaterThanOrEqual(1100)
  })

  it('sends groups with a watched in-stock color, then only other-color in-stock, then out-only', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.watch(PRO_256_BLACK, true)
    s.watch(MAX_1TB)
    s.setStock({ [`${SILVER}@R250`]: 'Today' })
    await s.monitor.runCheck()
    s.attempts.length = 0

    s.setStock({ [`${PRO_256_SILVER}@R250`]: 'Today', [`${MAX_1TB}@R250`]: 'Today' })
    await s.monitor.runCheck()

    expect(s.texts()).toHaveLength(3)
    textStarts(s.texts()[0], '<b>📱 iPhone 18 Pro Max 1TB</b>')
    textStarts(s.texts()[1], '<b>📱 iPhone 18 Pro 256GB</b>')
    textStarts(s.texts()[2], '<b>📱 iPhone 18 Pro 512GB</b>')
    expect(s.texts()[2]).toMatch(/sold out everywhere/i)
  })

  it('skips a group Telegram refuses with a 4xx, sends the next, and keeps the refused rows for the next check', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.watch(MAX_1TB)
    s.setStock({ [`${SILVER}@R250`]: 'Today', [`${MAX_1TB}@R250`]: 'Today' })
    let calls = 0
    s.onSend(() =>
      ++calls === 1 ? { ok: false, error: { kind: 'http', status: 400, description: 'Bad Request: chat not found' } } : { ok: true },
    )

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(2)
    expect(s.alerted()).toEqual([`${MAX_1TB}@R250`])
    expect(s.monitor.snapshot().telegramLastError).toEqual({
      kind: 'http',
      status: 400,
      description: 'Bad Request: chat not found',
    })

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(3)
    expect(s.texts()[2]).toContain('Silver')
    expect(s.alerted()).toEqual([`${SILVER}@R250`, `${MAX_1TB}@R250`])
    expect(s.monitor.snapshot().telegramLastError).toBeNull()
  })

  it('stops the pass on a network error, commits nothing, and resends every group next check', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.watch(MAX_1TB)
    s.setStock({ [`${SILVER}@R250`]: 'Today', [`${MAX_1TB}@R250`]: 'Today' })
    s.onSend(() => ({ ok: false, error: { kind: 'network' } }))

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(1)
    expect(s.alerted()).toEqual([])
    expect(s.monitor.snapshot().telegramLastError).toEqual({ kind: 'network' })

    s.onSend(() => ({ ok: true }))
    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(3)
    expect(s.alerted()).toEqual([`${SILVER}@R250`, `${MAX_1TB}@R250`])
    expect(s.monitor.snapshot().telegramLastError).toBeNull()
  })

  it('stops the pass on a 429 that cannot be waited out', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.watch(MAX_1TB)
    s.setStock({ [`${SILVER}@R250`]: 'Today', [`${MAX_1TB}@R250`]: 'Today' })
    s.onSend(() => ({ ok: false, error: { kind: 'http', status: 429 }, retryAfterSec: 40 }))

    await s.monitor.runCheck({ deadline: NOW + 30_000 })

    expect(s.sleeps).toEqual([])
    expect(s.attempts).toHaveLength(1)
    expect(s.alerted()).toEqual([])
  })

  it('waits retry_after once on a 429 when it fits before the deadline, then sends', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.setStock({ [`${SILVER}@R250`]: 'Today' })
    let calls = 0
    s.onSend(() => (++calls === 1 ? { ok: false, error: { kind: 'http', status: 429 }, retryAfterSec: 3 } : { ok: true }))

    await s.monitor.runCheck({ deadline: NOW + 60_000 })

    expect(s.sleeps).toEqual([3000])
    expect(s.attempts).toHaveLength(2)
    expect(s.alerted()).toEqual([`${SILVER}@R250`])
  })

  it('does not wait on a 429 whose retry_after runs past the deadline: nothing committed', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.setStock({ [`${SILVER}@R250`]: 'Today' })
    s.onSend(() => ({ ok: false, error: { kind: 'http', status: 429 }, retryAfterSec: 40 }))

    await s.monitor.runCheck({ deadline: NOW + 30_000 })

    expect(s.sleeps).toEqual([])
    expect(s.attempts).toHaveLength(1)
    expect(s.alerted()).toEqual([])
  })

  it('ends the pass 5 s before the deadline', async () => {
    const s = await setup()
    const parts = [SILVER, ...OTHER_GROUPS]
    parts.forEach((part) => s.watch(part))
    s.setStock(Object.fromEntries(parts.map((part) => [`${part}@R250`, 'Today' as const])))

    await s.monitor.runCheck({ deadline: NOW + 10_000 })

    expect(s.attempts).toHaveLength(5)
    expect(s.attempts.every((m) => m.at <= NOW + 5000)).toBe(true)
  })

  it('still sends the first watched in-stock message when a slow Apple call used up the time before the deadline', async () => {
    const s = await setup({ appleSeconds: 28 })
    s.watch(SILVER)
    s.watch(MAX_1TB)
    s.setStock({ [`${SILVER}@R250`]: 'Today', [`${MAX_1TB}@R250`]: 'Today' })

    await s.monitor.runCheck({ deadline: NOW + 30_000 })

    expect(s.attempts).toHaveLength(1)
    expect(s.texts()[0]).toContain('Silver')
    expect(s.alerted()).toEqual([`${SILVER}@R250`])
  })

  it('skips a group whose only store was toggled off during the pass: no message, no row', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.watch(MAX_1TB)
    s.setStock({ [`${SILVER}@R250`]: 'Today', [`${MAX_1TB}@R415`]: 'Today' })
    s.onSend(() => {
      s.db.setStoreEnabled('R415', false)
      return { ok: true }
    })

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(1)
    expect(s.alerted()).toEqual([`${SILVER}@R250`])
  })

  it('commits only the rows of a message whose store was toggled off while it was being delivered', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.setStock({ [`${SILVER}@R250`]: 'Today', [`${SILVER}@R415`]: 'Today' })
    s.onSend(() => {
      s.db.setStoreEnabled('R415', false)
      return { ok: true }
    })

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(1)
    expect(s.alerted()).toEqual([`${SILVER}@R250`])
  })

  it('drops a stale other-color event before its group is sent when the color becomes watched, and the next check sends it as watched', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.watch(PRO_256_BLACK, true)
    s.setStock({ [`${SILVER}@R250`]: 'Today', [`${PRO_256_SILVER}@R250`]: 'Today' })
    let first = true
    s.onSend(() => {
      if (first) {
        first = false
        s.watch(PRO_256_SILVER)
        s.monitor.reconcile({ newlyWatched: [PRO_256_SILVER] })
      }
      return { ok: true }
    })

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(1)
    expect(s.alerted()).toEqual([`${SILVER}@R250`])

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(2)
    textStarts(s.texts()[1], '<b>📱 iPhone 18 Pro 256GB</b>')
    expect(s.texts()[1]).not.toContain('Other color')
    expect(s.alerted()).toEqual([`${PRO_256_SILVER}@R250`, `${SILVER}@R250`])
  })

  it('skips the insert of a color that became watched while its "Other color" message was in flight, and the next check sends it as watched', async () => {
    const s = await setup()
    s.watch(SILVER, true)
    s.setStock({ [`${BURGUNDY}@R250`]: 'Today' })
    let first = true
    s.onSend(() => {
      if (first) {
        first = false
        s.watch(BURGUNDY)
        s.monitor.reconcile({ newlyWatched: [BURGUNDY] })
      }
      return { ok: true }
    })

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(1)
    expect(s.texts()[0]).toContain('<b>Burgundy</b> · Other color')
    expect(s.alerted()).toEqual([])

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(2)
    expect(s.texts()[1]).toContain('Burgundy')
    expect(s.texts()[1]).not.toContain('Other color')
    expect(s.alerted()).toEqual([`${BURGUNDY}@R250`])
  })

  it('skips a group whose only store was toggled off during the gap before it, and sends nothing for it', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.watch(MAX_1TB)
    s.setStock({ [`${SILVER}@R250`]: 'Today', [`${MAX_1TB}@R415`]: 'Today' })
    s.onSleep(() => s.db.setStoreEnabled('R415', false))

    await s.monitor.runCheck()

    expect(s.sleeps).toEqual([1100])
    expect(s.attempts).toHaveLength(1)
    expect(s.alerted()).toEqual([`${SILVER}@R250`])
  })

  it('drops the alerted row of a pair that went out even when its role flipped while the out message was in flight', async () => {
    const s = await setup()
    s.watch(SILVER, true)
    s.watch(BURGUNDY)
    s.setStock({ [`${BURGUNDY}@R250`]: 'Today' })
    await s.monitor.runCheck()
    expect(s.alerted()).toEqual([`${BURGUNDY}@R250`])

    s.setStock({})
    s.onSend(() => {
      s.db.removeWatch(BURGUNDY)
      return { ok: true }
    })
    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(2)
    expect(s.alerted()).toEqual([])
  })

  it('writes no row when the store is toggled off while its message is being delivered', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.setStock({ [`${SILVER}@R250`]: 'Today' })
    s.onSend(() => {
      s.db.setStoreEnabled('R250', false)
      return { ok: true }
    })

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(1)
    expect(s.alerted()).toEqual([])
  })
})

describe('health', () => {
  const downs = (s: { texts: () => string[] }) => s.texts().filter((t) => /monitoring is down/i.test(t))
  const ups = (s: { texts: () => string[] }) => s.texts().filter((t) => /back up/i.test(t))

  async function failing() {
    const s = await setup()
    s.watch(SILVER)
    s.setFulfillmentStatus(541)
    return s
  }

  it.each([
    ['token-rejected', /rejected/i, (s: Awaited<ReturnType<typeof setup>>) => s.setFulfillmentStatus(541)],
    ['unexpected', /unexpected/i, (s: Awaited<ReturnType<typeof setup>>) => s.setFulfillmentStatus(503)],
    ['network', /network/i, (s: Awaited<ReturnType<typeof setup>>) => s.setNetworkDown(true)],
  ])('sends one plain-text "monitoring is down" message naming a %s cause on the third failure, not before', async (_cause, wording, fail) => {
    const s = await setup()
    s.watch(SILVER)
    fail(s)

    await s.monitor.runCheck()
    await s.monitor.runCheck()
    expect(s.attempts).toHaveLength(0)
    await s.monitor.runCheck()

    expect(downs(s)).toHaveLength(1)
    expect(downs(s)[0]).toMatch(wording)
    expect(s.attempts[0]?.buttons).toBeUndefined()
  })

  it('names an expired token in the down message', async () => {
    const s = await failing()
    s.advance(2 * HOUR)

    await s.monitor.runCheck()

    expect(downs(s)[0]).toMatch(/expired/i)
  })

  it('sends no further down message while the failures go on', async () => {
    const s = await failing()
    for (let i = 0; i < 6; i++) await s.monitor.runCheck()

    expect(downs(s)).toHaveLength(1)
  })

  it('does not count failures that a success interrupts', async () => {
    const s = await failing()
    await s.monitor.runCheck()
    await s.monitor.runCheck()
    s.setFulfillmentStatus(200)
    await s.monitor.runCheck()
    s.setFulfillmentStatus(541)
    await s.monitor.runCheck()
    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(0)
  })

  it('keeps counting failures across a restart over the same database', async () => {
    const s = await failing()
    await s.monitor.runCheck()
    await s.monitor.runCheck()

    const restarted = createMonitor({ apple: s.apple, telegram: { sendMessage: async (m) => (s.attempts.push({ ...m, at: s.now() }), { ok: true }) }, db: s.db, now: s.now })
    await restarted.runCheck()

    expect(downs(s)).toHaveLength(1)
  })

  it('retries the down message on the next failure when Telegram rejected it, and then sends exactly one', async () => {
    const s = await failing()
    s.onSend(() => ({ ok: false, error: { kind: 'network' } }))
    for (let i = 0; i < 3; i++) await s.monitor.runCheck()
    s.onSend(() => ({ ok: true }))

    await s.monitor.runCheck()
    await s.monitor.runCheck()

    expect(downs(s)).toHaveLength(2)
  })

  it('sends exactly one back up message on the first success after the down message', async () => {
    const s = await failing()
    for (let i = 0; i < 3; i++) await s.monitor.runCheck()
    s.setFulfillmentStatus(200)

    await s.monitor.runCheck()
    await s.monitor.runCheck()

    expect(ups(s)).toHaveLength(1)
    expect(s.attempts[0]?.buttons).toBeUndefined()
  })

  it('sends no back up message when no down message was announced', async () => {
    const s = await failing()
    await s.monitor.runCheck()
    s.setFulfillmentStatus(200)

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(0)
  })

  it('retries the back up message on the next success when Telegram rejected it', async () => {
    const s = await failing()
    for (let i = 0; i < 3; i++) await s.monitor.runCheck()
    s.setFulfillmentStatus(200)
    s.onSend(() => ({ ok: false, error: { kind: 'timeout' } }))
    await s.monitor.runCheck()
    s.onSend(() => ({ ok: true }))

    await s.monitor.runCheck()
    await s.monitor.runCheck()

    expect(ups(s)).toHaveLength(2)
  })

  it('sends exactly one back up message when the monitor restarts between down and up', async () => {
    const s = await failing()
    for (let i = 0; i < 3; i++) await s.monitor.runCheck()
    s.setFulfillmentStatus(200)

    const restarted = createMonitor({ apple: s.apple, telegram: { sendMessage: async (m) => (s.attempts.push({ ...m, at: s.now() }), { ok: true }) }, db: s.db, now: s.now })
    await restarted.runCheck()
    await restarted.runCheck()

    expect(ups(s)).toHaveLength(1)
  })

  it('goes down at once on a token that failed past its known expiry, with exactly one message', async () => {
    const s = await failing()
    s.advance(HOUR + 1000)

    await s.monitor.runCheck()
    await s.monitor.runCheck()
    await s.monitor.runCheck()

    expect(downs(s)).toHaveLength(1)
    expect(downs(s)[0]).toMatch(/expired/i)
    expect(s.attempts).toHaveLength(1)
  })

  it('does not go down at once on a rejected token that has not passed its expiry', async () => {
    const s = await failing()

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(0)
  })

  it('leaves health untouched by a skipped check', async () => {
    const s = await failing()
    await s.monitor.runCheck()
    await s.monitor.runCheck()
    s.db.setZip(null)
    expect(await s.monitor.runCheck()).toEqual({ skipped: true })
    s.db.setZip('10001')

    await s.monitor.runCheck()

    expect(downs(s)).toHaveLength(1)
  })

  it('keeps the failure count and cause on the snapshot, and clears them on success', async () => {
    const s = await failing()
    await s.monitor.runCheck()
    expect(s.monitor.snapshot().health).toEqual({ failures: 1, downAnnounced: false, cause: 'token-rejected' })
    for (let i = 0; i < 2; i++) await s.monitor.runCheck()
    expect(s.monitor.snapshot().health).toEqual({ failures: 3, downAnnounced: true, cause: 'token-rejected' })

    s.setFulfillmentStatus(200)
    await s.monitor.runCheck()

    expect(s.monitor.snapshot().health).toEqual({ failures: 0, downAnnounced: false, cause: null })
  })

  it('records a rejected health message as the last Telegram error and clears it when Telegram accepts one', async () => {
    const s = await failing()
    s.onSend(() => ({ ok: false, error: { kind: 'http', status: 400, description: 'Bad Request: chat not found' } }))
    for (let i = 0; i < 3; i++) await s.monitor.runCheck()
    expect(s.monitor.snapshot().telegramLastError).toEqual({ kind: 'http', status: 400, description: 'Bad Request: chat not found' })

    s.onSend(() => ({ ok: true }))
    await s.monitor.runCheck()

    expect(s.monitor.snapshot().telegramLastError).toBeNull()
  })
})

describe('token expiry warning', () => {
  const MIN = 60_000
  const warnings = (s: { texts: () => string[] }) => s.texts().filter((t) => /expires/i.test(t))

  async function expiringIn(minutes: number) {
    const s = await setup()
    s.watch(SILVER)
    s.db.setToken({ ...TOKEN, expiresAt: NOW + minutes * MIN })
    return s
  }

  it('warns once, naming the expiry time and how to refresh, when the token expires within 15 minutes', async () => {
    const s = await expiringIn(10)

    await s.monitor.runCheck()
    await s.monitor.runCheck()

    expect(warnings(s)).toHaveLength(1)
    expect(warnings(s)[0]).toMatch(/\d{2}:\d{2}/)
    expect(warnings(s)[0]).toMatch(/paste a fresh cURL or open apple\.com in Brave/i)
    expect(s.attempts[0]?.buttons).toBeUndefined()
  })

  it('does not warn while the token has more than 15 minutes left', async () => {
    const s = await expiringIn(16)

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(0)
  })

  it('warns even when the check is skipped', async () => {
    const s = await expiringIn(10)
    s.db.setZip(null)

    expect(await s.monitor.runCheck()).toEqual({ skipped: true })

    expect(warnings(s)).toHaveLength(1)
  })

  it('does not warn about a token that has already expired', async () => {
    const s = await expiringIn(-5)

    await s.monitor.runCheck()

    expect(warnings(s)).toHaveLength(0)
  })

  it('retries the warning on the next cycle when Telegram rejected it', async () => {
    const s = await expiringIn(10)
    s.onSend(() => ({ ok: false, error: { kind: 'network' } }))
    await s.monitor.runCheck()
    s.onSend(() => ({ ok: true }))

    await s.monitor.runCheck()
    await s.monitor.runCheck()

    expect(warnings(s)).toHaveLength(2)
  })

  it('keeps the warned flag across a restart', async () => {
    const s = await expiringIn(10)
    await s.monitor.runCheck()

    const restarted = createMonitor({ apple: s.apple, telegram: { sendMessage: async (m) => (s.attempts.push({ ...m, at: s.now() }), { ok: true }) }, db: s.db, now: s.now })
    await restarted.runCheck()

    expect(warnings(s)).toHaveLength(1)
  })

  it('still warns about a newer pair that arrived while the warning was being delivered', async () => {
    const s = await expiringIn(10)
    s.onSend(() => {
      s.db.setToken({ ...TOKEN, shldBtCk: 'id|2|payload|sig', expiresAt: NOW + 12 * MIN })
      return { ok: true }
    })
    await s.monitor.runCheck()
    s.onSend(() => ({ ok: true }))

    await s.monitor.runCheck()

    expect(warnings(s)).toHaveLength(2)
  })

  it('warns again about a newer pair once that one nears expiry', async () => {
    const s = await expiringIn(10)
    await s.monitor.runCheck()
    s.db.setToken({ ...TOKEN, shldBtCk: 'id|2|payload|sig', expiresAt: NOW + 2 * HOUR })
    await s.monitor.runCheck()
    expect(warnings(s)).toHaveLength(1)

    s.advance(2 * HOUR - 10 * MIN)
    await s.monitor.runCheck()

    expect(warnings(s)).toHaveLength(2)
  })
})

describe('token status', () => {
  it('is missing when no token is stored', async () => {
    const s = await setup()
    s.db.clearToken()

    expect(s.monitor.snapshot().token).toEqual({ status: 'missing', expiresAt: null })
  })

  it('is untested with its expiry until a check runs, then working after a successful check', async () => {
    const s = await setup()
    s.watch(SILVER)
    expect(s.monitor.snapshot().token).toEqual({ status: 'untested', expiresAt: TOKEN.expiresAt })

    await s.monitor.runCheck()

    expect(s.monitor.snapshot().token).toEqual({ status: 'working', expiresAt: TOKEN.expiresAt })
  })

  it('is rejected after Apple rejects a token that has not expired', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.setFulfillmentStatus(541)

    await s.monitor.runCheck()

    expect(s.monitor.snapshot().token.status).toBe('rejected')
  })

  it('is expired once the stored expiry has passed', async () => {
    const s = await setup()
    s.watch(SILVER)
    await s.monitor.runCheck()
    s.advance(HOUR + 1)

    expect(s.monitor.snapshot().token.status).toBe('expired')
  })

  it('goes back to untested when a new pair is stored, until the next check', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.setFulfillmentStatus(541)
    await s.monitor.runCheck()

    s.db.setToken({ ...TOKEN, shldBtCk: 'id|2|payload|sig', expiresAt: NOW + 2 * HOUR })
    expect(s.monitor.snapshot().token.status).toBe('untested')

    s.setFulfillmentStatus(200)
    await s.monitor.runCheck()
    expect(s.monitor.snapshot().token.status).toBe('working')
  })

  it('keeps working through a network failure, which says nothing about the token', async () => {
    const s = await setup()
    s.watch(SILVER)
    await s.monitor.runCheck()
    s.setNetworkDown(true)

    await s.monitor.runCheck()

    expect(s.monitor.snapshot().token.status).toBe('working')
  })

  it('holds no cookie value or user agent in the snapshot', async () => {
    const s = await setup()
    s.watch(SILVER)
    await s.monitor.runCheck()

    const text = JSON.stringify(s.monitor.snapshot())

    expect(text).not.toContain(TOKEN.dssid2)
    expect(text).not.toContain(TOKEN.shldBtCk)
    expect(text).not.toContain(TOKEN.userAgent)
  })
})

describe('catalog', () => {
  it('upserts by part and never deletes a part Apple stops listing', async () => {
    const s = await setup()
    const all = s.db.listParts()
    expect(all).toHaveLength(40)

    const partial: Apple = { ...s.apple, fetchCatalog: async () => ({ ok: true, value: all.slice(0, 5) }) }
    await createMonitor({ apple: partial, telegram: { sendMessage: async () => ({ ok: true }) }, db: s.db, now: s.now }).loadCatalog()

    expect(s.db.listParts()).toHaveLength(40)
  })

  it('retries the catalog on each check while the parts table is empty, and stops once it has parts', async () => {
    const s = await setup()
    const parts = s.db.listParts()
    const db = openDb(':memory:')
    let fetches = 0
    let failing = true
    const apple: Apple = {
      ...s.apple,
      fetchCatalog: async () => {
        fetches++
        return failing ? { ok: false, reason: 'network' } : { ok: true, value: parts }
      },
    }
    const monitor = createMonitor({ apple, telegram: { sendMessage: async () => ({ ok: true }) }, db, now: s.now })

    await monitor.runCheck()
    await monitor.runCheck()
    expect(fetches).toBe(2)
    expect(db.listParts()).toEqual([])

    failing = false
    await monitor.runCheck()
    await monitor.runCheck()
    expect(fetches).toBe(3)
    expect(db.listParts()).toHaveLength(40)
  })
})

describe('telegram', () => {
  const BOT_TOKEN = '123456:SECRET-bot-token'
  type Call = { url: string; init: RequestInit | undefined }
  const telegramWith = (handler: (call: Call) => Promise<Response>) => {
    const calls: Call[] = []
    const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), init }
      calls.push(call)
      return handler(call)
    }) as typeof fetch
    return { calls, telegram: createTelegram({ fetch: fetchFake, botToken: BOT_TOKEN, chatId: '42' }) }
  }
  const message: OutgoingMessage = { text: 'hello' }

  it('still returns ok when cancelling the success response body rejects', async () => {
    const { telegram } = telegramWith(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              throw new Error('cancel failed')
            },
          }),
        ),
    )

    expect(await telegram.sendMessage(message)).toEqual({ ok: true })
  })

  it('classifies an HTTP failure with the description from Telegram JSON', async () => {
    const { telegram } = telegramWith(
      async () => new Response('{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}', { status: 400 }),
    )

    expect(await telegram.sendMessage(message)).toEqual({
      ok: false,
      error: { kind: 'http', status: 400, description: 'Bad Request: chat not found' },
    })
  })

  it('exposes retry_after on a 429', async () => {
    const { telegram } = telegramWith(
      async () =>
        new Response('{"ok":false,"description":"Too Many Requests: retry after 7","parameters":{"retry_after":7}}', {
          status: 429,
        }),
    )

    expect(await telegram.sendMessage(message)).toEqual({
      ok: false,
      error: { kind: 'http', status: 429, description: 'Too Many Requests: retry after 7' },
      retryAfterSec: 7,
    })
  })

  it('classifies a non-JSON HTTP failure without a description', async () => {
    const { telegram } = telegramWith(async () => new Response('<html>Bad gateway</html>', { status: 502 }))

    expect(await telegram.sendMessage(message)).toEqual({ ok: false, error: { kind: 'http', status: 502 } })
  })

  it('classifies a timeout', async () => {
    const { telegram } = telegramWith(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })

    expect(await telegram.sendMessage(message)).toEqual({ ok: false, error: { kind: 'timeout' } })
  })

  it('keeps the bot token out of a network error, the returned value and the monitor snapshot', async () => {
    const { telegram } = telegramWith(async ({ url }) => {
      throw new Error(`request to ${url} failed, reason: getaddrinfo ENOTFOUND api.telegram.org`)
    })
    const s = await setup()
    s.watch(SILVER)
    s.setStock({ [`${SILVER}@R250`]: 'Today' })
    const monitor = createMonitor({ apple: s.apple, telegram, db: s.db, now: s.now })

    const result = await telegram.sendMessage(message)
    await monitor.runCheck()

    expect(result).toEqual({ ok: false, error: { kind: 'network' } })
    expect(monitor.snapshot().telegramLastError).toEqual({ kind: 'network' })
    expect(JSON.stringify([result, monitor.snapshot()])).not.toContain('SECRET')
    expect(s.alerted()).toEqual([])
  })
})

describe('scheduler', () => {
  const SEC = 1000

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function schedulerSetup(options: { random?: () => number; appleMs?: number; telegramMs?: number } = {}) {
    const startTimes: number[] = []
    const fulfillmentUrls: string[] = []
    let running = 0
    let maxRunning = 0
    const fetchFake = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('product-locator-meta')) {
        return new Response(fixture(url.includes('family=iphoneduo') ? 'locator-duo.json' : 'locator-18pro.json'))
      }
      if (url.includes('pickup-message-recommendations')) return new Response(fixture('stores-10001.json'))
      startTimes.push(Date.now())
      fulfillmentUrls.push(url)
      running += 1
      maxRunning = Math.max(maxRunning, running)
      if (options.appleMs) await new Promise((resolve) => setTimeout(resolve, options.appleMs))
      running -= 1
      return new Response(fulfillmentBody(stock))
    }) as typeof fetch
    let stock: Record<string, Stock> = {}
    const apple = createApple({ fetch: fetchFake, now: Date.now })

    const sent: string[] = []
    const telegram: Telegram = {
      async sendMessage(message) {
        if (options.telegramMs) await new Promise((resolve) => setTimeout(resolve, options.telegramMs))
        sent.push(message.text)
        return { ok: true }
      },
    }

    const db = openDb(':memory:')
    const monitor = createMonitor({ apple, telegram, db, now: Date.now, random: options.random ?? (() => 0.5) })
    await monitor.loadCatalog()
    const stores = await apple.fetchStores('10001', SILVER)
    if (stores.ok) db.replaceStores(stores.value)
    db.setZip('10001')
    db.setToken({ ...TOKEN, expiresAt: NOW + 1000 * HOUR })
    db.addWatch(SILVER, true, NOW)

    return {
      db,
      monitor,
      sent,
      startTimes,
      fulfillmentUrls,
      maxRunning: () => maxRunning,
      setStock: (next: Record<string, Stock>) => {
        stock = next
      },
      advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    }
  }

  it('a check sends one fulfillment request covering the watched part and its other color', async () => {
    const s = await schedulerSetup()

    s.monitor.start()
    await s.advance(0)

    expect(s.fulfillmentUrls).toHaveLength(1)
    const url = new URL(s.fulfillmentUrls[0] ?? '')
    expect(url.searchParams.get('parts.0')).toBe(SILVER)
    expect(url.searchParams.get('parts.1')).toBe(BURGUNDY)
    s.monitor.stop()
  })

  it('starts 45 to 75 seconds apart over 100 checks at the default interval', async () => {
    let n = 0
    const s = await schedulerSetup({ random: () => [0, 1, 0.5, 0.13, 0.87][n++ % 5] ?? 0 })

    s.monitor.start()
    await s.advance(110 * 75 * SEC)
    s.monitor.stop()

    const starts = s.startTimes.slice(0, 101)
    expect(starts.length).toBe(101)
    const gaps = starts.slice(1).map((t, i) => t - (starts[i] ?? 0))
    expect(Math.min(...gaps)).toBe(45 * SEC)
    expect(Math.max(...gaps)).toBe(75 * SEC)
  })

  it('measures the gap from start to start when Apple is slow', async () => {
    const s = await schedulerSetup({ random: () => 0, appleMs: 20 * SEC })

    s.monitor.start()
    await s.advance(100 * SEC)
    s.monitor.stop()

    expect(s.startTimes.map((t) => (t - NOW) / SEC)).toEqual([0, 45, 90])
  })

  it('waits for a cycle that overruns the next start and never runs two checks at once', async () => {
    const s = await schedulerSetup({ random: () => 0, appleMs: 40 * SEC })
    s.db.setIntervalSec(30)

    s.monitor.start()
    await s.advance(200 * SEC)
    s.monitor.stop()

    expect(s.startTimes.length).toBeGreaterThan(3)
    expect(s.maxRunning()).toBe(1)
    const gaps = s.startTimes.slice(1).map((t, i) => t - (s.startTimes[i] ?? 0))
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(40 * SEC)
  })

  it('never runs a second timer chain when start is called twice', async () => {
    const s = await schedulerSetup()

    s.monitor.start()
    s.monitor.start()
    await s.advance(300 * SEC)
    s.monitor.stop()

    expect(s.startTimes.map((t) => (t - NOW) / SEC)).toEqual([0, 60, 120, 180, 240, 300])
  })

  it('does not start a second check when stop then start land during a check', async () => {
    const s = await schedulerSetup({ appleMs: 20 * SEC })

    s.monitor.start()
    await s.advance(5 * SEC)
    s.monitor.stop()
    s.monitor.start()
    await s.advance(100 * SEC)
    s.monitor.stop()

    expect(s.maxRunning()).toBe(1)
    expect(s.startTimes.map((t) => (t - NOW) / SEC)).toEqual([0, 60])
  })

  it('stops checking after stop', async () => {
    const s = await schedulerSetup()

    s.monitor.start()
    await s.advance(0)
    s.monitor.stop()
    await s.advance(600 * SEC)

    expect(s.startTimes).toHaveLength(1)
  })

  it('does not start another check after stop is called during a check', async () => {
    const s = await schedulerSetup({ appleMs: 20 * SEC })

    s.monitor.start()
    await s.advance(5 * SEC)
    s.monitor.stop()
    await s.advance(600 * SEC)

    expect(s.startTimes).toHaveLength(1)
  })

  it('reports no next check on the snapshot once the scheduler is stopped', async () => {
    const s = await schedulerSetup()

    s.monitor.start()
    await s.advance(0)
    s.monitor.stop()

    expect(s.monitor.snapshot().nextStartAt).toBeNull()
  })

  it('applies an interval change made between checks from that moment, without a restart', async () => {
    const s = await schedulerSetup()

    s.monitor.start()
    await s.advance(10 * SEC)
    s.monitor.setInterval(30)
    await s.advance(100 * SEC)
    s.monitor.stop()

    expect(s.startTimes.slice(0, 3).map((t) => (t - NOW) / SEC)).toEqual([0, 40, 70])
  })

  it('applies an interval change made during a check to the next start and still sends one request per period', async () => {
    const s = await schedulerSetup({ appleMs: 20 * SEC })

    s.monitor.start()
    await s.advance(5 * SEC)
    s.monitor.setInterval(300)
    await s.advance(500 * SEC)
    s.monitor.stop()

    expect(s.startTimes.map((t) => (t - NOW) / SEC)).toEqual([0, 300])
  })

  it('stores the interval, defaulting to 60 s, and rejects values outside 30 to 3600 s', async () => {
    const s = await schedulerSetup()

    expect(s.db.getSettings().intervalSec).toBe(60)
    s.monitor.setInterval(30)
    s.monitor.setInterval(3600)
    expect(() => s.monitor.setInterval(29)).toThrow(RangeError)
    expect(() => s.monitor.setInterval(3601)).toThrow(RangeError)
    expect(() => s.monitor.setInterval(45.5)).toThrow(RangeError)
    expect(s.db.getSettings().intervalSec).toBe(3600)
  })

  it('sends one "monitor started" message when started, and none for a second start call', async () => {
    const s = await schedulerSetup()

    s.monitor.start()
    s.monitor.start()
    await s.advance(0)
    s.monitor.stop()

    expect(s.sent.filter((t) => /monitor started/i.test(t))).toHaveLength(1)
  })

  it('reports when the next check is due on the snapshot', async () => {
    const s = await schedulerSetup({ random: () => 0.5 })

    expect(s.monitor.snapshot().nextStartAt).toBeNull()
    s.monitor.start()
    await s.advance(0)

    expect(s.monitor.snapshot().nextStartAt).toBe(NOW + 60 * SEC)
    s.monitor.stop()
  })

  it('gives the send pass the next start as its deadline, so a slow Telegram cannot push it past one cycle', async () => {
    const s = await schedulerSetup({ random: () => 0, telegramMs: 10 * SEC })
    s.db.setIntervalSec(30)
    s.setStock({ [`${SILVER}@R250`]: 'Today', [`${SILVER}@R415`]: 'Today', [`${SILVER}@R032`]: 'Today', [`${SILVER}@R095`]: 'Today' })

    s.monitor.start()
    await s.advance(30 * SEC)
    s.monitor.stop()

    expect(s.startTimes.map((t) => (t - NOW) / SEC)).toEqual([0, 22.5])
  })
})
