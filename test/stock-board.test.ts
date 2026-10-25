import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CatalogPart, StateDto } from '../src/shared/types'
import { StockBoard } from '../src/web/StockBoard'

const part = (p: string, modelName: string, colorName: string): CatalogPart => ({
  part: p,
  modelName,
  capacity: '256gb',
  colorName,
  title: `${modelName} 256gb ${colorName}`,
  buyUrl: `https://www.apple.com/shop/buy-iphone/${p}`,
})

const stores = [{ store: 'R1', name: 'Fifth Avenue', city: 'New York', state: 'NY', distanceMi: 1.2, enabled: true }]

const base: StateDto = {
  zip: '10001',
  stores,
  parts: [part('A1', 'iPhone 18 Pro Max', 'Black'), part('A2', 'iPhone 18 Pro Max', 'Silver')],
  watches: [
    { part: 'A1', otherColors: false, cells: [{ part: 'A1', store: 'R1', badge: 'Today' }] },
    { part: 'A2', otherColors: false, cells: [{ part: 'A2', store: 'R1', badge: 'Unavailable' }] },
  ],
  lastCheckAt: Date.now(),
  lastSuccessAt: Date.now() - 5 * 60_000,
  intervalSec: 60,
  lan: { enabled: false, restartRequired: false, urls: [] },
  token: { status: 'working', expiresAt: Date.now() + 110 * 60_000 },
  telegram: { configured: true, lastError: null },
  health: { status: 'healthy', failures: 0, cause: null },
  partsCount: { tracked: 2, cap: 20, unchecked: [] },
}

const down: StateDto = { ...base, health: { status: 'down', failures: 3, cause: 'network' } }
const capped: StateDto = { ...base, partsCount: { tracked: 22, cap: 20, unchecked: ['A2'] } }

const render = (state: StateDto | null) => renderToStaticMarkup(createElement(StockBoard, { state }))

describe('stock board page', () => {
  it('puts the cap note and its Trim your watches link before the first phone, so Tab reaches it before the Buy buttons', () => {
    const html = render(capped)
    const trim = html.indexOf('Trim your watches')
    const phone = html.indexOf('<section aria-label="iPhone 18 Pro Max')
    expect(trim).toBeGreaterThan(-1)
    expect(phone).toBeGreaterThan(trim)
    expect(html.indexOf('href="https://www.apple.com/shop/buy-iphone/A1"')).toBeGreaterThan(trim)
  })

  it('keeps the quiet list, which moves last visually, free of links and buttons so focus order matches what is seen', () => {
    const quiet = /<section aria-label="Not in stock nearby".*?<\/section>/.exec(render(capped))?.[0]
    expect(quiet).toContain('iPhone 18 Pro Max')
    expect(quiet).not.toMatch(/<(a|button)\b/)
  })

  it('starts the Buy link name with its visible text', () => {
    const names = [...render(base).matchAll(/aria-label="(Buy [^"]*)"/g)].map((m) => m[1])
    expect(names).toEqual([
      'Buy Black, iPhone 18 Pro Max 256GB, on apple.com (opens a new tab)',
      'Buy Black, iPhone 18 Pro Max 256GB, on apple.com (opens a new tab)',
    ])
  })

  it('announces Loading stock as text in the skeleton, not as an aria-label', () => {
    const html = render(null)
    expect(html).toMatch(/role="status"[^>]*>.*Loading stock…/)
    expect(html).not.toContain('aria-label="Loading stock"')
  })

  it('keeps the token time and the ticking age outside the live region, and the headline inside', () => {
    const live = [...render(base).matchAll(/<(\w+)[^>]*role="status"[^>]*>(.*?)<\/\1>/g)].map((m) => m[2]).join(' ')
    expect(live).toContain('Checking every minute')
    expect(live).not.toMatch(/last check|Token/)
  })

  it('keeps a failing check inside the live region', () => {
    const failing: StateDto = { ...base, health: { status: 'failing', failures: 2, cause: 'network' } }
    const live = [...render(failing).matchAll(/<(\w+)[^>]*role="status"[^>]*>(.*?)<\/\1>/g)].map((m) => m[2]).join(' ')
    expect(live).toContain('Last check failed')
  })

  it('shows the status strip while setup is incomplete', () => {
    const html = render({ ...base, watches: [], token: { status: 'missing', expiresAt: null } })
    expect(html).toContain('Set up your watch')
    expect(html).toContain('Not checking yet')
    expect(html).toContain('finish setup')
    expect(html).not.toContain('Checking every minute')
    expect(html).toContain('Token missing')
  })

  describe('stale stock under the down banner', () => {
    it('links each phone to the Last known stock note instead of fading the text', () => {
      const html = render(down)
      const id = /<p[^>]*id="([^"]+)"[^>]*>Last known stock, /.exec(html)?.[1]
      expect(id).toBeTruthy()
      expect(html).toContain(`aria-describedby="${id}"`)
      expect(html).not.toContain('opacity-55')
    })

    it('greys a phone section under the down banner and leaves it in colour while healthy', () => {
      const section = (html: string) => /<section aria-label="iPhone 18 Pro Max 256GB Black"[^>]*>/.exec(html)?.[0]
      expect(section(render(down))).toMatch(/class="[^"]*\bgrayscale\b/)
      expect(section(render(base))).not.toMatch(/grayscale/)
    })

    it('dates the Not in stock nearby list by the last successful check', () => {
      const html = render({ ...down, partsCount: { tracked: 2, cap: 20, unchecked: [] } })
      expect(html).toMatch(/Not in stock nearby.*As of the last check, /)
    })

    it('does not date the quiet list while monitoring is healthy', () => {
      expect(render(base)).not.toContain('As of the last check')
    })
  })
})
