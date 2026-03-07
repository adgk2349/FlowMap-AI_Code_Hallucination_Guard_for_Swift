# Good First Issues

This list is designed for first-time contributors. Each item is intentionally small, testable, and reviewable.

## 1) Diff Legend Tooltip Clarification

- Area: `editor/vscode/webview/graph.html`
- Goal: Improve wording for Added/Removed/Changed/Impacted legend items.
- Acceptance:
  - Updated tooltip copy is concise and consistent.
  - No layout break on desktop/mobile webview.

## 2) Auto-Analyze Status Message Refinement

- Area: `editor/vscode/src/extension.ts`
- Goal: Improve toggle message clarity for `flowmap.toggleAutoAnalyzeOnSave`.
- Acceptance:
  - Message clearly states enabled/disabled state.
  - Unit or integration behavior unchanged.

## 3) Add Test for Non-Git Workspace Diff Fallback

- Area: `crates/engine/src/git_diff.rs`
- Goal: Extend tests for non-git directory behavior.
- Acceptance:
  - New test added and passing under `cargo test`.
  - No regression in existing tests.

## 4) README: Add Quick Troubleshooting Section

- Area: `README.md`, `README.ko.md`, `README.ja.md`
- Goal: Add a short troubleshooting block for parser path/build issues.
- Acceptance:
  - Includes at least 3 common problems with fixes.
  - Language consistency maintained in each README.

## 5) Webview Empty-State Copy Improvement

- Area: `editor/vscode/webview/graph.js`
- Goal: Improve no-analysis prompt wording.
- Acceptance:
  - Message is action-oriented.
  - Existing analyze button flow still works.

## 6) Add Small Unit Test for GraphDiff Metadata Change

- Area: `crates/engine/src/graph_diff.rs` tests
- Goal: Ensure `changed_nodes` catches node metadata updates.
- Acceptance:
  - New unit test fails before fix and passes after.

## 7) Add `npm run typecheck` Script in Extension

- Area: `editor/vscode/package.json`
- Goal: Add a script alias for TS compile checks.
- Acceptance:
  - Script runs successfully in CI/local.
  - README/CONTRIBUTING updated with command.

## 8) Improve File Detail Mode Node Spacing

- Area: `editor/vscode/webview/graph.layouts.js`
- Goal: Slightly improve readability of dense function lists.
- Acceptance:
  - Layout overlap reduced on sample screenshot.
  - No severe regression in Calls/Overview modes.

## 9) Add Replay Command Example for Small Repos

- Area: `README*.md`
- Goal: Add a short replay command with `--count 20`.
- Acceptance:
  - Command copy-pastable.
  - Mentions expected output file path.

## 10) Add "Needs Repro" Label Guide

- Area: `CONTRIBUTING.md`
- Goal: Add rule for triaging incomplete bug reports.
- Acceptance:
  - Label usage policy documented in 3-5 lines.
  - Keeps issue response process clear.

---

If you are taking one issue, comment with:

`I can take this issue.`

Maintainer target is first response within 48 hours.

