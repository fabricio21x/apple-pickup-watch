import type {
  CatalogPart,
  GridCell,
  HealthDto,
  PartNumber,
  StateDto,
  StoreDto,
  TelegramError,
  TokenStatus,
  TrackedPair,
} from '../shared/types'

export type ApiErrorBody = {
  error: string
  fields?: string[]
  reason?: string
  cap?: number
  tracked?: number
  adding?: number
}

export const VIEWS = ['stock', 'watches', 'stores', 'settings'] as const
export type View = (typeof VIEWS)[number]

export const viewFromHash = (hash: string): View => VIEWS.find((v) => hash === `#/${v}`) ?? 'stock'

export type StoreStock = { store: StoreDto; badge: GridCell['badge'] }

export type Phone = {
  part: PartNumber
  model: string
  capacity: string
  colorName: string
  role: TrackedPair['role']
  watchedColors: string[]
  buyUrl: string
  finish: string | null
  available: StoreStock[]
  todayCount: number
  unchecked: StoreStock[]
  rest: StoreStock[]
  why: string
}

const isInStock = (badge: GridCell['badge']) => badge !== 'Unavailable' && badge !== 'Not checked'

const FINISHES: Record<string, string> = {
  black: 'var(--sw-black)',
  silver: 'var(--sw-silver)',
  glacier: 'var(--sw-glacier)',
  burgundy: 'var(--sw-burgundy)',
  'night sky': 'var(--sw-nightsky)',
  'star white': 'var(--sw-starwhite)',
}

const finishOf = (colorName: string) => FINISHES[colorName.toLowerCase()] ?? null

const pickupRank = (badge: GridCell['badge']) => (badge === 'Today' ? 0 : badge === 'Tomorrow' ? 1 : 2)

const byDistance = (a: StoreStock, b: StoreStock) => a.store.distanceMi - b.store.distanceMi

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function stockSections({ parts, stores, watches, partsCount }: StateDto): { inStock: Phone[]; quiet: Phone[] } {
  const storeById = new Map(stores.map((s) => [s.store, s]))
  const colorOf = new Map(parts.map((p) => [p.part, p.colorName]))
  const watchedParts = new Set(watches.map((w) => w.part))
  const tracked = new Map<PartNumber, { role: TrackedPair['role']; watchedColors: string[]; cells: Map<string, GridCell['badge']> }>()
  for (const w of watches) {
    for (const c of w.cells) {
      const role: TrackedPair['role'] = c.part === w.part ? 'watched' : 'other'
      if (role === 'other' && watchedParts.has(c.part)) continue
      let entry = tracked.get(c.part)
      if (!entry) tracked.set(c.part, (entry = { role, watchedColors: [], cells: new Map() }))
      const watchedColor = colorOf.get(w.part)
      if (role === 'other' && watchedColor && !entry.watchedColors.includes(watchedColor)) {
        entry.watchedColors.push(watchedColor)
      }
      entry.cells.set(c.store, c.badge)
    }
  }
  const pastCap = new Set(partsCount.unchecked)
  const phones: Phone[] = []
  for (const p of parts) {
    const entry = tracked.get(p.part) ?? (pastCap.has(p.part) ? { role: 'other' as const, watchedColors: [], cells: new Map() } : undefined)
    if (!entry) continue
    const stock = [...entry.cells].map(([store, badge]): StoreStock => ({ store: storeById.get(store)!, badge }))
    const available = stock
      .filter((r) => isInStock(r.badge))
      .sort((a, b) => pickupRank(a.badge) - pickupRank(b.badge) || byDistance(a, b))
    const unchecked = stock.filter((r) => r.badge === 'Not checked').sort(byDistance)
    const rest = stock.filter((r) => r.badge === 'Unavailable').sort(byDistance)
    const checked = available.length + rest.length
    phones.push({
      part: p.part,
      model: p.modelName,
      capacity: p.capacity.toUpperCase(),
      colorName: p.colorName,
      role: entry.role,
      watchedColors: entry.watchedColors,
      buyUrl: p.buyUrl,
      finish: finishOf(p.colorName),
      available,
      todayCount: available.filter((r) => r.badge === 'Today').length,
      unchecked,
      rest,
      why: pastCap.has(p.part) && available.length === 0
        ? `Not checked: over the ${partsCount.cap}-part cap`
        : checked === 0
          ? 'Not checked'
          : `${plural(checked, 'store')} checked`,
    })
  }
  const roleRank = (p: Phone) => (p.role === 'watched' ? 0 : 1)
  const bestPickup = (p: Phone) => pickupRank(p.available[0]!.badge)
  return {
    inStock: phones.filter((p) => p.available.length > 0).sort((a, b) => bestPickup(a) - bestPickup(b) || roleRank(a) - roleRank(b)),
    quiet: phones.filter((p) => p.available.length === 0).sort((a, b) => roleRank(a) - roleRank(b)),
  }
}

