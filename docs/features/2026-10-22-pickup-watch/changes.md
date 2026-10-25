# Changes: Apple Store pickup stock monitor

- Feature: pickup-watch

<!-- Every change to this feature after its spec was first approved: the user's feedback and findings from building or testing. An entry is written here before anything acts on it, so nothing said in chat is lost. Newest last. Status moves open → planned → done (or dropped, with the user's reason). -->

## C1: One formatted message per part, listing its stores
- Date: 2026-10-23
- Source: user, walkthrough after the first real run ("ok, did 1 and got bunch of alerts. I think we need to improve that:")
- Words: A message per part and instead of a button per message we can send the links per store so if iphone 18 pro max 256gb black is available in 10 stores, we can send 1 message with the list of stores and each will be the link for the puchase. We can have them also separated by today or tomorrow, in the same message. We can use html or markdown to format the messages better, lets make use of that. We can add emojis or colors so its easier to differentiate when reading
- Level: scope
- Status: done
- Outcome: spec.md Scope (alerts, content, sound, other colors, other messages), acceptance criteria 56-57, 59-60, 62-63 and decision log; design.md decisions 3, 6, 25, Data shapes (`StockMessage`), Test seams, Risks, amendment panel. Amended to one buy button per color after the panel (staff-engineer-2). Spec and design approved by the owner ("yes", 2026-10-23). Tasks T16, T17.

## C2: Buy links that preselect color, connectivity and trade-in
- Date: 2026-10-23
- Source: user, same walkthrough
- Words: the links in the messages only load the page with the model and storage selected, no color, conectivity or trade-in, which slows down the process of buying quickly.
- Level: scope
- Status: done
- Outcome: spec.md Scope (buy links), out of scope, acceptance criterion 61 and decision log; design.md decision 10, Constraints, Rollout step 0. `-unlocked` confirmed by the owner; `igt=true` checked in T14; no store or zip key in Apple's URL. Spec and design approved by the owner ("yes", 2026-10-23). Task T14.

## C3: cURL dialog hides Save on a long paste
- Date: 2026-10-23
- Source: user, same walkthrough
- Words: In the frontend, the curl box does not overflow scroll so a big paste basically hides the button and I cant save the curl, the dialog does not need to resize with the content
- Level: build
- Status: done
- Outcome: no document change; built as T13 in plan.md, commit 72b6930, reviewed.

## C4: Dashboard layout with client navigation
- Date: 2026-10-23
- Source: user, same walkthrough
- Words: The one-page feels awful, I think we can have a single page but add some sort of client navigation so it feels better, too much scrolling, I get lost when going through each of the cards, a dashboard like layout would be way better
- Level: scope
- Status: done
- Outcome: spec.md Scope (UI) and acceptance criteria 66, 69-71; design.md decision 18, File map. Spec and design approved by the owner ("yes", 2026-10-23). Task T18.

## C5: Cap tracked parts at 20
- Date: 2026-10-23
- Source: user, answering the token spike's parts-cap result (Apple returns at most 20 parts per request, plan.md Escalations)
- Words: About the 20 part limit, yeah we can limit to 20 parts for now to avoid redesigning
- Level: scope
- Status: done
- Outcome: spec.md Scope (parts cap), out of scope, acceptance criterion 55 and Facts; design.md decision 24, StateDto, Risks. Spec and design approved by the owner ("yes", 2026-10-23). Tasks T15, T18.

