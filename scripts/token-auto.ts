/*
 * Keeps the monitor's Apple token pair valid, unattended: npm run token:auto
 * Env (.env or shell): PORT (default 4319), BRAVE_CDP_PORT (default 9222), BRAVE_PROFILE_DIR (default data/brave-profile).
 * Cookie values are never logged.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { z } from 'zod'
import { shldExpiresAt } from '../src/server/apple'
import { readEnv as readServerEnv } from '../src/server/boot'

const root = fileURLToPath(new URL('..', import.meta.url))
const BUY_PAGE = 'https://www.apple.com/shop/buy-iphone/iphone-18-pro'
const APPLE = 'https://www.apple.com'
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const MIN = 60_000
const REFRESH_MARGIN_MS = 20 * MIN
const MAX_SLEEP_MS = 10 * MIN
const RETRY_MS = MIN
const PAGE_SETTLE_MS = 5000

export type CookiePair = { dssid2: string | undefined; shld: string | undefined }
type Pair = { dssid2: string; shld: string }

export function needsRefresh(pair: CookiePair, now: number): boolean {
  if (!pair.dssid2 || !pair.shld) return true
  const expiresAt = shldExpiresAt(pair.shld)
  return expiresAt === undefined || expiresAt - now < REFRESH_MARGIN_MS
}

// Never sooner than a minute, so a pair Apple did not renew retries gently instead of in a tight loop.
export function nextCheckDelayMs(expiresAt: number, now: number): number {
  return Math.min(Math.max(expiresAt - REFRESH_MARGIN_MS - now, RETRY_MS), MAX_SLEEP_MS)
}

const Env = z.object({
  BRAVE_CDP_PORT: z.coerce.number().int().min(1).max(65535).default(9222),
  BRAVE_PROFILE_DIR: z.string().min(1).default(`${root}data/brave-profile`),
})
const PostReply = z.object({ stored: z.boolean() })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`)
const at = (ms: number) => new Date(ms).toISOString()

function readConfig() {
  const envFile = `${root}.env`
  if (existsSync(envFile)) process.loadEnvFile(envFile)
  const parsed = Env.safeParse({ BRAVE_CDP_PORT: process.env.BRAVE_CDP_PORT || undefined, BRAVE_PROFILE_DIR: process.env.BRAVE_PROFILE_DIR || undefined })
  if (!parsed.success) throw new Error('BRAVE_CDP_PORT must be a port number and BRAVE_PROFILE_DIR a path')
  return { serverPort: readServerEnv(process.env).port, cdpPort: parsed.data.BRAVE_CDP_PORT, profile: parsed.data.BRAVE_PROFILE_DIR }
}
const config = readConfig()
const cdpUrl = `http://127.0.0.1:${config.cdpPort}`

async function cdpAnswers(): Promise<boolean> {
  try {
    return (await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2000) })).ok
  } catch {
    return false
  }
}

async function connect(): Promise<Browser> {
  if (!(await cdpAnswers())) {
    log(`CDP port ${config.cdpPort} is not answering: launching Brave with profile ${config.profile}`)
    mkdirSync(config.profile, { recursive: true, mode: 0o700 })
    const child = spawn(
      BRAVE,
      [`--remote-debugging-port=${config.cdpPort}`, `--user-data-dir=${config.profile}`, '--no-first-run', BUY_PAGE],
      { stdio: 'ignore', detached: true },
    )
    child.on('error', (error) => log(`could not launch Brave: ${error.message}`))
    child.unref()
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await chromium.connectOverCDP(cdpUrl)
    } catch (error) {
      if (attempt >= 30) throw error
      await sleep(1000)
    }
  }
}

async function readPair(context: BrowserContext): Promise<CookiePair> {
  const cookies = await context.cookies(APPLE)
  return { dssid2: cookies.find((c) => c.name === 'dssid2')?.value, shld: cookies.find((c) => c.name === 'shld_bt_ck')?.value }
}

async function currentPair(context: BrowserContext): Promise<Pair & { userAgent: string }> {
  const page = await context.newPage()
  try {
    let pair = await readPair(context)
    if (needsRefresh(pair, Date.now())) {
      log('pair missing or near expiry: clearing shld_bt_ck and reloading the buy page')
      // Apple issues a fresh pair on a page load only once shld_bt_ck is gone, never before it expires (spike/RESULT.md).
      await context.clearCookies({ name: 'shld_bt_ck' })
      await page.goto(BUY_PAGE, { waitUntil: 'load' })
      await page.waitForTimeout(PAGE_SETTLE_MS)
      pair = await readPair(context)
    }
    if (!pair.dssid2 || !pair.shld) throw new Error('Apple did not set dssid2 and shld_bt_ck')
    return { dssid2: pair.dssid2, shld: pair.shld, userAgent: await page.evaluate(() => navigator.userAgent) }
  } finally {
    await page.close()
  }
}

async function post(pair: Pair & { userAgent: string }): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${config.serverPort}/api/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dssid2: pair.dssid2, shld_bt_ck: pair.shld, userAgent: pair.userAgent }),
    signal: AbortSignal.timeout(15_000),
  })
  const reply = PostReply.safeParse(await res.json().catch(() => undefined))
  log(`POST /api/token: HTTP ${res.status}${reply.success ? `, stored=${reply.data.stored}` : ''}`)
  if (!res.ok) throw new Error(`the server answered HTTP ${res.status}`)
}

async function main(): Promise<void> {
  log(`token:auto start: server port ${config.serverPort}, CDP port ${config.cdpPort}, profile ${config.profile}`)
  let browser: Browser | undefined
  for (;;) {
    let delay = RETRY_MS
    try {
      browser ??= await connect()
      const context = browser.contexts()[0] ?? (await browser.newContext())
      const pair = await currentPair(context)
      const expiresAt = shldExpiresAt(pair.shld)
      if (expiresAt === undefined) throw new Error('shld_bt_ck has no readable expiry')
      log(`pair expires ${at(expiresAt)}`)
      await post(pair)
      delay = nextCheckDelayMs(expiresAt, Date.now())
    } catch (error) {
      log(`error, retrying in ${RETRY_MS / 1000}s: ${error instanceof Error ? error.message.split('\n')[0]?.slice(0, 200) : 'non-error'}`)
      await browser?.close().catch(() => undefined)
      browser = undefined
    }
    log(`next check ${at(Date.now() + delay)}`)
    await sleep(delay)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
