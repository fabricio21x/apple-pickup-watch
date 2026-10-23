import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createApple, type Apple, type AppleToken } from '../src/server/apple'
import { openDb } from '../src/server/db'
import { createMonitor } from '../src/server/monitor'
import { createTelegram, type OutgoingMessage, type SendResult, type Telegram } from '../src/server/telegram'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const NOW = Date.parse('2026-10-23T12:00:00Z')
const HOUR = 3_600_000
const SILVER = 'MJQ84LL/A'
const BURGUNDY = 'MJQ94LL/A'
const SILVER_URL = 'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-512gb-silver'
const BURGUNDY_URL = 'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-512gb-burgundy'
const TOKEN: AppleToken = { dssid2: 'fake-dssid2', shldBtCk: 'id|1|payload|sig', userAgent: 'Mozilla/5.0 test', expiresAt: NOW + HOUR }

type Stock = 'Today' | 'Tomorrow' | 'unavailable' | 'default'

function fulfillmentBody(stock: Record<string, Stock>): string {
  const body = JSON.parse(fixture('fulfillment-all-out.json'))
  for (const store of body.body.content.pickupMessage.stores) {
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

async function setup(options: { appleSeconds?: number } = {}) {
  let t = NOW
  const now = () => t
  const sleeps: number[] = []
  const sleep = async (ms: number) => {
    sleeps.push(ms)
    t += ms
  }

  let stock: Record<string, Stock> = {}
  let fulfillmentStatus = 200
  const fulfillmentUrls: string[] = []
  const fetchFake = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('product-locator-meta')) {
      return new Response(fixture(url.includes('family=iphoneduo') ? 'locator-duo.json' : 'locator-18pro.json'))
    }
    if (url.includes('pickup-message-recommendations')) return new Response(fixture('stores-10001.json'))
    fulfillmentUrls.push(url)
    t += (options.appleSeconds ?? 0) * 1000
    if (fulfillmentStatus !== 200) return new Response(fixture('rejected-541.html'), { status: fulfillmentStatus })
    return new Response(fulfillmentBody(stock))
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
    onSend: (fn: typeof reply) => {
      reply = fn
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
    expect(message?.text).toContain('iPhone 18 Pro 512GB Silver')
    expect(message?.text).toContain('West 14th Street')
    expect(message?.text).toContain('0.7 mi')
    expect(message?.text).toContain('Today')
    expect(message?.button?.url).toBe(SILVER_URL)
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
    expect(s.texts()[0]).toMatch(/in stock/i)
    expect(s.texts()[1]).toMatch(/out of stock/i)
    expect(s.texts()[1]).toContain('iPhone 18 Pro 512GB Silver')
    expect(s.texts()[1]).toContain('West 14th Street')
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
    expect(s.texts()[1]).toMatch(/out of stock/i)
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
  it('sends an "Other color" message naming the watched color, with the same fields and the sibling buy-page button', async () => {
    const s = await setup()
    s.watch(SILVER, true)
    s.setStock({ [`${BURGUNDY}@R250`]: 'Today' })

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(1)
    const message = s.attempts[0]
    expect(message?.text).toContain('Other color')
    expect(message?.text).toContain('(you watch Silver)')
    expect(message?.text).toContain('iPhone 18 Pro 512GB Burgundy')
    expect(message?.text).toContain('West 14th Street')
    expect(message?.text).toContain('0.7 mi')
    expect(message?.text).toContain('Today')
    expect(message?.button?.url).toBe(BURGUNDY_URL)
  })

  it('sends one "Other color" out-of-stock message when the sibling goes back out', async () => {
    const s = await setup()
    s.watch(SILVER, true)
    s.setStock({ [`${BURGUNDY}@R250`]: 'Today' })
    await s.monitor.runCheck()

    s.setStock({})
    await s.monitor.runCheck()

    expect(s.texts()).toHaveLength(2)
    expect(s.texts()[1]).toContain('Other color')
    expect(s.texts()[1]).toMatch(/out of stock/i)
    expect(s.texts()[1]).toContain('(you watch Silver)')
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
    expect(s.texts()[1]).toContain('iPhone 18 Pro 512GB Burgundy')
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
    expect(s.attempts).toHaveLength(3)
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
  const inStockAt = (part: string, stores: string[]) =>
    Object.fromEntries(stores.map((store) => [`${part}@${store}`, 'Today' as const]))
  const STORES = ['R250', 'R415', 'R032', 'R095', 'R251', 'R582', 'R654', 'R594']

  it('sends one message at a time at least 1.1 s apart', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.setStock(inStockAt(SILVER, ['R250', 'R415', 'R032']))

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(3)
    const [a, b, c] = s.attempts.map((m) => m.at)
    expect((b ?? 0) - (a ?? 0)).toBeGreaterThanOrEqual(1100)
    expect((c ?? 0) - (b ?? 0)).toBeGreaterThanOrEqual(1100)
  })

  it('sends watched in-stock, then other-color in-stock, then watched out-of-stock, then other-color out-of-stock', async () => {
    const s = await setup()
    s.watch(SILVER, true)
    s.setStock({ [`${SILVER}@R250`]: 'Today', [`${BURGUNDY}@R415`]: 'Today' })
    await s.monitor.runCheck()
    s.attempts.length = 0

    s.setStock({ [`${SILVER}@R032`]: 'Today', [`${BURGUNDY}@R032`]: 'Today' })
    await s.monitor.runCheck()

    expect(s.texts()).toHaveLength(4)
    expect(s.texts()[0]).toMatch(/^In stock/)
    expect(s.texts()[1]).toMatch(/^Other color in stock/)
    expect(s.texts()[2]).toMatch(/^Out of stock/)
    expect(s.texts()[3]).toMatch(/^Other color out of stock/)
  })

  it('stops at the first send failure, commits nothing, and sends the events again next check', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.setStock(inStockAt(SILVER, ['R250', 'R415']))
    s.onSend(() => ({ ok: false, error: { kind: 'http', status: 400, description: 'Bad Request: chat not found' } }))

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(1)
    expect(s.alerted()).toEqual([])
    expect(s.monitor.snapshot().telegramLastError).toEqual({
      kind: 'http',
      status: 400,
      description: 'Bad Request: chat not found',
    })

    s.onSend(() => ({ ok: true }))
    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(3)
    expect(s.alerted()).toEqual([`${SILVER}@R250`, `${SILVER}@R415`])
    expect(s.monitor.snapshot().telegramLastError).toBeNull()
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
    s.watch(SILVER)
    s.setStock(inStockAt(SILVER, STORES))

    await s.monitor.runCheck({ deadline: NOW + 10_000 })

    expect(s.attempts).toHaveLength(5)
    expect(s.attempts.every((m) => m.at <= NOW + 5000)).toBe(true)
  })

  it('still sends the first watched in-stock event when a slow Apple call used up the time before the deadline', async () => {
    const s = await setup({ appleSeconds: 28 })
    s.watch(SILVER, true)
    s.setStock({ [`${SILVER}@R250`]: 'Today', [`${BURGUNDY}@R250`]: 'Today' })

    await s.monitor.runCheck({ deadline: NOW + 30_000 })

    expect(s.attempts).toHaveLength(1)
    expect(s.texts()[0]).not.toContain('Other color')
    expect(s.alerted()).toEqual([`${SILVER}@R250`])
  })

  it('skips an event whose store was toggled off during the pass: no message, no row', async () => {
    const s = await setup()
    s.watch(SILVER)
    s.setStock(inStockAt(SILVER, ['R250', 'R415']))
    s.onSend(() => {
      s.db.setStoreEnabled('R415', false)
      return { ok: true }
    })

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(1)
    expect(s.alerted()).toEqual([`${SILVER}@R250`])
  })

  it('drops a stale other-color event when its color becomes watched during the pass, and the next check sends the watched alert', async () => {
    const s = await setup()
    s.watch(SILVER, true)
    s.setStock({ [`${SILVER}@R250`]: 'Today', [`${BURGUNDY}@R250`]: 'Today' })
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
    expect(s.texts()[0]).not.toContain('Other color')
    expect(s.alerted()).toEqual([`${SILVER}@R250`])

    await s.monitor.runCheck()

    expect(s.attempts).toHaveLength(2)
    expect(s.texts()[1]).toMatch(/^In stock/)
    expect(s.texts()[1]).toContain('iPhone 18 Pro 512GB Burgundy')
    expect(s.alerted()).toEqual([`${SILVER}@R250`, `${BURGUNDY}@R250`])
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
  const message: OutgoingMessage = { text: 'hello', button: { text: 'Open', url: SILVER_URL } }

  it('posts plain text with an inline URL button and no parse_mode', async () => {
    const { calls, telegram } = telegramWith(async () => new Response('{"ok":true}'))

    const result = await telegram.sendMessage(message)

    expect(result).toEqual({ ok: true })
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`)
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      chat_id: '42',
      text: 'hello',
      reply_markup: { inline_keyboard: [[{ text: 'Open', url: SILVER_URL }]] },
    })
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
