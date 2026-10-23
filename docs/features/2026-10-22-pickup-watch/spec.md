# Apple Store pickup stock monitor

- Size: big
- Feature: pickup-watch

## Problem
New iPhones (iPhone 18 Pro, 18 Pro Max, iPhone Duo) sell out for in-store pickup, and stock shows up at individual Apple Stores without warning. Today the only way to catch it is to keep reloading Apple's "Check availability" panel by hand, store by store and configuration by configuration. By the time a unit is noticed, it is often gone. The single user wants a tool that watches the exact configurations they want at the stores near a zip code and tells them the moment one becomes available, so they can check out before it sells out.

Apple's stock endpoint is undocumented and bot-protected. What we know about it is in `apple-api-notes.md` in this folder.

## Goal and success measure
Goal: the user gets a Telegram alert, within about one check cycle (60 s ±15 s), when a watched configuration becomes available for pickup at a selected store, and can open that configuration's buy page from the alert to check out.

Success measure: during a real stock event before or after 2026-11-01, the user receives the in-stock alert for a watched configuration and store, and reaches the buy page from the alert's store link.

## Users affected
- The single user who runs the monitor and buys the phone (owner and only operator).

## Scope
- Product catalog: every configuration (model + storage + color, one part number each) of the iPhone 18 Pro, 18 Pro Max and iPhone Duo, read from Apple's buy pages.
- Watches: the user picks one or more exact configurations from the list (Model → Storage → Color, multi-select).
- Location: one 5-digit US zip code; the nearby stores Apple returns (up to 12) are listed with distance and a toggle each, all on by default.
- Other colors: each watch also covers the other colors of the same model and storage, on by default, with a per-watch switch "Also alert for other colors".
- Poller: one `fulfillment-messages` request for all watched parts, plus the other-color parts of watches with the switch on, every 60 s ±15 s random jitter, interval adjustable in the UI.
- Parts cap: at most 20 tracked parts (watched plus other-color), because Apple returns at most 20 parts per request. A new watch or an other-colors switch that would go past 20 is refused with a message saying how many parts it would add, and the page always shows "N / 20 parts tracked".
- Token acquisition: a time-boxed (1 day) spike on getting a working `dssid2` + `shld_bt_ck` pair automatically (Playwright, and attaching over CDP to a normally launched Brave with the user's profile); if no automated variant keeps working for 2+ hours unattended, a browser extension that pushes the pair from the user's real browser; pasting a cURL into the UI as the fallback in either case.
- Stock state: `pickupDisplay: "available"` counts as in stock, labelled Today or Tomorrow from the quote; every other value (`unavailable`, `default`) counts as not in stock. Last known state per (part, store) is persisted, so a restart does not re-alert.
- Telegram alerts, one message per model + storage: when a check finds that any tracked (part, enabled store) pair of a model + storage came in or went out, one new message for that model + storage; nothing while unchanged. A store that stays in stock and only changes between Today and Tomorrow sends nothing.
- Stock message content: the model and storage as a bold heading; a section per color that is in stock, watched colors first and the others labelled "Other color"; under each color, its stores grouped Today and Tomorrow, each store name a buy link, with its distance; stores new since the last message marked 🆕; a line naming the stores that just went out. When no store is left for the model + storage, the message says it is sold out everywhere. Emojis tell in stock, new and out apart.
- Sound: a message that adds at least one store notifies; a message where stores only went out arrives silently.
- Buy links: each store link opens that configuration's buy page with as many as Apple's URL supports of: the color, Unlocked, No trade-in, that store for pickup, and the zip. Whatever the URL can't carry is left for the user to pick on the page.
- Other colors: an other-color part follows the same in / out rules as a watched part and appears in its model + storage message under its color, labelled "Other color".
- Health alerts: one "monitoring is down" alert after 3 consecutive failed checks, naming the cause (token expired/rejected, network, unexpected response), and one "back up" alert when checks succeed again.
- Other messages (down, back up, token expiring, monitor started) use the same style: each kind has its own emoji and bold heading.
- UI: mobile-first views with client-side navigation, a sidebar on wide screens and bottom tabs on the phone, the current view kept in the URL. Stock board (home): every tracked part × enabled store with Today / Tomorrow / unavailable, in stock first, plus the last successful check and health. Watches: product picker, watches with their other-colors switch, and the parts count. Stores: zip + store toggles. Settings: Telegram status and test message, token status and cURL paste, check interval, Wi-Fi access opt-in.
- Network exposure: the server listens on localhost by default; an opt-in setting exposes it on the local network; API responses never include the Telegram bot token or Apple cookies.

## Out of scope
- Login or user accounts: single user on localhost; login belongs with the later deploy.
- Deploying to Railway: local first; deploy is a later feature and needs the untested datacenter-IP check.
- Several zip codes at once: one location covers the user's stated need with one request per check.
- Non-US stores: the user watches US Apple Stores only.
- Model-level watches ("any 18 Pro Max"): exact configurations first; can come later.
- Automating checkout: the user checks out themselves.
- Preselecting buy-page options by anything other than the URL (scripted clicks, a browser helper): the links preselect what Apple's URL allows, and the 2026-11-01 deadline leaves no room for more.
- More than 20 tracked parts: needs several requests per check, which is a redesign.
- Zip autocomplete: a 5-digit zip needs none, and the typeahead returned nothing from plain HTTP.
- Keeping the Mac awake: the user's Mac is always on.
- Models other than iPhone 18 Pro, 18 Pro Max and iPhone Duo: not needed now.

## Acceptance criteria
- [ ] The product picker lists every configuration found on Apple's iPhone 18 Pro and iPhone Duo buy pages, each shown as model, storage and color, and selecting one or more creates a watch per configuration.
- [ ] Entering a valid 5-digit US zip lists the stores Apple returns for it with name and distance, all toggled on; a store toggled off never triggers an alert.
- [ ] Each check sends exactly one `fulfillment-messages` request covering all watched parts and the other-color parts of watches with the switch on, and consecutive checks are 45–75 s apart at the default interval.
- [ ] Tracked parts never exceed 20: adding a watch or turning on other colors that would go past 20 is refused with a message saying how many parts it would add, and the Watches view shows "N / 20 parts tracked".
- [ ] A new watch has "Also alert for other colors" on; turning it off stops other-color entries for that watch.
- [ ] When a same-model, same-storage, different-color part of a watch with the switch on changes to `available` at an enabled store, it appears in that model + storage message under its color, labelled "Other color", by the same in / out rules as a watched part.
- [ ] Changing the interval in the UI changes the time between checks without a restart.
- [ ] When one or more tracked pairs of a model + storage change from not in stock to `available` in a check, exactly one Telegram message for that model + storage arrives within one check cycle, with sound, listing every enabled store where each of its tracked colors is in stock, grouped Today and Tomorrow, each store name a link with its distance, and the new stores marked 🆕.
- [ ] When pairs of a model + storage only go back to not in stock in a check, exactly one silent message arrives listing the stores still in stock and naming those that went out; when none is left, it says sold out everywhere.
- [ ] Each store link opens the buy page with every option the design found Apple's URL to support preselected (from color, Unlocked, No trade-in, store, zip).
- [ ] While a pair's state is unchanged, no further message is sent for it, including after the server restarts; a change between Today and Tomorrow alone sends nothing.
- [ ] Down, back up, token expiring and monitor started messages each carry their own emoji and bold heading.
- [ ] `unavailable` and `default` are both treated as not in stock.
- [ ] After 3 consecutive failed checks, exactly one "monitoring is down" message arrives naming the cause; when a check next succeeds, exactly one "back up" message arrives.
- [ ] The Settings view shows whether the Apple token is working, and the user can paste a cURL from their browser to replace it.
- [ ] The token spike ends within 1 day with a written result; if no automated variant kept working for 2+ hours unattended, the browser extension keeps the server's token valid while Brave is open.
- [ ] The "send test message" button delivers a Telegram message to the configured chat.
- [ ] The Stock board shows Today / Tomorrow / unavailable for each tracked pair, in-stock pairs first, and the time of the last successful check.
- [ ] Stock board, Watches, Stores and Settings are separate views reached from a sidebar on wide screens and bottom tabs at phone width; a refresh or the browser's back button keeps or returns to the view.
- [ ] Every view is fully usable at 375 px width with no horizontal scroll.
- [ ] By default the server is unreachable from another device on the network; after enabling the Wi-Fi opt-in it is reachable from the phone on the same network.
- [ ] No API response contains the Telegram bot token or the Apple cookie values.
- [ ] The whole app starts locally with one command.

## Facts
- The alerts must be working by 2026-11-01 (user, 2026-10-22)
- The monitor has a single user, the owner (user, 2026-10-22)
- Only US Apple Stores are watched (user, 2026-10-22)
- The Mac running the monitor is always on and does not sleep (user, 2026-10-22)
- The models to watch are the iPhone 18 Pro, iPhone 18 Pro Max and iPhone Duo (user, 2026-10-22)
- Apple's store uses `fulfillment-messages`, `pickup-message-recommendations` and `typeahead` for pickup availability and location lookup (user, 2026-10-22)
- Each model + storage + color configuration has its own Apple part number (user, 2026-10-22)
- Availability of the same model and storage in a different color is worth an alert (user, 2026-10-22)
- The user prefers TypeScript, React and Node, and agreed to Hono + Vite + React with SQLite in one process (user, 2026-10-22)
- The user wants the UI built with shadcn/ui (user, 2026-10-22)
- The app runs locally for now; a later deploy may target Railway (user, 2026-10-22)
- Apple returns at most 20 parts per `fulfillment-messages` request (docs/features/2026-10-22-pickup-watch/plan.md:124)
- Tracking at most 20 parts is acceptable for now (user, 2026-10-23)
- Buy links should preselect Unlocked and No trade-in (user, 2026-10-23)
- The owner uses the page on the Mac and the phone about equally (user, 2026-10-23)
- Prefers HTML or Markdown formatting for Telegram messages (user, 2026-10-23)

## Assumptions
None

## Open questions
None

## Design
(Mid only; written by /fbs:architect)

## Decision log
- 2026-10-22: Build an Apple Store pickup monitor for the iPhone 18 Pro, 18 Pro Max and iPhone Duo. Why: the user wants a real-time alert so they can check out before stock sells out.
- 2026-10-22: A watch is one exact configuration (part number); several watches at once; model-level watches later. Why: Apple tracks pickup stock per part number, and exact watches avoid alerts for unwanted configurations.
- 2026-10-22: The catalog is read from the part numbers embedded in Apple's buy pages and offered as a Model → Storage → Color picker. Why: the user picks from a list instead of typing codes, and the buy pages already list every configuration.
- 2026-10-22: One zip code; Apple's nearby stores listed with toggles, all on by default. Why: one input, and far stores can still be excluded.
- 2026-10-22: Poll `fulfillment-messages` once per cycle for all watched parts, every 60 s ±15 s, adjustable. Why: one request covers every part and store, and a slower rate lowers the chance of the session being blocked.
- 2026-10-22: Count `available` as in stock (labelled Today or Tomorrow) and every other value as not in stock. Why: the user wants alerts for both same-day and next-day pickup, told apart in the message.
- 2026-10-22: Alert on each change to in stock and on each change back to out of stock, never while unchanged; persist the last known state. Why: the user can tell from the chat whether stock is still there even if they missed the first alert, and a restart must not spam.
- 2026-10-22: Send alerts through a Telegram bot. Why: free, works from a local server with outbound calls only, and supports a link button; web push would need HTTPS and a Home Screen PWA reachable from the phone.
- 2026-10-22: The in-stock alert carries model, storage, color, store, distance, pickup day and a button to the configuration's buy page; the user picks the store at checkout. Why: two taps to the right page with nothing unproven to build.
- 2026-10-22: Alert on the same model and storage in another color, as its own message labelled "Other color", with the same appear/disappear rules. Why: the user wants to know when their color is out but another is in, and only a separate alert can say that.
- 2026-10-22: Other colors are on by default with a per-watch switch. Why: it is what the user asked for, and the switch silences a model where only one color will do.
- 2026-10-22: Fetch other colors by adding their parts to the same `fulfillment-messages` request, not from `pickup-message-recommendations`. Why: the recommendations endpoint returns at most 3 similar parts and omits the queried one, so it misses colors at random; one exact request covers them all.
- 2026-10-22: Health alert after 3 consecutive failed checks naming the cause, plus a recovery alert. Why: when the token dies every check fails, and silence must not look like "no stock".
- 2026-10-22: Token: spike Playwright and CDP-attached Brave first, time-boxed to 1 day; if none keeps working 2+ hours unattended, build a browser extension that pushes the token pair; pasting a cURL is the fallback. Why: an automated source needs nothing from the user, the extension is the known-good route (a DevTools-controlled Chrome's token was rejected), and the 2026-11-01 deadline is fixed.
- 2026-10-22: The stack, hosting and data store are left to /fbs:architect; the user's preference is recorded in Facts. Why: technology choices belong to the design stage.
- 2026-10-22: Record the technology preference as Hono + Vite + React with SQLite, over the earlier Next.js / NestJS wording. Why: it is the user's latest answer, and the earlier wording mentioned a monorepo the user never asked for.
- 2026-10-22: One mobile-first, well-organised page. Why: a single-user tool the user mostly glances at.
- 2026-10-22: Listen on localhost by default with a Wi-Fi opt-in; never return secrets from the API. Why: no login exists in v1, and login belongs with the later deploy.
- 2026-10-22: No sleep prevention. Why: the user's Mac is always on.
- 2026-10-22: US stores only, one location, no deploy, no login, no auto-checkout in this feature. Why: the user's stated scope and the 2026-11-01 deadline.
- 2026-10-23: Amended: one message per model + storage, with a section per color and its stores as buy links grouped Today and Tomorrow, replacing one message per (part, store) with a button. Why: change 1 (user, walkthrough 2026-10-23); grouping by model + storage over per part because the owner watches all 4 colors of one model, so a restock is 1 notification instead of up to 4.
- 2026-10-23: Amended: each change sends a new message with the full current store list, new stores marked and gone stores named, rather than only the stores that changed or one message edited in place. Why: change 1 (user, 2026-10-23); the latest message is always the whole picture, and Telegram edits make no sound.
- 2026-10-23: Amended: messages that add a store notify; messages where stores only went out are silent; a Today/Tomorrow change alone sends nothing. Why: change 1 (user, 2026-10-23); only new stock needs action, and the day labels flip on their own twice a day.
- 2026-10-23: Amended: all Telegram messages get emojis and bold headings; the HTML or Markdown choice is left to /fbs:architect as the owner's preference. Why: change 1 (user, 2026-10-23).
- 2026-10-23: Amended: buy links preselect, as far as Apple's URL allows, the color, Unlocked, No trade-in, the store and the zip; store preselection moves back into scope. Why: change 2 (user, 2026-10-23); best effort, because nobody knows yet what Apple's URL accepts and the deadline is fixed.
- 2026-10-23: Amended: the page becomes Stock board, Watches, Stores and Settings views with a sidebar on wide screens and bottom tabs on the phone, replacing the single page. Why: change 4 (user, 2026-10-23); the owner uses both screens equally, and the stock board is what they check most.
- 2026-10-23: Amended: at most 20 tracked parts; a change that would exceed it is refused and the page shows the count. Why: change 5 (user, 2026-10-23); Apple returns at most 20 parts per request, and nothing set up is dropped silently.
