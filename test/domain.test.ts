import { describe, expect, it } from 'vitest'
import type { CatalogPart, Observation, StockEvent, TrackedPair } from '../src/shared/types'
import {
  diff,
  jitterMs,
  nextHealth,
  orderEvents,
  pickupFrom,
  siblingsOf,
  trackedPairs,
} from '../src/server/domain'

const part = (p: string, modelName: string, capacity: string, colorName: string): CatalogPart => ({
  part: p,
  modelName,
  capacity,
  colorName,
  title: `${modelName} ${capacity} ${colorName}`,
  buyUrl: 'https://www.apple.com/shop/buy-iphone/iphone-18-pro',
})

const catalog: CatalogPart[] = [
  part('PRO-256-BLK', 'iPhone 18 Pro', '256gb', 'Black'),
  part('PRO-256-BLU', 'iPhone 18 Pro', '256gb', 'Blue'),
  part('PRO-256-ORG', 'iPhone 18 Pro', '256gb', 'Orange'),
  part('PRO-512-BLK', 'iPhone 18 Pro', '512gb', 'Black'),
  part('MAX-256-BLK', 'iPhone 18 Pro Max', '256gb', 'Black'),
  part('DUO-256-BLK', 'iPhone Duo', '256gb', 'Black'),
]

const stores = [
  { store: 'R1', enabled: true },
  { store: 'R2', enabled: true },
  { store: 'R3', enabled: false },
]

const sortPairs = (pairs: TrackedPair[]) =>
  [...pairs].sort((a, b) => `${a.part}/${a.store}`.localeCompare(`${b.part}/${b.store}`))

describe('siblingsOf', () => {
  it('returns the other colors of the same model and capacity only', () => {
    expect(
      siblingsOf(catalog, 'PRO-256-BLK')
        .map((p) => p.part)
        .sort(),
    ).toEqual(['PRO-256-BLU', 'PRO-256-ORG'])
  })
})

describe('trackedPairs', () => {
  it('tracks a watch as watched at every enabled store and never at a disabled one', () => {
    const pairs = trackedPairs([{ part: 'DUO-256-BLK', otherColors: false }], catalog, stores)
    expect(sortPairs(pairs)).toEqual([
      { part: 'DUO-256-BLK', store: 'R1', role: 'watched' },
      { part: 'DUO-256-BLK', store: 'R2', role: 'watched' },
    ])
  })

  it('adds same-model same-capacity siblings as other with the watched color when the switch is on', () => {
    const pairs = trackedPairs([{ part: 'PRO-256-BLK', otherColors: true }], catalog, stores)
    expect(sortPairs(pairs)).toEqual([
      { part: 'PRO-256-BLK', store: 'R1', role: 'watched' },
      { part: 'PRO-256-BLK', store: 'R2', role: 'watched' },
      { part: 'PRO-256-BLU', store: 'R1', role: 'other', relatedColors: ['Black'] },
      { part: 'PRO-256-BLU', store: 'R2', role: 'other', relatedColors: ['Black'] },
      { part: 'PRO-256-ORG', store: 'R1', role: 'other', relatedColors: ['Black'] },
      { part: 'PRO-256-ORG', store: 'R2', role: 'other', relatedColors: ['Black'] },
    ])
  })

  it('adds no other-color pairs when the switch is off', () => {
    const pairs = trackedPairs([{ part: 'PRO-256-BLK', otherColors: false }], catalog, stores)
    expect(pairs.every((p) => p.role === 'watched')).toBe(true)
  })

  it('never treats a watched part as other, and lists both watched colors on a shared sibling', () => {
    const pairs = trackedPairs(
      [
        { part: 'PRO-256-BLK', otherColors: true },
        { part: 'PRO-256-BLU', otherColors: true },
      ],
      catalog,
      [{ store: 'R1', enabled: true }],
    )
    expect(sortPairs(pairs)).toEqual([
      { part: 'PRO-256-BLK', store: 'R1', role: 'watched' },
      { part: 'PRO-256-BLU', store: 'R1', role: 'watched' },
      { part: 'PRO-256-ORG', store: 'R1', role: 'other', relatedColors: ['Black', 'Blue'] },
    ])
  })

  it('lists only the watches with the switch on as the related colors of a sibling', () => {
    const pairs = trackedPairs(
      [
        { part: 'PRO-256-BLK', otherColors: true },
        { part: 'PRO-256-BLU', otherColors: false },
      ],
      catalog,
      [{ store: 'R1', enabled: true }],
    )
    expect(pairs).toContainEqual({ part: 'PRO-256-ORG', store: 'R1', role: 'other', relatedColors: ['Black'] })
  })

  it('does not mix capacities or models into the siblings', () => {
    const pairs = trackedPairs([{ part: 'PRO-256-BLK', otherColors: true }], catalog, [
      { store: 'R1', enabled: true },
    ])
    const parts = pairs.map((p) => p.part)
    expect(parts).not.toContain('PRO-512-BLK')
    expect(parts).not.toContain('MAX-256-BLK')
  })

  it('tracks nothing when every store is disabled', () => {
    expect(
      trackedPairs([{ part: 'PRO-256-BLK', otherColors: true }], catalog, [{ store: 'R1', enabled: false }]),
    ).toEqual([])
  })
})

