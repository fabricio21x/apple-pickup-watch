The repository has no code, configuration, tests or commits yet; every row below is a document or an outside service the new code must respect.

## Impact map: greenfield Apple Store pickup monitor

| Area | What | Evidence | Why it matters |
|---|---|---|---|
| Doc | Spec scope: catalog, watches, location, other colors, poller, token, stock state, alerts, UI, stack, network exposure | `docs/features/2026-10-22-pickup-watch/spec.md:20-33` | Every module the design adds must trace to one of these lines; anything else is outside the approved scope. |
| Doc | Spec out-of-scope list | `docs/features/2026-10-22-pickup-watch/spec.md:36-44` | Bounds the build: no login, deploy, multi-zip, non-US, model-level watches, checkout automation, autocomplete or sleep handling. |
| Doc | Spec acceptance criteria | `docs/features/2026-10-22-pickup-watch/spec.md:47-65` | Each test seam in the design must check one of these lines; criterion 47 says "iPhone 18 Pro and iPhone Duo buy pages", and the 18 Pro Max lives on the 18 Pro page. |
| Doc | Spec decision log | `docs/features/2026-10-22-pickup-watch/spec.md:84-102` | Settled input: one request per cycle, other colors from the same request, the order of token sources, Hono + Vite + SQLite, localhost default. |
| External service | Apple `fulfillment-messages`: request parameters and response path | `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:9`, `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:21-26` | The poller builds `parts.N` and `location`, and parses `body.content.pickupMessage.stores[].partsAvailability[part].pickupDisplay` and `pickupSearchQuote` into stock state and Today/Tomorrow. |
| External service | Apple token contract: `dssid2` + `shld_bt_ck` pair, browser User-Agent, HTTP 541 HTML on rejection | `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:16-20` | The client must send the pair from one session and classify a 541 or HTML body as "token rejected" for the health alert. |
| External service | Apple `pickup-message-recommendations`: store list without a token | `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:10` | Returns the 12 nearest stores for a location with no token, so the zip → store list step can work before a token exists. |
| External service | Apple buy pages: variant objects with `partNumber`, `familyType`, `dimensionCapacity`, `dimensionColor`, `seoUrlToken`; product list with `name`, `price` | `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:29-35` | The catalog scraper keeps only `-unlocked` / `LL/A` entries, derives model from `familyType` (`iphone18pro`, `iphone18promax`, `iphoneduo`), groups other colors by `familyType` + `dimensionCapacity`, and builds the alert link from `seoUrlToken`. |
| External service | Untested Apple behaviour: datacenter IP, automated token, zip in config URL, block rate at 60 s | `docs/features/2026-10-22-pickup-watch/apple-api-notes.md:39-42` | The token spike and the link's zip parameter are checked during implementation; the block rate is a running risk the health alert reports. |
| External service | Telegram Bot API (alerts, link button, test message) | `docs/features/2026-10-22-pickup-watch/spec.md:27-30`, `docs/features/2026-10-22-pickup-watch/spec.md:60` | Outbound `sendMessage` with an inline URL button; the bot token and chat id are new configuration that no API response may return. |

## Checked, not touched
- .git
- docs
