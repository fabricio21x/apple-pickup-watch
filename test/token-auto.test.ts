import { describe, expect, it } from 'vitest'
import { needsRefresh, nextCheckDelayMs } from '../scripts/token-auto'

const NOW = Date.parse('2026-10-24T12:00:00Z')
const MIN = 60_000
const shld = (expiresAtMs: number) => `fakeid1|${expiresAtMs / 1000}|fakepayload==|fakesig`
const pair = (expiresAtMs: number) => ({ dssid2: 'fake-dssid2', shld: shld(expiresAtMs) })

describe('needsRefresh', () => {
  it('leaves a pair with more than 20 minutes left alone', () => {
    expect(needsRefresh(pair(NOW + 21 * MIN), NOW)).toBe(false)
  })

  it('refreshes a pair that expires within 20 minutes', () => {
    expect(needsRefresh(pair(NOW + 19 * MIN), NOW)).toBe(true)
  })

  it('refreshes a pair that already expired', () => {
    expect(needsRefresh(pair(NOW - MIN), NOW)).toBe(true)
  })

  it('refreshes when a cookie is missing', () => {
    expect(needsRefresh({ dssid2: undefined, shld: shld(NOW + 100 * MIN) }, NOW)).toBe(true)
    expect(needsRefresh({ dssid2: 'fake-dssid2', shld: undefined }, NOW)).toBe(true)
  })

  it('refreshes when shld_bt_ck has no readable expiry', () => {
    expect(needsRefresh({ dssid2: 'fake-dssid2', shld: 'garbage' }, NOW)).toBe(true)
  })
})

describe('nextCheckDelayMs', () => {
  it('re-checks within 10 minutes however far away the expiry is', () => {
    expect(nextCheckDelayMs(NOW + 120 * MIN, NOW)).toBe(10 * MIN)
  })

  it('wakes 20 minutes before the expiry when that is sooner than 10 minutes away', () => {
    expect(nextCheckDelayMs(NOW + 25 * MIN, NOW)).toBe(5 * MIN)
  })

  it('retries in a minute, not in a tight loop, when the expiry is already inside the 20-minute margin', () => {
    expect(nextCheckDelayMs(NOW + 5 * MIN, NOW)).toBe(MIN)
    expect(nextCheckDelayMs(NOW - MIN, NOW)).toBe(MIN)
  })
})
