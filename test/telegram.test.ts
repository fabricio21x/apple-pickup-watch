import { describe, expect, it } from 'vitest'
import type { StockMessage } from '../src/shared/types'
import {
  createTelegram,
  healthMessage,
  startedMessage,
  stockMessage,
  testMessage,
  tokenWarningMessage,
} from '../src/server/telegram'

type Store = StockMessage['colors'][number]['stores'][number]
type Color = StockMessage['colors'][number]

const store = (overrides: Partial<Store> = {}): Store => ({
  store: 'R250',
  name: 'West 14th Street',
  distanceMi: 0.66,
  label: 'Today',
  isNew: false,
  ...overrides,
})

const color = (overrides: Partial<Color> = {}): Color => ({
  colorName: 'Black',
  role: 'watched',
  buyUrl: 'https://www.apple.com/shop/buy-iphone/iphone-18-pro/black-unlocked',
  stores: [store()],
  ...overrides,
})

const message = (overrides: Partial<StockMessage> = {}): StockMessage => ({
  group: { modelName: 'iPhone 18 Pro Max', capacity: '256gb' },
  sound: true,
  colors: [color()],
  gone: [],
  commit: { insert: [], delete: [] },
  ...overrides,
})

// Telegram counts a message after parsing entities: no tags, and each entity is one character.
const lengthAsTelegram = (html: string) =>
  [...html.replace(/<\/?b>/g, '').replace(/&(amp|lt|gt|quot);/g, '?')].length

