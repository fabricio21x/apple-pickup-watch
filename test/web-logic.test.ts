import { describe, expect, it } from 'vitest'
import type { CatalogPart, StateDto, StoreDto, WatchDto } from '../src/shared/types'
import {
  buildCatalogTree,
  errorMessage,
  healthText,
  lanUrls,
  partsToWatch,
  stockBoard,
  timeLeft,
  viewFromHash,
} from '../src/web/logic'

const part = (p: string, modelName: string, capacity: string, colorName: string): CatalogPart => ({
  part: p,
  modelName,
  capacity,
  colorName,
  title: `${modelName} ${capacity} ${colorName}`,
  buyUrl: 'https://www.apple.com/shop/buy-iphone/x',
})

const catalog = [
  part('A1', 'iPhone 18 Pro', '256gb', 'Silver'),
  part('A2', 'iPhone 18 Pro', '256gb', 'Black'),
  part('A3', 'iPhone 18 Pro', '512gb', 'Silver'),
  part('B1', 'iPhone 18 Pro Max', '256gb', 'Silver'),
  part('A4', 'iPhone 18 Pro', '1tb', 'Black'),
]

describe('catalog picker tree', () => {
  it('groups parts by model, then storage, then color, in catalog order', () => {
    expect(buildCatalogTree(catalog)).toEqual([
      {
        model: 'iPhone 18 Pro',
        storages: [
          {
            capacity: '256gb',
            colors: [
              { part: 'A1', colorName: 'Silver' },
              { part: 'A2', colorName: 'Black' },
            ],
          },
          { capacity: '512gb', colors: [{ part: 'A3', colorName: 'Silver' }] },
          { capacity: '1tb', colors: [{ part: 'A4', colorName: 'Black' }] },
        ],
      },
      { model: 'iPhone 18 Pro Max', storages: [{ capacity: '256gb', colors: [{ part: 'B1', colorName: 'Silver' }] }] },
    ])
  })

  it('has no groups for an empty catalog', () => {
    expect(buildCatalogTree([])).toEqual([])
  })
})

describe('picker selection', () => {
  it('lists the selected parts that are not watched yet, once each', () => {
    expect(partsToWatch(new Set(['A1', 'A2', 'B1']), [{ part: 'A2' }])).toEqual(['A1', 'B1'])
  })
})

describe('LAN URLs', () => {
  it('drops loopback addresses and keeps the others', () => {
    expect(
      lanUrls([
        'http://127.0.0.1:4319',
        'http://192.168.1.20:4319',
        'http://localhost:4319',
        'http://[::1]:4319',
        'http://127.0.1.1:4319',
        'http://my-mac.local:4319',
      ]),
    ).toEqual(['http://192.168.1.20:4319', 'http://my-mac.local:4319'])
  })
})

describe('token time left', () => {
  const now = 1_000_000_000_000
  it('shows hours and minutes', () => {
    expect(timeLeft(now + (2 * 60 + 5) * 60_000, now)).toBe('2 h 5 min left')
  })
  it('shows minutes under an hour', () => {
    expect(timeLeft(now + 14 * 60_000 + 30_000, now)).toBe('14 min left')
  })
  it('shows under a minute', () => {
    expect(timeLeft(now + 20_000, now)).toBe('under 1 min left')
  })
  it('says expired once the time has passed', () => {
    expect(timeLeft(now - 1, now)).toBe('expired')
  })
})

describe('API error messages', () => {
  it('names the invalid fields', () => {
    expect(errorMessage({ error: 'invalid-request', fields: ['zip'] })).toBe('Invalid value: zip.')
  })
  it('explains why a pasted cURL was rejected', () => {
    expect(errorMessage({ error: 'token-rejected', reason: 'expired' })).toBe(
      'Token rejected: the cURL is already expired. Copy a fresh one.',
    )
  })
  it('explains that a zip has no stores', () => {
    expect(errorMessage({ error: 'no-stores' })).toBe('No Apple Stores found for that zip.')
  })
  it('falls back to the code for an unknown error', () => {
    expect(errorMessage({ error: 'brand-new' })).toBe('Something went wrong (brand-new).')
  })
})

describe('health text', () => {
  it('says checks are working when healthy', () => {
    expect(healthText({ status: 'healthy', failures: 0, cause: null })).toBe('Checks are working')
  })
  it('names the cause when monitoring is down', () => {
    expect(healthText({ status: 'down', failures: 3, cause: 'token-expired' })).toBe(
      'Monitoring is down: the Apple token expired',
    )
  })
  it('counts the failures while still failing', () => {
    expect(healthText({ status: 'failing', failures: 2, cause: 'network' })).toBe(
      'Last check failed: Apple could not be reached (2 in a row)',
    )
  })
})

describe('view from the URL hash', () => {
  it.each([
    ['#/stock', 'stock'],
    ['#/watches', 'watches'],
    ['#/stores', 'stores'],
    ['#/settings', 'settings'],
  ])('opens %s', (hash, view) => {
    expect(viewFromHash(hash)).toBe(view)
  })
  it.each(['', '#', '#/', '#/nope', '#/watches/extra', '#stock', 'watches'])('falls back to the stock board for "%s"', (hash) => {
    expect(viewFromHash(hash)).toBe('stock')
  })
})

