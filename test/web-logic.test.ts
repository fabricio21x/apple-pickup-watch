import { describe, expect, it } from 'vitest'
import type { CatalogPart } from '../src/shared/types'
import { buildCatalogTree, errorMessage, healthText, lanUrls, partsToWatch, timeLeft } from '../src/web/logic'

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
