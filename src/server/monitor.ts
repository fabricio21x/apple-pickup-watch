import type {
  CheckOutcome,
  Observation,
  PartNumber,
  StockEvent,
  StoreNumber,
  TelegramError,
  TokenStatus,
  TrackedPair,
} from '../shared/types'
import type { Apple, AppleToken } from './apple'
import type { Db, Health } from './db'
import { diff, jitterMs, nextHealth, orderEvents, trackedPairs, type FailureCause, type HealthResult } from './domain'
import {
  healthMessage,
  startedMessage,
  stockMessage,
  tokenWarningMessage,
  type OutgoingMessage,
  type Telegram,
} from './telegram'

const SEND_GAP_MS = 1100
const DEADLINE_MARGIN_MS = 5000
const MIN_INTERVAL_SEC = 30
const MAX_INTERVAL_SEC = 3600
const EXPIRY_WARNING_MS = 15 * 60_000

type TokenOutcome = Extract<TokenStatus, 'working' | 'rejected' | 'expired'>
const TOKEN_FAILURE: Partial<Record<FailureCause, TokenOutcome>> = {
  'token-rejected': 'rejected',
  'token-expired': 'expired',
}
const tokenKey = (token: AppleToken) => `${token.dssid2}|${token.shldBtCk}`

type StoreMeta = { store: StoreNumber; name: string; distanceMi: number }

export type Snapshot = {
  observations: Observation[]
  stores: StoreMeta[]
  lastCheckAt: number | null
  lastSuccessAt: number | null
  nextStartAt: number | null
  telegramLastError: TelegramError | null
  token: { status: TokenStatus; expiresAt: number | null }
  health: Health
}

export type CheckResult = CheckOutcome | { skipped: true }

export type Monitor = {
  runCheck(options?: { deadline?: number }): Promise<CheckResult>
  reconcile(options?: { newlyWatched?: PartNumber[] }): void
  loadCatalog(): Promise<void>
  snapshot(): Snapshot
  start(): void
  stop(): void
  setInterval(sec: number): void
}

