import { z } from 'zod'
import type { CatalogPart, StockEvent, TelegramError, TrackedPair } from '../shared/types'
import type { FailureCause, HealthMessage } from './domain'

const TIMEOUT_MS = 10_000

export type OutgoingMessage = { text: string; button?: { text: string; url: string } }
export type SendResult = { ok: true } | { ok: false; error: TelegramError; retryAfterSec?: number }
export type Telegram = { sendMessage(message: OutgoingMessage): Promise<SendResult> }

const HEADLINE: Record<StockEvent['kind'], Record<TrackedPair['role'], string>> = {
  in: { watched: 'In stock', other: 'Other color in stock' },
  out: { watched: 'Out of stock', other: 'Other color out of stock' },
}

export function stockMessage(
  event: StockEvent,
  part: CatalogPart,
  store: { name: string; distanceMi: number },
): OutgoingMessage {
  const { pair } = event
  const youWatch = pair.role === 'other' ? ` (you watch ${pair.relatedColors.join(', ')})` : ''
  const lines = [
    `${HEADLINE[event.kind][pair.role]}: ${part.title}${youWatch}`,
    `Store: ${store.name}, ${store.distanceMi.toFixed(1)} mi`,
  ]
  if (event.kind === 'out') return { text: lines.join('\n') }
  return {
    text: [...lines, `Pickup: ${event.label ?? 'Available'}`].join('\n'),
    button: { text: 'Open buy page', url: part.buyUrl },
  }
}

const CAUSE_TEXT: Record<FailureCause, string> = {
  'token-expired': 'the Apple token has expired',
  'token-rejected': 'Apple rejected the token',
  network: 'Apple could not be reached (network problem)',
  unexpected: 'Apple sent an unexpected response',
}

const REFRESH_TOKEN = 'Paste a fresh cURL or open apple.com in Brave.'

export function healthMessage(message: HealthMessage): OutgoingMessage {
  if (message.kind === 'up') return { text: 'Monitoring is back up. Stock alerts are working again.' }
  const fix = message.cause === 'token-expired' || message.cause === 'token-rejected' ? ` ${REFRESH_TOKEN}` : ''
  return { text: `Monitoring is down: ${CAUSE_TEXT[message.cause]}. No stock alerts will arrive until this is fixed.${fix}` }
}

export function tokenWarningMessage(expiresAt: number): OutgoingMessage {
  const time = new Date(expiresAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return { text: `The Apple token expires at ${time}. ${REFRESH_TOKEN}` }
}

export const startedMessage = (): OutgoingMessage => ({ text: 'Pickup watch monitor started.' })

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
    async sendMessage({ text, button }) {
      const body = {
        chat_id: deps.chatId,
        text,
        ...(button && { reply_markup: { inline_keyboard: [[{ text: button.text, url: button.url }]] } }),
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
