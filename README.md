# FlowMap

FlowMap is a code-graph engine that visualizes function, variable, and module bindings from Swift code. It surfaces call graphs and data-flow graphs as a diff-aware diagram inside VS Code, letting developers see how AI-generated changes ripple through a codebase.

---

## Architecture

```
flowmap/
├── crates/
│   ├── protocol/   # JSON protocol types (request/response envelopes, graph model)
│   ├── engine/     # Command router: ping, shutdown, analyze
│   │               #   scanner.rs          — finds *.swift files with WalkDir
│   │               #   swift_bridge.rs     — spawns flowmap-swift-ast, parses JSON
│   │               #   graph_builder.rs    — merges SwiftGraph → BuiltGraph
│   │               #   git_diff.rs         — detects changed Swift files via git
│   │               #   incremental_graph.rs — builds HEAD/current graph fragments
│   │               #   graph_diff.rs       — diffs two BuiltGraphs (add/remove/change)
│   │               #   impact_analysis.rs  — BFS over calls edges to find impacted nodes
│   └── cli/        # flowmap binary — reads JSON from stdin, writes JSON to stdout
├── editor/
│   └── vscode/     # VS Code extension — cytoscape graph panel with diff colours
├── parsers/
│   └── swift-ast/  # Swift package: flowmap-swift-ast CLI (SwiftSyntax AST walker)
│                   #   two-phase call resolution — declaration pass + post-walk resolve
├── .github/
│   └── workflows/  # CI (cargo fmt, clippy, test, build)
├── Cargo.toml      # Rust workspace
└── README.md
```

### Communication

The VS Code extension spawns the `flowmap` binary as a child process. Requests and responses are exchanged as newline-delimited JSON over stdin/stdout following the protocol defined in `SPEC_PROTOCOL.md`.

---

## Building

### Rust engine

Requires Rust stable (≥ 1.70).

```bash
cargo build
```

### Swift AST parser

Requires Swift 5.9+ (ships with Xcode 15+).

```bash
cd parsers/swift-ast
swift build -c release
```

This produces `.build/release/flowmap-swift-ast`. Copy it next to the `flowmap`
binary so the engine can find it automatically:

```bash
cp parsers/swift-ast/.build/release/flowmap-swift-ast target/debug/
```

---

## Running

### ping — verify the engine is alive

```bash
echo '{"protocolVersion":"0.1","requestId":"1","cmd":"ping","payload":{}}' | cargo run -p cli
```

Expected response:

```json
{
  "protocolVersion": "0.1",
  "requestId": "1",
  "ok": true,
  "payload": {
    "engineVersion": "0.1.0",
    "capabilities": ["swift", "graphDiff", "impactAnalysis"]
  }
}
```

### analyze — return a real Swift dependency graph

```bash
echo '{"protocolVersion":"0.1","requestId":"2","cmd":"analyze","payload":{"path":"/path/to/swift/project"}}' | cargo run -p cli
```

The engine walks all `*.swift` files under `path`, runs `flowmap-swift-ast` on
each, and returns a merged graph. Nodes carry `kind` (`file`, `type`, `func`),
`name`, `uri` (absolute file path), and `line`. Edges carry `kind` (`contains`
or `calls`).

Example response:

```json
{
  "protocolVersion": "0.1",
  "requestId": "2",
  "ok": true,
  "payload": {
    "graph": {
      "nodes": [
        { "id": "UserService", "kind": "type", "name": "UserService",
          "uri": "/path/UserService.swift", "line": 3 },
        { "id": "UserService::fetchUser", "kind": "func", "name": "fetchUser",
          "uri": "/path/UserService.swift", "line": 4 }
      ],
      "edges": [
        { "id": "contains::UserService::UserService::fetchUser",
          "kind": "contains", "from": "UserService", "to": "UserService::fetchUser" }
      ]
    },
    "diff": { "added": [], "removed": [], "modified": [] },
    "impact": [],
    "jumpIndex": {}
  }
}
```

### shutdown

```bash
echo '{"protocolVersion":"0.1","requestId":"3","cmd":"shutdown","payload":{}}' | cargo run -p cli
```

---

## Testing

```bash
cargo test
```

---

## Protocol

See `SPEC_PROTOCOL.md` for the full request/response schema.

---

## VSCode Extension Usage

The extension lives in `editor/vscode/` and communicates with the `flowmap`
binary over stdin/stdout using the JSON protocol.

### Prerequisites

1. Build the Rust engine (produces `target/debug/flowmap`):
   ```bash
   cargo build
   ```
2. Install extension dependencies:
   ```bash
   cd editor/vscode && npm install
   ```

### Running in development

1. Open the repository root in VS Code.
2. Press **F5** — VS Code compiles the TypeScript and launches an Extension
   Development Host window.
3. In the new window open the Command Palette (`⇧⌘P`) and run:
   **FlowMap: Analyze Workspace**
4. The **FlowMap Graph** panel opens and renders the call graph.

### Configuration

