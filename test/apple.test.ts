import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createApple,
  parseCurl,
  parseTokenBody,
  type AppleToken,
} from '../src/server/apple'

const fixtureDir = new URL('./fixtures/', import.meta.url)
const fixture = (name: string) => readFileSync(new URL(name, fixtureDir), 'utf8')

const NOW = Date.parse('2026-10-23T12:00:00Z')
const HOUR = 3_600_000
const shld = (expiresAtMs: number) => `fakeid1|${expiresAtMs / 1000}|fakepayload==|fakesig`
const DSSID = 'fake-dssid2-value'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'

type Call = { url: string; init: RequestInit | undefined }
type Handler = (url: string, init: RequestInit | undefined) => Promise<Response>

function fakeFetch(handler: Handler) {
  const calls: Call[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  return { fn, calls }
}

const reply = (status: number, body: string) => async () => new Response(body, { status })
const apple = (handler: Handler, extra: { timeoutMs?: number } = {}) => {
  const f = fakeFetch(handler)
  return { ...f, apple: createApple({ fetch: f.fn, now: () => NOW, ...extra }) }
}

describe('catalog', () => {
  const locators = (url: string) => {
    if (url.includes('family=iphone18pro')) return Promise.resolve(new Response(fixture('locator-18pro.json')))
    if (url.includes('family=iphoneduo')) return Promise.resolve(new Response(fixture('locator-duo.json')))
    return Promise.resolve(new Response('', { status: 404 }))
  }

  it('lists 32 iPhone 18 Pro and Pro Max parts plus 8 Duo parts from the two locator families', async () => {
    const { apple: a, calls } = apple(locators)
    const result = await a.fetchCatalog()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(40)
    expect(result.value.filter((p) => p.modelName === 'iPhone Duo')).toHaveLength(8)
    expect(result.value.filter((p) => p.modelName.startsWith('iPhone 18 Pro'))).toHaveLength(32)
    expect(calls.map((c) => c.url).sort()).toEqual([
      'https://www.apple.com/shop/product-locator-meta?family=iphone18pro',
      'https://www.apple.com/shop/product-locator-meta?family=iphoneduo',
    ])
  })

  it('splits the title into model, capacity and color and links to the unlocked buy page', async () => {
    const { apple: a } = apple(locators)
    const result = await a.fetchCatalog()
    if (!result.ok) throw new Error('catalog failed')
    const byPart = new Map(result.value.map((p) => [p.part, p]))
    expect(byPart.get('MJQ84LL/A')).toEqual({
      part: 'MJQ84LL/A',
      modelName: 'iPhone 18 Pro',
      capacity: '512gb',
      colorName: 'Silver',
      title: 'iPhone 18 Pro 512GB Silver',
      buyUrl: 'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-512gb-silver-unlocked',
    })
    expect(byPart.get('MK1F4LL/A')).toMatchObject({
      modelName: 'iPhone Duo',
      capacity: '256gb',
      colorName: 'Night Sky',
    })
    expect([...byPart.values()].find((p) => p.modelName === 'iPhone 18 Pro Max')).toBeDefined()
  })

  it('treats non-breaking spaces in a title like plain spaces', async () => {
    const body = JSON.parse(fixture('locator-duo.json'))
    const products = body.body.productLocatorOverlayData.productLocatorMeta.products
    for (const p of products) p.productTitle = p.productTitle.replaceAll(' ', ' ')
    const { apple: a } = apple(async (url) =>
      url.includes('iphoneduo') ? new Response(JSON.stringify(body)) : new Response(fixture('locator-18pro.json')),
    )
    const result = await a.fetchCatalog()
    if (!result.ok) throw new Error('catalog failed')
    expect(result.value.find((p) => p.part === 'MK1F4LL/A')).toMatchObject({
      title: 'iPhone Duo 256GB Night Sky',
      modelName: 'iPhone Duo',
      colorName: 'Night Sky',
    })
  })

  it('drops entries whose productLink is not an https www.apple.com buy-iphone link', async () => {
    const bad = [
      'https://evil.example/shop/buy-iphone/iphone-18-pro/x',
      'javascript:alert(1)',
      'http://www.apple.com/shop/buy-iphone/iphone-18-pro/x',
      'https://www.apple.com/shop/other',
      'https://www.apple.com.evil.example/shop/buy-iphone/x',
      'https://www.apple.com@evil.example/shop/buy-iphone/x',
      'https://www.apple.com/shop/buy-iphone/../../evil',
    ]
    const body = JSON.parse(fixture('locator-18pro.json'))
    const products: { carrierModel: string; partNumber: string; productLink: string }[] =
      body.body.productLocatorOverlayData.productLocatorMeta.products
    const unlocked = products.filter((p) => p.carrierModel === 'UNLOCKED/US')
    const droppedParts = bad.map((link, i) => {
      const entry = unlocked[i]!
      entry.productLink = link
      return entry.partNumber
    })
    const { apple: a } = apple(async (url) =>
      url.includes('iphone18pro') ? new Response(JSON.stringify(body)) : new Response(fixture('locator-duo.json')),
    )
    const result = await a.fetchCatalog()
    if (!result.ok) throw new Error('catalog failed')
    expect(result.value).toHaveLength(40 - bad.length)
    for (const part of droppedParts) expect(result.value.find((p) => p.part === part)).toBeUndefined()
    expect(result.value.every((p) => p.buyUrl.startsWith('https://www.apple.com/shop/buy-iphone/'))).toBe(true)
  })

  it('ends every buy link in -unlocked with no query, so Apple preselects Unlocked and No trade-in', async () => {
    const { apple: a } = apple(locators)
    const result = await a.fetchCatalog()
    if (!result.ok) throw new Error('catalog failed')
    expect(result.value).toHaveLength(40)
    for (const { buyUrl } of result.value) {
      const url = new URL(buyUrl)
      expect(url.origin).toBe('https://www.apple.com')
      expect(url.pathname).toMatch(/^\/shop\/buy-iphone\/.+-unlocked$/)
      expect(url.search).toBe('')
      expect(url.hash).toBe('')
    }
  })

  it('does not double -unlocked when Apple already includes it', async () => {
    const body = JSON.parse(fixture('locator-18pro.json'))
    const products: { carrierModel: string; partNumber: string; productLink: string }[] =
      body.body.productLocatorOverlayData.productLocatorMeta.products
    const entry = products.find((p) => p.carrierModel === 'UNLOCKED/US')!
    const plain = entry.productLink
    entry.productLink = `${plain}-unlocked`
    const { apple: a } = apple(async (url) =>
      url.includes('iphone18pro') ? new Response(JSON.stringify(body)) : new Response(fixture('locator-duo.json')),
    )
    const result = await a.fetchCatalog()
    if (!result.ok) throw new Error('catalog failed')
    expect(result.value.find((p) => p.part === entry.partNumber)?.buyUrl).toBe(`${plain}-unlocked`)
  })

  it('drops entries whose productLink carries a query or fragment', async () => {
    const body = JSON.parse(fixture('locator-18pro.json'))
    const products: { carrierModel: string; partNumber: string; productLink: string }[] =
      body.body.productLocatorOverlayData.productLocatorMeta.products
    const unlocked = products.filter((p) => p.carrierModel === 'UNLOCKED/US')
    const withQuery = unlocked[0]!
    const withFragment = unlocked[1]!
    withQuery.productLink += '?igt=true'
    withFragment.productLink += '#config'
    const { apple: a } = apple(async (url) =>
      url.includes('iphone18pro') ? new Response(JSON.stringify(body)) : new Response(fixture('locator-duo.json')),
    )
    const result = await a.fetchCatalog()
    if (!result.ok) throw new Error('catalog failed')
    expect(result.value).toHaveLength(38)
    expect(result.value.find((p) => p.part === withQuery.partNumber)).toBeUndefined()
    expect(result.value.find((p) => p.part === withFragment.partNumber)).toBeUndefined()
  })

  it('fails as network when a locator request throws', async () => {
    const { apple: a } = apple(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await a.fetchCatalog()).toEqual({ ok: false, reason: 'network' })
  })

  it('fails as unexpected when one locator family answers 503, so no partial catalog is stored', async () => {
    const { apple: a } = apple(async (url) =>
      url.includes('iphoneduo') ? new Response(fixture('maintenance-503.html'), { status: 503 }) : new Response(fixture('locator-18pro.json')),
    )
    expect(await a.fetchCatalog()).toEqual({ ok: false, reason: 'unexpected' })
  })

  it('fails as unexpected when the locator body is not the expected shape', async () => {
    const { apple: a } = apple(reply(200, '{"body":{}}'))
    expect(await a.fetchCatalog()).toEqual({ ok: false, reason: 'unexpected' })
  })
})

describe('stores for a zip', () => {
  it('lists the 12 stores Apple returns with name, city, state and distance', async () => {
    const { apple: a, calls } = apple(reply(200, fixture('stores-10001.json')))
    const result = await a.fetchStores('10001', 'MJQ84LL/A')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(12)
    expect(result.value[0]).toEqual({
      store: 'R250',
      name: 'West 14th Street',
      city: 'New York',
      state: 'NY',
      distanceMi: 0.66,
    })
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/shop/pickup-message-recommendations')
    expect(url.searchParams.get('location')).toBe('10001')
    expect(url.searchParams.get('product')).toBe('MJQ84LL/A')
  })

  it.each(['1000', '100011', '1000a', '10001 ', '', '10001&x=1'])('rejects the zip %j without calling Apple', async (zip) => {
    const { apple: a, calls } = apple(reply(200, fixture('stores-10001.json')))
    expect(await a.fetchStores(zip, 'MJQ84LL/A')).toEqual({ ok: false, reason: 'invalid-zip' })
    expect(calls).toHaveLength(0)
  })

  it('fails as network when the request throws', async () => {
    const { apple: a } = apple(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await a.fetchStores('10001', 'MJQ84LL/A')).toEqual({ ok: false, reason: 'network' })
  })

  it('fails as unexpected on a non-200 status or a body without stores', async () => {
    expect(await apple(reply(503, fixture('maintenance-503.html'))).apple.fetchStores('10001', 'MJQ84LL/A')).toEqual({
      ok: false,
      reason: 'unexpected',
    })
    expect(await apple(reply(200, '{"body":{"PickupMessage":{}}}')).apple.fetchStores('10001', 'MJQ84LL/A')).toEqual({
      ok: false,
      reason: 'unexpected',
    })
  })
})

describe('fulfillment check', () => {
  const token: AppleToken = { dssid2: DSSID, shldBtCk: shld(NOW + HOUR), userAgent: UA, expiresAt: NOW + HOUR }
  const allStores = ['R250', 'R415', 'R032', 'R095', 'R251', 'R582', 'R654', 'R594', 'R715', 'R755', 'R612', 'R753']
  const request = {
    zip: '10001',
    token,
    watchedParts: ['MJQ84LL/A', 'MK1F4LL/A'],
    otherParts: ['MJQ94LL/A'],
    enabledStores: allStores,
  }

  const okOutcome = async (name: string, overrides: Partial<typeof request> = {}) => {
    const { apple: a } = apple(reply(200, fixture(name)))
    const outcome = await a.check({ ...request, ...overrides })
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.cause}`)
    return outcome
  }

  it('sends one request with every part, the zip, the cookie pair and the User-Agent', async () => {
    const { apple: a, calls } = apple(reply(200, fixture('fulfillment-all-out.json')))
    await a.check(request)
    expect(calls).toHaveLength(1)
    const url = new URL(calls[0]!.url)
    expect(url.origin + url.pathname).toBe('https://www.apple.com/shop/fulfillment-messages')
    expect(url.searchParams.get('parts.0')).toBe('MJQ84LL/A')
    expect(url.searchParams.get('parts.1')).toBe('MK1F4LL/A')
    expect(url.searchParams.get('parts.2')).toBe('MJQ94LL/A')
    expect(url.searchParams.get('parts.3')).toBeNull()
    expect(url.searchParams.get('location')).toBe('10001')
    expect(url.searchParams.get('cppart')).toBe('UNLOCKED/US')
    const headers = new Headers(calls[0]!.init?.headers)
    expect(headers.get('cookie')).toBe(`dssid2=${DSSID}; shld_bt_ck=${token.shldBtCk}`)
    expect(headers.get('user-agent')).toBe(UA)
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps cookie values out of the request URL', async () => {
    const { apple: a, calls } = apple(reply(200, fixture('fulfillment-all-out.json')))
    await a.check(request)
    expect(calls[0]!.url).not.toContain(DSSID)
    expect(calls[0]!.url).not.toContain('fakepayload')
  })

  it('reports every pair out of stock when Apple says unavailable, with store name and distance', async () => {
    const outcome = await okOutcome('fulfillment-all-out.json')
    expect(outcome.observations).toHaveLength(36)
    expect(outcome.observations.every((o) => o.pickup.kind === 'out')).toBe(true)
    expect(outcome.stores).toHaveLength(12)
    expect(outcome.stores[0]).toEqual({ store: 'R250', name: 'West 14th Street', distanceMi: 0.66 })
  })

  it('reads Available Today as in stock labelled Today at that store only', async () => {
    const outcome = await okOutcome('fulfillment-today.json')
    const inStock = outcome.observations.filter((o) => o.pickup.kind === 'in')
    expect(inStock).toEqual([{ part: 'MJQ84LL/A', store: 'R250', pickup: { kind: 'in', label: 'Today' } }])
  })

  it('reads Available Tomorrow as in stock labelled Tomorrow', async () => {
    const outcome = await okOutcome('fulfillment-tomorrow.json')
    const inStock = outcome.observations.filter((o) => o.pickup.kind === 'in')
    expect(inStock).toEqual([{ part: 'MJQ84LL/A', store: 'R250', pickup: { kind: 'in', label: 'Tomorrow' } }])
  })

  it('observes an other-color part like any other part', async () => {
    const outcome = await okOutcome('fulfillment-other-color-today.json')
    expect(outcome.observations.filter((o) => o.pickup.kind === 'in')).toEqual([
      { part: 'MJQ94LL/A', store: 'R250', pickup: { kind: 'in', label: 'Today' } },
    ])
  })

  it('treats a Duo "check back" default as not in stock', async () => {
    const outcome = await okOutcome('fulfillment-duo-check-back.json')
    expect(outcome.observations.filter((o) => o.part === 'MK1F4LL/A').every((o) => o.pickup.kind === 'out')).toBe(true)
  })

  it('gives no observation for an enabled store missing from a 200, so its state is kept', async () => {
    const outcome = await okOutcome('fulfillment-missing-store.json')
    expect(outcome.observations.some((o) => o.store === 'R753')).toBe(false)
    expect(outcome.stores.map((s) => s.store)).not.toContain('R753')
    expect(outcome.observations).toHaveLength(33)
  })

  it('observes only enabled stores', async () => {
    const outcome = await okOutcome('fulfillment-today.json', { enabledStores: ['R250', 'R415'] })
    expect(new Set(outcome.observations.map((o) => o.store))).toEqual(new Set(['R250', 'R415']))
    expect(outcome.stores.map((s) => s.store)).toEqual(['R250', 'R415'])
  })

  it('does not fail when an other-color part is missing from every store', async () => {
    const outcome = await okOutcome('fulfillment-missing-part.json', {
      watchedParts: ['MJQ84LL/A'],
      otherParts: ['MJQ94LL/A', 'MK1F4LL/A'],
    })
    expect(outcome.observations.some((o) => o.part === 'MK1F4LL/A')).toBe(false)
    expect(outcome.observations.some((o) => o.part === 'MJQ84LL/A')).toBe(true)
  })

  it('fails as unexpected when a watched part is missing from every store', async () => {
    const { apple: a } = apple(reply(200, fixture('fulfillment-missing-part.json')))
    expect(await a.check(request)).toEqual({ ok: false, cause: 'unexpected' })
  })

  it('fails as unexpected when none of the enabled stores is in the response', async () => {
    const { apple: a } = apple(reply(200, fixture('fulfillment-all-out.json')))
    expect(await a.check({ ...request, enabledStores: ['R999'] })).toEqual({ ok: false, cause: 'unexpected' })
  })

  it('fails as network when the request throws, without the thrown message in the outcome', async () => {
    const { apple: a } = apple(async () => {
      throw new TypeError(`fetch failed dssid2=${DSSID}`)
    })
    const outcome = await a.check(request)
    expect(outcome).toEqual({ ok: false, cause: 'network' })
  })

  it('fails as network when Apple does not answer within the timeout', async () => {
    const { apple: a } = apple(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
      { timeoutMs: 20 },
    )
    expect(await a.check(request)).toEqual({ ok: false, cause: 'network' })
  })

  it.each([541, 401, 403])('classifies HTTP %i with an expired stored token as token-expired', async (status) => {
    const { apple: a } = apple(reply(status, fixture('rejected-541.html')))
    const expired = { ...token, expiresAt: NOW - 1 }
    expect(await a.check({ ...request, token: expired })).toEqual({ ok: false, cause: 'token-expired' })
  })

  it.each([541, 401, 403])('classifies HTTP %i with an unexpired stored token as token-rejected', async (status) => {
    const { apple: a } = apple(reply(status, fixture('rejected-541.html')))
    expect(await a.check(request)).toEqual({ ok: false, cause: 'token-rejected' })
  })

  it('classifies the 503 maintenance page as unexpected, not a token problem', async () => {
    const { apple: a } = apple(reply(503, fixture('maintenance-503.html')))
    expect(await a.check({ ...request, token: { ...token, expiresAt: NOW - 1 } })).toEqual({
      ok: false,
      cause: 'unexpected',
    })
  })

  it.each([500, 502, 404, 429])('classifies HTTP %i as unexpected', async (status) => {
    const { apple: a } = apple(reply(status, '{"head":{"status":"x"}}'))
    expect(await a.check(request)).toEqual({ ok: false, cause: 'unexpected' })
  })

  it('classifies a 200 with a non-JSON body as unexpected', async () => {
    const { apple: a } = apple(reply(200, fixture('rejected-541.html')))
    expect(await a.check(request)).toEqual({ ok: false, cause: 'unexpected' })
  })

  it('classifies a 200 whose JSON lacks the stores list as unexpected', async () => {
    const { apple: a } = apple(reply(200, '{"body":{"content":{}}}'))
    expect(await a.check(request)).toEqual({ ok: false, cause: 'unexpected' })
  })
})

describe('token parsing', () => {
  const goodShld = shld(NOW + HOUR)
  const cookie = `dssid2=${DSSID}; shld_bt_ck=${goodShld}; other=x`
  const accepted = { ok: true, token: { dssid2: DSSID, shldBtCk: goodShld, userAgent: UA, expiresAt: NOW + HOUR } }
  const url = "'https://www.apple.com/shop/fulfillment-messages?fae=true&parts.0=MJQ84LL%2FA&location=10001'"

  it('reads a Chrome "Copy as cURL" with the cookie in -b and the User-Agent in -H', () => {
    const curl = `curl ${url} \\\n  -H 'accept: */*' \\\n  -H 'accept-language: en-US,en;q=0.9' \\\n  -b '${cookie}' \\\n  -H 'referer: https://www.apple.com/' \\\n  -H 'user-agent: ${UA}'`
    expect(parseCurl(curl, NOW)).toEqual(accepted)
  })

  it('reads the cookie from a -H cookie header, whatever its case', () => {
    const curl = `curl ${url} \\\n  -H 'Cookie: ${cookie}' \\\n  -H 'User-Agent: ${UA}'`
    expect(parseCurl(curl, NOW)).toEqual(accepted)
  })

  it('reads the User-Agent from -A and the cookie from --cookie', () => {
    const curl = `curl ${url} --cookie '${cookie}' -A '${UA}'`
    expect(parseCurl(curl, NOW)).toEqual(accepted)
  })

  it('reads double-quoted values', () => {
    const curl = `curl ${url} -b "${cookie}" -H "user-agent: ${UA}"`
    expect(parseCurl(curl, NOW)).toEqual(accepted)
  })

  it("reads bash $'…' quoting, including escaped quotes and unicode", () => {
    const ua = "Mozilla/5.0 (X11; Linux) 'quoted' \\ back"
    const escaped = ua.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
    const curl = `curl ${url} \\\n  -b $'${cookie}' \\\n  -H $'user-agent: ${escaped}\\u0021'`
    expect(parseCurl(curl, NOW)).toEqual({ ok: true, token: { ...accepted.token, userAgent: `${ua}!` } })
  })

  it('reads a one-line paste with Windows line endings in the continuations', () => {
    const curl = `curl ${url} \\\r\n  -b '${cookie}' \\\r\n  -H 'user-agent: ${UA}'`
    expect(parseCurl(curl, NOW)).toEqual(accepted)
  })

  it('treats flags as case-sensitive: -B is not the cookie flag', () => {
    const curl = `curl ${url} -B '${cookie}' -H 'user-agent: ${UA}'`
    expect(parseCurl(curl, NOW)).toEqual({ ok: false, reason: 'missing-cookie' })
  })

  it('rejects a cURL whose cookie lacks shld_bt_ck', () => {
    const curl = `curl ${url} -b 'dssid2=${DSSID}' -H 'user-agent: ${UA}'`
    expect(parseCurl(curl, NOW)).toEqual({ ok: false, reason: 'missing-cookie' })
  })

  it('rejects a cURL whose cookie lacks dssid2', () => {
    const curl = `curl ${url} -b 'shld_bt_ck=${goodShld}' -H 'user-agent: ${UA}'`
    expect(parseCurl(curl, NOW)).toEqual({ ok: false, reason: 'missing-cookie' })
  })

  it('rejects a cURL without a User-Agent', () => {
    const curl = `curl ${url} -b '${cookie}'`
    expect(parseCurl(curl, NOW)).toEqual({ ok: false, reason: 'missing-user-agent' })
  })

  it('rejects text that is not a cURL command', () => {
    expect(parseCurl('hello world', NOW)).toEqual({ ok: false, reason: 'missing-cookie' })
  })

  const body = (overrides: Record<string, unknown> = {}) => ({
    dssid2: DSSID,
    shld_bt_ck: goodShld,
    userAgent: UA,
    ...overrides,
  })

  it('accepts the extension body and takes expiresAt from the shld_bt_ck timestamp', () => {
    expect(parseTokenBody(body(), NOW)).toEqual(accepted)
  })

  it.each([
    ['dssid2', { dssid2: '' }],
    ['shld_bt_ck', { shld_bt_ck: undefined }],
  ])('rejects a body with %s missing', (_name, overrides) => {
    expect(parseTokenBody(body(overrides), NOW)).toEqual({ ok: false, reason: 'missing-cookie' })
  })

  it('rejects a body that is not an object', () => {
    expect(parseTokenBody('dssid2=x', NOW)).toEqual({ ok: false, reason: 'missing-cookie' })
  })

  it('rejects a body without userAgent', () => {
    expect(parseTokenBody(body({ userAgent: undefined }), NOW)).toEqual({ ok: false, reason: 'missing-user-agent' })
  })

  it.each(['nopipes', 'id|notanumber|payload|sig', 'id|1792000000|payload', 'id|1792000000||sig', '|1792000000|payload|sig'])(
    'rejects the malformed shld_bt_ck %j',
    (value) => {
      expect(parseTokenBody(body({ shld_bt_ck: value }), NOW)).toEqual({ ok: false, reason: 'malformed' })
    },
  )

  it('rejects a pair that has expired, including at the exact expiry second', () => {
    expect(parseTokenBody(body({ shld_bt_ck: shld(NOW - HOUR) }), NOW)).toEqual({ ok: false, reason: 'expired' })
    expect(parseTokenBody(body({ shld_bt_ck: shld(NOW) }), NOW)).toEqual({ ok: false, reason: 'expired' })
  })

  it('accepts a freshly issued pair 2 h ahead and rejects one more than 2 h 5 min ahead', () => {
    expect(parseTokenBody(body({ shld_bt_ck: shld(NOW + 2 * HOUR) }), NOW).ok).toBe(true)
    expect(parseTokenBody(body({ shld_bt_ck: shld(NOW + 2 * HOUR + 5 * 60_000) }), NOW).ok).toBe(true)
    expect(parseTokenBody(body({ shld_bt_ck: shld(NOW + 2 * HOUR + 5 * 60_000 + 1000) }), NOW)).toEqual({
      ok: false,
      reason: 'too-far-ahead',
    })
  })

  it('applies the same expiry rules to a pasted cURL', () => {
    const old = `dssid2=${DSSID}; shld_bt_ck=${shld(NOW - HOUR)}`
    expect(parseCurl(`curl ${url} -b '${old}' -H 'user-agent: ${UA}'`, NOW)).toEqual({ ok: false, reason: 'expired' })
  })
})

describe('fixtures', () => {
  it('hold no Apple cookie values: no dssid2=, shld_bt_ck= or Set-Cookie line', () => {
    const files = readdirSync(fixtureDir)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = fixture(file)
      expect(text, file).not.toMatch(/dssid2=/i)
      expect(text, file).not.toMatch(/shld_bt_ck=/i)
      expect(text, file).not.toMatch(/^set-cookie:/im)
    }
  })
})
