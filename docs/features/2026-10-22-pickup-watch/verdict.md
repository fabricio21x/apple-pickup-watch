# Verdict: Apple Store pickup stock monitor

- Feature: pickup-watch
- Tree: 5f540b6a9e845d035e670577cd85dc461e48513a
- Date: 2026-10-25

Validation evidence: `.git/fbs/evidence/pickup-watch/2026-10-25-1759/index.md` (captured on this tree after changes 11 and 12, the refusal backoff and renew-on-rejection; below as "validate").

## Suite
- `npm test` → "Test Files  9 passed (9)", "Tests  498 passed (498)"
- `npx tsc --noEmit` → clean, no output
- Failures not in the baseline: none (plan.md records no failing baseline tests)

## Criteria
- [x] Picker lists every configuration; selecting creates one watch per configuration — validate: "spec.md:52 picker and watch creation"; test/apple.test.ts:45 "lists 32 iPhone 18 Pro and Pro Max parts plus 8 Duo parts from the two locator families"; test/api.test.ts:500 "creates one watch per posted part with other colors on"
- [x] Zip lists stores with name and distance, all on; a store toggled off never alerts — validate: "spec.md:53 stores"; test/api.test.ts:354 "lists the stores Apple returns for the zip with name and distance, all enabled"; test/monitor.test.ts:269 "does not alert for a store that is toggled off"
- [x] One request per check covering all tracked parts; 45–75 s apart while checks succeed — test/monitor.test.ts:389 "sends one Apple request holding every tracked part and the zip"; test/monitor.test.ts:1570 "starts 45 to 75 seconds apart over 100 checks at the default interval"
- [x] At most 20 tracked parts; refusal says how many it adds; "N / 20 parts tracked" — validate: "spec.md:55 cap"; test/api.test.ts:614 "parts cap" block
- [x] A new watch has other colors on; turning it off stops other-color entries — validate: "spec.md:56"; test/monitor.test.ts:327 "sends no other-color message when the watch has the switch off"; test/monitor.test.ts:337 "turning the switch off prunes the other-color rows silently and no out-of-stock message follows"
- [x] Other-color part in the model + storage message, labelled "Other color", same in/out rules — test/monitor.test.ts:300 "lists a watched color and its other color in one message, the other labelled \"Other color\""; test/monitor.test.ts:313 "sends one silent message naming the other color when it goes back out"; validate: "spec.md:57 other colors on the board"
- [x] Interval change without a restart — validate: "interval change without a restart" (saved 61, restored to 60)
- [x] After Apple refuses a check, the next checks start 2, 5, then 10 minutes later and stay 10 minutes apart until a success; a success or a newer token returns to the set interval; network errors don't slow checks — test/monitor.test.ts:1422 "spaces the checks 2, 5, 10 and 10 minutes apart after Apple answers HTTP %i" (541, 401, 403, 429); test/monitor.test.ts:1433 "returns to the set interval after a check succeeds"; test/monitor.test.ts:1461 "resets the backoff and reschedules one interval from now when a newer token is stored"
- [x] When the token is reported rejected, token:auto stores a fresh pair within 2 minutes, at most once every 10 minutes; a refused fresh pair is named as Apple limiting the network — test/token-auto.test.ts:48 "renews when the server reports the token rejected and no forced renewal happened yet" and the `shouldRenewOnRejection` block; test/apple.test.ts:384 "classifies HTTP %i with a token newer than the one at the first refusal as network-limited"; test/monitor.test.ts:992 "is network-limited when a token newer than the one at the first refusal is refused too"; test/monitor.test.ts:1475 "settles at 10 minutes apart when the fresh token is refused too and nothing renews it again"; validate: "down message names Apple limiting the network (page side)". The token:auto loop's 1-minute status read is verified by reading scripts/token-auto.ts (recorded in plan.md T24)
- [x] One message per model + storage within one cycle, with sound, every enabled in-stock store grouped Today/Tomorrow with distance, new stores 🆕, one buy button per in-stock color — test/monitor.test.ts:147 "sends one message with sound for two colors coming in at three stores, every store new"; test/monitor.test.ts:163 "lists all four stores when a fourth comes in later, with only the fourth marked new"; test/telegram.test.ts:46 "renders a bold heading, a bold color, and Today and Tomorrow lines with distances"; test/telegram.test.ts:176 "carries one 🛒 Buy button per in-stock color with that color's URL"; test/monitor.test.ts:634 "still sends the first watched in-stock message when a slow Apple call used up the time before the deadline"
- [x] Stores only going out → one silent message with what's left and what went out; none left → sold out everywhere — test/monitor.test.ts:179 "sends one silent message with the stores left and the one that went out when a store goes out"; test/monitor.test.ts:207 "gives exactly one in-stock and one out-of-stock message over out, in, in, out"; test/telegram.test.ts:168 "says sold out everywhere, with no buttons, when no color is left"
- [x] Buy button preselects every option Apple's URL supports — test/apple.test.ts:125 "ends every buy link in -unlocked with no query, so Apple preselects Unlocked and No trade-in"; validate: "buy link" (Burgundy, 256GB, No trade-in, Buy, Unlocked selected)
- [x] No repeat while unchanged, including after a restart; Today/Tomorrow alone sends nothing — test/monitor.test.ts:239 "sends nothing for an unchanged pair after a restart over the same database"; test/monitor.test.ts:227 "sends nothing when the day label changes while the pair stays in stock"
- [x] Down, back up, token expiring and monitor started messages each with their emoji and bold heading — test/telegram.test.ts:241, :264, :268, :272 (🚨 Monitoring is down, ✅ Back up, ⏳ Token expiring, ▶️ Monitor started)
- [x] `unavailable` and `default` are not in stock — test/domain.test.ts:166 "treats %j as not in stock"; test/monitor.test.ts:256 "treats %s as not in stock: an alerted pair goes out"
- [x] Exactly one down after 3 failures naming the cause, and that checks are slowed when they are; exactly one back up — test/monitor.test.ts:798 "sends one plain-text \"monitoring is down\" message naming a %s cause on the third failure, not before"; test/monitor.test.ts:1013 "names Apple limiting the network in the one down message and says the checks are slowed"; test/monitor.test.ts:822 "sends no further down message while the failures go on"; test/monitor.test.ts:865 "sends exactly one back up message on the first success after the down message"
- [x] Settings shows whether the token works; a pasted cURL replaces it — validate: "token status and cURL paste"; test/api.test.ts:783 "stores a pasted cURL and reports status and expiry only"
- [x] Spike ended with a written result; the token stays valid unattended — spike/RESULT.md (CDP variant kept a working pair 3 h unattended); validate: "token kept valid unattended"; test/token-auto.test.ts (needsRefresh, nextCheckDelayMs, shouldRenewOnRejection)
- [x] The test button delivers a Telegram message — validate: "test message" ("Test message sent.", lastError null); test/api.test.ts:897 "sends a test message and answers ok"
- [x] Stock board: Today / Tomorrow / unavailable per tracked pair, in stock first, last successful check — validate: "stock board"; test/web-logic.test.ts:222 "orders a phone stores Today first, then Tomorrow, then Apple own labels, nearest first within each"; test/web-logic.test.ts:253 "shows phones with a Today store before phones with only Tomorrow, then in catalog order"; test/web-logic.test.ts:398 "shows the check interval, the age of the last successful check and the token time left"
- [x] Four views; sidebar on wide screens, bottom tabs on the phone; refresh and back keep the view — validate: "four views" (1060 px content column at 1500 px, side rail stays in place while scrolling); test/stock-board.test.ts:42 "puts the cap note and its Trim your watches link before the first phone, so Tab reaches it before the Buy buttons"
- [x] Every view usable at 375 px with no horizontal scroll — validate: "375 px" (all four views, the network-limited state and the Wi-Fi notice)
- [x] Unreachable from other devices by default; reachable after the Wi-Fi opt-in — test/boot.test.ts:42 "binds loopback only by default and all interfaces once Wi-Fi access was saved"; validate: "Wi-Fi" (200 from http://192.168.18.75:4319 and http://fabricios-macbook.local:4319 with the opt-in)
- [x] No API response contains the bot token or the Apple cookie values — test/api.test.ts:1122 "never returns the Apple cookie values or the bot token from any route, error paths included"; validate: "no secrets"
- [x] The whole app starts with one command — validate: "one command" (`npm start` built and served the app on this tree)

## Open issues
None

## Verdict
Verdict: pass
Every acceptance criterion has a green test or validation evidence from this tree, nothing is escalated or blocked, and every final review, including changes 11 and 12, approved with comments.
