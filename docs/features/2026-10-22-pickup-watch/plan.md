# Plan: Apple Store pickup stock monitor

- Feature: pickup-watch
- Branch: fbs/pickup-watch, branch base 7a85437095081d7363a9f89c27d80589bfd540a8
- Test command: `npm test` (vitest run); type check: `npx tsc --noEmit`
- Baseline: None. The branch base holds only docs, so no test runner or test exists before T1 (design.md decision 1 names vitest and strict TS).
- Workers: one parallel batch (T2, T3, T4 in worktrees), then one at a time, because T1 owns `package.json` for all three and they share no other file, while T5–T11 form a chain through `apple.ts`, `monitor.ts` and `api.ts`.

Order follows design.md Rollout: the token spike script lands right after the scaffold so the owner can run it before the Duo's pickup opening on 10.24. T12 needs the owner's spike run and its result.

## Tasks

### T1: Scaffold the project
- Serves: setup (design.md decisions 1, 15; Data shapes)
- Files: `package.json` (scripts `start`, `dev`, `test`, `capture`, plus server, test and spike dependencies incl. Playwright as a dev dependency, so T2–T4 never touch it), `tsconfig.json`, `.gitignore`, `.env.example`, `src/shared/types.ts`
- Depends on: none
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Non-blocking: `GridCell.badge` copies design.md:215 verbatim and widens to `string` (src/shared/types.ts:34); one tsconfig gives server code the DOM lib (tsconfig.json:4), worth splitting when the page lands. Deviations: resolved majors are typescript 7, vitest 5, zod 4, better-sqlite3 13; `noUncheckedIndexedAccess` added; Playwright's Chromium needs `npx playwright install chromium` before the spike.

### T2: Token spike script
- Serves: "The token spike ends within 1 day with a written result" (spec.md:58; design.md Rollout step 1.1–1.5, including the plain Telegram send for an env list of parts)
- Files: `spike/token.ts`
- Depends on: T1
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Non-blocking, worth knowing before the owner's run: browser variants test the pair with Node fetch only, no curl control (spike/token.ts:381); the CDP retry loop also swallows round errors and restarts from round 1 (spike/token.ts:409); one transient error ends a playwright run (spike/token.ts:372); every 541 prints "EXPIRED" and failed cycles count as accepted (spike/token.ts:331); bad Telegram creds show only when stock appears (spike/token.ts:310); a failed curl control aborts replay (spike/token.ts:314); alerts are unpaced (spike/token.ts:351). vitest also picks up `.claude/worktrees/**` tests; exclude it in a later vitest config. Deviations: `parts-cap` needs the cURL pair; only `dssid2`, `shld_bt_ck` and the UA are sent; `--adopt` ignores cookie clears; browser variants run `--rounds` (default 3, 90 min apart); `cdp` takes `--profile`.

### T3: Fixture capture script and fixtures
- Serves: setup for spec.md:46, 47, 55, 56 (design.md decision 20, Test seams fixture list)
- Files: `scripts/capture-fixtures.ts`, `test/fixtures/*`
- Depends on: T1
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Non-blocking: a non-541 reply still overwrites `rejected-541.html` (scripts/capture-fixtures.ts:87); a live capture requests different parts from the hand-built set (scripts/capture-fixtures.ts:80); the cURL parser misses `$'…'` quoting, matches flags case-insensitively, and one error path can print the cookie to the owner's terminal (scripts/capture-fixtures.ts:44, 102); hand-built titles use plain spaces where Apple uses NBSP (test/fixtures/fulfillment-today.json:23), so names must come from the catalog. Hand-built `fulfillment-*`: all-out, today, tomorrow, other-color-today, duo-check-back, missing-part, missing-store; live capture goes to `fulfillment-live.json`. The token-free bodies (locator, stores, rejected-541) are captured live. `fulfillment-*.json` need the owner's cookie pair, so they are built in the shape of apple-api-notes.md:21-26 until `npm run capture` is run with a pasted token; `maintenance-503.html` is a written HTML body.

### T4: Domain logic
- Serves: spec.md:46 (siblings), 47 (disabled stores never tracked), 48 (jitter), 49–50 (other colors), 55 (`unavailable`/`default` not in stock)
- Files: `src/server/domain.ts`, `test/domain.test.ts`
- Depends on: T1
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Non-blocking: `pickupFrom('available', '')` gives an empty label (src/server/domain.ts:58); `other` pairs for one sibling share one `relatedColors` array (src/server/domain.ts:49). Deviations: `Watch`, `StoreToggle`, `AlertedRow` are local types in domain.ts; `siblingsOf(catalog, part)` is the sibling helper (the picker tree is left to the page); `nextHealth(state, result, {now, expiresAt})` returns `{state, send}` and never sets `downAnnounced` (the caller does once Telegram accepts); a known-expiry failure still counts toward `failures`; `jitterMs` does not clamp 30–3600 s (the API boundary does); "Today" is matched before "Tomorrow", case-sensitive.