describe('stock message', () => {
  it('renders a bold heading, a bold color, and Today and Tomorrow lines with distances', () => {
    const { text } = stockMessage(
      message({
        colors: [
          color({
            stores: [
              store({ name: 'West 14th Street', distanceMi: 0.66 }),
              store({ store: 'R415', name: 'Grand Central', distanceMi: 1.24, label: 'Tomorrow' }),
            ],
          }),
        ],
      }),
    )

    expect(text).toBe(
      [
        '<b>📱 iPhone 18 Pro Max 256GB</b>',
        '',
        '<b>Black</b>',
        '🟢 Today: West 14th Street (0.7 mi)',
        '🟡 Tomorrow: Grand Central (1.2 mi)',
      ].join('\n'),
    )
  })

  it('puts Other color beside an other-color heading', () => {
    const { text } = stockMessage(message({ colors: [color({ colorName: 'Glacier', role: 'other' })] }))

    expect(text).toContain('<b>Glacier</b> · Other color')
  })

  it('puts 🆕 before a new store only', () => {
    const { text } = stockMessage(
      message({
        colors: [
          color({
            stores: [
              store({ name: 'West 14th Street', isNew: false }),
              store({ store: 'R095', name: 'Fifth Avenue', distanceMi: 2, isNew: true }),
            ],
          }),
        ],
      }),
    )

    expect(text).toContain('🟢 Today: West 14th Street (0.7 mi), 🆕 Fifth Avenue (2.0 mi)')
  })

  it('gives any other Apple label its own 🔵 line', () => {
    const { text } = stockMessage(
      message({ colors: [color({ stores: [store({ name: 'SoHo', label: 'Available Thu 10/30' })] })] }),
    )

    expect(text).toContain('🔵 Available Thu 10/30: SoHo (0.7 mi)')
    expect(text).not.toContain('Today')
  })

  it('lists alerted stores missing from the response on a ⚪ Not checked line', () => {
    const { text } = stockMessage(
      message({
        colors: [
          color({
            stores: [store(), store({ store: 'R415', name: 'Grand Central', distanceMi: 1.24, label: 'not checked' })],
          }),
        ],
      }),
    )

    expect(text).toContain('🟢 Today: West 14th Street (0.7 mi)')
    expect(text).toContain('⚪ Not checked: Grand Central (1.2 mi)')
  })

  it('names the colors and stores that went out on a 🔴 Gone line', () => {
    const { text } = stockMessage(
      message({
        sound: false,
        gone: [
          { colorName: 'Black', storeName: 'Fifth Avenue' },
          { colorName: 'Silver', storeName: 'SoHo' },
        ],
      }),
    )

    expect(text).toContain('🔴 Gone: Black at Fifth Avenue, Silver at SoHo')
    expect(text).not.toContain('Sold out')
  })

  it('says sold out everywhere, with no buttons, when no color is left', () => {
    const out = stockMessage(message({ sound: false, colors: [], gone: [{ colorName: 'Black', storeName: 'SoHo' }] }))

    expect(out.text).toContain('🔴 Sold out everywhere')
    expect(out.text).toContain('🔴 Gone: Black at SoHo')
    expect(out.buttons).toBeUndefined()
  })

  it('carries one 🛒 Buy button per in-stock color with that color\'s URL', () => {
    const { buttons } = stockMessage(
      message({
        colors: [
          color({ colorName: 'Black', buyUrl: 'https://apple.test/black-unlocked' }),
          color({ colorName: 'Silver', buyUrl: 'https://apple.test/silver-unlocked' }),
        ],
      }),
    )

    expect(buttons).toEqual([
      { text: '🛒 Buy Black', url: 'https://apple.test/black-unlocked' },
      { text: '🛒 Buy Silver', url: 'https://apple.test/silver-unlocked' },
    ])
  })

  it('never puts a URL in the text', () => {
    const { text } = stockMessage(message({ colors: [color(), color({ colorName: 'Silver' })] }))

    expect(text).not.toMatch(/https?:|apple\.com/)
  })

  it('sends with sound when a store came in and silently when only stores went out', () => {
    expect(stockMessage(message({ sound: true })).silent).toBeUndefined()
    expect(stockMessage(message({ sound: false })).silent).toBe(true)
  })

  it('shows <b>, & and " in every Apple-supplied string literally, with <b> as the only tag', () => {
    const nasty = '<b>A&B "x"</b>'
    const { text, buttons } = stockMessage(
      message({
        group: { modelName: nasty, capacity: '<&">' },
        colors: [color({ colorName: nasty, stores: [store({ name: nasty }), store({ name: 'SoHo', label: nasty })] })],
        gone: [{ colorName: nasty, storeName: nasty }],
      }),
    )

    const escaped = '&lt;b&gt;A&amp;B &quot;x&quot;&lt;/b&gt;'
    expect(text.split(escaped).length - 1).toBe(6)
    expect(text).toContain('&lt;&amp;&quot;&gt;')
    expect(text.replace(/<\/?b>/g, '').match(/[<>"]/g)).toBeNull()
    expect(text.match(/<[^>]*>/g)?.every((tag) => tag === '<b>' || tag === '</b>')).toBe(true)
    expect(buttons?.[0]?.text).toBe(`🛒 Buy ${nasty}`)
  })

  it('stays under 4096 characters for 4 colors x 12 stores with the longest store names', () => {
    const longName = (i: number) => `Apple Store with a very long & rather "unusual" mall name ${String(i).padStart(2, '0')}`
    const stores = Array.from({ length: 12 }, (_, i) =>
      store({ store: `R${100 + i}`, name: longName(i), distanceMi: 10 + i, isNew: true }),
    )
    const colors = ['Cosmic Orange', 'Deep Blue Titanium', 'Natural Titanium', 'Desert Titanium'].map((colorName) =>
      color({ colorName, role: 'other', stores }),
    )

    const { text } = stockMessage(message({ colors }))

    expect(lengthAsTelegram(text)).toBeGreaterThan(3000)
    expect(lengthAsTelegram(text)).toBeLessThan(4096)
  })
})

describe('other messages', () => {
  it('styles the down message with 🚨, a bold heading, the cause and the fix', () => {
    const { text } = healthMessage({ kind: 'down', cause: 'token-expired' })

    expect(text.startsWith('🚨 <b>Monitoring is down</b>\n')).toBe(true)
    expect(text).toContain('the Apple token has expired')
    expect(text).toContain('Paste a fresh cURL')
  })

  it('styles the back up message with ✅ and a bold heading', () => {
    expect(healthMessage({ kind: 'up' }).text).toMatch(/^✅ <b>Back up<\/b>\n.+/)
  })

  it('styles the token warning with ⏳ and a bold heading', () => {
    expect(tokenWarningMessage(Date.UTC(2026, 9, 23, 12, 0)).text).toMatch(/^⏳ <b>Token expiring<\/b>\nThe Apple token expires at \d\d:\d\d\./)
  })

  it('styles the started message with ▶️ and a bold heading', () => {
    expect(startedMessage().text).toMatch(/^▶️ <b>Monitor started<\/b>\n.+/)
  })

  it('styles the test message with 🧪 and a bold heading', () => {
    expect(testMessage().text).toMatch(/^🧪 <b>Test message<\/b>\n.+/)
  })

  it('carries no button and no sound change', () => {
    for (const out of [healthMessage({ kind: 'up' }), startedMessage(), testMessage()]) {
      expect(out.buttons).toBeUndefined()
      expect(out.silent).toBeUndefined()
    }
  })
})

describe('request body', () => {
  const send = async (outgoing: Parameters<ReturnType<typeof createTelegram>['sendMessage']>[0]) => {
    let url = ''
    let body: unknown
    const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
      url = String(input)
      body = JSON.parse(String(init?.body))
      return new Response('{"ok":true}')
    }) as typeof fetch
    await createTelegram({ fetch: fetchFake, botToken: 'BOT', chatId: '42' }).sendMessage(outgoing)
    return { url, body }
  }

  it('asks for HTML parsing and puts each button on its own keyboard row', async () => {
    const { url, body } = await send({
      text: '<b>hello</b>',
      buttons: [
        { text: '🛒 Buy Black', url: 'https://apple.test/black-unlocked' },
        { text: '🛒 Buy Silver', url: 'https://apple.test/silver-unlocked' },
      ],
    })

    expect(url).toBe('https://api.telegram.org/botBOT/sendMessage')
    expect(body).toEqual({
      chat_id: '42',
      text: '<b>hello</b>',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🛒 Buy Black', url: 'https://apple.test/black-unlocked' }],
          [{ text: '🛒 Buy Silver', url: 'https://apple.test/silver-unlocked' }],
        ],
      },
    })
  })

  it('adds disable_notification for a silent message and no keyboard without buttons', async () => {
    expect((await send({ text: 'hello', silent: true })).body).toEqual({
      chat_id: '42',
      text: 'hello',
      parse_mode: 'HTML',
      disable_notification: true,
    })
  })
})
