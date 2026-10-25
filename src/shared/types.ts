export type PartNumber = string
export type StoreNumber = string

export type CatalogPart = {
  part: PartNumber
  modelName: string
  capacity: string
  colorName: string
  title: string
  buyUrl: string
}

export type Pickup = { kind: 'in'; label: string } | { kind: 'out' }

export type TrackedPair =
  | { part: PartNumber; store: StoreNumber; role: 'watched' }
  | { part: PartNumber; store: StoreNumber; role: 'other'; relatedColors: string[] }

export type Observation = { part: PartNumber; store: StoreNumber; pickup: Pickup }

export type StockEvent = { kind: 'in' | 'out'; pair: TrackedPair; label?: string }

export type StockMessage = {
  group: { modelName: string; capacity: string }
  sound: boolean
  colors: {
    colorName: string
    role: TrackedPair['role']
    buyUrl: string
    stores: { store: StoreNumber; name: string; distanceMi: number; label: string | 'not checked'; isNew: boolean }[]
  }[]
  gone: { colorName: string; storeName: string }[]
  commit: { insert: TrackedPair[]; delete: TrackedPair[] }
}

export type CheckOutcome =
  | {
      ok: true
      observations: Observation[]
      stores: { store: StoreNumber; name: string; distanceMi: number }[]
    }
  | { ok: false; cause: 'network' | 'token-expired' | 'token-rejected' | 'network-limited' | 'unexpected' }

export type GridCell = {
  part: PartNumber
  store: StoreNumber
  badge: 'Today' | 'Tomorrow' | string | 'Unavailable' | 'Not checked'
}

export type TokenStatus = 'missing' | 'untested' | 'working' | 'rejected' | 'expired'

export type TelegramError = { kind: 'network' | 'timeout' | 'http'; status?: number; description?: string }

export type StoreDto = {
  store: StoreNumber
  name: string
  city: string
  state: string
  distanceMi: number
  enabled: boolean
}

export type WatchDto = { part: PartNumber; otherColors: boolean; cells: GridCell[] }

export type HealthDto = {
  status: 'healthy' | 'failing' | 'down'
  failures: number
  cause: Extract<CheckOutcome, { ok: false }>['cause'] | null
}

export type StateDto = {
  zip: string | null
  stores: StoreDto[]
  parts: CatalogPart[]
  watches: WatchDto[]
  lastCheckAt: number | null
  lastSuccessAt: number | null
  intervalSec: number
  lan: { enabled: boolean; restartRequired: boolean; urls: string[] }
  token: { status: TokenStatus; expiresAt: number | null }
  telegram: { configured: boolean; lastError: TelegramError | null }
  health: HealthDto
  partsCount: { tracked: number; cap: 20; unchecked: PartNumber[] }
}
