# Claude Code Agent Rules

## Hard Rules

1. Never commit broken builds
2. Do not modify protocol schema without approval
3. Keep PRs small (<400 lines)
4. No TODO placeholders
5. Update documentation with features

---

## PR Order

PR1
Rust workspace + protocol structs

PR2
VSCode extension skeleton

PR3
Graph visualization

PR4
Impact analysis

---

## Coding Standards

Rust
- cargo fmt
- clippy clean

Typescript
- eslint clean

---

## Security

- No hardcoded paths
- No tokens in code
