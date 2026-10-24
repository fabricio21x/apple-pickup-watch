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
- Status: planned
- Outcome: build level, no document change; task T19 in plan.md.
