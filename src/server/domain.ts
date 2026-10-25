import type {
  CatalogPart,
  CheckOutcome,
  Observation,
  PartNumber,
  Pickup,
  StockEvent,
  StockMessage,
  StoreNumber,
  TrackedPair,
} from '../shared/types'

export type Watch = { part: PartNumber; otherColors: boolean }
export type StoreToggle = { store: StoreNumber; enabled: boolean }
export type AlertedRow = { part: PartNumber; store: StoreNumber }

export type HealthState = { failures: number; downAnnounced: boolean }
export type FailureCause = Extract<CheckOutcome, { ok: false }>['cause']
export type HealthResult = { ok: true } | { ok: false; cause: FailureCause }
export type HealthMessage = { kind: 'down'; cause: FailureCause; slowedMin?: number } | { kind: 'up' }

const DOWN_AFTER_FAILURES = 3

const pairKey = (p: { part: PartNumber; store: StoreNumber }) => `${p.part}/${p.store}`

export function siblingsOf(catalog: CatalogPart[], part: PartNumber): CatalogPart[] {
  const own = catalog.find((c) => c.part === part)
  if (!own) return []
  return catalog.filter(
    (c) => c.part !== part && c.modelName === own.modelName && c.capacity === own.capacity,
  )
}

export const PARTS_CAP = 20

function relatedColorsBySibling(watches: Watch[], catalog: CatalogPart[]): Map<PartNumber, string[]> {
  const watchedParts = new Set(watches.map((w) => w.part))
  const relatedBySibling = new Map<PartNumber, string[]>()
  for (const w of watches.filter((w) => w.otherColors)) {
    const color = catalog.find((c) => c.part === w.part)?.colorName
    if (color === undefined) continue
    for (const sibling of siblingsOf(catalog, w.part)) {
      if (watchedParts.has(sibling.part)) continue
      relatedBySibling.set(sibling.part, [...(relatedBySibling.get(sibling.part) ?? []), color])
    }
  }
  return relatedBySibling
}

export function trackedParts(watches: Watch[], catalog: CatalogPart[]): PartNumber[] {
  const others = relatedColorsBySibling(watches, catalog)
  return [...watches.map((w) => w.part), ...catalog.map((c) => c.part).filter((part) => others.has(part))]
}

export function trackedPairs(watches: Watch[], catalog: CatalogPart[], stores: StoreToggle[]): TrackedPair[] {
  const enabled = stores.filter((s) => s.enabled).map((s) => s.store)

  const watched = watches.flatMap((w) => enabled.map((store): TrackedPair => ({ part: w.part, store, role: 'watched' })))
  const other = [...relatedColorsBySibling(watches, catalog)].flatMap(([part, relatedColors]) =>
    enabled.map((store): TrackedPair => ({ part, store, role: 'other', relatedColors })),
  )

  return [...watched, ...other]
}

export function pickupFrom(pickupDisplay: string, pickupSearchQuote: string): Pickup {
  if (pickupDisplay !== 'available') return { kind: 'out' }
  const quote = pickupSearchQuote.toLowerCase()
  const day = ['Today', 'Tomorrow'].find((word) => quote.includes(word.toLowerCase()))
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

const groupKey = (c: { modelName: string; capacity: string }) => `${c.modelName}|${c.capacity}`

type StoreInfo = Extract<CheckOutcome, { ok: true }>['stores'][number]

export function stockMessages(
  events: StockEvent[],
  tracked: TrackedPair[],
  observations: Observation[],
  alerted: AlertedRow[],
  catalog: CatalogPart[],
  stores: StoreInfo[],
): StockMessage[] {
  const parts = new Map(catalog.map((c, order) => [c.part, { ...c, order }]))
  const groupOrder = new Map<string, number>()
  catalog.forEach((c, order) => groupOrder.set(groupKey(c), groupOrder.get(groupKey(c)) ?? order))
  const storeInfo = new Map(stores.map((s) => [s.store, s]))
  const observed = new Map(observations.map((o) => [pairKey(o), o.pickup]))
  const alertedKeys = new Set(alerted.map(pairKey))
  const newKeys = new Set(events.filter((e) => e.kind === 'in').map((e) => pairKey(e.pair)))

  const groups = new Map<string, { group: StockMessage['group']; events: StockEvent[] }>()
  for (const event of events) {
    const part = parts.get(event.pair.part)
    if (!part) continue
    const entry = groups.get(groupKey(part)) ?? {
      group: { modelName: part.modelName, capacity: part.capacity },
      events: [],
    }
    entry.events.push(event)
    groups.set(groupKey(part), entry)
  }

  function colorsOf(key: string): StockMessage['colors'] {
    const byPart = new Map<PartNumber, { order: number; color: StockMessage['colors'][number] }>()
    for (const pair of tracked) {
      const part = parts.get(pair.part)
      const store = storeInfo.get(pair.store)
      if (!part || !store || groupKey(part) !== key) continue
      const pickup = observed.get(pairKey(pair))
      const unseen = alertedKeys.has(pairKey(pair)) ? 'not checked' : null
      const label = pickup ? (pickup.kind === 'in' ? pickup.label : null) : unseen
      if (label === null) continue
      const entry = byPart.get(pair.part) ?? {
        order: part.order,
        color: { colorName: part.colorName, role: pair.role, buyUrl: part.buyUrl, stores: [] },
      }
      entry.color.stores.push({
        store: store.store,
        name: store.name,
        distanceMi: store.distanceMi,
        label,
        isNew: newKeys.has(pairKey(pair)),
      })
      byPart.set(pair.part, entry)
    }
    return [...byPart.values()]
      .sort((a, b) => Number(b.color.role === 'watched') - Number(a.color.role === 'watched') || a.order - b.order)
      .map(({ color }) => ({ ...color, stores: color.stores.sort((a, b) => a.distanceMi - b.distanceMi) }))
  }

  const rank = (groupEvents: StockEvent[]) => {
    if (groupEvents.some((e) => e.kind === 'in' && e.pair.role === 'watched')) return 0
    return groupEvents.some((e) => e.kind === 'in') ? 1 : 2
  }

  return [...groups]
    .sort(
      ([ka, a], [kb, b]) => rank(a.events) - rank(b.events) || (groupOrder.get(ka) ?? 0) - (groupOrder.get(kb) ?? 0),
    )
    .map(([key, { group, events: groupEvents }]) => ({
      group,
      sound: groupEvents.some((e) => e.kind === 'in'),
      colors: colorsOf(key),
      gone: groupEvents.flatMap((e) => {
        const part = parts.get(e.pair.part)
        const store = storeInfo.get(e.pair.store)
        return e.kind === 'out' && part && store ? [{ colorName: part.colorName, storeName: store.name }] : []
      }),
      commit: {
        insert: groupEvents.filter((e) => e.kind === 'in').map((e) => e.pair),
        delete: groupEvents.filter((e) => e.kind === 'out').map((e) => e.pair),
      },
    }))
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
