# Design: Apple Store pickup stock monitor

- Feature: pickup-watch
- Spec: docs/features/2026-10-22-pickup-watch/spec.md

## Impact

The repository has no code, configuration, tests or commits yet; every row below is a document or an outside service the new code must respect.

### Impact map

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

### Checked, not touched
- .git
- docs

## Constraints

Business facts:
- Single user, the owner (user, 2026-10-22).
- US Apple Stores only (user, 2026-10-22).
- Alerts working by 2026-11-01 (user, 2026-10-22).
- Runs on the owner's Mac, which is always on (user, 2026-10-22).
- Models: iPhone 18 Pro, 18 Pro Max, iPhone Duo (user, 2026-10-22).

Providers and stack (spec decision log):
- Apple's undocumented store endpoints (`fulfillment-messages`, `pickup-message-recommendations`, buy pages), with the `dssid2` + `shld_bt_ck` token pair.
- Telegram Bot API for every message.
- Hono + Vite + React + shadcn/ui, SQLite, one Node process, one start command, Railway-ready later.

Conventions: none recorded; there is no project `CLAUDE.md` or `.claude/rules/`, and the user-level `CLAUDE.md` is empty.

Timeline and outside limits:
- 2026-10-22 to 2026-11-01: a 1-day token spike, then the build.
- Telegram allows about one message per second per chat and answers 429 with `retry_after` when exceeded.
- Apple may block the session or change its markup at any time; nothing guarantees the endpoints.

## Options considered

The core data shape is the last alerted stock state per (part, store): it drives the in-stock, out-of-stock, other-color and Tomorrow → Today messages and the restart rule.

**A. Last-state table, compare and commit after send (recommended).**
- Data: one `availability` row per tracked (part, enabled store) pair holding `out` or `in` with its day. Each check parses Apple's response, compares it with the rows in a pure function that returns transitions, sends a message per transition, and writes a row as soon as its message is sent.
- Structure: about 8 server files (`domain`, `db`, `apple`, `catalog`, `monitor`, `telegram`, `api`, `main`) and 4 UI sections.
- Cost: smallest that meets every criterion; one table to reverse.
- For the user: alerts are not repeated on restart, and a failed Telegram send is retried on the next check instead of lost.

**B. Snapshot log, compare the last two snapshots.**
- Data: a `checks` table storing every response's availability (12 stores × N parts per minute); transitions derived by comparing the two newest snapshots.
- Structure: same modules plus retention and pruning.
- Cost: more storage and a pruning job; gives a history nothing in the spec asks for.
- For the user: nothing visible beyond A, unless a history view is built later.

**C. In-memory state only.**
- Data: a `Map` of pair → state, lost on restart.
- Cost: the least code, but it re-alerts every in-stock pair after a restart, which fails the criterion at `spec.md:55`.

Recommendation: A, because it is the smallest shape that meets the restart criterion, and committing after the send turns Telegram failures into retries instead of lost alerts.

## Decisions

1. Pair state is a tagged value `out | in(day)`, with day `today | tomorrow | other`; the last alerted state per tracked (part, enabled store) pair is stored, and a pure `diff` returns transitions. Alternatives: snapshot log (B), memory only (C). Principle: principle-model-the-domain.
2. Transitions that send a message: no row or `out` → `in` (in-stock, labelled watched or other color), `in` → `out` (out-of-stock), and `in(tomorrow)` → `in(today)` (now today) only while the row's `today_seen` is 0. `today_seen` is set on any `in(today)` observation and reset on `out`, so a pair that cycles Today → Tomorrow → Today each day alerts once per in-stock run. `in(today)` → `in(tomorrow)` and changes to or from `other` update the row silently.
3. A missing row counts as `out`, so stock that is already there when a watch is added, a store is re-enabled, or the app first starts sends an in-stock message (user, 2026-10-22).
4. After any watch, store or zip change, the tracked set is recomputed and only `availability` rows whose (part, store) is no longer in it are deleted, so a part still covered by another watch keeps its rows. This keeps "row missing" meaning "not alerted yet".
5. Sending and committing, per transition:
   - Before each Telegram send and its row write, the monitor re-reads the current tracked set, enabled stores and zip from the db and drops any transition whose (part, store) is no longer tracked.
   - Each transition is sent and committed on its own; the row is written synchronously as soon as its send resolves. A failed send skips to the next transition and leaves the old row, so the next check finds the same transition and retries it.
   - A Telegram 4xx other than 429 is logged and the row committed anyway, so a message that can never be sent is not retried forever.
   - Message formatting falls back to the part number when the variant row is missing.
   - When Telegram is not configured, transitions are not sent and rows are not committed, so stock alerts once it is configured.
   - Delivery is at-least-once: a response timeout after Telegram delivered, or a crash between send and row write, can produce a rare duplicate.
