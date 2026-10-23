import Database from 'better-sqlite3'
import type { CatalogPart, PartNumber, StoreNumber, TrackedPair } from '../shared/types'
import type { AppleToken, StoreInfo } from './apple'
import type { AlertedRow, FailureCause, HealthState, Watch } from './domain'

export type StoreRow = StoreInfo & { enabled: boolean }
export type Settings = {
  zip: string | null
  token: AppleToken | null
  tokenWarned: boolean
  intervalSec: number
  lanEnabled: boolean
}
export type Health = HealthState & { cause: FailureCause | null }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS parts (
  part TEXT PRIMARY KEY,
  model_name TEXT NOT NULL,
  capacity TEXT NOT NULL,
  color_name TEXT NOT NULL,
  title TEXT NOT NULL,
  buy_url TEXT NOT NULL,
  sort INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stores (
  store_number TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  distance_mi REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS watches (
  part TEXT PRIMARY KEY REFERENCES parts(part),
  other_colors INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alerted (
  part TEXT NOT NULL,
  store_number TEXT NOT NULL,
  PRIMARY KEY (part, store_number)
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  zip TEXT,
  interval_sec INTEGER NOT NULL DEFAULT 60,
  lan_enabled INTEGER NOT NULL DEFAULT 0,
  token_dssid2 TEXT,
  token_shld TEXT,
  token_ua TEXT,
  token_expires_at INTEGER,
  token_warned INTEGER NOT NULL DEFAULT 0,
  health_failures INTEGER NOT NULL DEFAULT 0,
  health_down_announced INTEGER NOT NULL DEFAULT 0,
  health_cause TEXT
);
INSERT OR IGNORE INTO settings (id) VALUES (1);
`

type PartRow = {
  part: string
  model_name: string
  capacity: string
  color_name: string
  title: string
  buy_url: string
}
type StoreDbRow = {
  store_number: string
  name: string
  city: string
  state: string
  distance_mi: number
  enabled: number
}
type WatchDbRow = { part: string; other_colors: number }
type AlertedDbRow = { part: string; store_number: string }
type SettingsDbRow = {
  zip: string | null
  token_dssid2: string | null
  token_shld: string | null
  token_ua: string | null
  token_expires_at: number | null
  token_warned: number
  interval_sec: number
  lan_enabled: number
}
type HealthDbRow = { health_failures: number; health_down_announced: number; health_cause: FailureCause | null }

export function openDb(path: string) {
  const conn = new Database(path)
  conn.exec(SCHEMA)

  const upsertPart = conn.prepare(
    `INSERT INTO parts (part, model_name, capacity, color_name, title, buy_url, sort)
     VALUES (@part, @modelName, @capacity, @colorName, @title, @buyUrl, @sort)
     ON CONFLICT(part) DO UPDATE SET model_name = @modelName, capacity = @capacity, color_name = @colorName,
       title = @title, buy_url = @buyUrl, sort = @sort`,
  )
  const selectParts = conn.prepare<[], PartRow>('SELECT * FROM parts ORDER BY sort')

  const upsertStore = conn.prepare(
    `INSERT INTO stores (store_number, name, city, state, distance_mi, enabled)
     VALUES (@store, @name, @city, @state, @distanceMi, 1)
     ON CONFLICT(store_number) DO UPDATE SET name = @name, city = @city, state = @state, distance_mi = @distanceMi`,
  )
  const selectStores = conn.prepare<[], StoreDbRow>('SELECT * FROM stores ORDER BY distance_mi, store_number')
  const deleteStore = conn.prepare('DELETE FROM stores WHERE store_number = ?')
  const updateStoreEnabled = conn.prepare('UPDATE stores SET enabled = ? WHERE store_number = ?')

  const insertWatch = conn.prepare('INSERT INTO watches (part, other_colors, created_at) VALUES (?, ?, ?)')
  const selectWatches = conn.prepare<[], WatchDbRow>('SELECT part, other_colors FROM watches ORDER BY created_at, part')
  const updateOtherColors = conn.prepare('UPDATE watches SET other_colors = ? WHERE part = ?')
  const deleteWatch = conn.prepare('DELETE FROM watches WHERE part = ?')

  const selectAlerted = conn.prepare<[], AlertedDbRow>('SELECT part, store_number FROM alerted ORDER BY part, store_number')
  const insertAlerted = conn.prepare('INSERT OR IGNORE INTO alerted (part, store_number) VALUES (?, ?)')
  const deleteAlerted = conn.prepare('DELETE FROM alerted WHERE part = ? AND store_number = ?')
  const deleteAlertedForPart = conn.prepare('DELETE FROM alerted WHERE part = ?')

  const selectSettings = conn.prepare<[], SettingsDbRow>(
    'SELECT zip, token_dssid2, token_shld, token_ua, token_expires_at, token_warned, interval_sec, lan_enabled FROM settings WHERE id = 1',
  )
  const updateZip = conn.prepare('UPDATE settings SET zip = ? WHERE id = 1')
  const updateIntervalSec = conn.prepare('UPDATE settings SET interval_sec = ? WHERE id = 1')
  const updateLanEnabled = conn.prepare('UPDATE settings SET lan_enabled = ? WHERE id = 1')
  const updateToken = conn.prepare(
    'UPDATE settings SET token_dssid2 = ?, token_shld = ?, token_ua = ?, token_expires_at = ?, token_warned = 0 WHERE id = 1',
  )
  const updateTokenWarned = conn.prepare('UPDATE settings SET token_warned = ? WHERE id = 1')
  const selectHealth = conn.prepare<[], HealthDbRow>(
    'SELECT health_failures, health_down_announced, health_cause FROM settings WHERE id = 1',
  )
  const updateHealth = conn.prepare(
    'UPDATE settings SET health_failures = ?, health_down_announced = ?, health_cause = ? WHERE id = 1',
  )

  const transaction = <T>(fn: () => T): T => conn.transaction(fn)()

  return {
    transaction,
    close: () => conn.close(),

    upsertParts(parts: CatalogPart[]): void {
      transaction(() => parts.forEach((p, sort) => upsertPart.run({ ...p, sort })))
    },
    listParts(): CatalogPart[] {
      return selectParts.all().map((r) => ({
        part: r.part,
        modelName: r.model_name,
        capacity: r.capacity,
        colorName: r.color_name,
        title: r.title,
        buyUrl: r.buy_url,
      }))
    },

    replaceStores(stores: StoreInfo[]): void {
      transaction(() => {
        stores.forEach((s) => upsertStore.run(s))
        const listed = new Set(stores.map((s) => s.store))
        selectStores.all().forEach((r) => {
          if (!listed.has(r.store_number)) deleteStore.run(r.store_number)
        })
      })
    },
    listStores(): StoreRow[] {
      return selectStores.all().map((r) => ({
        store: r.store_number,
        name: r.name,
        city: r.city,
        state: r.state,
        distanceMi: r.distance_mi,
        enabled: r.enabled === 1,
      }))
    },
    setStoreEnabled(store: StoreNumber, enabled: boolean): void {
      updateStoreEnabled.run(enabled ? 1 : 0, store)
    },

    addWatch(part: PartNumber, otherColors: boolean, createdAt: number): void {
      insertWatch.run(part, otherColors ? 1 : 0, createdAt)
    },
    listWatches(): Watch[] {
      return selectWatches.all().map((r) => ({ part: r.part, otherColors: r.other_colors === 1 }))
    },
    setOtherColors(part: PartNumber, otherColors: boolean): void {
      updateOtherColors.run(otherColors ? 1 : 0, part)
    },
    removeWatch(part: PartNumber): void {
      deleteWatch.run(part)
    },

    listAlerted(): AlertedRow[] {
      return selectAlerted.all().map((r) => ({ part: r.part, store: r.store_number }))
    },
    insertAlerted(row: AlertedRow): void {
      insertAlerted.run(row.part, row.store)
    },
    deleteAlerted(row: AlertedRow): void {
      deleteAlerted.run(row.part, row.store)
    },
    deleteAlertedForPart(part: PartNumber): void {
      deleteAlertedForPart.run(part)
    },
    pruneAlerted(tracked: TrackedPair[]): void {
      const keep = new Set(tracked.map((p) => `${p.part}/${p.store}`))
      transaction(() => {
        selectAlerted.all().forEach((r) => {
          if (!keep.has(`${r.part}/${r.store_number}`)) deleteAlerted.run(r.part, r.store_number)
        })
      })
    },

    getSettings(): Settings {
      const row = selectSettings.get()
      if (!row) throw new Error('settings row missing')
      const { token_dssid2, token_shld, token_ua, token_expires_at } = row
      const token =
        token_dssid2 !== null && token_shld !== null && token_ua !== null && token_expires_at !== null
          ? { dssid2: token_dssid2, shldBtCk: token_shld, userAgent: token_ua, expiresAt: token_expires_at }
          : null
      return {
        zip: row.zip,
        token,
        tokenWarned: row.token_warned === 1,
        intervalSec: row.interval_sec,
        lanEnabled: row.lan_enabled === 1,
      }
    },
    setZip(zip: string | null): void {
      updateZip.run(zip)
    },
    setIntervalSec(sec: number): void {
      updateIntervalSec.run(sec)
    },
    setLanEnabled(enabled: boolean): void {
      updateLanEnabled.run(enabled ? 1 : 0)
    },
    setToken(token: AppleToken): void {
      updateToken.run(token.dssid2, token.shldBtCk, token.userAgent, token.expiresAt)
    },
    clearToken(): void {
      updateToken.run(null, null, null, null)
    },
    setTokenWarned(warned: boolean): void {
      updateTokenWarned.run(warned ? 1 : 0)
    },

    getHealth(): Health {
      const row = selectHealth.get()
      if (!row) throw new Error('settings row missing')
      return { failures: row.health_failures, downAnnounced: row.health_down_announced === 1, cause: row.health_cause }
    },
    setHealth(health: Health): void {
      updateHealth.run(health.failures, health.downAnnounced ? 1 : 0, health.cause)
    },
  }
}

export type Db = ReturnType<typeof openDb>
