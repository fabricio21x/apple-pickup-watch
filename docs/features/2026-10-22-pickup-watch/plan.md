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
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Non-blocking: the "goes down at once" test would pass without the at-once branch (test/monitor.test.ts:668; the single-check expired test proves it); the startup message is sent alongside the first cycle, skipping the 1.1 s gap (src/server/monitor.ts:242); `start()` after `stop()` sends another startup message (src/server/monitor.ts:239); `setToken` resets `token_warned` even for the same pair (src/server/db.ts:121), so the API must not re-store an unchanged pair. Deviations: snapshot gains `token: {status, expiresAt}` and `health: {failures, downAnnounced, cause}`; the startup message is fire-and-forget and not retried; an expired stored token shows `expired` at once; the warning is sent only while 0 < time left ≤ 15 min; expiry time shown as server-local `HH:MM`.

### T9: HTTP API
- Serves: spec.md:47 (zip save keeps toggles), 57 (token status, cURL paste), 59 (test message route), 60 (grid DTO), 62 (Host and loopback guards), 63 (no secrets in any response)
- Files: `src/server/api.ts`, `test/api.test.ts`, `src/shared/types.ts` (DTOs), `src/server/db.ts` (`lanEnabled`)
- Depends on: T8
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Non-blocking: `lanHosts()` keeps internal interfaces, so `lan.urls` lists `http://127.0.0.1:…` (src/server/api.ts:77, add `!i.internal`); route params skip zod (src/server/api.ts:185, 204); a known-expiry outage shows `failing` until the down message is delivered (src/server/api.ts:66); a `{curl}` body replaces any pair whatever its origin (src/server/api.ts:246; still loopback-only). Routes: `GET /api/state`, `PUT /api/zip`, `PUT /api/stores/:store`, `POST /api/watches`, `DELETE|PATCH /api/watches/:part`, `PUT /api/interval`, `PUT /api/lan`, `POST /api/token`, `POST /api/telegram/test`. Deviations: `createApi({db, monitor, apple, telegram|null, lanEnabled, extensionId, port, now, hostname?, networkInterfaces?})`; guards run on `*`, so static routes added by index.ts are guarded too; the loopback guard uses `getConnInfo` and fails closed; the grid covers watched parts only; empty store list → 422, empty catalog → 503, lookup failure → 502; re-watching a part is a no-op.

### T10: The page
- Serves: spec.md:46 (picker), 47 (zip and store toggles), 49 (other-colors switch), 51 (interval), 57 (token status and paste dialog), 59 (test button), 60 (grid), 61 (375 px), 62 (Wi-Fi toggle and LAN URL)
- Files: `vite.config.ts`, `components.json`, `index.html`, `src/web/**`, `package.json` (page dependencies)
- Depends on: T9
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Non-blocking: a long Apple quote in a `nowrap` badge can widen a store row at 375 px (src/web/Watches.tsx:102); overlapping polls can briefly undo a just-made change (src/web/App.tsx:23); the picker clears its selection even when creating watches failed (src/web/Watches.tsx:37); the interval input never re-syncs from the server (src/web/SettingsStrip.tsx:149); App.tsx exports `formatTime`, creating an import cycle and disabling fast refresh (src/web/App.tsx:15); `vite.config.ts` is outside `tsconfig` `include` (tsconfig.json:17); any failed state fetch shows "Cannot reach the monitor", even a 403 (src/web/App.tsx:27). Deviations: extra files `src/web/logic.ts` (tested pure logic), `src/web/vite-env.d.ts`, `src/web/lib/utils.ts`; `vitest.config.ts` merged into `vite.config.ts`; the picker is a checkbox tree; no "next check" shown; light theme only; remove has no confirmation.

