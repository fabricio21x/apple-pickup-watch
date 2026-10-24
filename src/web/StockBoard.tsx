import type { StateDto } from '../shared/types'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatTime, healthText, stockBoard } from './logic'

export function StockBoard({ state }: { state: StateDto }) {
  const { health, lastSuccessAt } = state
  const blocks = stockBoard(state)

  return (
    <>
      <Card>
        <CardContent className="space-y-1 text-sm">
          <p className="text-muted-foreground">
            Last successful check: {lastSuccessAt === null ? 'none yet' : formatTime(lastSuccessAt)}
          </p>
          <p className={health.status === 'healthy' ? 'break-words' : 'break-words text-destructive'}>
            {healthText(health)}
          </p>
        </CardContent>
      </Card>
      {blocks.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nothing to show yet. Watch a phone in Watches and enable a store in Stores.
        </p>
      )}
      {blocks.map((b) => (
        <Card key={`${b.model}/${b.capacity}`}>
          <CardHeader>
            <CardTitle className="break-words">
              {b.model} <span className="uppercase">{b.capacity}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {b.rows.map((r) => {
                const inStock = r.badge !== 'Unavailable' && r.badge !== 'Not checked'
                return (
                  <li key={`${r.part}/${r.store.store}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                        <span className="break-words">{r.colorName}</span>
                        {r.role === 'other' && <Badge variant="outline">Other color</Badge>}
                      </p>
                      <p className="text-xs break-words text-muted-foreground">
                        {inStock ? (
                          <a href={r.buyUrl} target="_blank" rel="noreferrer" className="underline">
                            {r.store.name}
                          </a>
                        ) : (
                          r.store.name
                        )}{' '}
                        · {r.store.distanceMi.toFixed(1)} mi
                      </p>
                    </div>
                    <Badge
                      variant={inStock ? 'default' : r.badge === 'Unavailable' ? 'secondary' : 'outline'}
                      className="h-auto max-w-[45%] rounded-md text-center whitespace-normal"
                    >
                      {r.badge}
                    </Badge>
                  </li>
                )
              })}
            </ul>
          </CardContent>
        </Card>
      ))}
    </>
  )
}
