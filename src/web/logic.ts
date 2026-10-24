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

export type StockRow = {
  part: PartNumber
  colorName: string
  role: TrackedPair['role']
  store: StoreDto
  badge: GridCell['badge']
  buyUrl: string
}

export type StockBlock = { model: string; capacity: string; rows: StockRow[] }

export const isInStock = (badge: GridCell['badge']) => badge !== 'Unavailable' && badge !== 'Not checked'

const stockRank = (badge: GridCell['badge']) => (isInStock(badge) ? 0 : badge === 'Unavailable' ? 1 : 2)

export function stockBoard({ parts, stores, watches, partsCount }: StateDto): StockBlock[] {
  const storeById = new Map(stores.map((s) => [s.store, s]))
  const enabled = stores.filter((s) => s.enabled)
  const watchedParts = new Set(watches.map((w) => w.part))
  const tracked = new Map<PartNumber, { role: TrackedPair['role']; cells: Map<string, GridCell['badge']> }>()
  for (const w of watches) {
    for (const c of w.cells) {
      const role: TrackedPair['role'] = c.part === w.part ? 'watched' : 'other'
      if (role === 'other' && watchedParts.has(c.part)) continue
      let entry = tracked.get(c.part)
      if (!entry) tracked.set(c.part, (entry = { role, cells: new Map() }))
      entry.cells.set(c.store, c.badge)
    }
  }
  const unchecked = new Set(partsCount.unchecked)
  const blocks: StockBlock[] = []
  for (const p of parts) {
    const entry =
      tracked.get(p.part) ??
      (unchecked.has(p.part)
        ? { role: 'other' as const, cells: new Map(enabled.map((s) => [s.store, 'Not checked' as const])) }
        : undefined)
    if (!entry) continue
    const rows = [...entry.cells].map(
      ([store, badge]): StockRow => ({
        part: p.part,
        colorName: p.colorName,
        role: entry.role,
        store: storeById.get(store)!,
        badge,
        buyUrl: p.buyUrl,
      }),
    )
    let block = blocks.find((b) => b.model === p.modelName && b.capacity === p.capacity)
    if (!block) blocks.push((block = { model: p.modelName, capacity: p.capacity, rows: [] }))
    block.rows.push(...rows)
  }
  for (const b of blocks) b.rows.sort((a, c) => stockRank(a.badge) - stockRank(c.badge))
  const hasStock = (b: StockBlock) => b.rows.some((r) => isInStock(r.badge))
  return [...blocks.filter(hasStock), ...blocks.filter((b) => !hasStock(b))]
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

export type LanStatus = 'off' | 'live' | 'pending-on' | 'pending-off'

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
