import { describe, expect, it } from 'vitest'
import type { CatalogPart, Observation, StockEvent, StockMessage, TrackedPair } from '../src/shared/types'
import {
  diff,
  jitterMs,
  nextHealth,
  pickupFrom,
  siblingsOf,
  stockMessages,
  trackedPairs,
  trackedParts,
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

describe('trackedParts', () => {
  it('lists watched parts first, then other-color parts in catalog order', () => {
    const parts = trackedParts(
      [
        { part: 'PRO-256-ORG', otherColors: true },
        { part: 'DUO-256-BLK', otherColors: false },
      ],
      catalog,
    )
    expect(parts).toEqual(['PRO-256-ORG', 'DUO-256-BLK', 'PRO-256-BLK', 'PRO-256-BLU'])
  })

  it('counts a sibling of two watches once and never counts a watched part as other', () => {
    const parts = trackedParts(
      [
        { part: 'PRO-256-BLK', otherColors: true },
        { part: 'PRO-256-BLU', otherColors: true },
      ],
      catalog,
    )
    expect(parts).toEqual(['PRO-256-BLK', 'PRO-256-BLU', 'PRO-256-ORG'])
  })

  it('adds no other-color parts for a watch with the switch off', () => {
    expect(trackedParts([{ part: 'PRO-256-BLK', otherColors: false }], catalog)).toEqual(['PRO-256-BLK'])
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

  it.each(['available today', 'AVAILABLE TOMORROW'])('matches the day word in any case: %s', (quote) => {
    expect(pickupFrom('available', quote)).toEqual({ kind: 'in', label: quote.toLowerCase().includes('today') ? 'Today' : 'Tomorrow' })
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

describe('stockMessages', () => {
  const watched = (p: string, s: string): TrackedPair => ({ part: p, store: s, role: 'watched' })
  const other = (p: string, s: string): TrackedPair => ({ part: p, store: s, role: 'other', relatedColors: ['Black'] })
  const inEvent = (pair: TrackedPair, label = 'Today'): StockEvent => ({ kind: 'in', pair, label })
  const outEvent = (pair: TrackedPair): StockEvent => ({ kind: 'out', pair })
  const inStock = (p: string, s: string, label = 'Today'): Observation => ({ part: p, store: s, pickup: { kind: 'in', label } })
  const outOfStock = (p: string, s: string): Observation => ({ part: p, store: s, pickup: { kind: 'out' } })
  const alertedAt = (...keys: string[]) => keys.map((k) => ({ part: k.split('@')[0] ?? '', store: k.split('@')[1] ?? '' }))
  const storeMeta = [
    { store: 'R1', name: 'Store One', distanceMi: 0.5 },
    { store: 'R2', name: 'Store Two', distanceMi: 1.5 },
    { store: 'R3', name: 'Store Three', distanceMi: 3 },
  ]
  const build = (
    events: StockEvent[],
    tracked: TrackedPair[],
    observations: Observation[],
    alerted: { part: string; store: string }[] = [],
  ): StockMessage[] => stockMessages(events, tracked, observations, alerted, catalog, storeMeta)

  it('sends one message per model and storage with every color that came in, each store new, and sound', () => {
    const tracked = ['R1', 'R2', 'R3'].flatMap((s) => [watched('PRO-256-BLK', s), watched('PRO-256-BLU', s)])
    const observations = tracked.map((p) => inStock(p.part, p.store))

    const messages = build(tracked.map((p) => inEvent(p)), tracked, observations)

    expect(messages).toHaveLength(1)
    const [message] = messages
    expect(message?.group).toEqual({ modelName: 'iPhone 18 Pro', capacity: '256gb' })
    expect(message?.sound).toBe(true)
    expect(message?.colors.map((c) => c.colorName)).toEqual(['Black', 'Blue'])
    expect(message?.colors[0]?.stores).toEqual([
      { store: 'R1', name: 'Store One', distanceMi: 0.5, label: 'Today', isNew: true },
      { store: 'R2', name: 'Store Two', distanceMi: 1.5, label: 'Today', isNew: true },
      { store: 'R3', name: 'Store Three', distanceMi: 3, label: 'Today', isNew: true },
    ])
    expect(message?.colors[0]?.buyUrl).toBe('https://www.apple.com/shop/buy-iphone/iphone-18-pro')
    expect(message?.gone).toEqual([])
    expect(message?.commit.insert).toHaveLength(6)
    expect(message?.commit.delete).toEqual([])
  })

  it('lists every store still in stock with only the store that came in marked new', () => {
    const tracked = ['R1', 'R2', 'R3'].map((s) => watched('PRO-256-BLK', s))
    const observations = tracked.map((p) => inStock(p.part, p.store, p.store === 'R2' ? 'Tomorrow' : 'Today'))

    const [message] = build([inEvent(watched('PRO-256-BLK', 'R3'))], tracked, observations, alertedAt('PRO-256-BLK@R1', 'PRO-256-BLK@R2'))

    expect(message?.colors[0]?.stores.map((s) => [s.store, s.label, s.isNew])).toEqual([
      ['R1', 'Today', false],
      ['R2', 'Tomorrow', false],
      ['R3', 'Today', true],
    ])
    expect(message?.commit.insert).toEqual([watched('PRO-256-BLK', 'R3')])
  })

  it('sends a silent message with the stores left and the ones that went out when stores only go out', () => {
    const tracked = ['R1', 'R2'].map((s) => watched('PRO-256-BLK', s))
    const observations = [inStock('PRO-256-BLK', 'R1'), outOfStock('PRO-256-BLK', 'R2')]

    const [message] = build([outEvent(watched('PRO-256-BLK', 'R2'))], tracked, observations, alertedAt('PRO-256-BLK@R1', 'PRO-256-BLK@R2'))

    expect(message?.sound).toBe(false)
    expect(message?.colors.map((c) => [c.colorName, c.stores.map((s) => s.store)])).toEqual([['Black', ['R1']]])
    expect(message?.gone).toEqual([{ colorName: 'Black', storeName: 'Store Two' }])
    expect(message?.commit).toEqual({ insert: [], delete: [watched('PRO-256-BLK', 'R2')] })
  })

  it('has no colors, meaning sold out everywhere, when the last in-stock store goes out', () => {
    const tracked = [watched('PRO-256-BLK', 'R1')]

    const [message] = build([outEvent(tracked[0] as TrackedPair)], tracked, [outOfStock('PRO-256-BLK', 'R1')], alertedAt('PRO-256-BLK@R1'))

    expect(message?.colors).toEqual([])
    expect(message?.gone).toEqual([{ colorName: 'Black', storeName: 'Store One' }])
  })

  it('lists watched colors first, then the other colors, each in catalog order', () => {
    const tracked = [watched('PRO-256-ORG', 'R1'), other('PRO-256-BLK', 'R1'), watched('PRO-256-BLU', 'R1')]
    const observations = tracked.map((p) => inStock(p.part, p.store))

    const [message] = build([inEvent(tracked[1] as TrackedPair)], tracked, observations, alertedAt('PRO-256-ORG@R1', 'PRO-256-BLU@R1'))

    expect(message?.colors.map((c) => [c.colorName, c.role])).toEqual([
      ['Blue', 'watched'],
      ['Orange', 'watched'],
      ['Black', 'other'],
    ])
  })

  it('splits models and storages into separate messages', () => {
    const tracked = [watched('PRO-256-BLK', 'R1'), watched('PRO-512-BLK', 'R1'), watched('MAX-256-BLK', 'R1')]
    const observations = tracked.map((p) => inStock(p.part, p.store))

    const messages = build(tracked.map((p) => inEvent(p)), tracked, observations)

    expect(messages.map((m) => [m.group.modelName, m.group.capacity])).toEqual([
      ['iPhone 18 Pro', '256gb'],
      ['iPhone 18 Pro', '512gb'],
      ['iPhone 18 Pro Max', '256gb'],
    ])
  })

  it('orders groups with a watched in event, then only other-color in events, then out-only, ties in catalog order', () => {
    const tracked = [
      watched('PRO-256-BLK', 'R1'),
      other('PRO-512-BLK', 'R1'),
      watched('MAX-256-BLK', 'R1'),
      watched('DUO-256-BLK', 'R1'),
    ]
    const events = [
      outEvent(tracked[0] as TrackedPair),
      inEvent(tracked[3] as TrackedPair),
      inEvent(tracked[1] as TrackedPair),
      inEvent(tracked[2] as TrackedPair),
    ]
    const observations = [
      outOfStock('PRO-256-BLK', 'R1'),
      inStock('PRO-512-BLK', 'R1'),
      inStock('MAX-256-BLK', 'R1'),
      inStock('DUO-256-BLK', 'R1'),
    ]

    const messages = build(events, tracked, observations, alertedAt('PRO-256-BLK@R1'))

    expect(messages.map((m) => `${m.group.modelName} ${m.group.capacity}`)).toEqual([
      'iPhone 18 Pro Max 256gb',
      'iPhone Duo 256gb',
      'iPhone 18 Pro 512gb',
      'iPhone 18 Pro 256gb',
    ])
  })

  it('lists an alerted store missing from the response as not checked, never new, and does not say sold out', () => {
    const tracked = [watched('PRO-256-BLK', 'R1'), watched('PRO-256-BLK', 'R2')]

    const [message] = build([outEvent(tracked[0] as TrackedPair)], tracked, [outOfStock('PRO-256-BLK', 'R1')], alertedAt('PRO-256-BLK@R1', 'PRO-256-BLK@R2'))

    expect(message?.colors).toHaveLength(1)
    expect(message?.colors[0]?.stores).toEqual([
      { store: 'R2', name: 'Store Two', distanceMi: 1.5, label: 'not checked', isNew: false },
    ])
    expect(message?.gone).toEqual([{ colorName: 'Black', storeName: 'Store One' }])
  })

  it('lists an alerted part missing from the response as not checked', () => {
    const tracked = [watched('PRO-256-BLK', 'R1'), other('PRO-256-BLU', 'R1')]

    const [message] = build([inEvent(tracked[0] as TrackedPair)], tracked, [inStock('PRO-256-BLK', 'R1')], alertedAt('PRO-256-BLU@R1'))

    expect(message?.colors.map((c) => [c.colorName, c.stores.map((s) => s.label)])).toEqual([
      ['Black', ['Today']],
      ['Blue', ['not checked']],
    ])
  })

  it('builds no message while nothing changed, even when a pair moves between Today and Tomorrow', () => {
    const tracked = [watched('PRO-256-BLK', 'R1')]

    expect(build([], tracked, [inStock('PRO-256-BLK', 'R1', 'Today')], alertedAt('PRO-256-BLK@R1'))).toEqual([])
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
