import type {
  CatalogPart,
  CheckOutcome,
  Observation,
  PartNumber,
  Pickup,
  StockEvent,
  StoreNumber,
  TrackedPair,
} from '../shared/types'

export type Watch = { part: PartNumber; otherColors: boolean }
export type StoreToggle = { store: StoreNumber; enabled: boolean }
export type AlertedRow = { part: PartNumber; store: StoreNumber }

export type HealthState = { failures: number; downAnnounced: boolean }
export type FailureCause = Extract<CheckOutcome, { ok: false }>['cause']
export type HealthResult = { ok: true } | { ok: false; cause: FailureCause }
export type HealthMessage = { kind: 'down'; cause: FailureCause } | { kind: 'up' }

const DOWN_AFTER_FAILURES = 3

const pairKey = (p: { part: PartNumber; store: StoreNumber }) => `${p.part}/${p.store}`

export function siblingsOf(catalog: CatalogPart[], part: PartNumber): CatalogPart[] {
  const own = catalog.find((c) => c.part === part)
  if (!own) return []
  return catalog.filter(
    (c) => c.part !== part && c.modelName === own.modelName && c.capacity === own.capacity,
  )
}

export function trackedPairs(watches: Watch[], catalog: CatalogPart[], stores: StoreToggle[]): TrackedPair[] {
  const enabled = stores.filter((s) => s.enabled).map((s) => s.store)
  const watchedParts = new Set(watches.map((w) => w.part))

  const watched = watches.flatMap((w) => enabled.map((store): TrackedPair => ({ part: w.part, store, role: 'watched' })))

  const relatedBySibling = new Map<PartNumber, string[]>()
  for (const w of watches.filter((w) => w.otherColors)) {
    const color = catalog.find((c) => c.part === w.part)?.colorName
    if (color === undefined) continue
    for (const sibling of siblingsOf(catalog, w.part)) {
      if (watchedParts.has(sibling.part)) continue
      relatedBySibling.set(sibling.part, [...(relatedBySibling.get(sibling.part) ?? []), color])
    }
  }
  const other = [...relatedBySibling].flatMap(([part, relatedColors]) =>
    enabled.map((store): TrackedPair => ({ part, store, role: 'other', relatedColors })),
  )

  return [...watched, ...other]
}

export function pickupFrom(pickupDisplay: string, pickupSearchQuote: string): Pickup {
  if (pickupDisplay !== 'available') return { kind: 'out' }
  const day = ['Today', 'Tomorrow'].find((word) => pickupSearchQuote.includes(word))
  return { kind: 'in', label: day ?? pickupSearchQuote }
}

export function diff(tracked: TrackedPair[], observations: Observation[], alerted: AlertedRow[]): StockEvent[] {
  const observed = new Map(observations.map((o) => [pairKey(o), o.pickup]))
  const alertedKeys = new Set(alerted.map(pairKey))
  const events: StockEvent[] = []
  for (const pair of tracked) {
    const pickup = observed.get(pairKey(pair))
    if (!pickup) continue
    const wasAlerted = alertedKeys.has(pairKey(pair))
    if (pickup.kind === 'in' && !wasAlerted) events.push({ kind: 'in', pair, label: pickup.label })
    if (pickup.kind === 'out' && wasAlerted) events.push({ kind: 'out', pair })
  }
  return events
}

const eventRank = (e: StockEvent) => (e.kind === 'in' ? 0 : 2) + (e.pair.role === 'watched' ? 0 : 1)

export function orderEvents(events: StockEvent[]): StockEvent[] {
  return [...events].sort((a, b) => eventRank(a) - eventRank(b))
}

export function nextHealth(
  state: HealthState,
  result: HealthResult,
  ctx: { now: number; expiresAt: number | null },
): { state: HealthState; send: HealthMessage | null } {
  if (result.ok) {
    return {
      state: { failures: 0, downAnnounced: state.downAnnounced },
      send: state.downAnnounced ? { kind: 'up' } : null,
    }
  }
  const failures = state.failures + 1
  const knownExpiry = result.cause === 'token-expired' && ctx.expiresAt !== null && ctx.now > ctx.expiresAt
  const due = !state.downAnnounced && (failures >= DOWN_AFTER_FAILURES || knownExpiry)
  return {
    state: { failures, downAnnounced: state.downAnnounced },
    send: due ? { kind: 'down', cause: result.cause } : null,
  }
}

export function jitterMs(intervalSec: number, random: () => number = Math.random): number {
  return intervalSec * 1000 * (0.75 + 0.5 * random())
}