export const countLine = ({ available, todayCount }: Pick<Phone, 'available' | 'todayCount'>) =>
  `In stock at ${plural(available.length, 'store')}${todayCount > 0 ? `, ${todayCount} for pickup today` : ''}`

export const capNote = ({ tracked, unchecked }: StateDto['partsCount']) =>
  unchecked.length > 0 ? `${tracked} parts tracked, ${tracked - unchecked.length} checked.` : null

export function setupSteps({ stores, watches, token, telegram }: Pick<StateDto, 'stores' | 'watches' | 'token' | 'telegram'>) {
  const steps = {
    telegram: telegram.configured,
    stores: stores.some((s) => s.enabled),
    watches: watches.length > 0,
    token: token.status !== 'missing',
  }
  return { ...steps, complete: steps.stores && steps.watches && steps.token }
}

export const intervalText = (sec: number) =>
  sec === 60 ? 'every minute' : sec > 60 && sec % 60 === 0 ? `every ${sec / 60} min` : `every ${sec} s`

function ageText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`
}

const isDown = ({ health, token }: Pick<StateDto, 'health' | 'token'>) =>
  health.status === 'down' || token.status === 'rejected' || token.status === 'expired'

function tokenText({ status, expiresAt }: StateDto['token'], now: number): string {
  if (status === 'working' && expiresAt !== null) {
    return expiresAt <= now ? 'Token expired' : `Token ${timeLeft(expiresAt, now)}`
  }
  return `Token ${tokenLabel(status).toLowerCase()}`
}

export function statusStrip(
  state: Pick<StateDto, 'intervalSec' | 'lastSuccessAt' | 'token' | 'health'>,
  now: number,
  setupComplete: boolean,
) {
  const { health, lastSuccessAt, intervalSec, token } = state
  const tone = !setupComplete ? 'idle' : isDown(state) ? 'down' : 'ok'
  return {
    tone,
    headline: { ok: `Checking ${intervalText(intervalSec)}`, idle: 'Not checking yet', down: 'Not checking' }[tone],
    ago: !setupComplete
      ? 'finish setup'
      : lastSuccessAt === null
        ? 'no check yet'
        : `last check ${ageText(now - lastSuccessAt)}`,
    token: tokenText(token, now),
    trouble: health.status === 'failing' ? healthText(health) : null,
  }
}

const DOWN_REASONS: Record<NonNullable<HealthDto['cause']>, { reason: string; tokenFix: boolean }> = {
  network: { reason: 'Apple could not be reached', tokenFix: false },
  'token-expired': { reason: 'The Apple token expired', tokenFix: true },
  'token-rejected': { reason: 'Apple rejected the token', tokenFix: true },
  'network-limited': { reason: 'Apple is limiting your network: a fresh token was refused too', tokenFix: false },
  unexpected: { reason: 'Apple returned an unexpected answer', tokenFix: false },
}

const TOKEN_STATUS_CAUSES: Partial<Record<TokenStatus, NonNullable<HealthDto['cause']>>> = {
  expired: 'token-expired',
  rejected: 'token-rejected',
}

export function downBanner(state: Pick<StateDto, 'health' | 'token'>) {
  if (!isDown(state)) return null
  const cause = state.health.cause ?? TOKEN_STATUS_CAUSES[state.token.status]
  const title = 'Monitoring is down'
  if (!cause) return { title, reason: 'Stock is not being checked.', tokenFix: false }
  const { reason, tokenFix } = DOWN_REASONS[cause]
  return { title, reason: `${reason}, so stock is not being checked.`, tokenFix }
}

export const formatTime = (ms: number) =>
  new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })

export type ModelGroup = {
  model: string
  storages: { capacity: string; colors: { part: PartNumber; colorName: string }[] }[]
}

export function buildCatalogTree(parts: CatalogPart[]): ModelGroup[] {
  const models: ModelGroup[] = []
  for (const p of parts) {
    let model = models.find((m) => m.model === p.modelName)
    if (!model) models.push((model = { model: p.modelName, storages: [] }))
    let storage = model.storages.find((s) => s.capacity === p.capacity)
    if (!storage) model.storages.push((storage = { capacity: p.capacity, colors: [] }))
    storage.colors.push({ part: p.part, colorName: p.colorName })
  }
  return models
}

export function partsToWatch(selected: ReadonlySet<PartNumber>, watched: { part: PartNumber }[]): PartNumber[] {
  const already = new Set(watched.map((w) => w.part))
  return [...selected].filter((p) => !already.has(p))
}

const LOOPBACK_HOST = /^(localhost|\[::1\]|127\.\d+\.\d+\.\d+)$/

export function lanUrls(urls: string[]): string[] {
  return urls.filter((u) => !LOOPBACK_HOST.test(new URL(u).hostname))
}

type LanStatus = 'off' | 'live' | 'pending-on' | 'pending-off'

export function lanStatus({ enabled, restartRequired }: Pick<StateDto['lan'], 'enabled' | 'restartRequired'>): LanStatus {
  if (restartRequired) return enabled ? 'pending-on' : 'pending-off'
  return enabled ? 'live' : 'off'
}

export function timeLeft(expiresAt: number, now: number): string {
  const minutes = Math.floor((expiresAt - now) / 60_000)
  if (expiresAt <= now) return 'expired'
  if (minutes < 1) return 'under 1 min left'
  if (minutes < 60) return `${minutes} min left`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min left`
}

