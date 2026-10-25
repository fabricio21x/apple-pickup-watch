# Validation setup: pickup-watch

- Verified end to end: 2026-10-24, launch (`npm start`), health (`GET /api/state`), token source (`npm run token:auto`), and the navigation flow at 375 px and 1280 px in Chrome DevTools MCP; stock board flow updated for change 9 on 2026-10-25

## Launch
- Stop the LaunchAgent copy first if it is installed (`launchctl bootout gui/$UID/com.pickup-watch`; restart it in Cleanup), so port 4319 is free.
- App: `npm start` from the repo root, in the background (it runs `vite build`, then `tsx src/server/index.ts`). Serves http://127.0.0.1:4319. Ready when the log prints `pickup-watch listening on 127.0.0.1:4319` and `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4319/api/state` prints `200`; allow 60 s.
- Token: `npm run token:auto` in the background. It launches Brave with the profile `data/brave-profile` and CDP port 9222 if that port isn't answering. Ready when its log prints `POST /api/token: HTTP 200`; allow 60 s.
- It uses the owner's real `data/pickup-watch.db` and `.env`, so it sends real Telegram messages (at least "Monitor started") and calls Apple once a minute.

## Health
`curl -s http://127.0.0.1:4319/api/state` returns JSON with `token.status` `working` (or `untested` right after a new pair), `telegram.configured` `true`, and `health.status` `healthy` with `lastSuccessAt` set within about 75 s of a valid token. Never print the whole response into chat: quote only these fields.

## Auth
None. The app has no login and answers only on 127.0.0.1 (spec.md: single owner). `POST /api/token` and `PUT /api/lan` accept loopback callers only, which the local browser is.

## Flows
- **Navigation:** open http://127.0.0.1:4319/. The nav has `aria-label="Views"` with links Stock, Watches, Stores, Settings (`href="#/stock"` …); the active one has `aria-current`. At 1280 px the sidebar shows (heading "Pickup watch", the nav, health and token chips); at 375 px a top bar and a fixed bottom tab bar show instead. End state: the URL hash matches the view, reload keeps it, browser back returns to the previous view, and `document.documentElement.scrollWidth <= innerWidth` on every view.
- **Stock board (`#/stock`), redesigned by change 9 (mockup `docs/features/2026-10-22-pickup-watch/mockups/stock-board.html`):** a status strip (`role="status"`: "Checking every minute · last check <age>", "Token <time> left"); when monitoring is down a `role="alert"` banner and "Last known stock, <time>" above faded stock. One `section` per phone with stock, labelled with the phone (model, storage, color), its in-stock store rows (name, distance, Today/Tomorrow pill), a Buy link whose `aria-label` starts "Buy <model> <storage> <color> on apple.com", and a `details`/`summary` "Not at N other stores". Phones with nothing nearby sit under "Not in stock nearby" (`aria-label="Not in stock nearby"`). Other states: "Nothing nearby yet", "Set up your watch" (first run), a `role="status"` "Loading stock" skeleton. The old health and token chips are hidden on this view. End state: in-stock phones first, Today before Tomorrow then nearest, Buy opens the `-unlocked` URL, `scrollWidth <= innerWidth` at 375 px.
- **Watches (`#/watches`):** card "Watching" with "N / 20 parts tracked" and one row per watch (switch labelled "Also alert for other colors", button "Remove"); card "Watch a phone" with a checkbox per configuration (labelled by the configuration) and the button "Select configurations" / "Watch N selected". Selecting enough parts to pass 20 shows "Adds N parts, which would make T / 20." and keeps the selection. Don't leave test watches behind: remove any you add.
- **Stores (`#/stores`):** card "Stores", input labelled "Zip code", button "Find stores", one switch per store labelled with its name and distance.
- **Settings (`#/settings`):** card "Settings"; button "Send test message" (sends a real Telegram message; the page shows the result); button "Paste cURL" opens a dialog with a textarea `aria-label="cURL command"` and "Save token"; input labelled "Check interval (seconds, 30 to 3600)" with "Save"; switch labelled "Wi-Fi access from other devices" (don't flip it during validation: it needs a restart and opens the app to the network).

## Cleanup
- Stop the `npm start` process tree (its `tsx src/server/index.ts` child) and `token:auto` (`scripts/token-auto.ts`) that you started. Leave the Brave window it launched only if the owner wants token:auto kept running; otherwise quit that Brave (profile `data/brave-profile`).
- Remove any watch you added, restore any store toggle or interval you changed.
- Restart the LaunchAgent if you stopped it: `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.pickup-watch.plist`.

## Helpers
None.