describe('parts cap refusal', () => {
  it('says how many parts the change adds and what it would make', () => {
    expect(errorMessage({ error: 'parts-cap', cap: 20, tracked: 22, adding: 19 })).toBe(
      'Adds 19 parts, which would make 22 / 20.',
    )
  })
  it('says "part" for a single part', () => {
    expect(errorMessage({ error: 'parts-cap', cap: 20, tracked: 21, adding: 1 })).toBe(
      'Adds 1 part, which would make 21 / 20.',
    )
  })
})

describe('stock board', () => {
  const store = (id: string, name: string, distanceMi: number, enabled = true): StoreDto => ({
    store: id,
    name,
    city: 'City',
    state: 'NY',
    distanceMi,
    enabled,
  })
  const stores = [store('R1', 'Near', 1), store('R2', 'Far', 5), store('R3', 'Off', 9, false)]
  const watch = (p: string, badges: [string, string][], otherColors = true): WatchDto => ({
    part: p,
    otherColors,
    cells: badges.map(([s, badge]) => ({ part: p, store: s, badge })),
  })
  const state = (over: Partial<StateDto>): StateDto => ({
    zip: '10001',
    stores,
    parts: catalog,
    watches: [],
    lastCheckAt: null,
    lastSuccessAt: null,
    intervalSec: 60,
    lan: { enabled: false, restartRequired: false, urls: [] },
    token: { status: 'working', expiresAt: null },
    telegram: { configured: true, lastError: null },
    health: { status: 'healthy', failures: 0, cause: null },
    partsCount: { tracked: 0, cap: 20, unchecked: [] },
    ...over,
  })
  const flat = (s: StateDto) =>
    stockBoard(s).map((b) => ({
      block: `${b.model} ${b.capacity}`,
      rows: b.rows.map((r) => [r.colorName, r.role, r.store.name, r.badge]),
    }))

  it('lists nothing when nothing is watched', () => {
    expect(stockBoard(state({}))).toEqual([])
  })

  it('puts in-stock rows before unavailable and not-checked rows within a block', () => {
    const s = state({
      watches: [
        watch('A1', [['R1', 'Unavailable'], ['R2', 'Today']]),
        watch('A2', [['R1', 'Not checked'], ['R2', 'Tomorrow']]),
      ],
      partsCount: { tracked: 2, cap: 20, unchecked: [] },
    })
    expect(flat(s)).toEqual([
      {
        block: 'iPhone 18 Pro 256gb',
        rows: [
          ['Silver', 'watched', 'Far', 'Today'],
          ['Black', 'watched', 'Far', 'Tomorrow'],
          ['Silver', 'watched', 'Near', 'Unavailable'],
          ['Black', 'watched', 'Near', 'Not checked'],
        ],
      },
    ])
  })

  it('treats a label other than Unavailable or Not checked as in stock', () => {
    const s = state({ watches: [watch('A1', [['R1', 'Unavailable'], ['R2', 'Available Thu 10/30']])] })
    expect(flat(s)[0]!.rows.map((r) => r[3])).toEqual(['Available Thu 10/30', 'Unavailable'])
  })

  it('makes one block per model and storage, those with stock first, others in catalog order', () => {
    const s = state({
      watches: [
        watch('A1', [['R1', 'Unavailable']]),
        watch('A3', [['R1', 'Unavailable']]),
        watch('B1', [['R1', 'Today']]),
      ],
    })
    expect(flat(s).map((b) => b.block)).toEqual([
      'iPhone 18 Pro Max 256gb',
      'iPhone 18 Pro 256gb',
      'iPhone 18 Pro 512gb',
    ])
  })

  it('shows parts past the cap as other-color rows that are not checked, after the watched rows', () => {
    const s = state({
      watches: [watch('A2', [['R1', 'Unavailable'], ['R2', 'Unavailable']])],
      partsCount: { tracked: 2, cap: 20, unchecked: ['A1'] },
    })
    expect(flat(s)[0]!.rows).toEqual([
      ['Black', 'watched', 'Near', 'Unavailable'],
      ['Black', 'watched', 'Far', 'Unavailable'],
      ['Silver', 'other', 'Near', 'Not checked'],
      ['Silver', 'other', 'Far', 'Not checked'],
    ])
  })

  it('leaves disabled stores out of the unchecked rows', () => {
    const s = state({
      watches: [watch('A2', [['R1', 'Unavailable']])],
      partsCount: { tracked: 2, cap: 20, unchecked: ['A1'] },
    })
    expect(flat(s)[0]!.rows.filter((r) => r[1] === 'other').map((r) => r[2])).toEqual(['Near', 'Far'])
  })

  it('carries the buy link of each color', () => {
    const s = state({ watches: [watch('A1', [['R1', 'Today']])] })
    expect(stockBoard(s)[0]!.rows[0]!.buyUrl).toBe('https://www.apple.com/shop/buy-iphone/x')
  })
})
