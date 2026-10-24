import { z } from 'zod'
import type { StockMessage, TelegramError } from '../shared/types'
import type { FailureCause, HealthMessage } from './domain'

const TIMEOUT_MS = 10_000

export type OutgoingMessage = { text: string; button?: { text: string; url: string }; silent?: boolean }
export type SendResult = { ok: true } | { ok: false; error: TelegramError; retryAfterSec?: number }
export type Telegram = { sendMessage(message: OutgoingMessage): Promise<SendResult> }

export function stockMessage({ group, colors, gone, sound }: StockMessage): OutgoingMessage {
  const sections = colors.map((color) =>
    [
      `${color.colorName}${color.role === 'other' ? ' (Other color)' : ''}`,
      ...color.stores.map((s) => `${s.label}: ${s.name}, ${s.distanceMi.toFixed(1)} mi${s.isNew ? ' (new)' : ''}`),
    ].join('\n'),
  )
  const text = [
    `${group.modelName} ${group.capacity.toUpperCase()}`,
    ...(colors.length === 0 ? ['Sold out everywhere'] : sections),
    ...(gone.length > 0 ? [gone.map((g) => `Out of stock: ${g.colorName} at ${g.storeName}`).join('\n')] : []),
  ].join('\n\n')
  const first = colors[0]
  return {
    text,
    ...(first && { button: { text: 'Open buy page', url: first.buyUrl } }),
    ...(!sound && { silent: true }),
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
    async sendMessage({ text, button, silent }) {
      const body = {
        chat_id: deps.chatId,
        text,
        ...(silent && { disable_notification: true }),
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