describe('pickupFrom', () => {
  it('treats available with a Today quote as in, labelled Today', () => {
    expect(pickupFrom('available', 'Available Today')).toEqual({ kind: 'in', label: 'Today' })
  })

  it('treats available with a Tomorrow quote as in, labelled Tomorrow', () => {
    expect(pickupFrom('available', 'Available Tomorrow')).toEqual({ kind: 'in', label: 'Tomorrow' })
  })

  it('labels available with any other quote by the quote itself', () => {
    expect(pickupFrom('available', 'Available Oct 28')).toEqual({ kind: 'in', label: 'Available Oct 28' })
  })

  it.each(['unavailable', 'default', 'ineligible', 'something-new', ''])('treats %j as not in stock', (value) => {
    expect(pickupFrom(value, 'Available Today')).toEqual({ kind: 'out' })
  })
})

describe('diff', () => {
  const watched = (p: string, s: string): TrackedPair => ({ part: p, store: s, role: 'watched' })
  const inStock = (p: string, s: string, label = 'Today'): Observation => ({
    part: p,
    store: s,
    pickup: { kind: 'in', label },
  })
  const outOfStock = (p: string, s: string): Observation => ({ part: p, store: s, pickup: { kind: 'out' } })

  it('emits an in event with the label for a tracked pair in stock that was not alerted', () => {
    expect(diff([watched('A', 'R1')], [inStock('A', 'R1', 'Tomorrow')], [])).toEqual([
      { kind: 'in', pair: watched('A', 'R1'), label: 'Tomorrow' },
    ])
  })

  it('emits an out event for an alerted tracked pair observed out', () => {
    expect(diff([watched('A', 'R1')], [outOfStock('A', 'R1')], [{ part: 'A', store: 'R1' }])).toEqual([
      { kind: 'out', pair: watched('A', 'R1') },
    ])
  })

  it('emits nothing while the state is unchanged', () => {
    const tracked = [watched('A', 'R1'), watched('B', 'R1')]
    const observations = [inStock('A', 'R1'), outOfStock('B', 'R1')]
    expect(diff(tracked, observations, [{ part: 'A', store: 'R1' }])).toEqual([])
  })

  it('emits nothing when only the label changes while in stock', () => {
    expect(diff([watched('A', 'R1')], [inStock('A', 'R1', 'Today')], [{ part: 'A', store: 'R1' }])).toEqual([])
  })

  it('keeps the state of a pair with no observation', () => {
    expect(diff([watched('A', 'R1')], [], [{ part: 'A', store: 'R1' }])).toEqual([])
    expect(diff([watched('A', 'R1')], [inStock('A', 'R2')], [])).toEqual([])
  })

  it('ignores alerted rows and observations for pairs that are not tracked', () => {
    expect(
      diff([watched('A', 'R1')], [inStock('B', 'R1'), outOfStock('C', 'R1')], [{ part: 'C', store: 'R1' }]),
    ).toEqual([])
  })

  it('carries the other role and related colors on a sibling event', () => {
    const pair: TrackedPair = { part: 'B', store: 'R1', role: 'other', relatedColors: ['Black'] }
    expect(diff([pair], [inStock('B', 'R1')], [])).toEqual([{ kind: 'in', pair, label: 'Today' }])
  })
})

