The repository holds no source code, configuration or tests yet, so no explorers ran; every row below is a document or an outside service the new code must respect.

## Impact map: greenfield Apple Store pickup monitor

| Area | What | Evidence | Why it matters |
|---|---|---|---|
| Doc | Spec scope | `docs/features/2026-10-22-pickup-watch/spec.md:20-32` | Every module the design adds must trace to one of these lines: catalog, watches, location, other colors, poller, token, stock state, alerts, health, UI, network exposure. |
| Doc | Spec out-of-scope list | `docs/features/2026-10-22-pickup-watch/spec.md:35-43` | Bounds the build: no login, deploy, multi-zip, non-US, model-level watches, checkout automation, autocomplete or sleep handling. |
| Doc | Spec acceptance criteria | `docs/features/2026-10-22-pickup-watch/spec.md:46-64` | Each test seam checks one of these lines; criterion 46 names the "iPhone 18 Pro" page, which also carries the 18 Pro Max. |
| Doc | Spec Facts | `docs/features/2026-10-22-pickup-watch/spec.md:67-77` | Deadline, single user, US only, always-on Mac, stack preference, shadcn/ui and local-first are the constraints the design rests on. |
| Doc | Spec decision log | `docs/features/2026-10-22-pickup-watch/spec.md:89-108` | Settled input: one request per cycle with other colors in it, edge-triggered alerts, Telegram, token source order, localhost default; the stack is left to this stage. |
| Doc | Persisted last state per (part, store) | `docs/features/2026-10-22-pickup-watch/spec.md:26`, `docs/features/2026-10-22-pickup-watch/spec.md:54` | The last known state must survive a restart so an unchanged pair never re-alerts. |
| Doc | Network exposure and secrets | `docs/features/2026-10-22-pickup-watch/spec.md:32`, `docs/features/2026-10-22-pickup-watch/spec.md:62-63` | The server binds to localhost by default, opts into the LAN, and no response may carry the bot token or Apple cookies. |
| External service | Apple `fulfillment-messages` request and response | `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:9`, `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:21-26` | The poller builds `parts.N` and `location`, and parses `stores[].partsAvailability[part].pickupDisplay` and `pickupSearchQuote` into stock state and Today/Tomorrow. |
| External service | Apple token pair with a 2 h hard expiry | `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:16-20` | Every check sends `dssid2` + `shld_bt_ck` with a browser User-Agent; a 541 HTML reply means the token is rejected, and any unattended source must refresh inside 2 h. |
| External service | Apple `pickup-message-recommendations` | `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:10` | Returns the 12 nearest stores with no token, so a zip can list stores before any token exists. |
| External service | Apple buy pages | `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:12`, `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:29-35` | The catalog keeps the unlocked `LL/A` phone variants (32 + 8), drops `S…` parts, groups other colors by `familyType` + `dimensionCapacity`, and builds buy links from `seoUrlToken`. |
| External service | Buy-page link format | `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:27` | The alert button targets `/shop/buy-iphone/<page>/<seoUrlToken>`; whether a zip parameter is honoured is untested. |
| External service | Untested Apple behaviour | `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:37-42` | Automated token, zip in the link and the 60 s block rate have to be checked in the spike or carried as risks. |
| External service | Telegram Bot API | `docs/features/2026-10-22-pickup-watch/spec.md:27-30`, `docs/features/2026-10-22-pickup-watch/spec.md:59`, `docs/features/2026-10-22-pickup-watch/spec.md:96-97` | Outbound `sendMessage` with an inline URL button for stock, health and test messages; the bot token and chat id are new secrets no response may return. |

## Checked, not touched
- .git
- docs/features/2026-10-22-pickup-watch/trial-1
- docs/features/2026-10-22-pickup-watch/trial-2

## Open
- Whether stock already present when a watch is added, a store is re-enabled or the app first starts should alert at once, or only on a later change.
- Whether a Tomorrow → Today change on a pair already in stock should send a message.
- Whether Wi-Fi access without login may let any device on the network change watches, stores, zip and interval.
- Whether the config page URL accepts a zip parameter.
- How many parts Apple accepts in one `fulfillment-messages` request.
