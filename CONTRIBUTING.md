# Contributing to FlowMap

Thanks for contributing to FlowMap.

This document is optimized for first-time contributors. If you are looking for a starting point, check [docs/good-first-issues.md](docs/good-first-issues.md).

## Quick Start (5-10 minutes)

1. Fork and clone this repository.
2. Create a branch:
   - `feat/<short-topic>` for features
   - `fix/<short-topic>` for fixes
   - `docs/<short-topic>` for documentation
3. Run local checks before opening a PR.

## Local Setup

Prerequisites:

- macOS only (current Swift parser build/runtime path is macOS-dependent)
- Rust toolchain
- Swift toolchain / Xcode command line tools
- Node.js 20+

Build commands:

```bash
cargo build
cd parsers/swift-ast && swift build -c release && cd ../..
cd editor/vscode && npm ci && npm run compile && cd ../..
```

## Contribution Rights (Public Beta)

FlowMap is currently public beta and all rights are reserved by the author for the beta period.

By submitting a pull request, patch, or issue attachment with code/content, you confirm:

- You have the legal right to submit that contribution.
- You grant the maintainer a non-exclusive, worldwide, royalty-free license to use, modify, and redistribute your contribution as part of this repository during public beta.
- You do not submit third-party code/assets with incompatible terms.

Final outbound licensing terms for the project will be announced after the public beta period.

## Required Checks Before PR

Run these in repo root:

```bash
cargo fmt --check
cargo clippy -- -D warnings
cargo test
cd editor/vscode && npm run lint && npm run compile && cd ../..
```

If your change affects analysis/diff behavior, also attach validation output:

```bash
node scripts/run_sample_scenarios.mjs --report reports/sample-scenarios-report.json
node scripts/run_commit_replay.mjs --repo /path/to/swift-repo --count 20 --report reports/replay-local.json
```

## Pull Request Guidelines

- Keep PR scope small and reviewable.
- Include a short problem statement and what changed.
- Include before/after behavior.
- For graph UI changes, include screenshots or GIF.
- For parser/engine logic changes, include at least one regression test.

Maintainer target: first review response within 48 hours for new contributors.

## First Contribution Checklist

- Pick one item from [docs/good-first-issues.md](docs/good-first-issues.md)
- Reproduce and confirm current behavior
- Add or update tests
- Run required checks
- Open PR using the provided PR template
- Request review

## Reporting Issues

Use GitHub Issue templates:

- Bug report: reproducible defect
- Feature request: problem + proposal + acceptance criteria

## Code Style Notes

- Rust: keep clippy clean; avoid panic-prone changes in engine paths.
- TypeScript/JS: keep webview code modular (`graph.*.js` split).
- Swift parser: prioritize stable JSON schema output for engine compatibility.

## Validation Evidence in README

Bundled validation reports live under `reports/`. If you update benchmark/replay reports, include:

- what dataset/repo was used
- command used
- summary metrics (TP/TN/FP/FN, detection rate)
