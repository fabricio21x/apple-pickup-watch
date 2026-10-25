import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const DEFAULT_PORT = 4319

const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),
  EXTENSION_ID: z.string().default(''),
})

export type BootEnv = {
  port: number
  telegram: { botToken: string; chatId: string } | null
  extensionId: string
}

export function readEnv(env: NodeJS.ProcessEnv): BootEnv {
  const parsed = Env.safeParse({
    PORT: env.PORT || DEFAULT_PORT,
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || undefined,
    TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID || undefined,
    EXTENSION_ID: env.EXTENSION_ID,
  })
  if (!parsed.success) throw new Error('PORT must be a whole number from 1 to 65535')
  const { PORT, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, EXTENSION_ID } = parsed.data
  return {
    port: PORT,
    telegram: TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? { botToken: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID } : null,
    extensionId: EXTENSION_ID,
  }
}

export const bindHost = (lanEnabled: boolean) => (lanEnabled ? '0.0.0.0' : '127.0.0.1')

export function prepareDataDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const db = join(dir, 'pickup-watch.db')
  closeSync(openSync(db, 'a', 0o600))
  chmodSync(db, 0o600)
  return db
}
