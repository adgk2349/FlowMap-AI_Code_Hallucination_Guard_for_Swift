# FlowMap Public Beta Validation (Detailed)

- Generated: 2026-03-07T19:30:58.208Z
- Replay reports: 3
- Scenario report: sample-scenarios-report.json

## Replay Aggregate

- Total commit pairs: 209
- Swift / Non-Swift pairs: 112 / 97
- TP / TN / FP / FN: 106 / 97 / 0 / 6
- Non-Swift FP Rate: 0%
- Swift Detection Rate: 94.64%
- Overall Match Rate: 97.13%

## Replay Per Report

| Repo | Strict | Pairs | Swift | Non-Swift | TP | TN | FP | FN | Warn | Fail | Error |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| flowmap-heavy-swift-repo | yes | 120 | 100 | 20 | 100 | 20 | 0 | 0 | 0 | 0 | 0 |
| FlowMap | no | 74 | 4 | 70 | 4 | 70 | 0 | 0 | 0 | 0 | 0 |
| KDecoder | no | 15 | 8 | 7 | 2 | 7 | 0 | 6 | 6 | 0 | 0 |

## Non-Pass Cases (Replay)

- Non-pass total: 6
- warn_swift_no_graph_change: 6

| Repo | Status | Commit | Subject | Swift Files | Engine Changed | Expected Changed |
|---|---|---|---|---:|---:|---:|
| KDecoder | warn_swift_no_graph_change | 0bbee27 | Bump version to v2.0.1 | 1 | no | no |
| KDecoder | warn_swift_no_graph_change | dacbd2e | Translate README to Korean, add quit button | 1 | no | no |
| KDecoder | warn_swift_no_graph_change | 32eb843 | Move quit button to bottom bar with visible glassEffect style | 1 | no | no |
| KDecoder | warn_swift_no_graph_change | 9ce4f79 | Rearrange layout: version beside title, quit top-right, checkbox bottom-right | 1 | no | no |
| KDecoder | warn_swift_no_graph_change | 014d377 | Update repository links to reflect rename to KDecoder-for-Mac | 1 | no | no |
| KDecoder | warn_swift_no_graph_change | 36d81f8 | Correct repository name to KDecoder_for_Mac in links | 1 | no | no |

## Sample Scenario Regression

- Scenario count: 60
- Passed / Failed: 60 / 0
- Pass rate: 100%
- FP total: 0
- FN total: 0
- Gate: PASS

## Public Beta Gate

- replay_non_swift_fp_rate_ok: PASS
- replay_swift_detection_rate_ok: PASS
- replay_overall_match_rate_ok: PASS
- replay_error_pairs_ok: PASS
- sample_pass_rate_ok: PASS
- sample_fp_total_ok: PASS
- sample_fn_total_ok: PASS

**Final Gate:** PASS

## Notes

- `warn_swift_no_graph_change` means Swift files changed but graph topology did not change.
- In non-strict mode, these warnings are tracked but do not fail the report.

