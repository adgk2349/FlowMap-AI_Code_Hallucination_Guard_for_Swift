# FlowMap

FlowMap is a code-graph engine that visualizes function, variable, and module bindings from Swift code. It surfaces call graphs and data-flow graphs as a diff-aware diagram inside VS Code, letting developers see how AI-generated changes ripple through a codebase.

---

## Architecture

```
flowmap/
├── crates/
│   ├── protocol/   # JSON protocol types (request/response envelopes, graph model)
│   ├── engine/     # Command router: ping, shutdown, analyze
│   └── cli/        # flowmap binary — reads JSON from stdin, writes JSON to stdout
├── editor/
│   └── vscode/     # VS Code extension (future milestone)
├── .github/
│   └── workflows/  # CI (cargo fmt, clippy, test, build)
├── Cargo.toml      # Rust workspace
└── README.md
```

### Communication

The VS Code extension spawns the `flowmap` binary as a child process. Requests and responses are exchanged as newline-delimited JSON over stdin/stdout following the protocol defined in `SPEC_PROTOCOL.md`.

---

## Building

Requires Rust stable (≥ 1.70).

```bash
cargo build
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

### analyze — return a graph analysis result

```bash
echo '{"protocolVersion":"0.1","requestId":"2","cmd":"analyze","payload":{}}' | cargo run -p cli
```

Expected response (PR1 returns a schema-valid empty graph):

```json
{
  "protocolVersion": "0.1",
  "requestId": "2",
  "ok": true,
  "payload": {
    "graph": { "nodes": [], "edges": [] },
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
