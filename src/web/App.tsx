import { useCallback, useEffect, useState } from 'react'
import { Eye, PackageCheck, Settings as SettingsIcon, Store, type LucideIcon } from 'lucide-react'
import type { StateDto } from '../shared/types'
import { api, ApiError } from './api'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Settings } from './Settings'
import { StockBoard } from './StockBoard'
import { Stores } from './Stores'
import { Watches } from './Watches'
import { tokenLabel, viewFromHash, VIEWS, type View } from './logic'

const POLL_MS = 5000

export type Act = (action: () => Promise<unknown>) => Promise<boolean>

const NAV: Record<View, { label: string; Icon: LucideIcon }> = {
  stock: { label: 'Stock', Icon: PackageCheck },
  watches: { label: 'Watches', Icon: Eye },
  stores: { label: 'Stores', Icon: Store },
  settings: { label: 'Settings', Icon: SettingsIcon },
}

function useView(): View {
  const [view, setView] = useState(() => viewFromHash(window.location.hash))

  useEffect(() => {
    const onHashChange = () => setView(viewFromHash(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return view
}

export default function App() {
  const view = useView()
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

  useEffect(() => setMessage(null), [view])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  const act: Act = async (action) => {
    setMessage(null)
    let ok = true
    try {
      await action()
    } catch (e) {
      ok = false
      setMessage(e instanceof ApiError ? e.message : 'Could not reach the server.')
    }
    await refresh()
    return ok
  }

  return (
    <div className="min-h-screen md:pl-56">
      <aside className="fixed inset-y-0 left-0 hidden w-56 flex-col gap-6 border-r bg-background p-4 md:flex">
        <h1 className="text-xl font-semibold">Pickup watch</h1>
        <nav className="flex flex-col gap-1" aria-label="Views">
          {VIEWS.map((v) => (
            <NavLink key={v} target={v} active={v === view} className="flex-row justify-start gap-3 rounded-md px-3 py-2 text-sm" />
          ))}
        </nav>
        {state && view !== 'stock' && <StatusChips state={state} className="flex-col items-start" />}
      </aside>
      <header className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b bg-background px-4 py-2 md:hidden">
        <h1 className="text-lg font-semibold">Pickup watch</h1>
        {state && view !== 'stock' && <StatusChips state={state} className="justify-end" />}
      </header>
      {/* 68.75rem is 1100px; an arbitrary px breakpoint would sort before md: and lose */}
      <main
        className={cn(
          'mx-auto flex w-full flex-col gap-4 p-4 pb-24 md:pb-4',
          view === 'stock'
            ? 'max-w-[752px] md:max-w-[784px] md:px-8 md:pt-7 md:pb-12 min-[68.75rem]:max-w-[1124px]'
            : 'max-w-2xl',
        )}
      >
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
        {view === 'stock' && (state || !offline) && <StockBoard state={state} />}
        {state ? (
          <>
            {view === 'watches' && <Watches state={state} act={act} />}
            {view === 'stores' && <Stores state={state} act={act} />}
            {view === 'settings' && <Settings state={state} act={act} />}
          </>
        ) : (
          view !== 'stock' && !offline && <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </main>
      <nav
        aria-label="Views"
        className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-4 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {VIEWS.map((v) => (
          <NavLink key={v} target={v} active={v === view} className="flex-col gap-1 py-2 text-xs" />
        ))}
      </nav>
    </div>
  )
}

function NavLink({ target, active, className }: { target: View; active: boolean; className: string }) {
  const { label, Icon } = NAV[target]
  return (
    <a
      href={`#/${target}`}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center justify-center font-medium',
        active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50',
        className,
      )}
    >
      <Icon className="size-5" aria-hidden />
      {label}
    </a>
  )
}

function StatusChips({ state, className }: { state: StateDto; className: string }) {
  const { health, token } = state
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Badge variant={health.status === 'healthy' ? 'default' : 'destructive'}>{health.status}</Badge>
      <Badge variant={token.status === 'working' ? 'default' : 'secondary'}>Token: {tokenLabel(token.status)}</Badge>
    </div>
  )
}
