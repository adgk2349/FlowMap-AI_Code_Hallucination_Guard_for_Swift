use protocol::{Graph, RequestEnvelope, ResponseEnvelope};
use serde_json::json;

const ENGINE_VERSION: &str = "0.1.0";

pub fn handle_request(req: RequestEnvelope) -> ResponseEnvelope {
    match req.cmd.as_str() {
        "ping" => handle_ping(&req),
        "shutdown" => handle_shutdown(&req),
        "analyze" => handle_analyze(&req),
        _ => ResponseEnvelope::error(
            &req.protocol_version,
            &req.request_id,
            "UNKNOWN_COMMAND",
            &format!("Unknown command: {}", req.cmd),
        ),
    }
}

fn handle_ping(req: &RequestEnvelope) -> ResponseEnvelope {
    ResponseEnvelope::success(
        &req.protocol_version,
        &req.request_id,
        json!({
            "engineVersion": ENGINE_VERSION,
            "capabilities": ["swift", "graphDiff", "impactAnalysis"]
        }),
    )
}

fn handle_shutdown(req: &RequestEnvelope) -> ResponseEnvelope {
    ResponseEnvelope::success(
        &req.protocol_version,
        &req.request_id,
        json!({ "ok": true }),
    )
}

fn handle_analyze(req: &RequestEnvelope) -> ResponseEnvelope {
    let graph = Graph {
        nodes: vec![],
        edges: vec![],
    };
    let graph_value = serde_json::to_value(&graph).unwrap_or_default();
    ResponseEnvelope::success(
        &req.protocol_version,
        &req.request_id,
        json!({
            "graph": graph_value,
            "diff": {
                "added": [],
                "removed": [],
                "modified": []
            },
            "impact": [],
            "jumpIndex": {}
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_req(cmd: &str) -> RequestEnvelope {
        RequestEnvelope {
            protocol_version: "0.1".to_string(),
            request_id: "test-1".to_string(),
            cmd: cmd.to_string(),
            payload: json!({}),
        }
    }

    #[test]
    fn test_ping() {
        let resp = handle_request(make_req("ping"));
        assert!(resp.ok);
        let p = resp.payload.unwrap();
        assert_eq!(p["engineVersion"], ENGINE_VERSION);
        let caps = p["capabilities"].as_array().unwrap();
        assert!(caps.iter().any(|c| c == "swift"));
        assert!(caps.iter().any(|c| c == "graphDiff"));
        assert!(caps.iter().any(|c| c == "impactAnalysis"));
    }

    #[test]
    fn test_shutdown() {
        let resp = handle_request(make_req("shutdown"));
        assert!(resp.ok);
    }

    #[test]
    fn test_analyze() {
        let resp = handle_request(make_req("analyze"));
        assert!(resp.ok);
        let p = resp.payload.unwrap();
        assert!(p["graph"]["nodes"].is_array());
        assert!(p["graph"]["edges"].is_array());
        assert!(p["diff"]["added"].is_array());
        assert!(p["diff"]["removed"].is_array());
        assert!(p["impact"].is_array());
        assert!(p["jumpIndex"].is_object());
    }

    #[test]
    fn test_unknown_command() {
        let resp = handle_request(make_req("unknown_cmd"));
        assert!(!resp.ok);
        assert_eq!(resp.error.unwrap().code, "UNKNOWN_COMMAND");
    }
}
