import { z } from 'zod'
import type { CatalogPart, CheckOutcome, Observation, PartNumber, StoreNumber } from '../shared/types'
import { pickupFrom } from './domain'

const ORIGIN = 'https://www.apple.com'
const FAMILIES = ['iphone18pro', 'iphoneduo'] as const
const TIMEOUT_MS = 20_000
const MAX_AHEAD_MS = 2 * 3_600_000 + 5 * 60_000

export type AppleToken = { dssid2: string; shldBtCk: string; userAgent: string; expiresAt: number }
export type TokenRejection = 'missing-cookie' | 'missing-user-agent' | 'malformed' | 'expired' | 'too-far-ahead'
export type TokenResult = { ok: true; token: AppleToken } | { ok: false; reason: TokenRejection }

export type StoreInfo = { store: StoreNumber; name: string; city: string; state: string; distanceMi: number }
export type Lookup<T> = { ok: true; value: T } | { ok: false; reason: 'network' | 'unexpected' | 'invalid-zip' }

export type CheckRequest = {
  zip: string
  token: AppleToken
  watchedParts: PartNumber[]
  otherParts: PartNumber[]
  enabledStores: StoreNumber[]
}

export type Apple = {
  fetchCatalog(): Promise<Lookup<CatalogPart[]>>
  fetchStores(zip: string, part: PartNumber): Promise<Lookup<StoreInfo[]>>
  check(request: CheckRequest): Promise<CheckOutcome>
}

const ZIP_RE = /^\d{5}$/
const PART_RE = /^[A-Z0-9]{5}LL\/A$/
const STORE_RE = /^R\d{3,4}$/
const TITLE_RE = /^(.+?) (\d+(?:GB|TB)) (.+)$/i

