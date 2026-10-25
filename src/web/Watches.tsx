import { useState } from 'react'
import type { PartNumber, StateDto, WatchDto } from '../shared/types'
import type { Act } from './App'
import { api } from './api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { buildCatalogTree, partsToWatch } from './logic'

export function Watches({ state, act }: { state: StateDto; act: Act }) {
  const { tracked, cap, unchecked } = state.partsCount

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Watching</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm">
            {tracked} / {cap} parts tracked
          </p>
          {unchecked.length > 0 && (
            <p className="text-sm text-destructive">Over the cap: {unchecked.length} other-color parts not checked</p>
          )}
          {state.watches.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing watched yet. Pick configurations below.</p>
          ) : (
            <ul className="divide-y">
              {state.watches.map((w) => (
                <WatchRow key={w.part} watch={w} state={state} act={act} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Picker state={state} act={act} />
    </>
  )
}

function Picker({ state, act }: { state: StateDto; act: Act }) {
  const [selected, setSelected] = useState<ReadonlySet<PartNumber>>(new Set())
  const tree = buildCatalogTree(state.parts)
  const watched = new Set(state.watches.map((w) => w.part))
  const toWatch = partsToWatch(selected, state.watches)

  const toggle = (part: PartNumber, on: boolean) => {
    const next = new Set(selected)
    if (on) next.add(part)
    else next.delete(part)
    setSelected(next)
  }

  const add = async () => {
    if (await act(() => api.addWatches(toWatch))) setSelected(new Set())
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Watch a phone</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {tree.length === 0 && <p className="text-sm text-muted-foreground">The product catalog is not loaded yet.</p>}
        {tree.map((m) => (
          <fieldset key={m.model} className="min-w-0 space-y-2">
            <legend className="font-medium break-words">{m.model}</legend>
            {m.storages.map((s) => (
              <div key={s.capacity} className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground uppercase">{s.capacity}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {s.colors.map((c) => (
                    <div key={c.part} className="flex items-center gap-2">
                      <Checkbox
                        id={`pick-${c.part}`}
                        checked={watched.has(c.part) || selected.has(c.part)}
                        disabled={watched.has(c.part)}
                        onCheckedChange={(on) => toggle(c.part, on === true)}
                      />
                      <Label htmlFor={`pick-${c.part}`} className="font-normal">
                        {c.colorName}
                      </Label>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </fieldset>
        ))}
        <Button onClick={() => void add()} disabled={toWatch.length === 0}>
          {toWatch.length === 0 ? 'Select configurations' : `Watch ${toWatch.length} selected`}
        </Button>
      </CardContent>
    </Card>
  )
}

function WatchRow({ watch, state, act }: { watch: WatchDto; state: StateDto; act: Act }) {
  const title = state.parts.find((p) => p.part === watch.part)?.title ?? watch.part
  const switchId = `other-${watch.part}`

  return (
    <li className="space-y-2 py-3">
      <p className="text-sm font-medium break-words">{title}</p>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Switch
            id={switchId}
            checked={watch.otherColors}
            onCheckedChange={(on) => void act(() => api.setOtherColors(watch.part, on))}
          />
          <Label htmlFor={switchId} className="font-normal">
            Also alert for other colors
          </Label>
        </div>
        <Button variant="outline" size="sm" onClick={() => void act(() => api.removeWatch(watch.part))}>
          Remove
        </Button>
      </div>
    </li>
  )
}
