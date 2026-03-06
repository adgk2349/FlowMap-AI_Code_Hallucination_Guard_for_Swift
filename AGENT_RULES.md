# Claude Code Agent Rules

## Hard Rules

1. Never commit broken builds
2. Do not modify protocol schema without approval
3. Keep PRs small (prefer <400 LOC *per commit*). If a change is larger, split across multiple commits/PRs.
4. No TODO placeholders
5. Update documentation when you ship features
6. Token discipline: avoid sweeping refactors; implement the smallest correct change that passes tests

---

## PR Order (current plan)

PR1  Rust workspace + protocol structs + CLI scaffolding (done)
PR2  VSCode extension skeleton (done)
PR3  SwiftSyntax AST parser + dependency graph generation (done)
PR4  Git diff + graph diff + impact analysis + VSCode diff UI (done)
PR5  Calls edges (same-file first), edge rendering, click-to-highlight call chains (next)
PR6  Cross-file call resolution + optional type hints (future)
PR7  Variable/parameter/property binding graph (future)

---

## Overnight / Agentic Runs

When running unattended (sleep mode):

- Work on **ONE PR scope only**
- Max **5 commits**; stop after that
- Stop immediately if:
  - tests fail
  - build fails
  - protocol/schema would need changes
- Prefer "plan → implement → test → commit" loops

---

## Coding Standards

Rust
- `cargo fmt`
- `cargo clippy -D warnings`
- `cargo test`

TypeScript
- `npm run compile`
- `npm run lint` (if configured)

---

## Security

- No hardcoded absolute paths
- No tokens, keys, or secrets in code or logs