6. Tracked parts = watched parts ∪ other colors of watches with `otherColors` on (same `familyType` + `capacity`, different color, from the catalog). A part that is both watched and another watch's other color is labelled watched.
7. One `fulfillment-messages` request per check carries every tracked part. The store list comes only from `pickup-message-recommendations`, which needs no token; stores in a poll response that are not in the `stores` table are ignored.
8. Health is a small machine kept in memory:
   - `idle(reason)` when a check cannot run (decision 19); no message is sent.
   - `up` → `failing(n)` on a failed check. At n ≥ 3 the monitor sends one down message naming the failure kind and enters `down` only after that message is sent; while the send fails it stays `failing` and retries the message on each failed check.
   - `down` → `up` on the next success, entered only after the back-up message is sent.
   - Failure kinds: `token-rejected` (HTTP 541 or an HTML body), `network` (fetch error or timeout), `unexpected` (a 200 that fails the response schema).
   - Alternative: persist health, rejected because a restart during an outage only costs one repeated down message.
9. Apple responses and buy-page JSON are parsed once at the boundary with zod schemas into typed values; nothing past `apple.ts` / `catalog.ts` reads raw Apple fields. Apple URLs are built only with `URLSearchParams`. Principle: principle-model-the-domain.
10. The catalog is scraped from both buy pages at startup and every 24 h; after a failed scrape it retries every 5 minutes until one succeeds, then returns to the 24 h cadence. Only entries whose `seoUrlToken` ends in `-unlocked` are kept. A scrape counts as successful only if it yields at least one variant per model in `MODELS` and each buy page yields at least half its previous count. It is written as an upsert in one transaction, and a part a watch references is never deleted.
11. The token is one row (`dssid2`, `shld_bt_ck`, `userAgent`, `source`, `updatedAt`) written only through `setToken` in `db.ts`. Every token source reaches it through `POST /api/token`: the pasted cURL from the UI, and whichever source the spike picks (a standalone Playwright script or the browser extension), which run as separate processes and are never imported by `main.ts`. Any CDP or Playwright source uses a dedicated Brave or Chromium profile directory used only for apple.com, never the owner's daily profile; its debugging port binds to `127.0.0.1` with `--remote-allow-origins` set without a wildcard. The real-profile CDP variant is spiked but not promoted to the production token source. The poller never stores cookies from Apple's `Set-Cookie`; the replayed pair is what was verified to work. Principle: principle-smallest-change.
12. The poll loop is a `setTimeout` chain that reads the interval from config before each wait (default 60 s; jitter ±25% of the interval, clamped so every wait is at least 30 s, which keeps 45–75 s at the default), so an interval change applies at the next wait without a restart. A single-flight guard means a check never starts while the previous check's send pass is running, and the send pass stops when the time until the next scheduled check is used up, leaving the remaining transitions uncommitted so the next check recomputes and retries them.
13. Telegram credentials come from `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`; the README explains getting the chat id. The UI shows "configured: yes/no" and `telegramStatus` (`ok | failing`, from the last send attempt). Messages, including the test message, go through one sequential queue, at least 1 s apart, honouring `retry_after`. Alternative: entering credentials in the UI, rejected as an extra secret-handling path for one user.
14. Request guard in `api.ts`:
    - A middleware on every request, GET included, checks the `Host` header against an explicit allowlist (`localhost:PORT`, `127.0.0.1:PORT`, and when LAN is on the Mac's interface IPs and `<hostname>.local:PORT`) and returns 421 otherwise.
    - Mutating routes accept only `Content-Type: application/json`; their `Origin` is checked against the same explicit list, never against the incoming `Host`. A request with no `Origin` is rejected unless the remote address is loopback.
    - The only cross-origin exception is the single origin `chrome-extension://<pinned id>`, accepted only on `POST /api/token`; the id is pinned with a fixed `key` in `extension/manifest.json`.
    - `PUT /api/config { lanEnabled }` is accepted only from loopback.
    - `POST /api/token` is accepted only from loopback or the pinned extension origin, so no other device on the network can swap the token.
    - Every request body and path parameter is parsed with zod before `db.ts` is called: `zip` matches `^\d{5}$`, `intervalSec` is an integer from 30 to 3600, `parts` is an array of at most 20 entries that exist in `variants`, `storeNumber` exists in `stores`, `lanEnabled` is a boolean.
    - Every route and the Hono `onError` handler return fixed error DTOs (`{ error: '<code>' }`), never upstream error text or request input; every response is built from explicit DTO types that have no secret fields.
    - In-memory limits: one test message per 10 s and one zip change per 10 s, returning 429 otherwise.
15. Wi-Fi access is a persisted `lanEnabled` setting read once at boot: the server listens on `127.0.0.1`, or on `0.0.0.0` when it is on. After the toggle changes, the settings strip shows "restart to apply".
16. The UI polls `GET /api/state` every 10 s; no websocket or server-sent events. Principle: principle-smallest-change.
17. The grid is one card per watch listing its stores with status badges, at every width. Principle: principle-smallest-change.
18. The alert link is `https://www.apple.com/shop/buy-iphone/<page>/<seoUrlToken>`; a zip is added only if a check during implementation shows the page accepts one.
19. A check runs only when a zip is set, at least one tracked part exists and a token row exists; otherwise the loop skips the fetch, health is `idle` with reason `no zip | no watches | no token` shown in the UI, and no Telegram message is sent.
20. A tracked pair with no observation in a successful response produces no transition and keeps its row; the grid shows it as "not reported".
21. The grid is built from the observations of the latest successful check, kept in memory by `monitor.ts`; `availability` stays the "last alerted" state.
22. Transitions are sent in priority order: watched in-stock (today before tomorrow), watched now-today, other-color in-stock, then out-of-stock; within a tier, nearest store first. The sort is a pure function beside `diff`.
23. `PUT /api/config { zip }` fetches the store list first, passing a fixed known part from `MODELS` as the recommendations `product`, so the lookup works before the first catalog scrape. If the fetch fails or returns zero stores, it returns 4xx and changes nothing; otherwise it writes the zip, the store list and the cleared `availability` rows in one SQLite transaction.
24. The pasted cURL parser keeps only `dssid2`, `shld_bt_ck` and the User-Agent and discards the rest without logging.

## Data shapes

```ts
// domain.ts
type Model = 'iphone18pro' | 'iphone18promax' | 'iphoneduo'          // Apple familyType
const MODELS: Record<Model, { label: string; buyPage: 'iphone-18-pro' | 'iphone-duo'; lookupPart: string }>

type Variant = {
  part: string            // 'MJW44LL/A'
  model: Model
  capacity: string        // '256gb'
  color: string           // 'black'
  name: string            // 'iPhone 18 Pro Max 256GB Black'
  price: number
  url: string             // https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.9-inch-display-256gb-black-unlocked
}

type Watch = { part: string; otherColors: boolean }

type Store = { storeNumber: string; name: string; city: string; state: string; distanceMi: number; enabled: boolean }

type Day = 'today' | 'tomorrow' | 'other'
type PairState = { kind: 'out' } | { kind: 'in'; day: Day; quote: string }
// Apple → PairState: pickupDisplay 'available' → in; anything else ('unavailable', 'default', unknown) → out
// day from pickupSearchQuote: /today/i → today, /tomorrow/i → tomorrow, else other

type Observation = { part: string; storeNumber: string; state: PairState }
// grid cell: an Observation from the latest successful check, or 'not reported'

type Transition =
  | { kind: 'in-stock'; part: string; storeNumber: string; day: Day; quote: string; role: Role }
  | { kind: 'out-of-stock'; part: string; storeNumber: string; role: Role }
  | { kind: 'now-today'; part: string; storeNumber: string; role: Role }
  | { kind: 'silent'; part: string; storeNumber: string; state: PairState }   // row update, no message
type Role = { kind: 'watched' } | { kind: 'other-color'; watchedPart: string }

type FailureKind = 'token-rejected' | 'network' | 'unexpected'
type IdleReason = 'no zip' | 'no watches' | 'no token'
type Health =
  | { kind: 'idle'; reason: IdleReason; lastSuccessAt: string | null }
  | { kind: 'up'; lastSuccessAt: string | null }
  | { kind: 'failing'; count: number; lastSuccessAt: string | null; lastFailure: FailureKind }
  | { kind: 'down'; since: string; lastSuccessAt: string | null; lastFailure: FailureKind }

type Token = { dssid2: string; shldBtCk: string; userAgent: string; source: 'paste' | 'extension' | 'playwright'; updatedAt: string }
type TokenStatus = 'missing' | 'ok' | 'rejected'      // from the last check; the only token data the API returns
type TelegramStatus = 'ok' | 'failing'                // from the last send attempt
```

SQLite tables (created on boot with `CREATE TABLE IF NOT EXISTS`):

| Table | Columns | Notes |
|---|---|---|
| `variants` | `part` PK, `model`, `capacity`, `color`, `name`, `price`, `url`, `updated_at` | Upserted by each successful scrape; parts referenced by a watch are never deleted. |
| `watches` | `part` PK → `variants.part`, `other_colors` INTEGER 0/1 default 1, `created_at` | |
| `stores` | `store_number` PK, `name`, `city`, `state`, `distance_mi`, `enabled` INTEGER 0/1 default 1 | Replaced on zip change, all enabled. |
| `availability` | (`part`, `store_number`) PK, `state` `'out' \| 'in'`, `day` `'today' \| 'tomorrow' \| 'other'` NULL when out, `quote`, `today_seen` INTEGER 0/1, `changed_at` | Last alerted state; only tracked pairs (decision 4). |
| `config` | single row `id = 1`: `zip` NULL, `interval_sec` default 60, `lan_enabled` 0/1 default 0 | |
| `token` | single row `id = 1`: `dssid2`, `shld_bt_ck`, `user_agent`, `source`, `updated_at` | Never serialised by the API. |

## Module boundaries

- `domain.ts`: types and the `MODELS` registry; imports nothing.
- `db.ts`: opens SQLite (better-sqlite3), creates tables, exposes typed reads and writes per table, including `setToken`, the single write path for the token row. The only module that writes SQL.
- `apple.ts`: builds and sends `fulfillment-messages` and `pickup-message-recommendations` requests with the token pair, classifies failures into `FailureKind`, parses with zod into `Observation[]` and `Store[]`; parses a pasted cURL into a `Token`. The only module that knows Apple's request and response shapes.
- `catalog.ts`: fetches the two buy pages, extracts unlocked variant objects and the product list, returns `Variant[]`. Called by `main.ts` on boot, every 24 h, and every 5 minutes after a failure.
- `monitor.ts`: owns the poll loop and its single-flight guard, tracked-part computation, the pure `diff(prev, observations, watches, stores) → Transition[]` and priority sort, the health machine, the latest observations for the grid, and commit-after-send. Calls `apple`, `db`, `telegram`.
- `telegram.ts`: formats a `Transition` or health change into text plus an inline URL button, sends through one sequential queue with spacing and `retry_after`, and reports `TelegramStatus`. The only module that reads `TELEGRAM_*`.
- `api.ts`: Hono routes, the Host/Origin guard, zod body parsing, DTO builders, fixed error DTOs and rate limits. Calls `db`, `apple` (zip lookup, cURL parse), `monitor` (health, latest observations), `telegram` (test message).
- `main.ts`: loads `.env`, opens the db, starts catalog refresh and the monitor, serves the built UI and `api`, and listens on the host from `config.lan_enabled` at boot.
- `web/`: the React page; talks only to `/api/*`.
- `spike/`: token experiments, not imported by the server. Whichever source wins becomes a standalone script (`scripts/token-playwright.ts`) or `extension/`, both calling `POST /api/token`.

API:

| Route | Body / result |
|---|---|
| `GET /api/state` | `{ config, stores, watches, observations, lastCheckAt, health, tokenStatus, telegramConfigured, telegramStatus }` |
| `GET /api/catalog` | `Variant[]` grouped by model → capacity → color |
| `PUT /api/config` | `{ zip?, intervalSec?, lanEnabled? }`; zip per decision 23; `lanEnabled` from loopback only, applied on restart |
| `POST /api/watches` | `{ parts: string[] }` |
| `PATCH /api/watches/:part` | `{ otherColors: boolean }` |
| `DELETE /api/watches/:part` | removes the watch and the rows no longer tracked |
| `PATCH /api/stores/:storeNumber` | `{ enabled: boolean }` |
| `POST /api/token` | `{ curl: string }` or `{ dssid2, shldBtCk, userAgent, source }`; loopback or the pinned extension only |
| `POST /api/telegram/test` | queues a test message; at most one per 10 s |

## File map

```
pickup-watch/
├── package.json            scripts: dev (vite + server), start (build UI, run server), test (vitest), spike
├── tsconfig.json           strict TypeScript for server and web
├── vite.config.ts          React build to dist/, dev proxy /api → server
├── components.json         shadcn/ui config
├── index.html              Vite entry
├── .env.example            TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, PORT
├── .gitignore              node_modules, dist, .env, *.db
├── README.md               setup: bot and chat id, start, pasting a cURL, Wi-Fi access
├── server/
│   ├── main.ts             boot, catalog schedule, monitor start, listen on the host from config
│   ├── domain.ts           types and MODELS registry
│   ├── db.ts               SQLite schema, typed queries, setToken
│   ├── apple.ts            Apple requests, failure classification, zod parsing, cURL parsing
│   ├── catalog.ts          buy-page scrape → Variant[]
│   ├── monitor.ts          poll loop, single-flight guard, tracked parts, diff, priority sort, health machine, commit-after-send
│   ├── telegram.ts         message formatting, sequential queue, status
│   └── api.ts              Hono routes, Host/Origin guard, zod bodies, DTOs, rate limits
├── web/
│   ├── main.tsx            React root
│   ├── App.tsx             page layout and 10 s state polling
│   ├── api.ts              typed fetch helpers using server/domain.ts types
│   ├── sections/
│   │   ├── LocationSection.tsx   zip input and store toggles
│   │   ├── WatchPicker.tsx       Model → Storage → Color multi-select, other-colors switch
│   │   ├── WatchGrid.tsx         one card per watch with store status badges
│   │   └── SettingsStrip.tsx     Telegram status and test, token status and cURL paste, interval, Wi-Fi (restart to apply), idle reason
│   └── components/ui/      shadcn/ui generated components
├── test/
│   ├── fixtures/           fulfillment 200 (multi-part, all states), 541 HTML, recommendations 200, trimmed buy pages, sample cURL
│   ├── apple.test.ts       parsing, failure kinds, cURL parsing
│   ├── catalog.test.ts     variant extraction, grouping, success thresholds, upsert
│   ├── monitor.test.ts     diff, priority sort, tracked parts, health machine, idle, commit-after-send, single-flight, jitter
│   ├── telegram.test.ts    message text and button, spacing, retry_after, permanent failure
│   └── api.test.ts         secrets in no response, Host/Origin guard, body validation, zip change, rate limits
└── spike/
    ├── token.ts            Playwright launch and CDP attach variants, dedicated profiles
    └── RESULT.md           written spike result, pasted-pair lifetime, chosen token source and its deploy implication
```

If the spike picks the extension, add `extension/manifest.json` (MV3, fixed `key` to pin the id, `cookies` and `alarms` permissions, host access to apple.com and localhost) and `extension/background.js`: it reloads an apple.com tab on an alarm, reads `dssid2` and `shld_bt_ck`, and posts them to `POST /api/token`. If it picks Playwright, add `scripts/token-playwright.ts`, a standalone process with a dedicated profile that refreshes on the same cadence and posts to `POST /api/token`.

## Test seams

| Criterion | Where it is checked | What the test controls |
|---|---|---|
| `spec.md:47` catalog lists every configuration | `catalog.test.ts` | Trimmed buy-page fixtures; asserts unlocked-only, model from `familyType`, grouping, rejected thin scrape, watched parts kept on upsert |
| `spec.md:48` zip lists stores, all on; disabled store never alerts | `api.test.ts`, `monitor.test.ts` | Recommendations fixture via a fake fetch; failed or empty lookup changes nothing; `diff` with a disabled store |
| `spec.md:49` one request with all tracked parts; 45–75 s apart | `monitor.test.ts` | Fake fetch counts calls and reads `parts.N`; injected random and clock; a slow fake Telegram across two ticks sends each transition exactly once |
| `spec.md:50-51` other-colors switch and labelled messages | `monitor.test.ts`, `telegram.test.ts` | Catalog with sibling colors; `diff` returns `role: other-color`; formatted text contains "Other color"; deleting one watch keeps rows still covered by another |
| `spec.md:52` interval change without restart | `monitor.test.ts` | Change config between waits on a fake clock |
| `spec.md:53-55` in, out, no repeat, restart | `monitor.test.ts` | Sequences of observations against stored rows; a fresh monitor on the same SQLite file sends nothing for unchanged pairs; a watch deleted between fetch and commit sends nothing; a response omitting one part and one store produces no transition; priority order; `today_seen` stops a daily now-today |
| `spec.md:56` `unavailable` and `default` are out | `apple.test.ts` | Fixture with all three `pickupDisplay` values |
| `spec.md:57` health down and back up | `monitor.test.ts` | Fake fetch returning 541, throwing, or malformed JSON three times, then a 200; a failing down send is retried; no zip, watch or token gives `idle` and no message |
| `spec.md:58` token status and cURL paste | `apple.test.ts`, `api.test.ts` | Sample cURL with `-b` and with `-H 'cookie:'`; only three values kept |
| `spec.md:59` token spike result | Manual | `spike/RESULT.md` records each variant, its profile, how long its token lasted, the pasted pair's lifetime under 60 s replay, and the deploy implication |
| `spec.md:60` test message | Manual with the real bot; `telegram.test.ts` for the request shape and a permanent failure on message 1 of 3 | Fake fetch for the unit test |
| `spec.md:61` grid shows state and last check | Manual in the browser | Live data from a running monitor |
| `spec.md:62` usable at 375 px | Manual in browser device mode | — |
| `spec.md:63` localhost by default, Wi-Fi opt-in | Manual from the phone; unit test of the host chosen from config | — |
| `spec.md:64` no secrets in responses | `api.test.ts` | Seeds a fake bot token and cookies; asserts no GET, POST, PUT, PATCH or DELETE response contains them, including forced Telegram and cURL-parse failures |
| Request guard (decision 14) | `api.test.ts` | Host `attacker.example` rejected on `GET /api/state` and `PUT /api/config`; non-loopback request without Origin gets 403 on every mutating route; a different `chrome-extension://` origin is rejected; a non-loopback `POST /api/token` is rejected; `intervalSec` 1 and an unknown part get 400 |
| `spec.md:65` one start command | Manual: `npm start` on a clean clone | — |

## Risks

- **Apple blocks the session or IP at a 60 s rate** (medium): the health alert reports it within about 3 minutes; the interval is adjustable in the UI, with a 30 s floor.
- **No automated token source works and the token lasts about 2 h** (medium): the extension is the planned fallback; pasting a cURL keeps working meanwhile; the health alert names `token-rejected`.
- **An extension-reloaded tab does not get a fresh accepted token** (unknown): part of the spike; if it fails too, pasting a cURL is the only source and the user is told so in the spike result.
- **The later deploy needs a token source that runs off the Mac** (high if the deploy happens): only the extension or a residential-IP sidecar posting to `POST /api/token` would work from Railway; the spike result records this as a selection criterion.
- **Apple caps the parts per request** (unknown; 3 parts tested): measured during implementation with about 20 parts; if capped, it breaks the one-request criterion and goes back to the user.
- **Apple changes its response or buy-page markup** (low per week, high over months): zod parsing fails into `unexpected`, which the health alert reports; the stored catalog and the scrape success thresholds keep the picker working.
- **A burst of messages hits Telegram's rate limit** (medium on first start with many in-stock pairs): sequential sending with spacing and `retry_after`, in priority order; the single-flight guard and per-transition commit retry the rest on the next check.
- **Wi-Fi access exposes the app without login** (low; opt-in, home network): the Host allowlist, Origin rules and zod bodies limit what another device can do; a LAN client can still read the zip and stores.
- **Apple's terms limit automated access** (unknown consequence): no Apple ID is used, the rate is one request a minute, and the tool is for personal use.

## Rollout

Single user on their own Mac (user, 2026-10-22), so there is no staged release, flag or migration: the owner runs `npm start` after filling `.env`.

Order of work, fitted to the 2026-11-01 deadline (user, 2026-10-22):
1. Day 1: token spike. At its start, begin a 60 s ±15 s replay of a freshly pasted pair and record in `spike/RESULT.md` when it is first rejected and whether adopting the new `dssid2` from `Set-Cookie` changes that. The spike ends with `spike/RESULT.md`.
2. Core: `domain`, `db`, `apple`, `catalog`, `monitor`, `telegram` with their tests, using a pasted cURL.
3. API and the page.
4. The token source the spike chose (standalone Playwright script or extension).
5. A live run against real stock, which is the spec's success measure.

## Assumptions
- [x] The alerts must be working by 2026-11-01 (user, 2026-10-22)
- [x] The monitor has a single user, the owner (user, 2026-10-22)
- [x] Only US Apple Stores are watched (user, 2026-10-22)
- [x] The Mac running the monitor is always on and does not sleep (user, 2026-10-22)
- [x] Stock already present when a watch is added, a store is re-enabled or the app starts sends an in-stock message (user, 2026-10-22)
- [x] A unit changing from Tomorrow to Today pickup sends a new message (user, 2026-10-22)

## Open questions
None

## Gulag outcome

**Panel:** workflow fbs:panel. Seats: pessimist, security, lazy-boi, code-purist, staff-engineer; none missing.

- pessimist-1 (major): accepted, nothing stops an in-flight commit from re-inserting rows for pairs just untracked, which suppresses the next in-stock alert.
- pessimist-2 (major): accepted, the grid read only `availability`, written only after a successful send, so a failing Telegram showed no stock.
- pessimist-3 (major): accepted, one permanent 4xx could head the send queue forever.
- pessimist-4 (major): accepted, a send pass at 1 msg/s can outlast the wait and either break `spec.md:49` or double-send.
- pessimist-5 (major): accepted, every in-stock pair would fire now-today each morning; open question whether the user wants that.
- pessimist-6 (major): accepted, `diff` was undefined for a tracked pair with no observation.
- pessimist-7 (major): accepted, replacing `variants` conflicts with the watches foreign key and a zero-variant scrape empties the picker.
- pessimist-8 (major): accepted, zip change had no ordering or failure rule, and the recommendations lookup needs a part a clean install lacks.
- pessimist-9 (minor): accepted, deleting a watch could drop rows still tracked through another watch.
- pessimist-10 (minor): accepted, fixed ±15 s jitter with no interval floor allows back-to-back checks.
- pessimist-11 (minor): accepted, `down` was entered even when the down message failed.
- pessimist-12 (minor): accepted, commit-after-send is at-least-once and the design overstated it.
- pessimist-13 (minor): accepted, a failed first scrape left the catalog empty for a day.
- pessimist-14 (minor): rejected, dropping the immediate re-listen (lazy-boi-4) removes this failure mode outright.
- security-1 (major): accepted for the no-Origin and loopback-only rules; the per-install access key is struck and left as an open question.
- security-2 (major): accepted, DNS rebinding reached the API even in localhost mode; a Host allowlist closes it.
- security-3 (major): accepted, the extension's POST was cross-origin with no defined exception.
- security-4 (major): accepted, request bodies had no stated validation.
- security-5 (major): accepted, attaching CDP to the real Brave profile exposes every logged-in session to any local process.
- security-6 (minor): accepted, the secrets test covered only GET bodies.
- security-7 (minor): accepted, the test route and zip change had no limit, and the test message bypassed the queue.
- lazy-boi-1 (minor): accepted, the wide-screen table served no criterion the card layout does not meet.
- lazy-boi-2 (minor): rejected, the 24 h timer is a few lines and the catalog can change within the 10-day window.
- lazy-boi-3 (minor): rejected, the structured token body is one schema and every token source now goes through `POST /api/token`.
- lazy-boi-4 (minor): accepted, no criterion needs a live re-listen or store auto-add from the poll.
- code-purist-1 (major): rejected, duplicate of pessimist-1.
- code-purist-2 (minor): accepted for placing `setToken` in `db.ts`; the re-listen hook is moot after lazy-boi-4.
- code-purist-3 (minor): rejected, taste; the pure `diff` and health machine are testable from `monitor.ts`.
- code-purist-4 (minor): rejected, taste; a type-only import is erased at build time.
- staff-engineer-1 (major): rejected, duplicate of pessimist-4.
- staff-engineer-2 (major): accepted, with 1 s spacing the send order is alert latency.
- staff-engineer-3 (major): accepted, a clean install would fail three times and send a false down message.
- staff-engineer-4 (major): accepted for measuring the pasted pair's lifetime during the spike; making the extension conditional is struck and left as an open question.
- staff-engineer-5 (minor): rejected, duplicate of pessimist-7.
- staff-engineer-6 (minor): accepted, a Playwright provider started from `main.ts` contradicts running unchanged on Railway.

Changes applied: decisions 2, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15 and 17 revised; decisions 19 to 24 added; `today_seen`, `idle`, `TelegramStatus` and `lookupPart` added to the data shapes; `variants` note, API table, file map, module boundaries, test seams, risks and rollout step 1 updated; Options A wording changed to "not repeated on restart".

Stale: after the review, the user's answer to the judge's open questions made `POST /api/token` loopback-or-extension only (decision 14, API table, guard test seam); the panel did not see this change.

## Decision log
- 2026-10-22: Store the last alerted state per tracked (part, enabled store) pair and compare with a pure diff, over a snapshot log or memory-only state. Why: smallest shape that meets the restart criterion; a log adds pruning for a history nobody asked for, and memory-only re-alerts after a restart. Principle: principle-smallest-change
- 2026-10-22: Model pair state as `out | in(day)` and transitions as a tagged union. Why: one structure decides every message kind instead of booleans checked across files. Principle: principle-model-the-domain
- 2026-10-22: A missing row counts as `out`, so stock already present alerts immediately. Why: the user wants to know about stock they can buy now (user, 2026-10-22).
- 2026-10-22: Tomorrow → Today sends a message once per in-stock run (tracked by `today_seen`); Today → Tomorrow and changes involving `other` update silently. Why: the user values knowing same-day pickup opened; the daily evening/morning flip would otherwise ping every in-stock pair twice a day.
- 2026-10-22: Send and commit each transition on its own, after re-checking it is still tracked; skip past failures; commit permanent 4xx. Why: a failed send is retried on the next check, a stale check cannot suppress later alerts, and one unsendable message cannot block the rest.
- 2026-10-22: Build the grid from the latest observations in memory, keeping `availability` as the last alerted state. Why: the grid must show Apple's stock even when Telegram is failing or not configured.
- 2026-10-22: Single-flight checks, a send pass bounded by the next check, and priority order for sends. Why: keeps checks 45–75 s apart without double-sends, and the alert the user waits for goes first.
- 2026-10-22: Fetch the store list for a zip from `pickup-message-recommendations` only, validated before anything is written, and ignore unknown stores in poll responses. Why: it needs no token, so setup works before a token exists, and a failed lookup leaves the old setup intact.
- 2026-10-22: Keep health in memory as `idle | up | failing(n) | down`, entering `down` and `up` only after their message is sent. Why: a clean install must not send a false down message, and a lost down message must be retried; persisting health only saves one repeated message after a restart. Principle: principle-smallest-change
- 2026-10-22: Parse Apple responses, buy pages and request bodies once with zod at the boundary. Why: a markup change becomes one classified `unexpected` failure, and bad input never reaches the db or Apple. Principle: principle-model-the-domain
- 2026-10-22: Scrape the catalog at startup, every 24 h and every 5 minutes after a failure, as a thresholded upsert that never deletes watched parts. Why: the picker and alert links keep working when a scrape fails or comes back thin; `LL/A` parts exist only on the unlocked entries.
- 2026-10-22: Every token source goes through `POST /api/token` into `setToken`; Playwright, if chosen, runs as a standalone script with a dedicated profile; Apple's `Set-Cookie` is ignored. Why: the server stays able to run unchanged on Railway, the owner's daily profile is never exposed on a debugging port, and replaying the pasted pair is what was verified.
- 2026-10-22: Telegram credentials in `.env`, UI shows configured and ok/failing, over entering them in the UI. Why: one user, and no extra path that handles a secret.
- 2026-10-22: Guard every request with a Host allowlist, mutations with explicit Origin rules, a pinned extension origin and loopback-only Wi-Fi toggling; fixed error DTOs and rate limits. Why: Wi-Fi access has no login, and DNS rebinding reaches localhost; these block other pages and devices from changing the app or reading secrets at little cost.
- 2026-10-22: Read `lanEnabled` at boot and show "restart to apply", over re-listening live. Why: no criterion needs a live switch, and re-listening can leave the server bound to nothing. Principle: principle-smallest-change
- 2026-10-22: The UI polls `GET /api/state` every 10 s, over websockets or server-sent events. Why: checks happen once a minute, so 10 s polling is fresh enough with no extra transport. Principle: principle-smallest-change
- 2026-10-22: One card-per-watch grid layout at every width, over cards on phones plus a table on wide screens. Why: 12 store columns cannot fit 375 px, and a second layout serves no criterion. Principle: principle-smallest-change
- 2026-10-22: Interval from 30 to 3600 s with ±25% jitter clamped to at least 30 s. Why: keeps 45–75 s at the default and prevents back-to-back checks that speed up an Apple block.
- 2026-10-22: Measure the pasted pair's lifetime under 60 s replay at the start of the spike. Why: it decides how much an automated token source is worth, at no extra cost.
- 2026-10-22: Server code in 8 flat files under `server/`, over a module-per-folder layout. Why: each file has one owner role and there is one caller per function; folders would add hops without a second consumer. Principle: principle-smallest-change
- 2026-10-22: No per-install access key for Wi-Fi access in v1. Why: the spec defers login to the deploy, and only the zip and store list are readable while the owner chooses Wi-Fi access (user, 2026-10-22).
- 2026-10-22: Tomorrow → Today alerts only the first time per in-stock run. Why: a daily repeat tells the owner nothing new (user, 2026-10-22).
- 2026-10-22: If only the owner's daily Brave profile works over CDP, build the extension instead. Why: the debugging port would expose every logged-in session to any local process (user, 2026-10-22).
- 2026-10-22: Build the extension whenever no automated source works, as the spec says, even if a pasted pair lasts a working day. Why: overnight coverage is the point, and reopening the spec costs more than it saves (user, 2026-10-22).
- 2026-10-22: `POST /api/token` accepts only loopback and the pinned extension origin. Why: Copy-as-cURL exists only in desktop DevTools, and no other device on the network should be able to swap the token (user, 2026-10-22).
- 2026-10-22: Rejected pessimist-14: re-listening when Wi-Fi access changes can leave the server listening on no address. Why: conflicts with lazy-boi-4, which wins: dropping the immediate re-listen removes this failure mode outright.
- 2026-10-22: Rejected lazy-boi-2: drop the 24 h catalog refresh and scrape at startup only. Why: the timer costs a few lines, the catalog can change within the 10-day window, and the upsert makes the refresh safe. Principle: principle-smallest-change
- 2026-10-22: Rejected lazy-boi-3: defer the structured body on `POST /api/token`. Why: it is one zod schema, and every token source now goes through `POST /api/token`, so deferring it saves nothing. Principle: principle-smallest-change
- 2026-10-22: Rejected code-purist-1: api.ts reaches into rows monitor.ts owns and the two can race. Why: duplicate of pessimist-1.
- 2026-10-22: Rejected code-purist-3: monitor.ts bundles five roles. Why: taste; the pure `diff` and health machine are testable from monitor.ts, and the design chose eight flat files.
- 2026-10-22: Rejected code-purist-4: two files named `api.ts`, and web/ imports server types. Why: taste; a type-only import is erased at build time, and same-named files under server/ and web/ are an ordinary convention.
- 2026-10-22: Rejected staff-engineer-1: the poll loop and send queue can overlap and double-send. Why: duplicate of pessimist-4.
- 2026-10-22: Rejected staff-engineer-5: replacing variants conflicts with the watches foreign key. Why: duplicate of pessimist-7.
