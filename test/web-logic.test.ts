import { describe, expect, it } from 'vitest'
import type { CatalogPart, StateDto, StoreDto, WatchDto } from '../src/shared/types'
import {
  buildCatalogTree,
  capNote,
  countLine,
  downBanner,
  errorMessage,
  healthText,
  lanStatus,
  lanUrls,
  partsToWatch,
  setupSteps,
  statusStrip,
  stockSections,
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

describe('Wi-Fi access status', () => {
  it('is off with nothing to show when disabled and nothing pending', () => {
    expect(lanStatus({ enabled: false, restartRequired: false })).toBe('off')
  })
  it('is live, so the addresses can be links, when enabled and already applied', () => {
    expect(lanStatus({ enabled: true, restartRequired: false })).toBe('live')
  })
  it('is waiting to turn on when enabled but the server was bound without it', () => {
    expect(lanStatus({ enabled: true, restartRequired: true })).toBe('pending-on')
  })
  it('is waiting to turn off when disabled but the server is still bound to the network', () => {
    expect(lanStatus({ enabled: false, restartRequired: true })).toBe('pending-off')
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
  const stores = [store('R1', 'Near', 1), store('R2', 'Mid', 5), store('R3', 'Far', 9)]
  const cell = (p: string, s: string, badge: string) => ({ part: p, store: s, badge })
  const watch = (p: string, badges: [string, string][], otherColors = true): WatchDto => ({
    part: p,
    otherColors,
    cells: badges.map(([s, badge]) => cell(p, s, badge)),
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
  const names = (rows: { store: StoreDto }[]) => rows.map((r) => r.store.name)

  describe('phone sections', () => {
    it('lists nothing when nothing is watched', () => {
      expect(stockSections(state({}))).toEqual({ inStock: [], quiet: [] })
    })

    it('splits phones with stock from phones without, in the sections the board shows', () => {
      const s = state({
        watches: [watch('A1', [['R1', 'Unavailable']]), watch('A2', [['R1', 'Today']], false)],
      })
      const { inStock, quiet } = stockSections(s)
      expect(inStock.map((p) => p.colorName)).toEqual(['Black'])
      expect(quiet.map((p) => p.colorName)).toEqual(['Silver'])
    })

    it('orders a phone stores Today first, then Tomorrow, then Apple own labels, nearest first within each', () => {
      const s = state({
        watches: [watch('A1', [['R1', 'Available Thu 10/30'], ['R2', 'Tomorrow'], ['R3', 'Today']])],
      })
      expect(names(stockSections(s).inStock[0]!.available)).toEqual(['Far', 'Mid', 'Near'])
    })

    it('puts Today stores before Tomorrow stores even when the Tomorrow store is nearer, and nearest first among equals', () => {
      const s = state({
        watches: [watch('A1', [['R1', 'Tomorrow'], ['R3', 'Today'], ['R2', 'Today']])],
      })
      expect(names(stockSections(s).inStock[0]!.available)).toEqual(['Mid', 'Far', 'Near'])
    })

    it('counts the stores with pickup today', () => {
      const s = state({
        watches: [watch('A1', [['R1', 'Tomorrow'], ['R2', 'Today'], ['R3', 'Today']])],
      })
      expect(stockSections(s).inStock[0]!.todayCount).toBe(2)
    })

    it('keeps stores without stock apart from the in-stock list: not checked ones listed, unavailable ones collapsed', () => {
      const s = state({
        watches: [watch('A1', [['R1', 'Unavailable'], ['R2', 'Not checked'], ['R3', 'Today']])],
      })
      const phone = stockSections(s).inStock[0]!
      expect(names(phone.available)).toEqual(['Far'])
      expect(names(phone.unchecked)).toEqual(['Mid'])
      expect(names(phone.rest)).toEqual(['Near'])
    })

    it('shows phones with a Today store before phones with only Tomorrow, then in catalog order', () => {
      const s = state({
        watches: [
          watch('A1', [['R1', 'Tomorrow']]),
          watch('A2', [['R1', 'Tomorrow']]),
          watch('A3', [['R1', 'Today']]),
        ],
        parts: [...catalog],
      })
      expect(stockSections(s).inStock.map((p) => p.part)).toEqual(['A3', 'A1', 'A2'])
    })

    it('shows a watched phone before an other color with the same pickup, whatever the catalog order', () => {
    const s = state({
      watches: [
        { part: 'A2', otherColors: true, cells: [cell('A2', 'R1', 'Tomorrow'), cell('A1', 'R1', 'Tomorrow')] },
      ],
    })
    expect(stockSections(s).inStock.map((p) => [p.colorName, p.role])).toEqual([
      ['Black', 'watched'],
      ['Silver', 'other'],
    ])
  })

  it('carries the buy link and the finish of each phone', () => {
      const s = state({ watches: [watch('A2', [['R1', 'Today']])] })
      const phone = stockSections(s).inStock[0]!
      expect(phone.buyUrl).toBe('https://www.apple.com/shop/buy-iphone/x')
      expect(phone.finish).toBe('var(--sw-black)')
    })

    it('has no finish dot for a color it does not know', () => {
      const s = state({
        parts: [part('Z1', 'iPhone 18 Pro', '256gb', 'Cosmic Orange')],
        watches: [watch('Z1', [['R1', 'Today']])],
      })
      expect(stockSections(s).inStock[0]!.finish).toBeNull()
    })

    it('writes the storage in capitals', () => {
      const s = state({ watches: [watch('A4', [['R1', 'Today']])] })
      expect(stockSections(s).inStock[0]!.capacity).toBe('1TB')
    })
  })

  describe('other colors', () => {
    const blue = part('A5', 'iPhone 18 Pro', '256gb', 'Blue')

    it('shows a sibling color found in a watch cells as an other color and names the color you watch', () => {
      const s = state({
        watches: [
          { part: 'A1', otherColors: true, cells: [cell('A1', 'R1', 'Unavailable'), cell('A2', 'R1', 'Today')] },
        ],
      })
      const phone = stockSections(s).inStock[0]!
      expect([phone.colorName, phone.role, phone.watchedColors]).toEqual(['Black', 'other', ['Silver']])
    })

    it('shows a sibling of two watches once, naming both colors', () => {
      const s = state({
        parts: [...catalog, blue],
        watches: [
          { part: 'A1', otherColors: true, cells: [cell('A1', 'R1', 'Unavailable'), cell('A5', 'R1', 'Tomorrow')] },
          { part: 'A2', otherColors: true, cells: [cell('A2', 'R1', 'Unavailable'), cell('A5', 'R1', 'Tomorrow')] },
        ],
      })
      const blues = stockSections(s).inStock.filter((p) => p.colorName === 'Blue')
      expect(blues.map((p) => p.watchedColors)).toEqual([['Silver', 'Black']])
    })

    it('shows a sibling that is itself watched as watched, not as an other color', () => {
      const s = state({
        watches: [
          { part: 'A1', otherColors: true, cells: [cell('A1', 'R1', 'Unavailable'), cell('A2', 'R1', 'Today')] },
          { part: 'A2', otherColors: false, cells: [cell('A2', 'R1', 'Today')] },
        ],
      })
      const black = stockSections(s).inStock.find((p) => p.colorName === 'Black')!
      expect([black.role, black.watchedColors]).toEqual(['watched', []])
    })
  })

  describe('phones with nothing nearby', () => {
    it('says how many stores were checked', () => {
      const s = state({ watches: [watch('A1', [['R1', 'Unavailable'], ['R2', 'Unavailable'], ['R3', 'Not checked']])] })
      expect(stockSections(s).quiet[0]!.why).toBe('2 stores checked')
    })

    it('says "1 store checked" for a single store', () => {
      const s = state({ watches: [watch('A1', [['R1', 'Unavailable']])] })
      expect(stockSections(s).quiet[0]!.why).toBe('1 store checked')
    })

    it('says not checked when no store answered', () => {
      const s = state({ watches: [watch('A1', [['R1', 'Not checked']])] })
      expect(stockSections(s).quiet[0]!.why).toBe('Not checked')
    })

    it('lists parts past the parts cap with the cap as the reason, after watched phones', () => {
      const s = state({
        watches: [watch('A2', [['R1', 'Unavailable']])],
        partsCount: { tracked: 22, cap: 20, unchecked: ['A1'] },
      })
      expect(stockSections(s).quiet.map((p) => [p.colorName, p.role, p.why])).toEqual([
        ['Black', 'watched', '1 store checked'],
        ['Silver', 'other', 'Not checked: over the 20-part cap'],
      ])
    })

    it('does not repeat a part past the cap that a watch cells already carry', () => {
      const s = state({
        watches: [
          { part: 'A2', otherColors: true, cells: [cell('A2', 'R1', 'Unavailable'), cell('A1', 'R1', 'Not checked')] },
        ],
        partsCount: { tracked: 2, cap: 20, unchecked: ['A1'] },
      })
      expect(stockSections(s).quiet.filter((p) => p.colorName === 'Silver')).toHaveLength(1)
    })
  })
})

describe('count line', () => {
  const phone = (stores: number, today: number) =>
    ({ available: Array.from({ length: stores }), todayCount: today }) as Parameters<typeof countLine>[0]

  it('names the stores and how many are for pickup today', () => {
    expect(countLine(phone(5, 4))).toBe('In stock at 5 stores, 4 for pickup today')
  })
  it('says "store" for one and drops the today part when none is today', () => {
    expect(countLine(phone(1, 0))).toBe('In stock at 1 store')
  })
})

describe('monitor status strip', () => {
  const now = 1_000_000_000_000
  const base = (over: Partial<StateDto>): StateDto =>
    ({
      intervalSec: 60,
      lastCheckAt: now - 14_000,
      lastSuccessAt: now - 14_000,
      token: { status: 'working', expiresAt: now + (110 * 60_000) },
      health: { status: 'healthy', failures: 0, cause: null },
      ...over,
    }) as StateDto

  it('shows the check interval, the age of the last successful check and the token time left', () => {
    expect(statusStrip(base({}), now)).toEqual({
      checking: true,
      headline: 'Checking every minute',
      ago: 'last check 14 s ago',
      token: 'Token 1 h 50 min left',
      trouble: null,
    })
  })
  it('states the interval in seconds or minutes when it is not a minute', () => {
    expect(statusStrip(base({ intervalSec: 30 }), now).headline).toBe('Checking every 30 s')
    expect(statusStrip(base({ intervalSec: 300 }), now).headline).toBe('Checking every 5 min')
  })
  it('counts the age from the last successful check, in minutes once past a minute', () => {
    expect(statusStrip(base({ lastSuccessAt: now - 11 * 60_000 }), now).ago).toBe('last check 11 min ago')
  })
  it('says no check yet before any check succeeded', () => {
    expect(statusStrip(base({ lastSuccessAt: null }), now).ago).toBe('no check yet')
  })
  it('says Not checking and Token rejected when Apple rejected the token', () => {
    const s = statusStrip(
      base({ token: { status: 'rejected', expiresAt: null }, health: { status: 'down', failures: 3, cause: 'token-rejected' } }),
      now,
    )
    expect([s.checking, s.headline, s.token]).toEqual([false, 'Not checking', 'Token rejected'])
  })
  it('says Token expired once the expiry has passed', () => {
    expect(statusStrip(base({ token: { status: 'working', expiresAt: now - 1 } }), now).token).toBe('Token expired')
  })
  it('says the token is missing', () => {
    expect(statusStrip(base({ token: { status: 'missing', expiresAt: null } }), now).token).toBe('Token missing')
  })
  it('keeps saying Checking while a check fails, and says how many failed in a row', () => {
    const s = statusStrip(base({ health: { status: 'failing', failures: 2, cause: 'network' } }), now)
    expect([s.checking, s.trouble]).toEqual([true, 'Last check failed: Apple could not be reached (2 in a row)'])
  })
})

describe('down banner', () => {
  const state = (over: Partial<StateDto>) =>
    ({
      token: { status: 'working', expiresAt: null },
      health: { status: 'healthy', failures: 0, cause: null },
      ...over,
    }) as StateDto

  it('is absent while checks work', () => {
    expect(downBanner(state({}))).toBeNull()
  })
  it('names the cause and points to the token fix when Apple rejected the token', () => {
    expect(
      downBanner(state({ health: { status: 'down', failures: 3, cause: 'token-rejected' }, token: { status: 'rejected', expiresAt: null } })),
    ).toEqual({ title: 'Monitoring is down', reason: 'Apple rejected the token, so stock is not being checked.', tokenFix: true })
  })
  it('has no token fix when Apple could not be reached', () => {
    expect(downBanner(state({ health: { status: 'down', failures: 3, cause: 'network' } }))).toEqual({
      title: 'Monitoring is down',
      reason: 'Apple could not be reached, so stock is not being checked.',
      tokenFix: false,
    })
  })
  it('shows for an expired token even before health goes down', () => {
    expect(downBanner(state({ token: { status: 'expired', expiresAt: null } }))?.reason).toBe(
      'The Apple token expired, so stock is not being checked.',
    )
  })
  it('still says stock is not being checked when down with no known cause', () => {
    expect(downBanner(state({ health: { status: 'down', failures: 3, cause: null } }))).toEqual({
      title: 'Monitoring is down',
      reason: 'Stock is not being checked.',
      tokenFix: false,
    })
  })
  it('does not show for a failing check that is not down yet', () => {
    expect(downBanner(state({ health: { status: 'failing', failures: 1, cause: 'network' } }))).toBeNull()
  })
})

describe('first-run setup', () => {
  const state = (over: Partial<StateDto>) =>
    ({
      stores: [{ store: 'R1', name: 'Near', city: 'C', state: 'NY', distanceMi: 1, enabled: true }],
      watches: [{ part: 'A1', otherColors: false, cells: [] }],
      token: { status: 'working', expiresAt: null },
      telegram: { configured: true, lastError: null },
      ...over,
    }) as StateDto

  it('is complete when stores, a watch and a token exist', () => {
    expect(setupSteps(state({}))).toEqual({ telegram: true, stores: true, watches: true, token: true, complete: true })
  })
  it('marks each missing step and is not complete', () => {
    expect(
      setupSteps(state({ stores: [], watches: [], token: { status: 'missing', expiresAt: null }, telegram: { configured: false, lastError: null } })),
    ).toEqual({ telegram: false, stores: false, watches: false, token: false, complete: false })
  })
  it('does not count stores that are all switched off', () => {
    const stores = [{ store: 'R1', name: 'Near', city: 'C', state: 'NY', distanceMi: 1, enabled: false }]
    expect(setupSteps(state({ stores })).stores).toBe(false)
  })
  it('does not hold the board back when only Telegram is missing', () => {
    expect(setupSteps(state({ telegram: { configured: false, lastError: null } })).complete).toBe(true)
  })
})

describe('parts cap note', () => {
  it('says how many parts are tracked and how many are checked', () => {
    expect(capNote({ tracked: 22, cap: 20, unchecked: ['A', 'B'] })).toBe('22 parts tracked, 20 checked.')
  })
  it('is absent when every tracked part is checked', () => {
    expect(capNote({ tracked: 12, cap: 20, unchecked: [] })).toBeNull()
  })
})
