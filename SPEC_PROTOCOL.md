# FlowMap Protocol v0.1 (Extension ↔ Engine)

## Common Rules
- Format: JSON (UTF-8)
- Request/response matched by `requestId`
- Compatibility handled via `protocolVersion`
- Engine communicates via stdin/stdout JSON (MVP)
- Positions and ranges follow LSP conventions (0-based)

---

## Basic Types

### URI
Example: `file:///Users/me/project/UserService.swift`

### Position
```json
{ "line": 0, "character": 0 }
```

### Range
```json
{
  "start": { "line": 0, "character": 0 },
  "end":   { "line": 0, "character": 0 }
}
```

### Severity
`"info" | "warning" | "error"`

---

## Request Envelope
```json
{
  "protocolVersion": "0.1",
  "requestId": "uuid",
  "cmd": "analyze",
  "payload": {}
}
```

### cmd values
- ping
- analyze
- shutdown

---

## Response Envelope

Success
```json
{
  "protocolVersion": "0.1",
  "requestId": "same",
  "ok": true,
  "payload": {}
}
```

Error
```json
{
  "protocolVersion": "0.1",
  "requestId": "same",
  "ok": false,
  "error": {
    "code": "ENGINE_ERROR",
    "message": "Description",
    "details": {}
  }
}
```

---

## Graph Model

### Graph
```json
{
  "nodes": [],
  "edges": []
}
```

### Node
```json
{
  "id": "node-id",
  "kind": "function",
  "name": "updateUser",
  "loc": {
    "uri": "file:///file.swift",
    "range": {
      "start": {"line": 1,"character":0},
      "end": {"line": 10,"character":0}
    }
  }
}
```

### Edge
```json
{
  "id": "edge-id",
  "kind": "call",
  "from": "nodeA",
  "to": "nodeB"
}
```

Node kinds:
- module
- type
- function
- variable
- parameter
- return
- property

Edge kinds:
- call
- assign
- reference_read
- reference_write
- return
- property_get
- property_set
