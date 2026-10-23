import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ORIGIN = 'https://www.apple.com'
const OUT_DIR = fileURLToPath(new URL('../test/fixtures/', import.meta.url))
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const ZIP = '10001'
const FORBIDDEN = [/dssid2=/i, /shld_bt_ck=/i, /^set-cookie:/im]

type LocatorBody = {
  body: { productLocatorOverlayData: { productLocatorMeta: { products: { partNumber: string; carrierModel: string }[] } } }
}

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(ORIGIN + path, {
    headers: { 'user-agent': BROWSER_UA, ...headers },
    signal: AbortSignal.timeout(20_000),
  })
  return { status: res.status, body: await res.text() }
}

function save(name: string, body: string) {
  const bad = FORBIDDEN.find((re) => re.test(body))
  if (bad) throw new Error(`refusing to write ${name}: body matches ${bad}`)
  writeFileSync(OUT_DIR + name, body)
  console.log(`wrote ${name} (${body.length} bytes)`)
}

function unlockedParts(locatorBody: string): string[] {
  const data = JSON.parse(locatorBody) as LocatorBody
  return data.body.productLocatorOverlayData.productLocatorMeta.products
    .filter((p) => p.carrierModel === 'UNLOCKED/US')
    .map((p) => p.partNumber)
}

// Cookies and User-Agent come from a pasted "Copy as cURL" and are only ever sent in the request.
function readCurl(): string | undefined {
  const file = process.env.CAPTURE_CURL_FILE
  if (file) return readFileSync(file, 'utf8')
  return process.env.CAPTURE_CURL
}

function quoted(curl: string, flags: string): string | undefined {
  const m = new RegExp(`(?:${flags})\\s+(?:'([^']*)'|"([^"]*)")`, 'i').exec(curl)
  return m?.[1] ?? m?.[2]
}

function cookieAndAgent(curl: string): { cookie: string; userAgent: string } {
  const cookie = quoted(curl, '-b|--cookie') ?? /-H\s+['"]cookie:\s*([^'"]*)['"]/i.exec(curl)?.[1]
  if (!cookie) throw new Error('no cookie found in the pasted cURL')
  const userAgent =
    quoted(curl, '-A|--user-agent') ?? /-H\s+['"]user-agent:\s*([^'"]*)['"]/i.exec(curl)?.[1] ?? BROWSER_UA
  return { cookie, userAgent }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  const locators = [
    ['locator-18pro.json', 'iphone18pro'],
    ['locator-duo.json', 'iphoneduo'],
  ] as const
  const parts: string[] = []
  for (const [file, family] of locators) {
    const { status, body } = await get(`/shop/product-locator-meta?family=${family}`)
    if (status !== 200) throw new Error(`${family} locator returned ${status}`)
    save(file, body)
    parts.push(...unlockedParts(body))
  }
  const [firstPart] = parts
  if (!firstPart) throw new Error('locator fixtures hold no UNLOCKED/US parts')

  const stores = await get(
    `/shop/pickup-message-recommendations?fae=true&mts.0=regular&mts.1=compact&cppart=UNLOCKED/US&location=${ZIP}&product=${encodeURIComponent(firstPart)}`,
  )
  if (stores.status !== 200) throw new Error(`stores lookup returned ${stores.status}`)
  save(`stores-${ZIP}.json`, stores.body)

  const partParams = parts
    .slice(0, 3)
    .map((p, i) => `parts.${i}=${encodeURIComponent(p)}`)
    .join('&')
  const fulfillmentPath = `/shop/fulfillment-messages?fae=true&pl=true&mts.0=regular&cppart=UNLOCKED/US&${partParams}&location=${ZIP}`

  const rejected = await get(fulfillmentPath)
  if (rejected.status !== 541) console.warn(`expected 541 without cookies, got ${rejected.status}`)
  save('rejected-541.html', rejected.body)

  const curl = readCurl()
  if (!curl) {
    console.log('no CAPTURE_CURL_FILE or CAPTURE_CURL set: skipped the token-gated fulfillment fixture')
    return
  }
  const { cookie, userAgent } = cookieAndAgent(curl)
  const live = await get(fulfillmentPath, { cookie, 'user-agent': userAgent })
  if (live.status !== 200) throw new Error(`fulfillment-messages with the pasted cookies returned ${live.status}`)
  save('fulfillment-live.json', live.body)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'capture failed')
  process.exit(1)
})