### T11: Boot, one command and LaunchAgent
- Serves: spec.md:62 (bind 127.0.0.1, 0.0.0.0 when LAN is on), 64 (one command), design.md decisions 19, 22, 23
- Files: `src/server/index.ts`, `launchd/com.pickup-watch.plist`, `README.md`, `package.json` (start script if T1's needs changes)
- Depends on: T10
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Non-blocking: the fatal handler logs only `err.name`, so a bad PORT or a port clash shows "uncaught exception: Error" with no cause, and under launchd that becomes a silent restart loop (src/server/index.ts:15); unconfigured Telegram shows a made-up `http` "Telegram is not configured" lastError on the page (src/server/index.ts:30), though nothing is marked alerted without a real send; `EXTENSION_ID` format is not checked (src/server/boot.ts:11); one test asserts both bind cases (test/boot.test.ts:43). Reviewer verified live: 127.0.0.1-only bind, Host guard on static files, 0700/0600 modes, LAN bind `*:4319` after opt-in and restart with no loopback URL listed. Deviations: extra `src/server/boot.ts` (`readEnv`, `bindHost`, `prepareDataDir`) with tests; the server listens before loading the catalog; `data/` and `dist/` resolve from the repo root; the plist logs to `data/pickup-watch.log`; the `lanHosts` internal-interface fix from T9 landed here.

### T12: Spike result and token source
- Serves: spec.md:58 (written result; the extension keeps the token valid while Brave is open)
- Files: `spike/RESULT.md`, and `extension/manifest.json` + `extension/background.js` or `scripts/token-auto.ts` (with its `token:auto` script), as the result decides
- Depends on: T2, T9, and the owner's spike run (design.md Rollout step 1)
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Spike outcome (2026-10-23/24): replay from Node fetch and curl both 200; Apple answers at most 20 parts per request; Playwright Chromium rejected (541); CDP into Brave with a dedicated profile kept a working pair 3 h unattended (rounds at 0, 90 and 180 min all 200). Renewal probes: a page load renews `shld_bt_ck` only once it has expired (10 loads from 31 to 3 min left renewed nothing; the first load after expiry did), but deleting `shld_bt_ck` and reloading issues a fresh accepted pair at any time while the old one stays valid. So the source is `scripts/token-auto.ts` over CDP, refreshing by clearing the cookie about 20 min before expiry; no extension. Live check by the implementer: against a scratch server and the spike's Brave, a post stored the pair, and a forced refresh cleared the cookie and posted a fresh pair in about 7 s. Non-blocking: no 3 h unattended run of token:auto itself yet (design Rollout step 3), and the relaunch-Brave and server-down paths are untested live (scripts/token-auto.ts:142); importing the module loads .env and reads config, so the unit test depends on the local .env (scripts/token-auto.ts:62); no test at exactly 20 min (test/token-auto.test.ts:10); no test of the post body or of logs holding no cookie values (scripts/token-auto.ts:119); if the profile is already open without the debugging port, every retry relaunches Brave with an unhelpful log (scripts/token-auto.ts:77). Deviations: pure helpers exported from the script, `main()` runs only as the entry point; env `BRAVE_CDP_PORT` and `BRAVE_PROFILE_DIR`; PORT read through `readEnv`; posts at every wake (at most 10 min; an equal pair is a no-op 200); a throwaway tab per wake; `shldExpiresAt` exported from apple.ts.

### T13: cURL paste dialog keeps its Save button reachable
- Serves: "the user can paste a cURL from their browser to replace it" (spec.md:57), 375 px usable (spec.md:61). Owner's walkthrough 2026-10-23: a long paste grows the textarea and pushes the Save button out of reach.
- Files: `src/web/SettingsStrip.tsx` (and `src/web/components/ui/textarea.tsx` / `dialog.tsx` only if needed)
- Depends on: T10
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Non-blocking: the textarea can still be dragged taller by hand (src/web/SettingsStrip.tsx:129, add `resize-none`); `DialogContent` has no max height, so viewports under ~420 px tall clip it (src/web/components/ui/dialog.tsx:64); `text-xs` under 16 px makes iOS Safari zoom on focus (src/web/SettingsStrip.tsx:129). Verified in Chromium at 375×667: the textarea stays 160 px with a 17.5 KB paste, no horizontal scroll, and Save and the rejection reason stay in view. Deviation: field sizing is overridden on this textarea, not in the shared component.

### T14: Unlocked buy link and the trade-in check
- Serves: spec.md:61 (buy button preselects what Apple's URL supports); design.md decision 10, Rollout amendment step 0. Change C2 in changes.md.
- Files: `src/server/apple.ts` (catalog `buyUrl` = `productLink` + `-unlocked`, `productLink` with no query or fragment), `test/apple.test.ts`, `docs/features/2026-10-22-pickup-watch/apple-api-notes.md`
- Depends on: none
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Browser check 2026-10-23 in the spike's Brave: the `-unlocked` link opens with color, storage, No trade-in, Buy and Unlocked selected; `?igt=true` clears No trade-in, so the link has no query. Non-blocking: a `productLink` ending in `/` would get `/-unlocked` (src/server/apple.ts:49; Apple's links have none); the no-double test passed before the change too (test/apple.test.ts:140); apple-api-notes.md:43 doesn't say the suffix is never doubled. Deviations: `test/monitor.test.ts` buy-URL constants updated to `-unlocked` (reviewer: justified); the query/fragment check is on the raw string, so a bare `?` or `#` is caught too; built in a worktree and merged as e1a582c.
### T15: Cap tracked parts at 20
- Serves: spec.md:54 (one request), 55 (cap, refusal with count); design.md decision 24, decision 5 (re-posting a watched part is a no-op). Change C5.
- Files: `src/server/domain.ts` (`trackedParts`, watched first), `src/server/monitor.ts` (part list cut at 20), `src/server/api.ts` (409 `parts-cap` on watch create and other-colors on, ignoring already-watched parts), `src/shared/types.ts` (`StateDto.partsCount`), `test/domain.test.ts`, `test/monitor.test.ts`, `test/api.test.ts`
- Depends on: none (shares no file with T14, which waits on the owner's `igt` check)
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Non-blocking: the 409 `tracked` is the count after the change (3 tracked + 19 added gives `tracked: 22, adding: 19`), so T18 must word it as "Adds <adding> parts, which would make <tracked> / 20" (src/server/api.ts:200); the re-post no-op test passed before the change too and only pins existing behaviour (test/api.test.ts:627); design.md's Test seams row says `StateDto.parts` where the field is `partsCount`, and its Impact row puts the cut in apple.ts:171 where it is in monitor.ts:185 (wording only, left so the approved design's hash holds). Deviations: the cap refuses only a change that would end above 20 and raise the count (`tracked > 20 && tracked > before`, src/server/api.ts:199), so re-posting a watched part or moving a part from other color to watched stays allowed when older data is already over the cap, matching spec.md:55 ("would go past 20") and decision 24's "a refusal drops nothing the owner set up"; `PARTS_CAP` and `trackedParts` live in domain.ts with a shared private `relatedColorsBySibling`; `partsCount.unchecked` is computed in api.ts as `trackedParts(...).slice(20)`, mirroring the monitor's cut.

### T16: One stock message per model + storage
- Serves: spec.md:28-30, 32 (grouping, sound, other colors), 56-57, 59-60, 62 (no repeats, Today/Tomorrow alone sends nothing); design.md decisions 3 (case-insensitive label), 6 (grouped send pass, not-checked stores, non-retryable 4xx skips a group, role check at commit). Change C1.
- Files: `src/server/domain.ts` (`stockMessages` replaces `orderEvents`, `pickupFrom`), `src/server/monitor.ts` (per-group send pass and commit), `src/shared/types.ts` (`StockMessage`), `test/domain.test.ts`, `test/monitor.test.ts`
- Depends on: T15
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Non-blocking (r-1 and r-2 are folded into T17, which touches monitor.ts): r-1 the commit also role-checks deletes, so a pair whose role flips while its out message is in flight keeps its row and repeats the out line next check (src/server/monitor.ts:149; deletes should match part and store only); r-2 the message is rebuilt before the up-to-1.1 s gap sleep, so a store turned off during the sleep can still be sent (src/server/monitor.ts:118; rebuild after the sleep); no monitor-level test feeds a store missing from the response through to 'not checked' (src/server/monitor.ts:215); an event whose part left the catalog is dropped silently every check (src/server/domain.ts:110, also before T16). Deviations: Telegram 5xx stops the pass like a network error; a 'not checked' store takes name and distance from `[...db.listStores(), ...outcome.stores]` with the response winning; interim plain text with one button for the first color until T17; `OutgoingMessage.silent` sends `disable_notification`; the monitor test's Apple fake answers every requested part.

### T17: HTML Telegram messages with per-color buy buttons
- Serves: spec.md:29, 31, 34, 59, 61, 63 (format, buttons, styled health/token/start/test messages); design.md decision 25. Change C1, C2.
- Files: `src/server/telegram.ts` (`escapeHtml`, `parse_mode: 'HTML'`, `disable_notification`, one inline URL button per in-stock color, styled other messages), `src/server/monitor.ts` (pass `sound`), `test/telegram.test.ts` (new), `test/monitor.test.ts`
- Depends on: T16
- Status: done
- Review: request-changes (after a 429 wait the pass resent the message built before the wait, so a store turned off during it could still be listed), then approve-with-comments; 1 fix round
- Notes: Also fixed T16's r-1 (commit deletes match part and store only) and r-2 (rebuild after the gap sleep). Non-blocking: the 4096 test covers all-in-stock stores only, and a long Gone line with ~60-character store names could pass 4096 (test/telegram.test.ts:196; real Apple names are short); the first-watched deadline exemption is decided before the gap sleep, so a group that lost its watched event during the sleep can still go out past the cutoff (src/server/monitor.ts:125); a group skipped after a 429 wait doesn't update `lastSentAt` (src/server/monitor.ts:138); the no-button test omits down and token-warning messages (test/telegram.test.ts:236). Deviations: store entries read `Name (0.7 mi)`, comma-separated, lines ordered Today, Tomorrow, other labels, Not checked; `🔴 Gone` also appears on a sold-out message; `OutgoingMessage.buttons` is a flat list, one button per keyboard row; started body "Pickup watch is checking for stock.", test body "Telegram alerts are working."; no test for r-3 of the first review (not observable).

### T18: Four-view page with sidebar and bottom tabs
- Serves: spec.md:35, 55 (parts count and refusal message), 66, 69-71; design.md decisions 18, 24 (over-cap parts in red, "Not checked" on the board). Change C4.
- Files: `src/web/App.tsx` (shell, hash view, sidebar at md+, top bar and bottom tabs below), `src/web/StockBoard.tsx` (new), `src/web/Watches.tsx`, `src/web/Stores.tsx` (from `Location.tsx`), `src/web/Settings.tsx` (from `SettingsStrip.tsx`), `src/web/logic.ts`, `test/web-logic.test.ts`
- Depends on: T15
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Browser checks by the implementer (Playwright, 28 pass): bottom tabs at 375×812 and sidebar at 1280×800, no horizontal scroll on every view, refresh keeps and back returns to the view, a real 409 refusal keeps the picker's selection, a long quote wraps, the dialog fits at 375×400. Non-blocking (r-1 and r-2 folded into T19): r-1 an error banner stays after switching views (src/web/App.tsx:40); r-2 the in-stock rule is written twice (src/web/StockBoard.tsx:37 and logic.ts:38 `stockRank`); the over-cap row test name says "after the watched rows" but the sort is by stock rank only (test/web-logic.test.ts:235). Deviations: blocks with stock come first; the "Watching" card (count, over-cap line, rows) sits above the picker; "part" singular when adding 1; built in a worktree and merged as 9f24d29; the stock board shows other colors only past the cap until T19.

### T19: Other-color rows on the stock board
- Serves: spec.md:69 (Today / Tomorrow / unavailable for each tracked pair); design.md decision 18 ("Other color" rows), Data shapes (`WatchDto.cells`, `GridCell.part`). Change C6.
- Files: `src/server/api.ts` (state builder: a watch's `cells` cover all its tracked pairs, its other-color siblings included when its switch is on), `src/web/logic.ts` (`stockBoard` takes other-color cells from `watches[].cells`, de-duplicated by part and store, marked "Other color"), `test/api.test.ts`, `test/web-logic.test.ts`
- Depends on: T17, T18
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Also folded in T18's r-1 (banner clears on view change) and r-2 (one exported `isInStock`). Non-blocking: nothing tests the banner clearing (src/web/App.tsx:51; no component tests in the project). Deviations: over-cap siblings are left out of `cells` and shown as "Not checked" only from `partsCount.unchecked`; the old "12 cells" assertion now counts only the watched part's cells.

### T20: One store per line in the stock message
- Serves: spec.md:29 (stores grouped Today and Tomorrow as plain text with their distance), 59, 60; design.md decision 25. Change C7 (walkthrough to-do 1a).
- Files: `src/server/telegram.ts` (each store, and each gone store, on its own line under its heading instead of comma-separated), `test/telegram.test.ts` (layout and the 4096-character worst case, now with a Gone line too)
- Depends on: none
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Owner asked for it after seeing the live message; more lines, easier to read. Non-blocking: the 4096 test now covers 4 colors × 11 in stock plus 1 gone each, and no longer asserts the design's 4 × 12 case (test/telegram.test.ts:221; it fits by hand count, 3787); with ~60-character store names a check where 44 stores go out at once would reach about 4126 and be refused by Telegram (src/server/telegram.ts:43; Apple's real names are much shorter; same accepted risk as T17); design.md decision 25's example and T17's deviation note still show the comma layout (wording only, the design's hash is kept). Deviations: two commits, the second fixing a test line offset; the app was restarted after 26de8a2, so live messages use the new layout.

### T21: Clear Wi-Fi restart notice
- Serves: spec.md:72 (reachable from the phone after enabling the Wi-Fi opt-in); design.md decision 16 (the toggle applies on restart and the page says so). Change C8 (walkthrough to-do 5a).
- Files: `src/web/Settings.tsx` (while `lan.restartRequired`, a prominent notice and the network addresses shown as "available after restart", not as links), `src/web/logic.ts` and `test/web-logic.test.ts` only if a pure helper is worth testing
- Depends on: none
- Status: done
- Review: approve-with-comments, 0 fix rounds; one non-blocking finding fixed in a follow-up commit (4e3435b)
- Notes: The owner turned Wi-Fi access on and the other devices couldn't load the page, because the server hadn't been restarted. Browser check by the implementer with a mocked `/api/state` at 375 px: pending-on shows a red alert, the restart how-to and the addresses as plain text; pending-off the alert without addresses; live the links; no horizontal scroll. Fixed after review: the how-to paragraph used `break-all` and split ordinary words; now `break-words`, with `break-all` only on the launchctl command (computed word-break normal, scrollWidth 375). Non-blocking: only the pure `lanStatus` helper is unit-tested; the link/no-link rendering rests on the browser check (no component tests in the project). Deviations: built in a worktree and merged as bfc9070; the old muted hint is replaced by the alert.

### T22: Redesigned stock board (UI)
- Serves: spec.md:35, 69-71 (stock board, four views, 375 px); design.md `## UI direction` and decision 18; mockup `mockups/stock-board.html`. Change C9.
- Files: `src/web/StockBoard.tsx` (rebuilt to the mockup), `src/web/logic.ts` (phone sections from `watches[].cells`, store order Today then distance, the rest collapsed, finish-color table, freshness and cap note), `src/web/index.css` (OKLCH warm neutrals, `--today`, `--tomorrow`, finish swatches), `test/web-logic.test.ts`
- Depends on: none
- Status: done
- Review: approve-with-comments, 0 fix rounds
- Notes: Built twice from ecf0055 as a model comparison (fbs:ui-implementer on Sonnet 5.5: 8.4 min, ~$1.81; on Opus 5.5: 14.3 min, ~$4.37; comparison page at `.git/fbs/evidence/pickup-watch/ui/compare.html`). The owner chose the Sonnet branch; it was merged into main as 849b2dd and exp/board-opus was deleted (owner, 2026-10-25). Screenshots against fixture data: `.git/fbs/evidence/pickup-watch/ui/exp-sonnet/`. Non-blocking: "last check <age>" counts from `lastSuccessAt` per spec.md:69 while design.md's Data paragraph names `lastCheckAt` (src/web/logic.ts:164; the design text should follow the spec at its next amendment); keyboard order puts the cap note's link after the phones although it shows above them (src/web/StockBoard.tsx:86); the loading `role=status` has no text to announce (src/web/StockBoard.tsx:373); the column is wider than the mockup's 720 px between 768 and 1099 px (src/web/App.tsx:90); the Buy link's accessible name doesn't start with its visible "Buy <color>" (src/web/StockBoard.tsx:143); the shadcn base tokens are retinted globally, so the other three views turn warm (src/web/index.css:8); the first-run step still asks for a zip when stores exist but are all off (src/web/StockBoard.tsx:309); the board's state choice in StockBoard.tsx has no test. Deviations: App.tsx changed (wider stock column, skeleton before the first state, status chips hidden on the stock view); phones ordered Today, Tomorrow, watched before other colors, then catalog; DOM order phones first with CSS order for the visual order; `animate-pulse` skeleton; 200 ms fade on changed rows.

### T23: Stock board follow-ups (UI)
- Serves: spec.md:35, 69-71; design.md `## UI direction` (Layout: 720 px reading column below 1100 px; Accessibility: availability in words, labelled controls, AA contrast, focus visible); mockup `mockups/stock-board.html`. Change C10 items 1-7 and 9.
- Files: `src/web/StockBoard.tsx` (focus order of the cap note, Buy accessible name starting with its visible text, loading text for screen readers, live region limited to state changes, stale stock at AA contrast with `aria-describedby` to "Last known stock", status shown during unfinished setup), `src/web/App.tsx` (stock column 720 px below 1100 px, 1060 px from 1100 px), `index.html` and a favicon file (no more `/favicon.ico` 404), `test/web-logic.test.ts` if any logic moves
- Depends on: T22
- Status: done
- Review: request-changes (the 1060 px column lost to the md rule above 1100 px; the setup state claimed "Checking every minute" while the monitor skips every tick; the desktop rail stopped being sticky), then approve-with-comments; 1 fix round
- Notes: From the T22 review and the change-9 final review. Keep the mockup's look; these are accessibility and layout fixes. Built in 15ebe7a and 73c303c. Non-blocking: the failing-check live region is `empty:hidden`, so some screen readers may miss the announcement when it fills (src/web/StockBoard.tsx:137); at 1100 px+ the phone column is 740 px (1060 - 40 - 280, as the mockup), while design.md says "max 720 px" (src/web/App.tsx:92); at 1100 px+ Tab reaches the rail's "Trim your watches" before the phones, as in the mockup's DOM (src/web/StockBoard.tsx:73); the stale state's contrast is argued from tokens, with no down-state screenshot (src/web/StockBoard.tsx:24). Deviations: stale stock is greyscale with links at 70 %, `aria-describedby` on each phone section, quiet list "As of the last check, <time>" while down; `statusStrip(state, now, setupComplete)` returns `tone` (ok, idle, down) and reads "Not checking yet · finish setup" while setup is incomplete; max-widths include main's padding; new test/stock-board.test.ts renders StockBoard to static markup; favicon is public/favicon.svg.

## Final review
- Status: todo (reopened 2026-10-25 for T23; previous: done (reopened 2026-10-25 for T22 and reviewed over ecf0055..bf89ce8: approve-with-comments, 0 fix rounds, 445 tests pass, type check clean. Non-blocking: when down with nothing in stock, the quiet list isn't marked stale (src/web/StockBoard.tsx:40); while setup is incomplete the stock view shows neither health nor last check now that the chips are hidden there (src/web/StockBoard.tsx:86); the status strip's live region re-announces the token time every minute (src/web/StockBoard.tsx:110); the stale column at 55 % opacity drops muted text below AA and loses the mockup's aria-describedby (src/web/StockBoard.tsx:71); phones without stock are summarised, the loosest reading of spec.md:69 (src/web/logic.ts:124); T22's own notes are still open. Cleanup over the range: unslop dropped one unused export (bf89ce8); no comments were added. The reviews below covered 7a85437..2cb4fe7) (reopened 2026-10-24 for T20 and T21 and reviewed again over 1a63282..2cb4fe7: approve-with-comments, 0 fix rounds, 416 tests pass, type check clean; non-blocking: design.md decision 25's example and worst-case sentence still describe the comma layout and the 4 × 12 case, which the new 4 × 11 + gone test covers by a longer message; the pending-on plain-text and live-link rendering has no automated test, only the browser check. Cleanup over that range: unslop removed one unused export (2cb4fe7); no comments were added, so no-comments had nothing to prune. The earlier review below covered 7a85437..1a63282)
- Review: approve-with-comments, 0 fix rounds (range 7a85437..1a63282; 411 tests pass, type check clean)
- Notes: Criteria met by code and tests: spec.md:52-66, 69, 73. Partly verified or unverified, manual by design: 61 (live buy-link tap; the Brave check is in T14), 67 (no 3 h unattended run of token:auto itself), 68 (real Telegram delivery), 70-71 (real layouts at 375 px and wide; Playwright checks in T18), 72 (phone over Wi-Fi), 74 (`npm start` on a clean clone). Non-blocking: README.md:55 and :83 still say "settings strip" instead of the Settings view and the toggle's label; the fatal handler logs only `err.name`, so under launchd a port clash or bad env restarts silently (src/server/index.ts:15, open since T11); a color whose only stores are "not checked" still gets a Buy button (src/server/telegram.ts:48); a later accepted health, warning or start message clears a stock-message refusal from `lastError` (src/server/monitor.ts:162); `EXTENSION_ID` remains in .env.example, boot.ts and the Origin guard though no extension was built (.env.example:4); the 4096-character test has no Gone line (test/telegram.test.ts:196). Cleanup: unslop removed unused UI-kit exports (3b9531f); no-comments removed one narrating comment and shortened the token-auto header, restoring the cookie-clearing why at its line (1a63282).

## Escalations
- Resolved (2026-10-24): the owner ran the token spike; the result is in T12's notes, and T12 is unblocked.
- Spike results so far (2026-10-23): replay — Node fetch and curl both 200; parts-cap — HTTP 200 but every store returned 20/40 parts (Apple caps at 20 parts per request); playwright — round 1 HTTP 541 (rejected); cdp — round 1 HTTP 200, rounds 2–3 pending.
- Resolved (2026-10-23): the owner's walkthrough changes went through `fbs:changes` (changes.md C1-C5). The spec and design were amended and re-approved by the owner, and became T14-T18. C3 was T13.
