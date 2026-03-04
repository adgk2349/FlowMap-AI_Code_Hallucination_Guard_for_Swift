# FlowMap MVP Requirements

## Goal
Visualize function/variable/module bindings from AI‑generated Swift code.

Show graph diff similar to code diff:
- + green = added
- - red = removed

Allow click navigation:
Graph node → source code location.

---

## Repo Setup
- [ ] Create monorepo
- [ ] Rust workspace
- [ ] flowmap CLI tool

---

## Protocol
- [ ] Implement JSON protocol types
- [ ] ping command
- [ ] analyze command (dummy)

---

## VSCode Extension
- [ ] Extension scaffold
- [ ] Webview graph panel
- [ ] Run Rust engine binary
- [ ] Display ping output

---

## Change Detection
- [ ] Detect large code edits
- [ ] Analyze last change command

---

## Graph Builder
- [ ] Nodes for functions/variables/types
- [ ] Edges for calls and references
- [ ] Depth traversal

---

## Graph Diff
- [ ] Detect added nodes
- [ ] Detect removed nodes
- [ ] Detect modified nodes

---

## UI
- [ ] Graph visualization panel
- [ ] Green/red diff coloring
- [ ] Node click → jump to code
