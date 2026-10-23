# Pickup watch

Watches Apple Store pickup availability for iPhone configurations and sends a Telegram message when one comes into stock (and when it goes out). One process, one SQLite file, one page at `http://127.0.0.1:4319`.

## Setup

Needs Node 22 or newer.

1. **Telegram bot.** In Telegram, message `@BotFather`, send `/newbot`, and copy the bot token it gives you.
2. **Chat id.** Send any message to your new bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy `message.chat.id`.
3. **`.env`.** Copy the example, fill in the token and chat id, and lock the file down (it holds the bot token):

   ```sh
   cp .env.example .env
   chmod 600 .env
   ```

   Without both values the app still runs, but sends no messages.
4. **Install and start:**

   ```sh
   npm install
   npm start
   ```

   `npm start` builds the page and starts the server. Open <http://127.0.0.1:4319>.

The first start creates `data/` (mode 0700) with the database `data/pickup-watch.db` (mode 0600). The database holds your Apple cookie, so keep it private. Deleting it re-alerts every pair currently in stock.

## Using it

1. Save your zip code to list nearby stores, and switch off the ones you don't want.
2. Pick the iPhones to watch.
3. Give the app an Apple token (below). Apple only accepts requests that carry a cookie pair from your browser, and a pair lasts at most 2 hours. The page shows its status and time left, and Telegram warns you 15 minutes before it expires.

### Token source

_To be filled in: the browser extension or `npm run token:auto`, whichever the spike picked._

### Pasting a cURL from Brave

1. Open an iPhone page on apple.com in Brave and click "Check availability" on the buy page.
2. Open DevTools, Network tab, find the `fulfillment-messages` request, right-click it, Copy, "Copy as cURL".
3. On the page, open the token dialog in the settings strip and paste it.

The token can only be set from the Mac itself, not from another device.

## Keep it running (LaunchAgent)

launchd starts the app at login and restarts it if it exits or crashes.

```sh
mkdir -p data && chmod 700 data
cp launchd/com.pickup-watch.plist ~/Library/LaunchAgents/
```

Edit `~/Library/LaunchAgents/com.pickup-watch.plist` and replace:

- `__REPO__` with the absolute path of this repo;
- `__NODE_BIN__` with the directory that holds `node` and `npm` (`dirname "$(which npm)"`).

Then load it:

```sh
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.pickup-watch.plist
```

Logs go to `data/pickup-watch.log`. To stop it: `launchctl bootout gui/$UID/com.pickup-watch`.

## Wi-Fi access (phone)

By default the server answers only on `127.0.0.1`. To open the page from your phone on the same Wi-Fi, turn on "Wi-Fi access" in the settings strip, then restart the app (`launchctl kickstart -k gui/$UID/com.pickup-watch`, or stop and rerun `npm start`). The strip then lists the URLs to use.

- There is no login: while it is on, anyone on that network can read the state and change watches, stores, zip and interval. Turn it off when you are on a network you don't trust.
- The token and the Wi-Fi switch stay Mac-only.
- The first time, macOS asks whether to allow incoming connections for `node`. Allow it (System Settings, Network, Firewall, Options).

## If Apple blocks your IP

Checking once a minute is light, but Apple may still block the session or IP, and that can refuse your own checkout from the same connection. The page and Telegram report failures within a few minutes. Raise the interval, and complete the purchase from your phone on cellular.

## Token spike

`spike/token.ts` is the throwaway experiment that decided how to keep the token valid. Its header lists the variants and flags:

```sh
npx playwright install chromium   # once, for the playwright variant
pbpaste | npx tsx spike/token.ts replay
npx tsx spike/token.ts parts-cap --file curl.txt
```

## Development

- `npm test` runs the tests, `npx tsc --noEmit` type-checks.
- `npm run dev` serves the page with Vite and proxies `/api` to `127.0.0.1`; run the server with `npx tsx src/server/index.ts` next to it.
