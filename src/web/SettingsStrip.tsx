import { useState } from 'react'
import type { StateDto } from '../shared/types'
import { formatTime, type Act } from './App'
import { api, ApiError } from './api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { lanUrls, telegramErrorText, timeLeft, tokenLabel } from './logic'

export function SettingsStrip({ state, act }: { state: StateDto; act: Act }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
      </CardHeader>
      <CardContent className="divide-y [&>section]:space-y-2 [&>section]:py-4 first:[&>section]:pt-0 last:[&>section]:pb-0">
        <TelegramSetting telegram={state.telegram} />
        <TokenSetting token={state.token} act={act} />
        <IntervalSetting intervalSec={state.intervalSec} act={act} />
        <LanSetting lan={state.lan} act={act} />
      </CardContent>
    </Card>
  )
}

function TelegramSetting({ telegram }: { telegram: StateDto['telegram'] }) {
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const send = async () => {
    setBusy(true)
    try {
      setResult((await api.testTelegram()) ?? 'Test message sent.')
    } catch (e) {
      setResult(e instanceof ApiError ? e.message : 'Could not reach the server.')
    }
    setBusy(false)
  }

  return (
    <section>
      <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
        Telegram
        <Badge variant={telegram.configured ? 'default' : 'secondary'}>
          {telegram.configured ? 'Configured' : 'Not configured'}
        </Badge>
      </h3>
      {!telegram.configured && (
        <p className="text-sm text-muted-foreground">Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env and restart.</p>
      )}
      {telegram.lastError && (
        <p className="text-sm break-words text-destructive">Last error: {telegramErrorText(telegram.lastError)}</p>
      )}
      <Button variant="outline" size="sm" onClick={() => void send()} disabled={!telegram.configured || busy}>
        Send test message
      </Button>
      {result && (
        <p role="status" className="text-sm break-words">
          {result}
        </p>
      )}
    </section>
  )
}

function TokenSetting({ token, act }: { token: StateDto['token']; act: Act }) {
  const [open, setOpen] = useState(false)
  const [curl, setCurl] = useState('')
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    try {
      await api.setToken(curl)
      setOpen(false)
      setCurl('')
      await act(async () => {})
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the server.')
    }
  }

  return (
    <section>
      <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
        Apple token
        <Badge variant={token.status === 'working' ? 'default' : 'secondary'}>{tokenLabel(token.status)}</Badge>
      </h3>
      {token.expiresAt !== null && (
        <p className="text-sm text-muted-foreground">
          {timeLeft(token.expiresAt, Date.now())} (expires {formatTime(token.expiresAt)})
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          setError(null)
        }}
      >
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            Paste cURL
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Paste cURL</DialogTitle>
            <DialogDescription>
              In Brave, open apple.com, then DevTools, Network. Right-click a request to apple.com and choose Copy as cURL.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="cURL command"
            value={curl}
            onChange={(e) => setCurl(e.target.value)}
            className="h-40 field-sizing-fixed overflow-y-auto font-mono text-xs break-all"
          />
          {error && (
            <p role="alert" className="text-sm break-words text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button onClick={() => void save()} disabled={curl.trim() === ''}>
              Save token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function IntervalSetting({ intervalSec, act }: { intervalSec: number; act: Act }) {
  const [seconds, setSeconds] = useState(String(intervalSec))

  return (
    <section>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void act(() => api.setInterval(Number(seconds)))
        }}
      >
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="interval">Check interval (seconds, 30 to 3600)</Label>
          <Input
            id="interval"
            type="number"
            inputMode="numeric"
            min={30}
            max={3600}
            step={1}
            value={seconds}
            onChange={(e) => setSeconds(e.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={seconds === '' || Number(seconds) === intervalSec}>
          Save
        </Button>
      </form>
    </section>
  )
}

function LanSetting({ lan, act }: { lan: StateDto['lan']; act: Act }) {
  const urls = lanUrls(lan.urls)

  return (
    <section>
      <div className="flex items-center gap-2">
        <Switch id="lan" checked={lan.enabled} onCheckedChange={(on) => void act(() => api.setLan(on))} />
        <Label htmlFor="lan">Wi-Fi access from other devices</Label>
      </div>
      {lan.restartRequired && (
        <p className="text-sm text-muted-foreground">Restart the monitor to apply this change.</p>
      )}
      {lan.enabled && urls.length > 0 && (
        <ul className="text-sm">
          {urls.map((u) => (
            <li key={u} className="break-all">
              <a href={u} className="underline">
                {u}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
