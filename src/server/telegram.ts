import { z } from 'zod'
import type { StockMessage, TelegramError } from '../shared/types'
import type { FailureCause, HealthMessage } from './domain'

const TIMEOUT_MS = 10_000

export type OutgoingMessage = { text: string; buttons?: { text: string; url: string }[]; silent?: boolean }
export type SendResult = { ok: true } | { ok: false; error: TelegramError; retryAfterSec?: number }
export type Telegram = { sendMessage(message: OutgoingMessage): Promise<SendResult> }

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const escapeHtml = (value: string) => value.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char] ?? char)

const DAY_EMOJI: Record<string, string> = { Today: '🟢', Tomorrow: '🟡' }
const NOT_CHECKED = 'not checked'

type ColorStores = StockMessage['colors'][number]['stores']

function storeLines(stores: ColorStores): string[] {
  const byLabel = new Map<string, ColorStores>()
  for (const s of stores) byLabel.set(s.label, [...(byLabel.get(s.label) ?? []), s])
  const rank = (label: string) => (label === 'Today' ? 0 : label === 'Tomorrow' ? 1 : label === NOT_CHECKED ? 3 : 2)
  return [...byLabel]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([label, group]) => {
      const heading = label === NOT_CHECKED ? '⚪ Not checked' : `${DAY_EMOJI[label] ?? '🔵'} ${escapeHtml(label)}`
      const list = group.map((s) => `${s.isNew ? '🆕 ' : ''}${escapeHtml(s.name)} (${s.distanceMi.toFixed(1)} mi)`)
      return `${heading}: ${list.join(', ')}`
    })
}

export function stockMessage({ group, colors, gone, sound }: StockMessage): OutgoingMessage {
  const sections = colors.map((color) =>
    [
      `<b>${escapeHtml(color.colorName)}</b>${color.role === 'other' ? ' · Other color' : ''}`,
      ...storeLines(color.stores),
    ].join('\n'),
  )
  const text = [
    `<b>📱 ${escapeHtml(`${group.modelName} ${group.capacity.toUpperCase()}`)}</b>`,
    ...(colors.length === 0 ? ['🔴 Sold out everywhere'] : sections),
    ...(gone.length > 0
      ? [`🔴 Gone: ${gone.map((g) => `${escapeHtml(g.colorName)} at ${escapeHtml(g.storeName)}`).join(', ')}`]
      : []),
  ].join('\n\n')
  return {
    text,
    ...(colors.length > 0 && { buttons: colors.map((c) => ({ text: `🛒 Buy ${c.colorName}`, url: c.buyUrl })) }),
    ...(!sound && { silent: true }),
  }
}

const notice = (heading: string, body: string): OutgoingMessage => ({ text: `${heading}\n${escapeHtml(body)}` })

const CAUSE_TEXT: Record<FailureCause, string> = {
  'token-expired': 'the Apple token has expired',
  'token-rejected': 'Apple rejected the token',
  network: 'Apple could not be reached (network problem)',
  unexpected: 'Apple sent an unexpected response',
}

const REFRESH_TOKEN = 'Paste a fresh cURL or open apple.com in Brave.'

export function healthMessage(message: HealthMessage): OutgoingMessage {
  if (message.kind === 'up') return notice('✅ <b>Back up</b>', 'Monitoring is back up. Stock alerts are working again.')
  const fix = message.cause === 'token-expired' || message.cause === 'token-rejected' ? ` ${REFRESH_TOKEN}` : ''
  return notice(
    '🚨 <b>Monitoring is down</b>',
    `${CAUSE_TEXT[message.cause]}. No stock alerts will arrive until this is fixed.${fix}`,
  )
}

export function tokenWarningMessage(expiresAt: number): OutgoingMessage {
  const time = new Date(expiresAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return notice('⏳ <b>Token expiring</b>', `The Apple token expires at ${time}. ${REFRESH_TOKEN}`)
}

export const startedMessage = (): OutgoingMessage => notice('▶️ <b>Monitor started</b>', 'Pickup watch is checking for stock.')

export const testMessage = (): OutgoingMessage => notice('🧪 <b>Test message</b>', 'Telegram alerts are working.')

const ErrorBody = z.looseObject({
  description: z.string().optional(),
  parameters: z.looseObject({ retry_after: z.number().optional() }).optional(),
})

export function createTelegram(deps: {
  fetch: typeof fetch
  botToken: string
  chatId: string
  timeoutMs?: number
}): Telegram {
  const url = `https://api.telegram.org/bot${deps.botToken}/sendMessage`
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS

  return {
    async sendMessage({ text, buttons, silent }) {
      const body = {
        chat_id: deps.chatId,
        text,
        parse_mode: 'HTML',
        ...(silent && { disable_notification: true }),
        ...(buttons && { reply_markup: { inline_keyboard: buttons.map(({ text, url }) => [{ text, url }]) } }),
      }
      let res: Response
      try {
        res = await deps.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        // The thrown error is dropped: its message can hold the request URL, which carries the bot token.
        return { ok: false, error: { kind: e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'network' } }
      }
      if (res.ok) {
        await res.body?.cancel().catch(() => {})
        return { ok: true }
      }

      let json: unknown
      try {
        json = await res.json()
      } catch {
        json = undefined
      }
      const parsed = ErrorBody.safeParse(json)
      const description = parsed.success ? parsed.data.description : undefined
      const retryAfterSec = parsed.success ? parsed.data.parameters?.retry_after : undefined
      return {
        ok: false,
        error: { kind: 'http', status: res.status, ...(description !== undefined && { description }) },
        ...(retryAfterSec !== undefined && { retryAfterSec }),
      }
    },
  }
}
