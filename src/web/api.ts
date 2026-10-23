import type { PartNumber, StateDto, StoreNumber, TelegramError, TokenStatus } from '../shared/types'
import { errorMessage, telegramErrorText, type ApiErrorBody } from './logic'

export class ApiError extends Error {
  constructor(public body: ApiErrorBody) {
    super(errorMessage(body))
  }
}

async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  const json: unknown = await res.json().catch(() => ({ error: `http-${res.status}` }))
  return { res, json }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { res, json } = await send(method, path, body)
  if (!res.ok) throw new ApiError(json as ApiErrorBody)
  return json as T
}

const part = (p: PartNumber) => encodeURIComponent(p)

export const api = {
  state: () => request<StateDto>('GET', '/state'),
  setZip: (zip: string) => request('PUT', '/zip', { zip }),
  setStore: (store: StoreNumber, enabled: boolean) => request('PUT', `/stores/${encodeURIComponent(store)}`, { enabled }),
  addWatches: (parts: PartNumber[]) => request('POST', '/watches', { parts }),
  removeWatch: (p: PartNumber) => request('DELETE', `/watches/${part(p)}`),
  setOtherColors: (p: PartNumber, otherColors: boolean) => request('PATCH', `/watches/${part(p)}`, { otherColors }),
  setInterval: (seconds: number) => request('PUT', '/interval', { seconds }),
  setLan: (enabled: boolean) => request('PUT', '/lan', { enabled }),
  setToken: (curl: string) =>
    request<{ stored: boolean; token: { status: TokenStatus; expiresAt: number | null } }>('POST', '/token', { curl }),
  testTelegram: async (): Promise<string | null> => {
    const { res, json } = await send('POST', '/telegram/test')
    if (res.ok) return null
    if (res.status === 502) return telegramErrorText((json as { error: TelegramError }).error)
    throw new ApiError(json as ApiErrorBody)
  },
}
