import { useState, type FormEvent } from 'react'
import type { StateDto } from '../shared/types'
import type { Act } from './App'
import { api } from './api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

export function Location({ state, act }: { state: StateDto; act: Act }) {
  const [zip, setZip] = useState(state.zip ?? '')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    await act(() => api.setZip(zip))
    setBusy(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Location</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={submit} className="flex items-end gap-2">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="zip">Zip code</Label>
            <Input
              id="zip"
              inputMode="numeric"
              pattern="\d{5}"
              maxLength={5}
              placeholder="10001"
              value={zip}
              onChange={(e) => setZip(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={busy || !/^\d{5}$/.test(zip)}>
            {busy ? 'Finding…' : 'Find stores'}
          </Button>
        </form>
        {state.stores.length === 0 ? (
          <p className="text-sm text-muted-foreground">Enter a zip to list nearby Apple Stores.</p>
        ) : (
          <ul className="divide-y">
            {state.stores.map((s) => (
              <li key={s.store} className="flex items-center justify-between gap-3 py-2">
                <Label htmlFor={`store-${s.store}`} className="min-w-0 flex-col items-start gap-0 break-words">
                  <span>{s.name}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {s.city}, {s.state} · {s.distanceMi.toFixed(1)} mi
                  </span>
                </Label>
                <Switch
                  id={`store-${s.store}`}
                  checked={s.enabled}
                  onCheckedChange={(enabled) => void act(() => api.setStore(s.store, enabled))}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
