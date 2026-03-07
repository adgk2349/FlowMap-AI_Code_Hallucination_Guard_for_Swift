# Commit Replay Validation Summary

- Generated: 2026-03-07T19:29:12.817Z
- Reports merged: 3
- Total commit pairs: 209
- Swift / Non-Swift pairs: 112 / 97
- TP / TN / FP / FN: 106 / 97 / 0 / 6
- Non-Swift FP Rate: 0%
- Swift Detection Rate: 94.64%
- Overall Match Rate: 97.13%

## Per Repo

| Repo | Strict | Pairs | Swift | Non-Swift | TP | TN | FP | FN | Non-Swift FP Rate | Swift Detect Rate | Gate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| flowmap-heavy-swift-repo | yes | 120 | 100 | 20 | 100 | 20 | 0 | 0 | 0% | 100% | PASS |
| FlowMap | no | 74 | 4 | 70 | 4 | 70 | 0 | 0 | 0% | 100% | PASS |
| KDecoder | no | 15 | 8 | 7 | 2 | 7 | 0 | 6 | 0% | 25% | PASS |

## Interpretation

- Non-Swift FP Rate measures hallucination risk on commits without Swift changes.
- Swift Detection Rate measures whether any graph diff was detected when Swift files changed.
- Non-strict reports treat Swift no-op commits as valid warnings rather than failures.