| Setting | Default | Description |
|---|---|---|
| `flowmap.binaryPath` | _(empty)_ | Absolute path to the `flowmap` binary. Leave empty to auto-resolve as `target/debug/flowmap` relative to the workspace root. |

### Prerequisites (PR3+)

Before running the extension you need both binaries in the same directory:

```bash
# 1. Build the Rust engine
cargo build

# 2. Build the Swift parser and copy it alongside the engine binary
cd parsers/swift-ast && swift build -c release && cd ../..
cp parsers/swift-ast/.build/release/flowmap-swift-ast target/debug/
```

### Commands (PR4+)

| Command | Description |
|---|---|
| `FlowMap: Analyze Workspace` | Full workspace graph with all diff colours baked in |
| `FlowMap: Show Graph Diff` | Same graph with unchanged nodes dimmed, diff nodes highlighted |
| `FlowMap: Show Impact Analysis` | Same graph with only changed + impacted nodes visible |

### Diff colour scheme

| Colour | Meaning |
|---|---|
| Dark green background | Added node / edge (in current tree, absent in HEAD) |
| Dark red background + dashed border | Removed node (in HEAD, absent in current tree) |
| Dark yellow background | Changed node (metadata differs from HEAD) |
| Orange border (3 px solid) | Impacted node — downstream of a changed/added/removed node |
| Green dashed edge | Added edge |
| Red dashed edge | Removed edge |

### Auto-analyze on save (PR6+)

FlowMap automatically re-analyzes the workspace whenever a Swift file is saved,
keeping the graph panel in sync without manual intervention.

| Setting | Default | Description |
|---|---|---|
| `flowmap.autoAnalyzeOnSave` | `true` | Enable/disable auto-analyze on save |
| `flowmap.autoAnalyzeDebounceMs` | `500` | Wait this many ms after the last save before triggering analysis |

**Behaviour:**
- The panel refreshes silently in the background — editor focus is never stolen.
- If an analysis is already running when a save arrives, exactly one extra
  analysis is queued and runs immediately after the current one completes
  (no spam — the queue depth is capped at one).
- If analysis fails, the last successful graph remains visible.

**Toggle command:** open the Command Palette and run
`FlowMap: Toggle Auto Analyze On Save` — a toast confirms the new state.

### Status badge (PR6+)

A status badge in the top-left corner of the graph panel shows whether the
workspace is clean relative to HEAD:

| Badge | Meaning |
|---|---|
| **✓ Clean** (green) | No node or edge changes detected vs HEAD |
| **⚑ Changed** (amber) | Diff detected; counts shown: `+N nodes  -N nodes  ~N nodes  +N edges  -N edges` |

When the status is **Changed**, unchanged nodes are rendered at reduced opacity
so that added, removed, changed, and impacted nodes stand out visually.

### Same-file `calls` edges (PR5+)

The Swift AST parser resolves function call sites within the same file using a
two-phase strategy:

1. **Declaration pass** — as the AST is walked, every function/initializer node
   is registered in an internal `funcsByScope` map, keyed by its enclosing type
   or file scope.

2. **Resolution pass** — after the walk is complete, each collected call site is
   matched against `funcsByScope`.  The resolver prefers a function with the
   same name declared in the caller's enclosing type; if not found it falls back
   to file scope.  Because the map is fully populated before resolution begins,
   **forward references** (calling a function declared later in the file) resolve
   correctly.  Unresolvable calls (e.g. stdlib or cross-file) are silently
   dropped.

`calls` edges appear as orange arrows in the graph.  Clicking a node highlights
only its **direct** callees (one hop), not the full transitive closure.

### Manual test checklist

- [ ] Extension loads without errors in the Extension Development Host
- [ ] All four FlowMap commands appear in the Command Palette (including Toggle Auto Analyze)
- [ ] FlowMap Graph panel opens after any command runs
- [ ] Nodes are colour-coded: file=dark blue, type=dark green, func=dark orange
- [ ] Type and file nodes contain their child nodes as compound (parent) boxes
- [ ] `calls` edges render as orange arrows between function nodes
- [ ] Scroll / pinch zooms the graph; nodes are draggable
- [ ] Clicking a node opens the corresponding file in a side panel at the correct line
- [ ] Clicking a node highlights its **direct** callee nodes only (yellow border, one hop)
- [ ] Clicking on the background clears the highlight
- [ ] After modifying a Swift file (without staging/committing), re-running
  "Show Graph Diff" shows the changed node in dark yellow and its downstream
  callee nodes with orange outlines
- [ ] Removed nodes appear as faded dark-red phantom nodes
- [ ] Legend in the top-right corner shows only relevant swatches
- [ ] Status badge (top-left) shows "✓ Clean" on an unmodified workspace
- [ ] After saving a Swift file with changes, badge updates to "⚑ Changed" with counts
- [ ] Unchanged nodes are visually muted (lower opacity) when status is Changed
- [ ] Saving a Swift file triggers auto-analyze (graph updates without focus steal)
- [ ] Toggling auto-analyze off + saving a Swift file → no re-analyze
- [ ] Toggling auto-analyze back on → next save re-analyzes
