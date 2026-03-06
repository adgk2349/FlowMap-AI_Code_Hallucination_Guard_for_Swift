use serde::{Deserialize, Serialize};

// --- Basic Types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Location {
    pub uri: String,
    pub range: Range,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
    Error,
}

// --- Graph Model ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    File,
    Type,
    Func,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeKind {
    Contains,
    Calls,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub kind: NodeKind,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loc: Option<Location>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub id: String,
    pub kind: EdgeKind,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

// --- Request / Response Envelopes ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestEnvelope {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub cmd: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseEnvelope {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorDetail>,
}

impl ResponseEnvelope {
    pub fn success(protocol_version: &str, request_id: &str, payload: serde_json::Value) -> Self {
        Self {
            protocol_version: protocol_version.to_string(),
            request_id: request_id.to_string(),
            ok: true,
            payload: Some(payload),
            error: None,
        }
    }

    pub fn error(protocol_version: &str, request_id: &str, code: &str, message: &str) -> Self {
        Self {
            protocol_version: protocol_version.to_string(),
            request_id: request_id.to_string(),
            ok: false,
            payload: None,
            error: Some(ErrorDetail {
                code: code.to_string(),
                message: message.to_string(),
                details: None,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_request_envelope_roundtrip() {
        let req = RequestEnvelope {
            protocol_version: "0.1".to_string(),
            request_id: "test-1".to_string(),
            cmd: "ping".to_string(),
            payload: serde_json::json!({}),
        };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: RequestEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.cmd, "ping");
        assert_eq!(parsed.request_id, "test-1");
    }

    #[test]
    fn test_graph_serialization() {
        let graph = Graph {
            nodes: vec![],
            edges: vec![],
        };
        let json = serde_json::to_string(&graph).unwrap();
        assert!(json.contains("nodes"));
        assert!(json.contains("edges"));
    }

    #[test]
    fn test_response_success() {
        let resp = ResponseEnvelope::success("0.1", "req-1", serde_json::json!({"ok": true}));
        assert!(resp.ok);
        assert!(resp.error.is_none());
    }

    #[test]
    fn test_response_error() {
        let resp = ResponseEnvelope::error("0.1", "req-1", "ENGINE_ERROR", "Something failed");
        assert!(!resp.ok);
        assert!(resp.payload.is_none());
        assert_eq!(resp.error.unwrap().code, "ENGINE_ERROR");
    }
}