### T5: Apple client
- Serves: spec.md:46 (catalog parse, productLink check), 47 (stores), 56 (outcome classification), 57 (cURL and token parsing), 63 (fixture cookie guard)
- Files: `src/server/apple.ts`, `test/apple.test.ts`, `vitest.config.ts`
- Depends on: T3, T4
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Non-blocking: `buyUrl` stores the raw `productLink` while the check validates the parsed URL (src/server/apple.ts:68); one entry without `pickupSearchQuote` fails the whole check as `unexpected` (src/server/apple.ts:97); expiry boundary `>` vs `<=` (src/server/apple.ts:179 vs 220); token values are not checked for control characters, so a bad pair would surface as `network` (src/server/apple.ts:175); no test names the UNLOCKED/US filter directly (test/apple.test.ts:45). Deviations: `createApple({fetch, now, timeoutMs?})` → `{fetchCatalog, fetchStores, check}`, standalone `parseCurl`/`parseTokenBody`; `AppleToken.expiresAt` in ms; `check` takes `watchedParts` and `otherParts` separately; a missing User-Agent is rejected; `fetchCatalog` fails whole if either family fails; `vitest.config.ts` excludes `.claude/**` and will need merging with T10's `vite.config.ts`; Windows `^`-escaped cURL not parsed.

### T6: Check cycle and alerts
- Serves: spec.md:47 (off never alerts), 49–50 (other-color messages), 52–55 (in-stock, out-of-stock, no repeats incl. restart)
- Files: `src/server/db.ts`, `src/server/telegram.ts`, `src/server/monitor.ts`, `test/monitor.test.ts`
- Depends on: T5
- Status: done
- Review: request-changes (send pass ignored role, so a watch created mid-pass let a stale "Other color" alert through and lost the watched alert), then approve-with-comments; 1 fix round
- Notes: Non-blocking: an `out` event whose role flips mid-send keeps its row and repeats next check (src/server/monitor.ts:90); no test proves the 10 s Telegram timeout is applied (src/server/telegram.ts:60); `res.body?.cancel()` can reject outside a try and throw out of `sendMessage` (src/server/telegram.ts:67); other-color text uses related colors from diff time (src/server/monitor.ts:76); partial catalog upserts renumber `sort` (src/server/db.ts:126). Deviations: `createMonitor({apple, telegram, db, now, sleep?})` → `{runCheck({deadline?}), reconcile({newlyWatched?}), loadCatalog(), snapshot()}`; the API must call `reconcile({newlyWatched:[part]})` after `db.addWatch`; `sendMessage` returns a result with `retryAfterSec` instead of throwing; out-of-stock messages carry no button; `getSettings()` exposes only zip and token so far. Covers design.md decisions 2–6, 8 (store/part missing handling), 10 (catalog fetch and retry), reconcile and the in-memory snapshot.

### T7: Scheduler
- Serves: spec.md:48 (one request, 45–75 s apart), 51 (interval change without restart)
- Files: `src/server/monitor.ts`, `test/monitor.test.ts`, `src/server/db.ts` (interval accessors)
- Depends on: T6
- Status: done
- Review: request-changes (the deadline test passed without the deadline), then approve-with-comments; 1 fix round
- Notes: Non-blocking: a mid-cycle interval decrease leaves the running pass on the old deadline (src/server/monitor.ts:149); `stop()` during a check keeps `nextStartAt` until it ends (src/server/monitor.ts:179); `start()` after `stop()` checks at once (src/server/monitor.ts:173); one test asserts only `startTimes.slice(0, 3)` (test/monitor.test.ts:839). Deviations: `monitor.setInterval(sec)` is the one place that validates 30–3600 (integer) and throws `RangeError`, so the API maps it to 400; `start()` checks at once; a mid-cycle change jitters from the cycle start; a thrown check re-arms and surfaces as an unhandled rejection (decision 22).

### T8: Health, token warning and startup message
- Serves: spec.md:56 (one down after 3 failures, one back up), 57 (token status), design.md decisions 9, 21, 22 (startup message)
- Files: `src/server/monitor.ts`, `src/server/telegram.ts`, `src/server/db.ts`, `test/monitor.test.ts`
- Depends on: T7
- Status: todo
- Review:
- Notes:

### T9: HTTP API
- Serves: spec.md:47 (zip save keeps toggles), 57 (token status, cURL paste), 59 (test message route), 60 (grid DTO), 62 (Host and loopback guards), 63 (no secrets in any response)
- Files: `src/server/api.ts`, `test/api.test.ts`
- Depends on: T8
- Status: todo
- Review:
- Notes:

### T10: The page
- Serves: spec.md:46 (picker), 47 (zip and store toggles), 49 (other-colors switch), 51 (interval), 57 (token status and paste dialog), 59 (test button), 60 (grid), 61 (375 px), 62 (Wi-Fi toggle and LAN URL)
- Files: `vite.config.ts`, `components.json`, `index.html`, `src/web/**`, `package.json` (page dependencies)
- Depends on: T9
- Status: todo
- Review:
- Notes:

### T11: Boot, one command and LaunchAgent
- Serves: spec.md:62 (bind 127.0.0.1, 0.0.0.0 when LAN is on), 64 (one command), design.md decisions 19, 22, 23
- Files: `src/server/index.ts`, `launchd/com.pickup-watch.plist`, `README.md`, `package.json` (start script if T1's needs changes)
- Depends on: T10
- Status: todo
- Review:
- Notes:

### T12: Spike result and token source
- Serves: spec.md:58 (written result; the extension keeps the token valid while Brave is open)
- Files: `spike/RESULT.md`, and `extension/manifest.json` + `extension/background.js` or `scripts/token-auto.ts` (with its `token:auto` script), as the result decides
- Depends on: T2, T9, and the owner's spike run (design.md Rollout step 1)
- Status: todo
- Review:
- Notes:

## Final review
- Status: todo
- Review:
- Notes:

## Escalations
None