## C6: Stock board can't show other-color rows
- Date: 2026-10-24
- Source: a finding from implement, T18
- Words: `StateDto` carries per-store badges only for watched parts (`watches[].cells`, src/server/api.ts state builder), so the stock board can show other-color siblings only when they are past the cap ("Not checked"). Spec.md:69 asks for Today / Tomorrow / unavailable for each tracked pair, and design decision 18 lists "Other color" rows on the board.
- Level: build (design.md Data shapes: `WatchDto.cells` holds "its GridCells for the stock board", and `GridCell` carries `part`, so a watch's cells can include its other-color pairs with no new field)
- Status: done
- Outcome: build level, no document change; task T19 in plan.md.

## C7: One store per line in the stock message
- Date: 2026-10-24
- Source: user, walkthrough (walkthrough-2026-10-24.md, to-do 1a)
- Words: it works well, just that I think we can improve the format in the message to have 1 store per line so it reads better instead of just comma separated, I know it occupies more space but it looks way better and easier to digest
- Level: build (spec.md:29 says stores "grouped Today and Tomorrow as plain text with their distance"; design decision 25 says "lines of store names with distance" without fixing the separator; T17 chose comma-separated)
- Status: done
- Outcome: build level, no document change; task T20 in plan.md. Final review and validation rerun after it.

## C8: Wi-Fi access restart is easy to miss
- Date: 2026-10-24
- Source: user, walkthrough (walkthrough-2026-10-24.md, to-do 5a)
- Words: only thing. I notice is that wifi access does not load in my other network devices
- Level: build (design decision 16: the Wi-Fi toggle saves the setting and the page says "restart to apply"; spec.md:72 holds once restarted, verified 2026-10-24: 200 from 192.168.18.75 and fabricios-macbook.local after the restart). The hint at src/web/Settings.tsx:189-191 is small muted text, and :192-197 lists the LAN URLs as live links before the restart.
- Status: done
- Outcome: build level, no document change; task T21 in plan.md. The owner chose to build it now.

## C9: Redesign the stock board
- Date: 2026-10-25
- Source: user
- Words: Redesign the stock board (the main dashboard view) properly: run the UI direction for it with impeccable, shape with me and then mockups. Stop after I approve the design; don't build it yet.
- Level: design (spec.md:35 and :69 still hold; design.md decision 18's stock board layout changes)
- Status: done
- Outcome: design level; design.md gained `## UI direction` (impeccable shape brief, approved by the owner 2026-10-25) and decision 18 points the stock board at it; `PRODUCT.md` and `mockups/stock-board.html` added; design approved by the owner ("yeah it looks good, approved", 2026-10-25). Task T22 in plan.md, not started at the owner's request.

## C10: Stock board follow-ups from review
- Date: 2026-10-25
- Source: user, agreeing to bundle the non-blocking review findings on the redesigned stock board (T22 review and the change-9 final review, recorded in plan.md)
- Words: sure, lets do the change
- Level: build, except one design wording fix. The items, with their evidence:
  1. The cap note's "Trim your watches" link shows above the phones but comes after them in keyboard order (src/web/StockBoard.tsx:86; WCAG 2.4.3).
  2. The Buy link's accessible name doesn't start with its visible "Buy <color>" (src/web/StockBoard.tsx:143; WCAG 2.5.3).
  3. The loading skeleton's `role="status"` has no text to announce (src/web/StockBoard.tsx:373).
  4. The status strip's live region re-announces the token time every minute (src/web/StockBoard.tsx:110).
  5. The stale stock under the down banner, faded to 55 %, drops muted text below AA contrast and lacks the mockup's `aria-describedby` to "Last known stock" (src/web/StockBoard.tsx:71).
  6. While setup is incomplete the stock view shows neither health nor the last check, now that the chips are hidden there (src/web/StockBoard.tsx:86).
  7. Between 768 and 1099 px the column is wider than the mockup's 720 px (src/web/App.tsx:90).
  8. design.md's UI direction Data paragraph says freshness comes from `lastCheckAt`, while spec.md:69 and the code use the last successful check (design wording).
  9. The app has no favicon, so every page load logs a 404 for `/favicon.ico`.
- Status: done
- Outcome: item 8 amended design.md's UI direction Data paragraph (freshness from `lastSuccessAt`) with a decision-log line, design approved automatically (wording only, no spec change); items 1-7 and 9 are task T23 in plan.md.

## C11: token:auto doesn't replace a token Apple rejected early
- Date: 2026-10-25
- Source: a finding while investigating an outage (the owner reported "monitoring is not working now")
- Words: From about 20:34Z on 2026-10-25 every check failed with Apple's 541 (health down, cause token-rejected, 29 failures by 20:56Z), although the stored pair, posted by token:auto at 19:47:57Z, didn't expire until 21:47:52Z. token:auto kept posting the same pair every 10 minutes ("stored=false") because it only renews by expiry (scripts/token-auto.ts `needsRefresh`, 20 minutes before expiry), so an early rejection would have left monitoring down until 21:27Z with no attempt to recover. In this incident a fresh pair from the same profile, and even a fresh session after clearing every apple.com cookie, were also rejected (541) while the buy page answered 200, so Apple was refusing this setup's stock checks; renewing alone wouldn't have fixed it, but the gap stands. The owner asked to record it (2026-10-25).
- Level: design (design.md decisions 13 and 21: token:auto refreshes before each expiry; it should also renew when the server reports the token rejected)
- Status: open
- Outcome: pending; not built until the owner asks

## C12: Apple blocked the home network's stock checks
- Date: 2026-10-25
- Source: user, after the 2026-10-25 outage (C11)
- Words: yes, indeed I thikn my ip was blocked. When I switched to cellular data it worked but with myu network I was blocked, we need to fix this.
- Evidence: from about 20:34Z every `fulfillment-messages` request from the Mac answered 541, with the stored pair, a freshly renewed pair and a brand-new session alike, while the buy page answered 200; the owner's own browser was blocked on the home network and worked on cellular. The interval had been 45 s that day (the spec's default is 60 s ±15 s, spec.md:24, :54). The monitor reported the cause as "token-rejected", because it can't tell a rejected token from a blocked network (both are 541).
- Level: to be sized
- Status: open
- Outcome: pending
