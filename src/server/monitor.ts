import type { CheckOutcome, Observation, PartNumber, StockEvent, StoreNumber, TelegramError } from '../shared/types'
import type { Apple } from './apple'
import type { Db } from './db'
import { diff, orderEvents, trackedPairs } from './domain'
import { stockMessage, type Telegram } from './telegram'

const SEND_GAP_MS = 1100
const DEADLINE_MARGIN_MS = 5000

type StoreMeta = { store: StoreNumber; name: string; distanceMi: number }

export type Snapshot = {
  observations: Observation[]
  stores: StoreMeta[]
  lastCheckAt: number | null
  lastSuccessAt: number | null
  telegramLastError: TelegramError | null
}

export type CheckResult = CheckOutcome | { skipped: true }

export type Monitor = {
  runCheck(options?: { deadline?: number }): Promise<CheckResult>
  reconcile(options?: { newlyWatched?: PartNumber[] }): void
  loadCatalog(): Promise<void>
  snapshot(): Snapshot
}

export function createMonitor(deps: {
  apple: Apple
  telegram: Telegram
  db: Db
  now: () => number
  sleep?: (ms: number) => Promise<void>
}): Monitor {
  const { apple, telegram, db, now } = deps
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const state: Snapshot = {
    observations: [],
    stores: [],
    lastCheckAt: null,
    lastSuccessAt: null,
    telegramLastError: null,
  }

  const currentTracked = () => trackedPairs(db.listWatches(), db.listParts(), db.listStores())
  const isTracked = (pair: { part: PartNumber; store: StoreNumber }) =>
    currentTracked().some((t) => t.part === pair.part && t.store === pair.store)

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

  return {
    loadCatalog,

    async runCheck({ deadline = Infinity } = {}) {
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
    },

    reconcile({ newlyWatched = [] } = {}) {
      db.transaction(() => {
        newlyWatched.forEach((part) => db.deleteAlertedForPart(part))
        db.pruneAlerted(currentTracked())
      })
    },

    snapshot: () => ({ ...state }),
  }
}
