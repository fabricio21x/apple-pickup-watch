import type { CheckOutcome, Observation, PartNumber, StockEvent, StoreNumber, TelegramError, TrackedPair } from '../shared/types'
import type { Apple } from './apple'
import type { Db } from './db'
import { diff, jitterMs, orderEvents, trackedPairs } from './domain'
import { stockMessage, type Telegram } from './telegram'

const SEND_GAP_MS = 1100
const DEADLINE_MARGIN_MS = 5000
const MIN_INTERVAL_SEC = 30
const MAX_INTERVAL_SEC = 3600

type StoreMeta = { store: StoreNumber; name: string; distanceMi: number }

export type Snapshot = {
  observations: Observation[]
  stores: StoreMeta[]
  lastCheckAt: number | null
  lastSuccessAt: number | null
  nextStartAt: number | null
  telegramLastError: TelegramError | null
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

  const state: Snapshot = {
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

  async function runCheck({ deadline = Infinity }: { deadline?: number } = {}): Promise<CheckResult> {
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
    if (!outcome.ok) return outcome

    state.lastSuccessAt = state.lastCheckAt
    state.observations = outcome.observations
    state.stores = outcome.stores

    const events = orderEvents(diff(currentTracked(), outcome.observations, db.listAlerted()))
    await sendPass(events, outcome.stores, deadline)
    return outcome
  }

  function arm() {
    timer = setTimeout(cycle, Math.max(0, (state.nextStartAt ?? 0) - now()))
  }

  async function cycle() {
    if (inFlight) return
    inFlight = true
    cycleStartedAt = now()
    state.nextStartAt = cycleStartedAt + jitterMs(db.getSettings().intervalSec, random)
    try {
      await runCheck({ deadline: state.nextStartAt })
    } finally {
      inFlight = false
      if (running) arm()
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

    snapshot: () => ({ ...state }),

    start() {
      if (running) return
      running = true
      void cycle()
    },

    stop() {
      running = false
      clearTimeout(timer)
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
