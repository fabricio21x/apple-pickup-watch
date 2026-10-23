The repository has no code, configuration, tests or commits yet; every row below is a document or an outside service the new code must respect.

## Impact map: greenfield Apple Store pickup monitor

| Area | What | Evidence | Why it matters |
|---|---|---|---|
| Doc | Spec scope | `docs/features/2026-10-22-pickup-watch/spec.md:20-32` | Every module the design adds must trace to one of these lines: catalog, watches, location, other colors, poller, token, stock state, alerts, health, UI, network exposure. |
| Doc | Spec out-of-scope list | `docs/features/2026-10-22-pickup-watch/spec.md:35-43` | Bounds the build: no login, deploy, multi-zip, non-US, model-level watches, checkout automation, autocomplete or sleep handling. |
| Doc | Spec acceptance criteria | `docs/features/2026-10-22-pickup-watch/spec.md:46-64` | Each test seam checks one of these lines; criterion 46 names the "iPhone 18 Pro" page, which also carries the 18 Pro Max. |
| Doc | Spec Facts: deadline, single user, US only, always-on Mac, stack preference, shadcn/ui, local first | `docs/features/2026-10-22-pickup-watch/spec.md:67-77` | The design's constraints and its technology choice rest on these lines. |
| Doc | Spec decision log | `docs/features/2026-10-22-pickup-watch/spec.md:89-108` | Settled input: one request per cycle, other colors in the same request, edge-triggered alerts, Telegram, token source order, localhost default; the stack is decided here with the preference as a constraint. |
| Doc | Persisted state and restart rule | `docs/features/2026-10-22-pickup-watch/spec.md:26`, `docs/features/2026-10-22-pickup-watch/spec.md:54` | The last known (part, store) state must survive a restart so unchanged pairs never re-alert. |
| Doc | Network exposure and secrets | `docs/features/2026-10-22-pickup-watch/spec.md:32`, `docs/features/2026-10-22-pickup-watch/spec.md:62-63` | The server binds to localhost by default, opts into the LAN, and no response may carry the bot token or Apple cookies. |
| External service | Apple `fulfillment-messages`: request and response | `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:9`, `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:21-27` | The poller builds `parts.N` and `location` and parses `stores[].partsAvailability[part].pickupDisplay` and `pickupSearchQuote` into stock state, Today/Tomorrow and the alert fields. |
| External service | Apple token contract with a 2 h hard expiry | `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:16-20` | The client sends the `dssid2` + `shld_bt_ck` pair with a browser User-Agent, classifies 541/HTML as token rejected, and any unattended source must refresh within 2 h. |
| External service | Apple `pickup-message-recommendations` | `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:10` | Returns the 12 nearest stores with no token, so the zip → store list step works before a token exists; unusable for other colors. |
| External service | Apple buy pages: phone variants, product list, URL tokens | `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:12`, `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:29-35` | The catalog keeps the 32 + 8 unlocked phone variants, drops `S…` parts, takes the model from `familyType`, groups other colors by `familyType` + `dimensionCapacity`, and builds links from `seoUrlToken`. |
| External service | Untested Apple behaviour | `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:37-42` | Datacenter IP, automated token, zip in the link and the 60 s block rate are checked in the spike or during implementation, or carried as risks. |
| External service | Telegram Bot API | `docs/features/2026-10-22-pickup-watch/spec.md:27-30`, `docs/features/2026-10-22-pickup-watch/spec.md:59`, `docs/features/2026-10-22-pickup-watch/spec.md:96-97` | Outbound `sendMessage` with an inline URL button for alerts, health and the test message; the bot token and chat id are new configuration no response may return. |

## Checked, not touched
- .git
- docs/features/2026-10-22-pickup-watch/trial-1