const TOKEN_REASONS: Record<string, string> = {
  'missing-cookie': 'the cURL has no Apple cookies',
  'missing-user-agent': 'the cURL has no User-Agent header',
  malformed: 'the cookies are not in the expected format',
  expired: 'the cURL is already expired. Copy a fresh one',
  'too-far-ahead': 'the cookie expiry is implausibly far ahead',
}

const ERRORS: Record<string, string> = {
  'invalid-json': 'The request was not valid JSON.',
  'forbidden-host': 'The server refused this address.',
  'forbidden-origin': 'The server refused this origin.',
  'json-required': 'The request must be JSON.',
  'loopback-only': 'This can only be changed from the Mac running the monitor.',
  'catalog-unavailable': 'The product catalog is not loaded yet. Try again in a minute.',
  network: 'Could not reach Apple. Try again.',
  unexpected: 'Apple returned an unexpected answer. Try again.',
  'invalid-zip': 'That is not a valid zip.',
  'no-stores': 'No Apple Stores found for that zip.',
  'unknown-store': 'That store is not in the list.',
  'unknown-part': 'That configuration is not in the catalog.',
  'unknown-watch': 'That watch no longer exists.',
  'invalid-interval': 'The interval must be a whole number of seconds from 30 to 3600.',
  'not-configured': 'Telegram is not configured. Set the bot token and chat id in .env.',
  internal: 'The server hit an error. Try again.',
}

export function errorMessage({ error, fields, reason, tracked, adding }: ApiErrorBody): string {
  if (error === 'parts-cap') return `Adds ${adding} part${adding === 1 ? '' : 's'}, which would make ${tracked} / 20.`
  if (error === 'invalid-request') return `Invalid value: ${(fields ?? []).join(', ') || 'request'}.`
  if (error === 'token-rejected') {
    return `Token rejected: ${(reason && TOKEN_REASONS[reason]) ?? reason ?? 'unknown reason'}.`
  }
  return ERRORS[error] ?? `Something went wrong (${error}).`
}

const TOKEN_LABELS: Record<TokenStatus, string> = {
  missing: 'Missing',
  untested: 'Untested',
  working: 'Working',
  rejected: 'Rejected',
  expired: 'Expired',
}

export const tokenLabel = (status: TokenStatus) => TOKEN_LABELS[status]

const CAUSES: Record<NonNullable<HealthDto['cause']>, string> = {
  network: 'Apple could not be reached',
  'token-expired': 'the Apple token expired',
  'token-rejected': 'Apple rejected the token',
  'network-limited': 'Apple is limiting your network: a fresh token was refused too',
  unexpected: 'Apple returned an unexpected answer',
}

export function healthText({ status, failures, cause }: HealthDto): string {
  if (status === 'healthy') return 'Checks are working'
  const why = cause ? `: ${CAUSES[cause]}` : ''
  return status === 'down' ? `Monitoring is down${why}` : `Last check failed${why} (${failures} in a row)`
}

export function telegramErrorText({ kind, status, description }: TelegramError): string {
  if (kind === 'http') return `Telegram answered ${status ?? 'with an error'}${description ? `: ${description}` : ''}`
  return kind === 'timeout' ? 'Telegram timed out' : 'Telegram could not be reached'
}

export function formatClock(ms: number, now: number): string {
  const date = new Date(ms)
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}
