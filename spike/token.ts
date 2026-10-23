/*
 * Day-1 token spike (throwaway). Finds out how to keep an Apple dssid2 + shld_bt_ck pair working.
 *
 *   npx tsx spike/token.ts <variant> [flags]
 *
 * Variants
 *   replay [--file curl.txt] [--adopt]
 *       Reads a "Copy as cURL" from the owner's browser (file or stdin, e.g. `pbpaste | npx tsx spike/token.ts replay`),
 *       replays fulfillment-messages from Node fetch every 60 s until Apple answers 541, after one /usr/bin/curl control call.
 *       --adopt applies non-empty Set-Cookie replies for dssid2 / shld_bt_ck to the pair (clears are ignored).
 *       Sends a Telegram message when a SPIKE_PARTS part first shows pickupDisplay "available" at a store.
 *   parts-cap [--file curl.txt]
 *       One request with all 40 catalog parts (token-free catalog); reports the status and parts per store.
 *   playwright [--rounds 3]
 *       Playwright Chromium (headful) opens the iPhone 18 Pro buy page, reads the pair, tests it; every 90 min.
 *   cdp [--rounds 3] [--profile <dir>]
 *       Same through CDP into a normally launched Brave with its own --user-data-dir (default spike/out/brave-profile).
 *
 * Env (.env or shell): SPIKE_ZIP (5 digits), SPIKE_PARTS (comma-separated part numbers; not needed for parts-cap),
 *   TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (replay only).
 * One-time: npx playwright install chromium
 * Output: stdout and spike/out/<variant>-<time>.log. Cookie values and the bot token are never logged.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { z } from 'zod'

const APPLE = 'https://www.apple.com'
const BUY_PAGE = `${APPLE}/shop/buy-iphone/iphone-18-pro`
const CATALOG_FAMILIES = ['iphone18pro', 'iphoneduo']
const REPLAY_EVERY_MS = 60_000
const BROWSER_EVERY_MS = 90 * 60_000
const CDP_PORT = 9222
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const OUT_DIR = fileURLToPath(new URL('./out/', import.meta.url))

type Pair = { dssid2: string; shld: string; userAgent: string }
type Target = { zip: string; parts: string[] }
type Telegram = { token: string; chatId: string }
type Store = z.infer<typeof StoreSchema>
type Reply = { status: number; stores: Store[] | undefined; setCookies: string[] }

const StoreSchema = z.object({
  storeNumber: z.string(),
  storeName: z.string(),
  storedistance: z.number().optional(),
  partsAvailability: z.record(
    z.string(),
    z.object({
      pickupDisplay: z.string(),
      pickupSearchQuote: z.string().optional(),
      messageTypes: z.object({ regular: z.object({ storePickupProductTitle: z.string().optional() }) }).optional(),
    }),
  ),
})
const FulfillmentSchema = z.object({ body: z.object({ content: z.object({ pickupMessage: z.object({ stores: z.array(StoreSchema) }) }) }) })
const CatalogSchema = z.object({
  body: z.object({
    productLocatorOverlayData: z.object({
      productLocatorMeta: z.object({ products: z.array(z.object({ partNumber: z.string(), carrierModel: z.string() })) }),
    }),
  }),
})
const EnvSchema = z.object({
  SPIKE_ZIP: z.string().regex(/^\d{5}$/, 'must be a 5-digit zip'),
  SPIKE_PARTS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean)),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
})

const startedAt = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
let logFile = ''

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}`
  console.log(line)
  appendFileSync(logFile, `${line}\n`)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function readEnv(): { target: Target; telegram: Telegram | undefined } {
  const envFile = fileURLToPath(new URL('../.env', import.meta.url))
  if (existsSync(envFile)) process.loadEnvFile(envFile)
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) fail(`Bad env: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`)
  const { SPIKE_ZIP, SPIKE_PARTS, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = parsed.data
  const telegram = TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? { token: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID } : undefined
  return { target: { zip: SPIKE_ZIP, parts: SPIKE_PARTS }, telegram }
}

function requireParts(target: Target): void {
  if (target.parts.length === 0) fail('SPIKE_PARTS is empty: set comma-separated part numbers')
}

// --- cURL parsing -----------------------------------------------------------

function shellSplit(text: string): string[] {
  const src = text.replace(/\\\r?\n/g, ' ')
  const tokens: string[] = []
  let cur = ''
  let inToken = false
  let i = 0
  while (i < src.length) {
    const c = src.charAt(i)
    if (c === "'" || (c === '$' && src.charAt(i + 1) === "'")) {
      const ansi = c === '$'
      i += ansi ? 2 : 1
      inToken = true
      while (i < src.length && src.charAt(i) !== "'") {
        if (ansi && src.charAt(i) === '\\') i++
        cur += src.charAt(i++)
      }
      i++
    } else if (c === '"') {
      i++
      inToken = true
      while (i < src.length && src.charAt(i) !== '"') {
        if (src.charAt(i) === '\\') i++
        cur += src.charAt(i++)
      }
      i++
    } else if (/\s/.test(c)) {
      if (inToken) tokens.push(cur)
      cur = ''
      inToken = false
      i++
    } else {
      cur += c
      inToken = true
      i++
    }
  }
  if (inToken) tokens.push(cur)
  return tokens
}

const shldExpiry = (shld: string): number | undefined => {
  const ts = Number(shld.split('|')[1])
  return Number.isInteger(ts) && ts > 1_000_000_000 ? ts * 1000 : undefined
}

function parseCookies(header: string): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  return cookies
}

function parseCurl(text: string): Pair {
  const tokens = shellSplit(text)
  let cookie = ''
  let userAgent = ''
  for (let i = 0; i < tokens.length; i++) {
    const flag = tokens[i]
    const value = tokens[i + 1] ?? ''
    if (flag === '-b' || flag === '--cookie') cookie = value
    else if (flag === '-A' || flag === '--user-agent') userAgent = value
    else if (flag === '-H' || flag === '--header') {
      const colon = value.indexOf(':')
      const name = value.slice(0, colon).trim().toLowerCase()
      if (name === 'cookie') cookie = value.slice(colon + 1).trim()
      else if (name === 'user-agent') userAgent = value.slice(colon + 1).trim()
    }
  }
  const cookies = parseCookies(cookie)
  const dssid2 = cookies.get('dssid2')
  const shld = cookies.get('shld_bt_ck')
  if (!dssid2 || !shld) fail('The cURL has no dssid2 and shld_bt_ck cookies (in -b or -H cookie)')
  if (!userAgent) fail('The cURL has no User-Agent (-H or -A)')
  if (shldExpiry(shld) === undefined) fail('shld_bt_ck is malformed: no unix timestamp in its second field')
  return { dssid2, shld, userAgent }
}

function readCurlInput(file: string | undefined): Pair {
  return parseCurl(file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8'))
}

function describeExpiry(shld: string): string {
  const at = shldExpiry(shld)
  if (at === undefined) return 'shld_bt_ck timestamp unreadable'
  const left = Math.round((at - Date.now()) / 60_000)
  return `shld_bt_ck ts=${new Date(at).toISOString()} (${left} min left)`
}

// --- Apple ------------------------------------------------------------------

function fulfillmentUrl(parts: string[], zip: string): string {
  const query = new URLSearchParams({ fae: 'true', pl: 'true', 'mts.0': 'regular', cppart: 'UNLOCKED/US' })
  parts.forEach((part, i) => query.set(`parts.${i}`, part))
  query.set('location', zip)
  return `${APPLE}/shop/fulfillment-messages?${query}`
}

function parseStores(status: number, text: string): Store[] | undefined {
  if (status !== 200) return undefined
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    log('200 but the body is not JSON')
    return undefined
  }
  const parsed = FulfillmentSchema.safeParse(json)
  if (!parsed.success) {
    log(`200 but unexpected shape: ${parsed.error.issues.map((i) => i.path.join('.')).slice(0, 3).join(', ')}`)
    return undefined
  }
  return parsed.data.body.content.pickupMessage.stores
}

async function fetchFulfillment(pair: Pair, target: { parts: string[]; zip: string }): Promise<Reply> {
  const res = await fetch(fulfillmentUrl(target.parts, target.zip), {
    headers: { cookie: `dssid2=${pair.dssid2}; shld_bt_ck=${pair.shld}`, 'user-agent': pair.userAgent },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  return { status: res.status, stores: parseStores(res.status, text), setCookies: res.headers.getSetCookie() }
}

// Cookie and User-Agent go to curl on stdin (--config -), so argv holds only the URL.
async function curlFulfillment(pair: Pair, target: Target): Promise<Reply> {
  const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const config = [`header = ${quote(`cookie: dssid2=${pair.dssid2}; shld_bt_ck=${pair.shld}`)}`, `header = ${quote(`user-agent: ${pair.userAgent}`)}`].join('\n')
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn('/usr/bin/curl', ['-sS', '--max-time', '30', '--config', '-', '-w', '\n%{http_code}', fulfillmentUrl(target.parts, target.zip)])
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`curl exit ${code}`))))
    child.stdin.end(config)
  })
  const newline = output.lastIndexOf('\n')
  const status = Number(output.slice(newline + 1))
  return { status, stores: parseStores(status, output.slice(0, newline)), setCookies: [] }
}

async function fetchCatalogParts(): Promise<string[]> {
  const parts = new Set<string>()
  for (const family of CATALOG_FAMILIES) {
    const res = await fetch(`${APPLE}/shop/product-locator-meta?family=${family}`, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) fail(`product-locator-meta ${family}: HTTP ${res.status}`)
    const parsed = CatalogSchema.safeParse(await res.json())
    if (!parsed.success) fail(`product-locator-meta ${family}: unexpected shape`)
    const unlocked = parsed.data.body.productLocatorOverlayData.productLocatorMeta.products.filter((p) => p.carrierModel === 'UNLOCKED/US')
    log(`catalog ${family}: ${unlocked.length} UNLOCKED/US parts`)
    for (const p of unlocked) parts.add(p.partNumber)
  }
  return [...parts]
}

async function sendTelegram(telegram: Telegram, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${telegram.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: telegram.chatId, text }),
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) return true
    log(`telegram HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  } catch {
    log('telegram send failed: network error')
  }
  return false
}

// --- Variants ---------------------------------------------------------------

function describeSetCookies(setCookies: string[], pair: Pair, adopt: boolean): void {
  for (const header of setCookies) {
    const [first = '', ...attributes] = header.split(';')
    const eq = first.indexOf('=')
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (name !== 'dssid2' && name !== 'shld_bt_ck') continue
    const cleared = value === '' || attributes.some((a) => /^\s*(max-age=0|expires=.*1970)/i.test(a))
    if (cleared) {
      log(`Set-Cookie: ${name} cleared (ignored)`)
    } else if (!adopt) {
      log(`Set-Cookie: new ${name} issued (not adopted)`)
    } else if (name === 'dssid2') {
      pair.dssid2 = value
      log('Set-Cookie: adopted new dssid2')
    } else if (shldExpiry(value) !== undefined) {
      pair.shld = value
      log(`Set-Cookie: adopted new shld_bt_ck, ${describeExpiry(value)}`)
    } else {
      log('Set-Cookie: new shld_bt_ck is malformed (ignored)')
    }
  }
}

async function replay(opts: { file: string | undefined; adopt: boolean }): Promise<void> {
  const { target, telegram } = readEnv()
  requireParts(target)
  if (!telegram) fail('replay needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID')
  const pair = readCurlInput(opts.file)
  log(`replay start: ${target.parts.length} parts, zip ${target.zip}, adopt=${opts.adopt}, ${describeExpiry(pair.shld)}`)

  const control = await curlFulfillment(pair, target)
  log(`curl control: HTTP ${control.status}, ${control.stores?.length ?? 0} stores`)

  const begun = Date.now()
  const alerted = new Set<string>()
  for (let cycle = 1; ; cycle++) {
    let reply: Reply
    try {
      reply = await fetchFulfillment(pair, target)
    } catch {
      log(`cycle ${cycle}: fetch failed (network error)`)
      await sleep(REPLAY_EVERY_MS)
      continue
    }
    const minutes = Math.round((Date.now() - begun) / 60_000)
    log(`cycle ${cycle}: fetch HTTP ${reply.status}, ${reply.stores?.length ?? 0} stores, ${minutes} min since start, ${describeExpiry(pair.shld)}`)
    describeSetCookies(reply.setCookies, pair, opts.adopt)
    if (reply.status === 541) {
      log(`EXPIRED: 541 after ${minutes} min and ${cycle - 1} accepted cycles`)
      return
    }
    if (reply.stores) await alertNewStock(reply.stores, alerted, telegram)
    await sleep(REPLAY_EVERY_MS)
  }
}

async function alertNewStock(stores: Store[], alerted: Set<string>, telegram: Telegram): Promise<void> {
  const available = new Map<string, string>()
  for (const store of stores) {
    for (const [part, info] of Object.entries(store.partsAvailability)) {
      if (info.pickupDisplay !== 'available') continue
      const title = info.messageTypes?.regular.storePickupProductTitle ?? part
      const distance = store.storedistance === undefined ? '' : `, ${store.storedistance} mi`
      available.set(`${part}|${store.storeNumber}`, `In stock: ${title} (${part}) at ${store.storeName}${distance}: ${info.pickupSearchQuote ?? 'available'}`)
    }
  }
  for (const key of alerted) if (!available.has(key)) alerted.delete(key)
  for (const [key, text] of available) {
    if (alerted.has(key)) continue
    log(`STOCK ${key}`)
    if (await sendTelegram(telegram, text)) alerted.add(key)
  }
}

async function partsCap(opts: { file: string | undefined }): Promise<void> {
  const { target } = readEnv()
  const pair = readCurlInput(opts.file)
  const parts = await fetchCatalogParts()
  log(`parts-cap: requesting ${parts.length} distinct parts for zip ${target.zip}, ${describeExpiry(pair.shld)}`)
  const reply = await fetchFulfillment(pair, { parts, zip: target.zip })
  log(`parts-cap: HTTP ${reply.status}${reply.status === 541 ? ' (token rejected or expired)' : ''}`)
  for (const store of reply.stores ?? []) {
    log(`store ${store.storeNumber} ${store.storeName}: ${Object.keys(store.partsAvailability).length}/${parts.length} parts`)
  }
}

async function browserRounds(context: BrowserContext, page: Page, rounds: number, target: Target): Promise<void> {
  for (let round = 1; round <= rounds; round++) {
    await page.goto(BUY_PAGE, { waitUntil: 'load' })
    await page.waitForTimeout(5000)
    const cookies = await context.cookies(APPLE)
    const dssid2 = cookies.find((c) => c.name === 'dssid2')?.value
    const shld = cookies.find((c) => c.name === 'shld_bt_ck')?.value
    if (!dssid2 || !shld) {
      log(`round ${round}: pair missing (dssid2 ${dssid2 ? 'present' : 'absent'}, shld_bt_ck ${shld ? 'present' : 'absent'})`)
    } else {
      const userAgent = await page.evaluate(() => navigator.userAgent)
      const reply = await fetchFulfillment({ dssid2, shld, userAgent }, target)
      log(`round ${round}: HTTP ${reply.status}, ${reply.stores?.length ?? 0} stores, ${describeExpiry(shld)}`)
    }
    if (round < rounds) await sleep(BROWSER_EVERY_MS)
  }
}

function readBrowserTarget(): Target {
  const { target } = readEnv()
  requireParts(target)
  return target
}

async function playwrightVariant(opts: { rounds: number }): Promise<void> {
  const target = readBrowserTarget()
  const browser = await chromium.launch({ headless: false })
  try {
    const context = await browser.newContext()
    await browserRounds(context, await context.newPage(), opts.rounds, target)
  } finally {
    await browser.close()
  }
}

async function cdpVariant(opts: { rounds: number; profile: string }): Promise<void> {
  const target = readBrowserTarget()
  log(`launching Brave with profile ${opts.profile}`)
  spawn(BRAVE, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${opts.profile}`, '--no-first-run', BUY_PAGE], { stdio: 'ignore', detached: true }).unref()
  for (let attempt = 1; ; attempt++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
      const context = browser.contexts()[0] ?? (await browser.newContext())
      await browserRounds(context, context.pages()[0] ?? (await context.newPage()), opts.rounds, target)
      log('done; Brave is left running')
      await browser.close()
      return
    } catch (error) {
      if (attempt >= 30) throw error
      await sleep(1000)
    }
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      adopt: { type: 'boolean', default: false },
      rounds: { type: 'string', default: '3' },
      profile: { type: 'string', default: `${OUT_DIR}brave-profile` },
    },
  })
  const variant = positionals[0]
  const rounds = Number(values.rounds)
  if (!Number.isInteger(rounds) || rounds < 1) fail('--rounds must be a positive integer')
  const variants: Record<string, () => Promise<void>> = {
    replay: () => replay({ file: values.file, adopt: values.adopt }),
    'parts-cap': () => partsCap({ file: values.file }),
    playwright: () => playwrightVariant({ rounds }),
    cdp: () => cdpVariant({ rounds, profile: values.profile }),
  }
  const run = variant ? variants[variant] : undefined
  if (!run) fail(`Usage: npx tsx spike/token.ts <${Object.keys(variants).join('|')}> (see the header of spike/token.ts)`)
  mkdirSync(OUT_DIR, { recursive: true })
  logFile = `${OUT_DIR}${variant}-${startedAt}.log`
  await run()
}

await main()
