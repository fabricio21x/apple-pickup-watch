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

export type CheckOutcome =
  | {
      ok: true
      observations: Observation[]
      stores: { store: StoreNumber; name: string; distanceMi: number }[]
    }
  | { ok: false; cause: 'network' | 'token-expired' | 'token-rejected' | 'unexpected' }

export type GridCell = {
  part: PartNumber
  store: StoreNumber
  badge: 'Today' | 'Tomorrow' | string | 'Unavailable' | 'Not checked'
}

export type TokenStatus = 'missing' | 'untested' | 'working' | 'rejected' | 'expired'

export type TelegramError = { kind: 'network' | 'timeout' | 'http'; status?: number; description?: string }
