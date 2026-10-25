# Verdict: Apple Store pickup stock monitor

- Feature: pickup-watch
- Tree: 2aecb48654af4369c95aad3c9128d4ee02cea772
- Date: 2026-10-25

Validation evidence: `.git/fbs/evidence/pickup-watch/2026-10-25-1200/index.md` (captured on this tree after change 9, the redesigned stock board; below as "validate"). Test citations outside test/web-logic.test.ts are unchanged since the previous verdict: no server or test file other than test/web-logic.test.ts changed since f71bbca.

## Suite
- `npm test` → "Test Files  8 passed (8)", "Tests  445 passed (445)"
- `npx tsc --noEmit` → clean, no output
- Failures not in the baseline: none (plan.md records no failing baseline tests)

## Criteria
- [x] Picker lists every configuration; selecting creates one watch per configuration — validate: "spec.md:52 picker and watch creation" (40 configurations, a watch created with other colors on, then removed); test/api.test.ts:492 "creates one watch per posted part with other colors on"
- [x] Zip lists stores with name and distance, all on; a store toggled off never alerts — validate: "spec.md:53 stores"; test/api.test.ts:346 "lists the stores Apple returns for the zip with name and distance, all enabled"; test/monitor.test.ts:269 "does not alert for a store that is toggled off"
- [x] One request per check covering all tracked parts; 45–75 s apart at the default — test/monitor.test.ts:389 "sends one Apple request holding every tracked part and the zip"; test/monitor.test.ts:1351 "starts 45 to 75 seconds apart over 100 checks at the default interval"
- [x] At most 20 tracked parts; refusal says how many it adds; "N / 20 parts tracked" — validate: "spec.md:55 cap" ("Adds 36 parts, which would make 40 / 20.", count stayed "4 / 20 parts tracked"); test/api.test.ts "parts cap" block
- [x] A new watch has other colors on; turning it off stops other-color entries — validate: "spec.md:56"; test/monitor.test.ts:327 "sends no other-color message when the watch has the switch off"; test/monitor.test.ts:337 "turning the switch off prunes the other-color rows silently and no out-of-stock message follows"
- [x] Other-color part appears in the model + storage message, labelled "Other color", same in/out rules — test/monitor.test.ts:300 "lists a watched color and its other color in one message, the other labelled \"Other color\""; test/monitor.test.ts:313 "sends one silent message naming the other color when it goes back out"; validate: "spec.md:57 other colors on the board"
- [x] Interval change without a restart — validate: "spec.md:58 interval" (saved 46, `intervalSec` 46, restored to 45)
- [x] One message per model + storage within one cycle, with sound, every enabled in-stock store grouped Today/Tomorrow with distance, new stores 🆕, one buy button per in-stock color — test/monitor.test.ts:147 "sends one message with sound for two colors coming in at three stores, every store new"; test/monitor.test.ts:163 "lists all four stores when a fourth comes in later, with only the fourth marked new"; test/telegram.test.ts:46 "renders a bold heading, a bold color, and Today and Tomorrow lines with distances"; test/telegram.test.ts:176 "carries one 🛒 Buy button per in-stock color with that color's URL"; test/monitor.test.ts:1505 (first watched in-stock message sent within the cycle)
- [x] Stores only going out → one silent message with what's left and what went out; none left → sold out everywhere — test/monitor.test.ts:179 "sends one silent message with the stores left and the one that went out when a store goes out"; test/monitor.test.ts:207 "gives exactly one in-stock and one out-of-stock message over out, in, in, out"; test/telegram.test.ts:168 "says sold out everywhere, with no buttons, when no color is left"
- [x] Buy button preselects every option Apple's URL supports — test/apple.test.ts:125 "ends every buy link in -unlocked with no query, so Apple preselects Unlocked and No trade-in"; validate: "spec.md:61 buy link" (Burgundy, 256GB, No trade-in, Buy, Unlocked selected); store and zip have no URL key (design.md decision 10)
- [x] No repeat while unchanged, including after a restart; Today/Tomorrow alone sends nothing — test/monitor.test.ts:239 "sends nothing for an unchanged pair after a restart over the same database"; test/monitor.test.ts:227 "sends nothing when the day label changes while the pair stays in stock"
- [x] Down, back up, token expiring and monitor started messages each with their emoji and bold heading — test/telegram.test.ts:238, :246, :250, :254 (🚨 Monitoring is down, ✅ Back up, ⏳ Token expiring, ▶️ Monitor started)
- [x] `unavailable` and `default` are not in stock — test/domain.test.ts:166 "treats %j as not in stock"; test/monitor.test.ts:256 "treats %s as not in stock: an alerted pair goes out"
- [x] Exactly one down after 3 failures naming the cause; exactly one back up — test/monitor.test.ts:794 "sends one plain-text \"monitoring is down\" message naming a %s cause on the third failure, not before"; test/monitor.test.ts:822 "sends no further down message while the failures go on"; test/monitor.test.ts:865 "sends exactly one back up message on the first success after the down message"
- [x] Settings shows whether the token works; a pasted cURL replaces it — validate: "spec.md:66 token status and cURL paste"; test/api.test.ts:775 "stores a pasted cURL and reports status and expiry only"
- [x] Spike ended with a written result; the token stays valid unattended (no extension needed) — spike/RESULT.md (CDP variant kept a working pair 3 h unattended); validate: "spec.md:67" (token:auto running since 2026-10-24 15:25Z, a stored refresh about every 100 min overnight, the latest at 16:27:51Z on 2026-10-25); test/token-auto.test.ts:14 "refreshes a pair that expires within 20 minutes"
- [x] The test button delivers a Telegram message — validate: "spec.md:68 test message" ("Test message sent.", POST 200, lastError null; receipt confirmed by the owner in the 2026-10-24 walkthrough)
- [x] Stock board: Today / Tomorrow / unavailable per tracked pair, in stock first, last successful check — validate: "spec.md:69 stock board (redesigned, C9)" (phones with stock first, Today then nearest, the rest collapsed or under "Not in stock nearby", "last check 13 s ago"); test/web-logic.test.ts:222 "orders a phone stores Today first, then Tomorrow, then Apple own labels, nearest first within each"; test/web-logic.test.ts:243 "keeps stores without stock apart from the in-stock list: not checked ones listed, unavailable ones collapsed"; test/web-logic.test.ts:253 "shows phones with a Today store before phones with only Tomorrow, then in catalog order"; test/web-logic.test.ts:398 "shows the check interval, the age of the last successful check and the token time left"
- [x] Four views; sidebar on wide screens, bottom tabs on the phone; refresh and back keep the view — validate: "spec.md:70 four views"
- [x] Every view usable at 375 px with no horizontal scroll — validate: "spec.md:71 375 px" (scrollWidth 375/375 on all four views and with the Wi-Fi notice shown)
- [x] Unreachable from other devices by default; reachable after the Wi-Fi opt-in — test/boot.test.ts:42 "binds loopback only by default and all interfaces once Wi-Fi access was saved"; validate: "spec.md:72 Wi-Fi" (listening on *:4319 with the opt-in, 200 from http://192.168.18.75:4319 and http://fabricios-macbook.local:4319; the restart notice shows while a change is pending)
- [x] No API response contains the bot token or the Apple cookie values — test/api.test.ts:1094 "never returns the Apple cookie values or the bot token from any route, error paths included"; validate: "spec.md:73 no secrets"
- [x] The whole app starts with one command — validate: "spec.md:74 one command" (`npm start` built and served the app on this tree)

## Open issues
None

## Verdict
Verdict: pass
Every acceptance criterion has a green test or validation evidence from this tree, nothing is escalated or blocked, and every final review, including change 9's, approved with comments.
