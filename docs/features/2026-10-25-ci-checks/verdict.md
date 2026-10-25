# Verdict: CI checks on pull requests

- Feature: ci-checks
- Tree: b9635e0a79e8922d7ac54eed1d89489054db9133
- Date: 2026-10-25

## Suite
- `npm test`: `Tests  460 passed (460)` (10 files, including the new `test/ci.test.ts`).
- `npm run typecheck` (`tsc`): exit 0, no errors.
- No failures; no baseline recorded.

## Criteria
- [x] Every pull request runs `npm run typecheck` and `npm test` in GitHub Actions, failing if either fails — `test/ci.test.ts:9` "runs on every pull request" and `test/ci.test.ts:13` "runs the type check and the test suite" assert the workflow's trigger and steps; `test/ci.test.ts:18` "has a typecheck script that runs tsc". The live run on GitHub is confirmed on the PR itself.

## Open issues
None

## Verdict
Verdict: pass
The workflow triggers on pull requests and runs both checks as plain steps, so either failing fails the job, and the suite and type check are green on this tree.