describe('orderEvents', () => {
  const watched = (p: string): TrackedPair => ({ part: p, store: 'R1', role: 'watched' })
  const other = (p: string): TrackedPair => ({ part: p, store: 'R1', role: 'other', relatedColors: ['Black'] })

  it('sends watched in, other in, watched out, then other out, keeping order within a group', () => {
    const events: StockEvent[] = [
      { kind: 'out', pair: other('o-out-1') },
      { kind: 'out', pair: watched('w-out-1') },
      { kind: 'in', pair: other('o-in-1'), label: 'Today' },
      { kind: 'in', pair: watched('w-in-1'), label: 'Today' },
      { kind: 'in', pair: watched('w-in-2'), label: 'Today' },
      { kind: 'out', pair: other('o-out-2') },
    ]
    expect(orderEvents(events).map((e) => e.pair.part)).toEqual([
      'w-in-1',
      'w-in-2',
      'o-in-1',
      'w-out-1',
      'o-out-1',
      'o-out-2',
    ])
  })
})

describe('nextHealth', () => {
  const fail = (cause: 'network' | 'token-expired' | 'token-rejected' | 'unexpected') => ({
    ok: false as const,
    cause,
  })
  const ok = { ok: true as const }
  const ctx = { now: 1_000, expiresAt: null }
  const fresh = { failures: 0, downAnnounced: false }

  it('counts the first two failures without sending anything', () => {
    const first = nextHealth(fresh, fail('network'), ctx)
    expect(first).toEqual({ state: { failures: 1, downAnnounced: false }, send: null })
    expect(nextHealth(first.state, fail('network'), ctx)).toEqual({
      state: { failures: 2, downAnnounced: false },
      send: null,
    })
  })

  it('is due for down, naming the cause, on the third consecutive failure', () => {
    expect(nextHealth({ failures: 2, downAnnounced: false }, fail('unexpected'), ctx)).toEqual({
      state: { failures: 3, downAnnounced: false },
      send: { kind: 'down', cause: 'unexpected' },
    })
  })

  it('stays due for down on later failures until the caller marks it announced', () => {
    expect(nextHealth({ failures: 3, downAnnounced: false }, fail('network'), ctx).send).toEqual({
      kind: 'down',
      cause: 'network',
    })
  })

  it('sends nothing more once down is announced', () => {
    expect(nextHealth({ failures: 5, downAnnounced: true }, fail('network'), ctx)).toEqual({
      state: { failures: 6, downAnnounced: true },
      send: null,
    })
  })

  it('is due for down at once on token-expired when now is past a known expiry', () => {
    expect(nextHealth(fresh, fail('token-expired'), { now: 2_000, expiresAt: 1_500 }).send).toEqual({
      kind: 'down',
      cause: 'token-expired',
    })
  })

  it('waits for the third failure on token-expired when the expiry is unknown or not yet passed', () => {
    expect(nextHealth(fresh, fail('token-expired'), { now: 2_000, expiresAt: null }).send).toBeNull()
    expect(nextHealth(fresh, fail('token-expired'), { now: 1_000, expiresAt: 1_500 }).send).toBeNull()
  })

  it('waits for the third failure on token-rejected even when the expiry has passed', () => {
    expect(nextHealth(fresh, fail('token-rejected'), { now: 2_000, expiresAt: 1_500 }).send).toBeNull()
  })

  it('clears failures on success and sends nothing when no down was announced', () => {
    expect(nextHealth({ failures: 2, downAnnounced: false }, ok, ctx)).toEqual({
      state: { failures: 0, downAnnounced: false },
      send: null,
    })
  })

  it('is due for back up on success after down was announced, leaving the flag for the caller', () => {
    expect(nextHealth({ failures: 4, downAnnounced: true }, ok, ctx)).toEqual({
      state: { failures: 0, downAnnounced: true },
      send: { kind: 'up' },
    })
  })
})

describe('jitterMs', () => {
  it('spans interval x 0.75 to x 1.25 in milliseconds', () => {
    expect(jitterMs(60, () => 0)).toBe(45_000)
    expect(jitterMs(60, () => 0.5)).toBe(60_000)
    expect(jitterMs(60, () => 1)).toBe(75_000)
  })

  it('scales with the interval at the range ends', () => {
    expect(jitterMs(30, () => 0)).toBe(22_500)
    expect(jitterMs(3600, () => 1)).toBe(4_500_000)
  })

  it('keeps the default interval within 45 to 75 s with the real random source', () => {
    for (let i = 0; i < 1000; i++) {
      const ms = jitterMs(60)
      expect(ms).toBeGreaterThanOrEqual(45_000)
      expect(ms).toBeLessThanOrEqual(75_000)
    }
  })
})
