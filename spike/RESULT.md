# Token spike result

Question: how does the monitor keep an Apple `dssid2` + `shld_bt_ck` pair valid, unattended? The pair lasts 2 hours, and Apple answers HTTP 541 once it is rejected.

**Decision: `npm run token:auto` over CDP into a dedicated Brave profile. No browser extension.** One automated variant kept working for 3 hours unattended, which meets the spec's bar (2+ hours).

## Variants

| Variant | Result |
| --- | --- |
| replay (2026-10-23 22:03Z) | Node `fetch` and a curl control both got HTTP 200 with a pasted pair. Apple's `Set-Cookie` issues a new `dssid2` and clears `shld_bt_ck` on each response. Adopting those did not help, so they are not adopted. |
| parts-cap | One request with 40 parts got HTTP 200, but every store returned 20 of 40 parts. Apple caps a request at 20 parts. |
| playwright (Chromium, headful) | HTTP 541, rejected. |
| cdp (Brave 1.97 on Chromium 155, dedicated `--user-data-dir`, `--remote-debugging-port=9222`, attached with Playwright `chromium.connectOverCDP`) | Rounds at 22:11Z, 23:41Z and 01:11Z all HTTP 200 with 12 stores: 3 hours unattended. Round 3 got a fresh pair. |

Brave on Chromium 155 ignores remote debugging on the default profile, so the CDP variant needs its own `--user-data-dir`, launched normally (not headless).

## How the pair renews

Probes on 2026-10-24:

- A buy-page load renews `shld_bt_ck` only after it has expired. Ten loads from 31 to 3 minutes before expiry renewed nothing; the first load after expiry did. Waiting for expiry would leave a gap.
- Deleting `shld_bt_ck` in the profile (`context.clearCookies({ name: 'shld_bt_ck' })`) and reloading `https://www.apple.com/shop/buy-iphone/iphone-18-pro` issues a fresh pair at any time: a new 2 hour expiry with the same `dssid2`. Fulfillment accepts it with HTTP 200, and the old pair stays accepted, so there is no gap.

## What `scripts/token-auto.ts` does

- Attaches to the CDP port, launching Brave with the dedicated profile (default `data/brave-profile`) when nothing answers.
- If the pair is missing or expires within 20 minutes, clears `shld_bt_ck`, reloads the buy page in its own tab and reads the pair again.
- Posts `{dssid2, shld_bt_ck, userAgent}` to `POST /api/token` on start and at every check, then sleeps until 20 minutes before the expiry (at most 10 minutes between checks). The server stores a pair only when its expiry is strictly newer.
- Refreshing 20 minutes early keeps the monitor's 15-minute expiry warning quiet.
- On any error it logs and retries in a minute, reconnecting or relaunching Brave if the CDP connection dropped.

## Live check (2026-10-24)

Against a throwaway server, the script attached to the running spike Brave and posted a pair: `POST /api/token` HTTP 200, `stored=true`, and `/api/state` showed the token `untested` with the pair's expiry. With the refresh margin raised to force a refresh, it cleared `shld_bt_ck`, reloaded the buy page, read a pair expiring 2 hours later than the old one, and the server stored it.

## Not built

The browser extension fallback. It is only needed when no automated variant passes.
