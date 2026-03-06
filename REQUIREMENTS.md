# FlowMap MVP Requirements (Swift-first)

## Product Goal
Reduce AI-assisted coding breakage by visualizing **Swift** code structure and change impact.

- Visualize: file/type/func nodes (now)
- Add: call edges (next)
- Show graph diff like code diff:
  - + green = added
  - - red = removed
  - ~ yellow = changed
- Impact analysis:
  - impacted nodes get orange outline
- Navigation:
  - Click node → jump to source code location

---

## Status

### Repo Setup
- [x] Monorepo created
- [x] Rust workspace
- [x] `flowmap` CLI tool

### Protocol
- [x] Implement JSON protocol types
- [x] `ping`
- [x] `analyze`

### VSCode Extension
- [x] Extension scaffold
- [x] Webview graph panel (Cytoscape)
- [x] Run Rust engine binary (configurable path)
- [x] Show analysis results

### Change Detection / Diff
- [x] Detect changed Swift files via `git diff`
- [x] Build old/new fragments (HEAD vs working tree)
- [x] Graph diff: added/removed/changed nodes + edges
- [x] Impact analysis: BFS downstream from changed nodes
- [x] Diff visualization colors + legend

---

## Next: PR5 (Calls edges)

### Graph Builder
- [ ] Extract `calls` edges from SwiftSyntax AST
  - Start with same-file resolution (best-effort)
  - Emit edges: `kind = "calls"`
- [ ] Render call edges in graph UI (arrows)
- [ ] Click node → highlight outgoing calls (and optionally transitive closure)

### Validation
- [ ] Test on 2-3 real Swift projects (including at least one iOS app)
- [ ] Record a short GIF demo for README

---

## Future (after Swift MVP)

- [ ] Cross-file call resolution (imports + simple name mapping)
- [ ] Variable / parameter / property binding nodes
- [ ] Type-resolution-assisted impact analysis
- [ ] Packaging (brew / cargo install) and VSCode marketplace release