export function createMonitor(deps: {
  apple: Apple
  telegram: Telegram
  db: Db
  now: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}): Monitor {
  const { apple, telegram, db, now, random } = deps
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const state: Omit<Snapshot, 'token' | 'health'> = {
    observations: [],
    stores: [],
    lastCheckAt: null,
    lastSuccessAt: null,
    nextStartAt: null,
    telegramLastError: null,
  }
  let running = false
  let inFlight = false
  let cycleStartedAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let tokenOutcome: { key: string; status: TokenOutcome } | null = null

  const currentTracked = () => trackedPairs(db.listWatches(), db.listParts(), db.listStores())
  const isTracked = (pair: TrackedPair) =>
    currentTracked().some((t) => t.part === pair.part && t.store === pair.store && t.role === pair.role)

  async function loadCatalog() {
    const result = await apple.fetchCatalog()
    if (result.ok) db.upsertParts(result.value)
  }

  async function sendPass(events: StockEvent[], stores: StoreMeta[], deadline: number) {
    const parts = new Map(db.listParts().map((p) => [p.part, p]))
    const storeMeta = new Map(stores.map((s) => [s.store, s]))
    const cutoff = deadline - DEADLINE_MARGIN_MS
    let lastSentAt: number | null = null
    let firstWatchedIn = true

    for (const event of events) {
      const part = parts.get(event.pair.part)
      const store = storeMeta.get(event.pair.store)
      if (!part || !store || !isTracked(event.pair)) continue

      const isWatchedIn = event.kind === 'in' && event.pair.role === 'watched'
      const exempt = firstWatchedIn && isWatchedIn
      if (isWatchedIn) firstWatchedIn = false

      const wait = lastSentAt === null ? 0 : Math.max(0, lastSentAt + SEND_GAP_MS - now())
      if (!exempt && now() + wait > cutoff) return
      if (wait > 0) await sleep(wait)

      const message = stockMessage(event, part, store)
      let result = await telegram.sendMessage(message)
      if (!result.ok && result.retryAfterSec !== undefined && now() + result.retryAfterSec * 1000 <= cutoff) {
        await sleep(result.retryAfterSec * 1000)
        result = await telegram.sendMessage(message)
      }
      lastSentAt = now()
      if (!result.ok) {
        state.telegramLastError = result.error
        return
      }
      state.telegramLastError = null

      db.transaction(() => {
        if (!isTracked(event.pair)) return
        if (event.kind === 'in') db.insertAlerted(event.pair)
        else db.deleteAlerted(event.pair)
      })
    }
  }

  async function notify(message: OutgoingMessage): Promise<boolean> {
    const result = await telegram.sendMessage(message)
    state.telegramLastError = result.ok ? null : result.error
    return result.ok
  }

  async function recordHealth(result: HealthResult, expiresAt: number) {
    const { state: next, send } = nextHealth(db.getHealth(), result, { now: now(), expiresAt })
    const health = { ...next, cause: result.ok ? null : result.cause }
    db.setHealth(health)
    if (send && (await notify(healthMessage(send)))) db.setHealth({ ...health, downAnnounced: send.kind === 'down' })
  }

  async function warnIfExpiring() {
    const { token, tokenWarned } = db.getSettings()
    if (!token || tokenWarned) return
    const left = token.expiresAt - now()
    if (left <= 0 || left > EXPIRY_WARNING_MS) return
    const accepted = await notify(tokenWarningMessage(token.expiresAt))
    if (accepted && db.getSettings().token?.shldBtCk === token.shldBtCk) db.setTokenWarned(true)
  }

  function tokenState(): Snapshot['token'] {
    const { token } = db.getSettings()
    if (!token) return { status: 'missing', expiresAt: null }
    if (now() > token.expiresAt) return { status: 'expired', expiresAt: token.expiresAt }
    const known = tokenOutcome?.key === tokenKey(token) ? tokenOutcome.status : 'untested'
    return { status: known, expiresAt: token.expiresAt }
  }

  async function check({ deadline = Infinity }: { deadline?: number }): Promise<CheckResult> {
    if (db.listParts().length === 0) await loadCatalog()

    const { zip, token } = db.getSettings()
    const tracked = currentTracked()
    if (!token || !zip || tracked.length === 0) return { skipped: true }

    const partsWith = (role: 'watched' | 'other') => [
      ...new Set(tracked.filter((t) => t.role === role).map((t) => t.part)),
    ]
    const outcome = await apple.check({
      zip,
      token,
      watchedParts: partsWith('watched'),
      otherParts: partsWith('other'),
      enabledStores: [...new Set(tracked.map((t) => t.store))],
    })

    state.lastCheckAt = now()
    const tokenStatus = outcome.ok ? 'working' : TOKEN_FAILURE[outcome.cause]
    if (tokenStatus) tokenOutcome = { key: tokenKey(token), status: tokenStatus }
    if (!outcome.ok) {
      await recordHealth(outcome, token.expiresAt)
      return outcome
    }

    state.lastSuccessAt = state.lastCheckAt
    state.observations = outcome.observations
    state.stores = outcome.stores

    const events = orderEvents(diff(currentTracked(), outcome.observations, db.listAlerted()))
    await sendPass(events, outcome.stores, deadline)
    await recordHealth(outcome, token.expiresAt)
    return outcome
  }

  async function runCheck(options: { deadline?: number } = {}): Promise<CheckResult> {
    const result = await check(options)
    await warnIfExpiring()
    return result
  }

  function arm() {
    timer = setTimeout(cycle, Math.max(0, (state.nextStartAt ?? 0) - now()))
  }

  async function cycle() {
    if (inFlight) return
    try {
      inFlight = true
      cycleStartedAt = now()
      state.nextStartAt = cycleStartedAt + jitterMs(db.getSettings().intervalSec, random)
      await runCheck({ deadline: state.nextStartAt })
    } finally {
      inFlight = false
      if (running) arm()
      else state.nextStartAt = null
    }
  }

  return {
    loadCatalog,
    runCheck,

    reconcile({ newlyWatched = [] } = {}) {
      db.transaction(() => {
        newlyWatched.forEach((part) => db.deleteAlertedForPart(part))
        db.pruneAlerted(currentTracked())
      })
    },

    snapshot: () => ({ ...state, token: tokenState(), health: db.getHealth() }),

    start() {
      if (running) return
      running = true
      void notify(startedMessage())
      void cycle()
    },

    stop() {
      running = false
      clearTimeout(timer)
      if (!inFlight) state.nextStartAt = null
    },

    setInterval(sec) {
      if (!Number.isInteger(sec) || sec < MIN_INTERVAL_SEC || sec > MAX_INTERVAL_SEC) {
        throw new RangeError(`interval must be a whole number of seconds from ${MIN_INTERVAL_SEC} to ${MAX_INTERVAL_SEC}`)
      }
      db.setIntervalSec(sec)
      if (!running) return
      if (inFlight) {
        state.nextStartAt = cycleStartedAt + jitterMs(sec, random)
      } else {
        clearTimeout(timer)
        state.nextStartAt = now() + jitterMs(sec, random)
        arm()
      }
    },
  }
}
