# Verdict: CI checks on pull requests

- Feature: ci-checks
- Tree: 4666542ee16c7200a6ba9e5f54766b651a1acdb9
- Date: 2026-10-25

## Suite
- Local `npm test`: `Tests  457 passed (457)` (9 files). `npm test -- no-such-file` exits 1 with "No test files found".
- Local `npm run typecheck` (`tsc`): exit 0.
- No failures; no baseline recorded.

## Criteria
- [x] Every pull request runs `npm run typecheck` and `npm test` in GitHub Actions, failing if either fails — PR #2's `CI / check` run 40223329871 (`pull_request` event, head f0f506819cfe1e8c72b5d38e0bb21979bc2fcc18, tree 4666542): setup-node resolved `.node-version` as 22, the `npm run typecheck` (`> tsc`) and `npm test` (`Tests  457 passed (457)`) steps succeeded, and the job passed. The user accepted this run as the criterion's evidence instead of a test (C3, 2026-10-25). Since that commit, only files under this folder have changed.

## Open issues
None

## Verdict
Verdict: pass
The workflow ran on this PR's head commit, ran both checks as separate steps that fail the job on a non-zero exit, and passed, and the local suite and type check are green.
