import { useCallback, useEffect, useState } from 'react'
import type { StateDto } from '../shared/types'
import { api, ApiError } from './api'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Location } from './Location'
import { SettingsStrip } from './SettingsStrip'
import { Watches } from './Watches'
import { healthText } from './logic'

const POLL_MS = 5000

export type Act = (action: () => Promise<unknown>) => Promise<void>

export const formatTime = (ms: number) =>
  new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })

export default function App() {
  const [state, setState] = useState<StateDto | null>(null)
  const [offline, setOffline] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setState(await api.state())
      setOffline(false)
    } catch {
      setOffline(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  const act: Act = async (action) => {
    setMessage(null)
    try {
      await action()
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Could not reach the server.')
    }
    await refresh()
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">Pickup watch</h1>
      {offline && (
        <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">
          Cannot reach the monitor. Retrying every {POLL_MS / 1000} s.
        </p>
      )}
      {message && (
        <p role="alert" className="rounded-md border border-destructive p-3 text-sm break-words text-destructive">
          {message}
        </p>
      )}
      {state ? (
        <>
          <StatusHeader state={state} />
          <Location state={state} act={act} />
          <Watches state={state} act={act} />
          <SettingsStrip state={state} act={act} />
        </>
      ) : (
        !offline && <p className="text-sm text-muted-foreground">Loading…</p>
      )}
    </main>
  )
}

function StatusHeader({ state }: { state: StateDto }) {
  const { health, lastSuccessAt } = state
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Status
          <Badge variant={health.status === 'healthy' ? 'default' : 'destructive'}>{health.status}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <p className="break-words">{healthText(health)}</p>
        <p className="text-muted-foreground">
          Last successful check: {lastSuccessAt === null ? 'none yet' : formatTime(lastSuccessAt)}
        </p>
      </CardContent>
    </Card>
  )
}
