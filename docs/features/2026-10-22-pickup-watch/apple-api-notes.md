# Apple Store API notes (spike, 2026-10-22)

Findings from requests made from a residential IP on 2026-10-22. Apple does not document these routes; any of this can change without notice.

## Routes

| Route | Use | Works from plain HTTP |
|---|---|---|
| `GET /shop/fulfillment-messages?fae=true&pl=true&mts.0=regular&cppart=UNLOCKED/US&parts.0=<part>&parts.1=<part>…&location=<zip or "City, ST">` | Exact pickup availability per part, for the 12 stores nearest the location | Only with a valid token pair (below) |
| `GET /shop/pickup-message-recommendations?fae=true&mts.0=regular&mts.1=compact&cppart=UNLOCKED/US&location=<loc>&product=<part>` | Similar models available nearby, plus the 12 nearest stores for the location | Yes, no token needed; `recommendedProducts` held at most 3 parts and never the queried one (3 queries) |
| `GET /shop/api/typeahead?fae=true&value=<text>` | Location autocomplete in the pickup panel | Returned an empty `data:{}` for `331` |
| `GET /shop/buy-iphone/iphone-18-pro`, `/shop/buy-iphone/iphone-duo` | Buy pages | Yes; they embed `"partNumber":"…/A"` 37 and 11 times; the phone variants are 32 (18 Pro + 18 Pro Max) and 8 (Duo), the rest are `S…` parts with no phone name |

## `fulfillment-messages`

- Without a valid token it returns HTTP 541 with an HTML "Page Not Found" body, including from `fetch` inside a DevTools-controlled Chrome tab.
- It needs two cookies from the same browser session: `dssid2` and `shld_bt_ck`, plus a browser `User-Agent`. Either cookie alone, or the two from different sessions, returns 541. `x-aos-ui-fetch-call-1` and `Referer` were not required.
- The same pair worked for about 20 consecutive requests. A 200 response sends `Set-Cookie` clearing `shld_bt_ck` and issuing a new `dssid2`, but replaying the original pair kept working.
- `shld_bt_ck` has the form `<id>|<unix ts>|<payload>|<sig>`. A freshly issued one carried a timestamp exactly 2 h ahead. Confirmed 2026-10-23 UTC (evening of 2026-10-22 local): one pair (the user's), replayed every 10 min, returned 200 through 00:58 UTC and 541 from 01:08 UTC; its timestamp was 01:01 UTC. The embedded timestamp is a hard expiry, and replaying the pair does not extend it.
- A DevTools-controlled Chrome (isolated context, via chrome-devtools-mcp) received a `shld_bt_ck` on page load, but Apple rejected it in-page and from curl. One attempt.
- Several `parts.N` in one request return every part for all 12 stores, sorted by distance.
- Response path: `body.content.pickupMessage.stores[]` with `storeNumber`, `storeName`, `storedistance`, `city`, `state`, and `partsAvailability[<part>]`:
  - `pickupDisplay`: `available` | `unavailable` | `default` (the Duo showed `default` with "Check back for availability on 10.24")
  - `pickupSearchQuote`: e.g. "Available Tomorrow", "Currently unavailable"
  - `messageTypes.regular.storePickupProductTitle`: e.g. "iPhone 18 Pro Max 1TB Burgundy"
- `pickupSearchQuote` values seen: "Available Today", "Available Tomorrow", "Currently unavailable", "Check back for availability on 10.24".
- The config page URL pattern seen in the browser: `/shop/buy-iphone/iphone-18-pro/6.9-inch-display-256gb-black-unlocked`.

## Buy pages (catalog)

- The 18 Pro and 18 Pro Max share `/shop/buy-iphone/iphone-18-pro` (title "Shop iPhone 18 Pro and iPhone 18 Pro Max"); the Duo is `/shop/buy-iphone/iphone-duo`.
- Each variant appears as an embedded JSON object, one per carrier (`att`, `t-mobile`, `verizon`, `unlocked`). The unlocked one carries the `LL/A` part, e.g. `{"partNumber":"MJW44LL/A","familyType":"iphone18promax","seoUrlToken":"6.9-inch-display-256gb-black-unlocked","dimensionCapacity":"256gb","dimensionColor":"black","dimensionScreensize":"6_9inch",…}`.
- A separate product list carries the display name and price: `{"sku":"MJW44","partNumber":"MJW44LL/A","price":{"fullPrice":1299.00},"name":"iPhone 18 Pro Max 256GB Black"}`.
- Duo names seen: "iPhone Duo 256GB Night Sky", "iPhone Duo 1TB Star White" (2 colors × 4 capacities in the list); its URLs follow `iphone-duo/7.6-inch-display-<capacity>-<color>-unlocked`.
- Same model + storage, other color = same `familyType` and `dimensionCapacity`, different `dimensionColor`.

## Not tested

- Whether a token works from a different IP or a datacenter IP (matters for the later Railway deploy).
- Whether Playwright, or attaching over CDP to a normally launched Brave with the user's profile, gets an accepted token.
- Whether the config page URL accepts a location/zip parameter.
- How fast Apple blocks a session polling every 60 s.
