# Walkthrough: Apple Store pickup stock monitor

- Feature: pickup-watch
- Date: 2026-10-24
- Commit: 78eca36

## Summary
- To-dos, defects first: no defects. One UX change: 1a, one store per line in the Telegram stock message instead of comma-separated (and the Gone line the same way), src/server/telegram.ts:27-28 and :43.
- Decisions still open: whether to build 1a now.
- To verify: the 3 h unattended token:auto run (started 15:25Z; first proactive refresh due about 17:06Z, 20 min before the 17:26Z expiry); the phone over Wi-Fi after the opt-in (spec.md:72) was not shown.
- Observations: None.
- Demo data: none. The walkthrough used the owner's real watches, stores and live stock; validation's test watch (MJQ84LL/A) was removed 2 s after it was added, and the interval was restored to 60.

## Agenda
1. Telegram stock alert, in the owner's chat and on the phone: one message per model + storage with a bold heading, a section per color, 🟢 Today / 🟡 Tomorrow store lines with distance, 🆕 on new stores, and one 🛒 Buy button per in-stock color that opens the unlocked configuration with No trade-in (spec.md:28-31, 59, 61).
2. The other Telegram messages: 🧪 test, ▶️ monitor started, 🚨 down and ✅ back up, each with its emoji and bold heading (spec.md:33-34, 63, 65, 68).
3. Stock board on the Mac, then at phone width: last successful check and health at the top, in-stock rows first, store names linking to the buy page; sidebar on the Mac, bottom tabs on the phone (spec.md:35, 69-71).
4. Watches: "N / 20 parts tracked", the watch rows with "Also alert for other colors", the picker, and the cap refusal (spec.md:52, 55-56).
5. Stores and Settings: zip and store switches; Telegram status and test button; token status, time left and the cURL dialog; interval; Wi-Fi switch (spec.md:53, 58, 66, 72).

No sign-in: the app has no login and answers only on 127.0.0.1. No demo data: the owner's real watches, stores and live Apple stock.

## To-dos
| # | Feature | Type | Severity | What | Root cause |
|---|---|---|---|---|---|
| 1a | 1 | UX | medium | One store per line under each day heading in the stock message (and one gone store per line), so it reads better; the message gets longer | src/server/telegram.ts:27-28 joins a day's stores with `', '` on one `🟢 Today:` line, and :43 joins gone stores with `', '`; T17 chose this layout where design decision 25 said only "lines of store names" |

## Feature 1: Telegram stock alert
- Status: done
- Shown: the owner's real chat on the phone: the iPhone 18 Pro Max 256GB stock message from the live run, its buy buttons, and the pages they open.
- Notes (verbatim):
  > it works well, just that I think we can improve the format in the message to have 1 store per line so it reads better instead of just comma separated, I know it occupies more space but it looks way better and easier to digest
- Screenshots: None
- To-dos: 1a

## Feature 2: The other Telegram messages
- Status: done
- Shown: reviewed by the owner on their own, in the chat and the running app, together with feature 1; not presented step by step.
- Notes (verbatim):
  > otherwise things look good
- Screenshots: None
- To-dos: None

## Feature 3: Stock board
- Status: done
- Shown: reviewed by the owner on their own, in the chat and the running app, together with feature 1; not presented step by step.
- Notes (verbatim):
  > otherwise things look good
- Screenshots: None
- To-dos: None

## Feature 4: Watches and the 20-part cap
- Status: done
- Shown: reviewed by the owner on their own, in the chat and the running app, together with feature 1; not presented step by step.
- Notes (verbatim):
  > otherwise things look good
- Screenshots: None
- To-dos: None

## Feature 5: Stores and Settings
- Status: done
- Shown: reviewed by the owner on their own, in the chat and the running app, together with feature 1; not presented step by step.
- Notes (verbatim):
  > otherwise things look good
- Screenshots: None
- To-dos: None

## Observations
None
