# FlowMap

FlowMap is a code-graph engine that visualizes function, variable, and module bindings from Swift code. It surfaces call graphs and data-flow graphs as a diff-aware diagram inside VS Code, letting developers see how AI-generated changes ripple through a codebase.

---

## Architecture

```
flowmap/
├── crates/
│   ├── protocol/   # JSON protocol types (request/response envelopes, graph model)
│   ├── engine/     # Command router: ping, shutdown, analyze
│   │               #   scanner.rs      — finds *.swift files with WalkDir
│   │               #   swift_bridge.rs — spawns flowmap-swift-ast, parses JSON
│   │               #   graph_builder.rs — merges SwiftGraph → BuiltGraph
│   └── cli/        # flowmap binary — reads JSON from stdin, writes JSON to stdout
├── editor/
│   └── vscode/     # VS Code extension — cytoscape graph panel
├── parsers/
│   └── swift-ast/  # Swift package: flowmap-swift-ast CLI (SwiftSyntax AST walker)
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

### Manual test checklist

- [ ] Extension loads without errors in the Extension Development Host
- [ ] "FlowMap: Analyze Workspace" appears in the Command Palette
- [ ] FlowMap Graph panel opens after the command runs
- [ ] Nodes are colour-coded: file=dark blue, type=dark green, func=dark orange
- [ ] Type and file nodes contain their child nodes as compound (parent) boxes
- [ ] `calls` edges render as orange arrows between function nodes
- [ ] Scroll / pinch zooms the graph; nodes are draggable
- [ ] Clicking a node with a `uri` opens the corresponding file in a side panel
  at the correct line number
