# Changes: CI checks on pull requests

- Feature: ci-checks

## C1: Fail the suite when no tests are found
- Date: 2026-10-25
- Source: PR #2 review, thread on package.json:11
- Words: "Blocking: with `--passWithNoTests`, CI goes green when vitest finds no test files at all, for example after a broken include glob or a moved folder. A CI gate that passes on zero tests isn't a gate. Please drop the flag (or use a separate CI script without it)." Reproduced: `vitest run --passWithNoTests no-such-file` exits 0; without the flag it exits 1.
- Level: build
- Status: open
- Outcome:

## C2: Pin the Node version CI and the Mac use
- Date: 2026-10-25
- Source: PR #2 review, thread on .github/workflows/ci.yml:16
- Words: "Why Node 22 here? Is that what runs the app on the Mac, and is it pinned anywhere in the repo so the two can't drift?" Nothing pins it: the Mac runs v22.17.0 through launchd, `engines` only says `>=22`, and the workflow hardcodes 22.
- Level: build
- Status: open
- Outcome:

## C3: Drop the regex workflow test
- Date: 2026-10-25
- Source: PR #2 review, thread on test/ci.test.ts:10; the user's answer
- Words: Reviewer: "These tests regex-match the YAML text, so they check how the file is formatted rather than whether CI works." User's choice: "Delete it, PR run is proof (Recommended)"
- Level: build
- Status: open
- Outcome:
