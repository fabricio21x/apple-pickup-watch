import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bindHost, prepareDataDir, readEnv } from '../src/server/boot'

const mode = (path: string) => statSync(path).mode & 0o777

describe('readEnv', () => {
  it('defaults to port 4319, no Telegram and no extension', () => {
    expect(readEnv({})).toEqual({ port: 4319, telegram: null, extensionId: '' })
  })

  it('reads the port, the Telegram pair and the extension ID', () => {
    const env = { PORT: '5000', TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_CHAT_ID: '42', EXTENSION_ID: 'abcdefghijklmnopabcdefghijklmnop' }

    expect(readEnv(env)).toEqual({
      port: 5000,
      telegram: { botToken: '1:abc', chatId: '42' },
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    })
  })

  it.each([
    { TELEGRAM_BOT_TOKEN: '1:abc' },
    { TELEGRAM_CHAT_ID: '42' },
    { TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_CHAT_ID: '' },
  ])('leaves Telegram unconfigured when either value is missing or empty (%j)', (env) => {
    expect(readEnv(env).telegram).toBeNull()
  })

  it('treats an empty PORT as the default', () => {
    expect(readEnv({ PORT: '' }).port).toBe(4319)
  })

  it.each(['abc', '0', '70000', '43.5'])('refuses to start on PORT=%s', (PORT) => {
    expect(() => readEnv({ PORT })).toThrow(/PORT/)
  })
})

describe('bindHost', () => {
  it('binds loopback only by default and all interfaces once Wi-Fi access was saved', () => {
    expect(bindHost(false)).toBe('127.0.0.1')
    expect(bindHost(true)).toBe('0.0.0.0')
  })
})

describe('prepareDataDir', () => {
  const fresh = () => join(mkdtempSync(join(tmpdir(), 'pickup-watch-')), 'data')

  it('creates data/ as 0700 and the db file as 0600', () => {
    const dir = fresh()

    const db = prepareDataDir(dir)

    expect(db).toBe(join(dir, 'pickup-watch.db'))
    expect(mode(dir)).toBe(0o700)
    expect(mode(db)).toBe(0o600)
  })

  it('tightens the modes of a directory and db file that already exist', () => {
    const dir = fresh()
    mkdirSync(dir, { mode: 0o755 })
    writeFileSync(join(dir, 'pickup-watch.db'), 'existing', { mode: 0o644 })

    const db = prepareDataDir(dir)

    expect(mode(dir)).toBe(0o700)
    expect(mode(db)).toBe(0o600)
  })
})