const isBuyLink = (link: string) => {
  if (!URL.canParse(link)) return false
  const url = new URL(link)
  return (
    url.origin === ORIGIN &&
    url.username === '' &&
    url.password === '' &&
    !/[?#]/.test(link) &&
    url.pathname.startsWith('/shop/buy-iphone/')
  )
}

// The -unlocked suffix opens the page with Unlocked and No trade-in selected; a query such as ?igt=true clears No trade-in.
const unlockedLink = (link: string) => (link.endsWith('-unlocked') ? link : `${link}-unlocked`)

const CatalogEnvelope = z.object({
  body: z.object({
    productLocatorOverlayData: z.object({ productLocatorMeta: z.object({ products: z.array(z.unknown()) }) }),
  }),
})

const CatalogEntry = z
  .object({
    carrierModel: z.literal('UNLOCKED/US'),
    partNumber: z.string().regex(PART_RE),
    productTitle: z
      .string()
      .transform((t) => t.replaceAll('\u00a0', ' ').replace(/ +/g, ' ').trim())
      .pipe(z.string().regex(TITLE_RE)),
    productLink: z.string().refine(isBuyLink),
  })
  .transform((e): CatalogPart => {
    const [, modelName = '', capacity = '', colorName = ''] = TITLE_RE.exec(e.productTitle) ?? []
    return {
      part: e.partNumber,
      modelName,
      capacity: capacity.toLowerCase(),
      colorName,
      title: e.productTitle,
      buyUrl: unlockedLink(e.productLink),
    }
  })

const StoresEnvelope = z.object({
  body: z.object({
    PickupMessage: z.object({
      stores: z.array(
        z.object({
          storeNumber: z.string().regex(STORE_RE),
          storeName: z.string(),
          city: z.string(),
          state: z.string(),
          storedistance: z.number(),
        }),
      ),
    }),
  }),
})

const FulfillmentEnvelope = z.object({
  body: z.object({
    content: z.object({
      pickupMessage: z.object({
        stores: z.array(
          z.object({
            storeNumber: z.string().regex(STORE_RE),
            storeName: z.string(),
            storedistance: z.number(),
            partsAvailability: z.record(z.string(), z.object({ pickupDisplay: z.string(), pickupSearchQuote: z.string() })),
          }),
        ),
      }),
    }),
  }),
})

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function createApple(deps: { fetch: typeof fetch; now: () => number; timeoutMs?: number }): Apple {
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS

  // null means the request threw or timed out; the thrown error is dropped because it can carry the URL or headers.
  async function get(url: string, headers: Record<string, string> = {}) {
    try {
      const res = await deps.fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
      return { status: res.status, body: parseJson(await res.text()) }
    } catch {
      return null
    }
  }

  async function fetchFamily(family: string): Promise<Lookup<CatalogPart[]>> {
    const res = await get(`${ORIGIN}/shop/product-locator-meta?family=${family}`)
    if (!res) return { ok: false, reason: 'network' }
    const envelope = res.status === 200 ? CatalogEnvelope.safeParse(res.body) : undefined
    if (!envelope?.success) return { ok: false, reason: 'unexpected' }
    const entries = envelope.data.body.productLocatorOverlayData.productLocatorMeta.products
    return {
      ok: true,
      value: entries.flatMap((entry) => {
        const parsed = CatalogEntry.safeParse(entry)
        return parsed.success ? [parsed.data] : []
      }),
    }
  }

  return {
    async fetchCatalog() {
      const results = await Promise.all(FAMILIES.map(fetchFamily))
      const failed = results.find((r) => !r.ok)
      if (failed) return failed
      const parts = new Map(results.flatMap((r) => (r.ok ? r.value : [])).map((p) => [p.part, p]))
      return { ok: true, value: [...parts.values()] }
    },

    async fetchStores(zip, part) {
      if (!ZIP_RE.test(zip)) return { ok: false, reason: 'invalid-zip' }
      const res = await get(
        `${ORIGIN}/shop/pickup-message-recommendations?fae=true&mts.0=regular&mts.1=compact&cppart=UNLOCKED/US&location=${zip}&product=${encodeURIComponent(part)}`,
      )
      if (!res) return { ok: false, reason: 'network' }
      const envelope = res.status === 200 ? StoresEnvelope.safeParse(res.body) : undefined
      if (!envelope?.success) return { ok: false, reason: 'unexpected' }
      return {
        ok: true,
        value: envelope.data.body.PickupMessage.stores.map((s) => ({
          store: s.storeNumber,
          name: s.storeName,
          city: s.city,
          state: s.state,
          distanceMi: s.storedistance,
        })),
      }
    },

    async check({ zip, token, watchedParts, otherParts, enabledStores }) {
      const parts = [...watchedParts, ...otherParts]
      const partParams = parts.map((p, i) => `parts.${i}=${encodeURIComponent(p)}`).join('&')
      const res = await get(
        `${ORIGIN}/shop/fulfillment-messages?fae=true&pl=true&mts.0=regular&cppart=UNLOCKED/US&${partParams}&location=${encodeURIComponent(zip)}`,
        { cookie: `dssid2=${token.dssid2}; shld_bt_ck=${token.shldBtCk}`, 'user-agent': token.userAgent },
      )
      if (!res) return { ok: false, cause: 'network' }
      if (res.status === 541 || res.status === 401 || res.status === 403) {
        return { ok: false, cause: deps.now() > token.expiresAt ? 'token-expired' : 'token-rejected' }
      }
      const envelope = res.status === 200 ? FulfillmentEnvelope.safeParse(res.body) : undefined
      if (!envelope?.success) return { ok: false, cause: 'unexpected' }

      const enabled = new Set(enabledStores)
      const stores = envelope.data.body.content.pickupMessage.stores.filter((s) => enabled.has(s.storeNumber))
      if (stores.length === 0) return { ok: false, cause: 'unexpected' }

      const observations: Observation[] = stores.flatMap((s) =>
        parts.flatMap((part) => {
          const availability = s.partsAvailability[part]
          if (!availability) return []
          return [{ part, store: s.storeNumber, pickup: pickupFrom(availability.pickupDisplay, availability.pickupSearchQuote) }]
        }),
      )
      if (watchedParts.some((part) => !observations.some((o) => o.part === part))) {
        return { ok: false, cause: 'unexpected' }
      }
      return {
        ok: true,
        observations,
        stores: stores.map((s) => ({ store: s.storeNumber, name: s.storeName, distanceMi: s.storedistance })),
      }
    },
  }
}

const SHLD_RE = /^[^|]+\|(\d+)\|.+\|[^|]+$/

export function shldExpiresAt(shldBtCk: string): number | undefined {
  const stamp = SHLD_RE.exec(shldBtCk)?.[1]
  return stamp === undefined ? undefined : Number(stamp) * 1000
}

function buildToken(
  dssid2: string | undefined,
  shldBtCk: string | undefined,
  userAgent: string | undefined,
  now: number,
): TokenResult {
  if (!dssid2 || !shldBtCk) return { ok: false, reason: 'missing-cookie' }
  if (!userAgent) return { ok: false, reason: 'missing-user-agent' }
  const expiresAt = shldExpiresAt(shldBtCk)
  if (expiresAt === undefined) return { ok: false, reason: 'malformed' }
  if (expiresAt <= now) return { ok: false, reason: 'expired' }
  if (expiresAt > now + MAX_AHEAD_MS) return { ok: false, reason: 'too-far-ahead' }
  return { ok: true, token: { dssid2, shldBtCk, userAgent, expiresAt } }
}

const TokenBody = z.looseObject({
  dssid2: z.string().catch(''),
  shld_bt_ck: z.string().catch(''),
  userAgent: z.string().catch(''),
})

export function parseTokenBody(body: unknown, now: number): TokenResult {
  const parsed = TokenBody.safeParse(body)
  if (!parsed.success) return { ok: false, reason: 'missing-cookie' }
  return buildToken(parsed.data.dssid2, parsed.data.shld_bt_ck, parsed.data.userAgent, now)
}

const ANSI_C_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"' }

// Splits a pasted shell command the way bash would: '…', "…", $'…', backslash escapes and line continuations.
function shellWords(input: string): string[] {
  const words: string[] = []
  let word = ''
  let inWord = false
  let i = 0
  const flush = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  while (i < input.length) {
    const c = input[i]!
    const rest = input.slice(i)
    const continuation = /^\\\r?\n/.exec(rest)
    if (continuation) {
      i += continuation[0].length
    } else if (/\s/.test(c)) {
      flush()
      i++
    } else if (c === "'") {
      const end = input.indexOf("'", i + 1)
      word += input.slice(i + 1, end === -1 ? undefined : end)
      inWord = true
      i = end === -1 ? input.length : end + 1
    } else if (c === '$' && input[i + 1] === "'") {
      i += 2
      inWord = true
      while (i < input.length && input[i] !== "'") {
        const escape = /^\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|(.))/s.exec(input.slice(i))
        if (!escape) {
          word += input[i]
          i++
          continue
        }
        const [whole, hex2, hex4, hex8, char] = escape
        const hex = hex2 ?? hex4 ?? hex8
        word += hex !== undefined ? String.fromCodePoint(parseInt(hex, 16)) : (ANSI_C_ESCAPES[char!] ?? whole)
        i += whole.length
      }
      i++
    } else if (c === '"') {
      inWord = true
      i++
      while (i < input.length && input[i] !== '"') {
        const escape = /^\\([$`"\\])/.exec(input.slice(i))
        word += escape ? escape[1] : input[i]
        i += escape ? 2 : 1
      }
      i++
    } else if (c === '\\') {
      word += input[i + 1] ?? ''
      inWord = true
      i += 2
    } else {
      word += c
      inWord = true
      i++
    }
  }
  flush()
  return words
}

function cookieValue(cookie: string | undefined, name: string): string | undefined {
  for (const pair of (cookie ?? '').split(';')) {
    const eq = pair.indexOf('=')
    if (eq > 0 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim()
  }
  return undefined
}

export function parseCurl(curl: string, now: number): TokenResult {
  const words = shellWords(curl)
  let cookie: string | undefined
  let userAgent: string | undefined
  let headerCookie: string | undefined
  let headerUserAgent: string | undefined
  words.forEach((flag, i) => {
    const value = words[i + 1]
    if (value === undefined) return
    if (flag === '-b' || flag === '--cookie') cookie = value
    else if (flag === '-A' || flag === '--user-agent') userAgent = value
    else if (flag === '-H' || flag === '--header') {
      const colon = value.indexOf(':')
      const name = value.slice(0, colon).trim().toLowerCase()
      if (name === 'cookie') headerCookie = value.slice(colon + 1).trim()
      if (name === 'user-agent') headerUserAgent = value.slice(colon + 1).trim()
    }
  })
  const cookies = cookie ?? headerCookie
  return buildToken(
    cookieValue(cookies, 'dssid2'),
    cookieValue(cookies, 'shld_bt_ck'),
    userAgent ?? headerUserAgent,
    now,
  )
}
