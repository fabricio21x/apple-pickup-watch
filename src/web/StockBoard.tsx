import { useEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight, Check, ChevronRight } from 'lucide-react'
import type { StateDto } from '../shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  capNote,
  countLine,
  downBanner,
  formatClock,
  intervalText,
  plural,
  setupSteps,
  statusStrip,
  stockSections,
  type Phone,
  type StoreStock,
} from './logic'

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const LINK = cn('font-semibold underline underline-offset-2 rounded-sm', FOCUS)
const STALE_NOTE_ID = 'stale-note'
const STALE = 'grayscale [&_a]:opacity-70'

function useNow() {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

export function StockBoard({ state }: { state: StateDto | null }) {
  if (!state) return <Loading />

  const { inStock, quiet } = stockSections(state)
  const banner = downBanner(state)
  const setup = setupSteps(state)
  const note = capNote(state.partsCount)
  const lastGood = banner && state.lastSuccessAt !== null ? formatClock(state.lastSuccessAt, Date.now()) : null
  const staleTime = inStock.length > 0 ? lastGood : null

  return (
    <div
      className={cn(
        'flex flex-col',
        'min-[1100px]:grid min-[1100px]:grid-cols-[minmax(0,1fr)_280px] min-[1100px]:grid-rows-[auto_auto_auto_1fr] min-[1100px]:items-start min-[1100px]:gap-x-10',
      )}
    >
      {banner && (
        <div
          role="alert"
          className={cn(
            'mt-3 mb-1 rounded-[10px] border border-destructive/30 bg-destructive-bg px-3.5 py-3 text-sm leading-snug text-destructive',
            'min-[1100px]:col-span-full min-[1100px]:row-start-1 min-[1100px]:mt-0 min-[1100px]:mb-5',
          )}
        >
          <b className="mb-0.5 block text-[15px]">{banner.title}</b>
          {banner.reason}
          {staleTime && ` What you see below is from ${staleTime} and may be gone.`}
          <span className="mt-1 block">
            {banner.tokenFix ? (
              <>
                <a href="#/settings" className={LINK}>
                  Paste a new token in Settings
                </a>{' '}
                or start <code className="font-mono text-[0.9em]">npm run token:auto</code>.
              </>
            ) : (
              'The monitor keeps retrying.'
            )}
          </span>
        </div>
      )}

      <div className="min-[1100px]:col-start-2 min-[1100px]:row-start-2">
        <Status state={state} />
        {setup.complete && note && (
          <p className="mt-1 mb-2 text-[13px] leading-snug text-ink-2 min-[1100px]:mt-3">
            {note}{' '}
            <a href="#/watches" className={LINK}>
              Trim your watches
            </a>{' '}
            to check them all.
          </p>
        )}
      </div>

      <div className="min-w-0 min-[1100px]:col-start-1 min-[1100px]:row-span-3 min-[1100px]:row-start-2">
        {!setup.complete ? (
          <Setup steps={setup} />
        ) : inStock.length === 0 ? (
          !banner && <NothingNearby state={state} phones={quiet.length} />
        ) : (
          <>
            {staleTime && (
              <p id={STALE_NOTE_ID} className="mt-1 mb-2 text-[13px] text-ink-2">
                Last known stock, {staleTime}
              </p>
            )}
            {inStock.map((p) => (
              <PhoneSection key={p.part} phone={p} stale={staleTime !== null} />
            ))}
          </>
        )}
      </div>

      {setup.complete && quiet.length > 0 && <QuietList phones={quiet} asOf={lastGood} />}
    </div>
  )
}

function Status({ state }: { state: StateDto }) {
  const now = useNow()
  const { checking, headline, ago, token, trouble } = statusStrip(state, now)
  return (
    <div
      className={cn(
        'grid grid-cols-[auto_1fr] items-center gap-x-2.5 gap-y-0.5 py-3.5 text-[13px] text-muted-foreground',
        'min-[1100px]:rounded-[10px] min-[1100px]:bg-secondary min-[1100px]:p-4',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-2 rounded-full',
          checking ? 'bg-today shadow-[0_0_0_3px_var(--today-bg)]' : 'bg-destructive shadow-[0_0_0_3px_var(--destructive-bg)]',
        )}
      />
      <span>
        <strong role="status" className="font-semibold text-ink-2">
          {headline}
        </strong>
        <span aria-hidden className={cn('text-border', 'min-[1100px]:hidden')}>
          {' '}
          ·{' '}
        </span>
        <span className={cn('tabular-nums', 'min-[1100px]:block min-[1100px]:first-letter:uppercase')}>{ago}</span>
      </span>
      <span className="col-start-2 tabular-nums">{token}</span>
      <span role="status" className="col-start-2 break-words text-destructive empty:hidden">
        {trouble}
      </span>
    </div>
  )
}

function BuyButton({ phone, className }: { phone: Phone; className: string }) {
  return (
    <Button asChild className={cn('h-11 rounded-xl px-[18px] text-base font-semibold', className)}>
      <a
        href={phone.buyUrl}
        target="_blank"
        rel="noreferrer"
        aria-label={`Buy ${phone.colorName}, ${phone.model} ${phone.capacity}, on apple.com (opens a new tab)`}
      >
        Buy {phone.colorName}
        <ArrowUpRight aria-hidden />
      </a>
    </Button>
  )
}

function Finish({ phone, className }: { phone: Pick<Phone, 'finish'>; className: string }) {
  return (
    <span
      aria-hidden
      className={cn('shrink-0 rounded-full shadow-[inset_0_0_0_1px_oklch(0.2_0.01_70/0.18)]', className)}
      style={{ background: phone.finish ?? 'transparent' }}
    />
  )
}

function PhoneSection({ phone, stale }: { phone: Phone; stale: boolean }) {
  const title = `${phone.model} ${phone.capacity} ${phone.colorName}`
  return (
    <section
      aria-label={title}
      aria-describedby={stale ? STALE_NOTE_ID : undefined}
      className={cn('border-t border-border py-5 first:border-t-0 first:pt-3 min-[1100px]:first:pt-1', stale && STALE)}
    >
      <div className="grid grid-cols-[auto_1fr_auto] items-start gap-x-3 gap-y-1">
        <Finish phone={phone} className="mt-0.5 size-[22px]" />
        <div className="min-w-0">
          <h2 className="text-[19px] leading-tight font-semibold tracking-tight break-words">{phone.model}</h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span>
              {phone.capacity} · {phone.colorName}
            </span>
            {phone.role === 'other' && (
              <>
                <Badge variant="ghost" className="rounded-md bg-label-bg px-[7px] text-xs font-semibold text-ink-2">
                  Other color
                </Badge>
                {phone.watchedColors.length > 0 && <span>you watch {phone.watchedColors.join(', ')}</span>}
              </>
            )}
          </p>
        </div>
        <BuyButton phone={phone} className="hidden md:inline-flex" />
        <p className="col-start-2 -col-end-1 mt-1.5 text-sm font-semibold text-today">{countLine(phone)}</p>
      </div>
      <ul className="mt-3.5 border-t border-border-soft">
        {phone.available.map((r) => (
          <StoreRow key={`${r.store.store}/${r.badge}`} stock={r} />
        ))}
        {phone.unchecked.map((r) => (
          <StoreRow key={r.store.store} stock={r} />
        ))}
      </ul>
      <BuyButton phone={phone} className="mt-3.5 flex w-full md:hidden" />
      {phone.rest.length > 0 && (
        <details className="group mt-2.5">
          <summary
            className={cn(
              'inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md text-sm text-muted-foreground [&::-webkit-details-marker]:hidden',
              FOCUS,
            )}
          >
            <ChevronRight
              aria-hidden
              className="size-3.5 transition-transform duration-200 ease-out group-open:rotate-90 motion-reduce:transition-none"
            />
            Not at {phone.rest.length} other {phone.rest.length === 1 ? 'store' : 'stores'}
          </summary>
          <ul className="border-t border-border-soft">
            {phone.rest.map((r) => (
              <StoreRow key={r.store.store} stock={r} quiet />
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

const PILLS: Record<string, string> = {
  Today: 'bg-today-bg text-today',
  Tomorrow: 'bg-tomorrow-bg text-tomorrow',
  'Not checked': 'bg-border-soft text-muted-foreground',
}

function StoreRow({ stock: { store, badge }, quiet = false }: { stock: StoreStock; quiet?: boolean }) {
  return (
    <li
      className={cn(
        'grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-border-soft py-2 animate-in fade-in duration-200 motion-reduce:animate-none',
        quiet ? 'min-h-10' : 'min-h-[52px]',
      )}
    >
      <span className={cn('min-w-0 [overflow-wrap:anywhere]', quiet ? 'text-[15px] text-ink-2' : 'text-[17px] leading-tight font-medium')}>
        {store.name}
      </span>
      <span className="text-[15px] text-muted-foreground tabular-nums">{store.distanceMi.toFixed(1)} mi</span>
      {badge === 'Unavailable' ? (
        <span className="text-[13px] text-muted-foreground">Unavailable</span>
      ) : (
        <Badge
          variant="ghost"
          className={cn(
            'h-auto min-w-[84px] px-2.5 py-1 text-[13px] font-semibold whitespace-normal',
            PILLS[badge] ?? 'bg-label-bg text-label',
          )}
        >
          {badge}
        </Badge>
      )}
    </li>
  )
}

function QuietList({ phones, asOf }: { phones: Phone[]; asOf: string | null }) {
  return (
    <section
      aria-label="Not in stock nearby"
      className={cn(
        'mt-2 border-t border-border pt-[18px]',
        'min-[1100px]:col-start-2 min-[1100px]:row-start-3 min-[1100px]:mt-5 min-[1100px]:border-t-0 min-[1100px]:pt-0',
        asOf && 'grayscale',
      )}
    >
      <h2 className="mb-1.5 text-[13px] font-semibold tracking-wide text-muted-foreground uppercase">Not in stock nearby</h2>
      {asOf && <p className="mb-1.5 text-[13px] text-ink-2">As of the last check, {asOf}</p>}
      <ul>
        {phones.map((p) => (
          <li key={p.part} className="grid grid-cols-[auto_1fr] items-center gap-x-2.5 border-b border-border-soft py-2.5">
            <Finish phone={p} className="size-3.5" />
            <span className="text-[15px] font-medium break-words">
              {p.model} {p.capacity} · {p.colorName}
            </span>
            <span className="col-start-2 text-[13px] text-muted-foreground">{p.why}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function NothingNearby({ state, phones }: { state: StateDto; phones: number }) {
  const stores = plural(state.stores.filter((s) => s.enabled).length, 'store')
  return (
    <Empty title="Nothing nearby yet">
      {phones === 1 ? 'Your phone is' : `None of your ${phones} phones is`} in stock at your {stores}. The monitor checks{' '}
      {intervalText(state.intervalSec)}
      {state.telegram.configured && ' and Telegram alerts you the moment one appears'}.
    </Empty>
  )
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pt-9 pb-3">
      <h2 className="mb-1.5 text-[21px] font-semibold tracking-tight">{title}</h2>
      <p className="max-w-[46ch] text-[15px] leading-snug text-ink-2">{children}</p>
    </div>
  )
}

function Setup({ steps }: { steps: ReturnType<typeof setupSteps> }) {
  const items: { done: boolean; text: ReactNode }[] = [
    {
      done: steps.telegram,
      text: steps.telegram ? 'Telegram is connected' : 'Set the Telegram bot token and chat id in .env to get alerts',
    },
    {
      done: steps.stores,
      text: steps.stores ? (
        'Nearby stores are listed'
      ) : (
        <>
          <a href="#/stores" className={LINK}>
            Choose your zip code
          </a>{' '}
          in Stores to list nearby Apple Stores
        </>
      ),
    },
    {
      done: steps.watches,
      text: steps.watches ? (
        'iPhones are chosen'
      ) : (
        <>
          <a href="#/watches" className={LINK}>
            Pick the iPhones to watch
          </a>{' '}
          in Watches
        </>
      ),
    },
    {
      done: steps.token,
      text: steps.token ? (
        'Token is set'
      ) : (
        <>
          <a href="#/settings" className={LINK}>
            Paste a token
          </a>{' '}
          in Settings, or run <code className="font-mono text-[0.9em]">npm run token:auto</code>
        </>
      ),
    },
  ]
  return (
    <div className="pt-9 pb-3">
      <h2 className="mb-1.5 text-[21px] font-semibold tracking-tight">Set up your watch</h2>
      <p className="max-w-[46ch] text-[15px] leading-snug text-ink-2">
        Pick the iPhones you want and the stores you can reach. The board then shows where each one can be picked up.
      </p>
      <ol className="mt-[18px]">
        {items.map(({ done, text }, i) => (
          <li key={i} className="grid grid-cols-[28px_1fr] items-center gap-2.5 border-t border-border-soft py-3 text-[15px]">
            <span
              className={cn(
                'grid size-6 place-items-center rounded-full text-[13px] font-semibold',
                done ? 'bg-today-bg text-today' : 'bg-secondary text-ink-2',
              )}
            >
              {done ? <Check aria-label="Done" className="size-3.5" /> : i + 1}
            </span>
            <span>{text}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

const bone = 'animate-pulse rounded-md bg-border-soft motion-reduce:animate-none'

function Loading() {
  return (
    <div>
      <div role="status" className="py-3.5">
        <span className="sr-only">Loading stock…</span>
        <div className={cn(bone, 'h-3.5 w-56 max-w-full')} />
      </div>
      <section aria-busy className="py-5">
        <div className="flex items-start gap-3">
          <div className={cn(bone, 'size-[22px] rounded-full')} />
          <div className="space-y-1.5">
            <div className={cn(bone, 'h-5 w-44')} />
            <div className={cn(bone, 'h-3.5 w-28')} />
          </div>
        </div>
        <div className="mt-3.5 border-t border-border-soft">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="grid min-h-[52px] grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-border-soft py-2">
              <div className={cn(bone, 'h-4 w-3/5')} />
              <div className={cn(bone, 'h-3.5 w-12')} />
              <div className={cn(bone, 'h-6 w-[84px] rounded-full')} />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
