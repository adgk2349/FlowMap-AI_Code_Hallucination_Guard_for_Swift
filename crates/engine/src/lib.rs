mod graph_builder;
mod scanner;
mod swift_bridge;

use graph_builder::BuiltGraph;
use protocol::{RequestEnvelope, ResponseEnvelope};
use serde_json::json;
use std::path::Path;

const ENGINE_VERSION: &str = "0.1.0";

pub fn handle_request(req: &RequestEnvelope) -> ResponseEnvelope {
    match req.cmd.as_str() {
        "ping" => handle_ping(req),
        "shutdown" => handle_shutdown(req),
        "analyze" => handle_analyze(req),
        _ => ResponseEnvelope::error(
            &req.protocol_version,
            &req.request_id,
            "UNKNOWN_COMMAND",
            &format!("Unknown command: {}", req.cmd),
        ),
    }
}

// ── ping ──────────────────────────────────────────────────────────────────────

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

// ── shutdown ──────────────────────────────────────────────────────────────────

fn handle_shutdown(req: &RequestEnvelope) -> ResponseEnvelope {
    ResponseEnvelope::success(
        &req.protocol_version,
        &req.request_id,
        json!({ "shutting_down": true }),
    )
}

// ── analyze ───────────────────────────────────────────────────────────────────

fn handle_analyze(req: &RequestEnvelope) -> ResponseEnvelope {
    let workspace_path = req
        .payload
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or(".");

    let graph = build_swift_graph(workspace_path);
    let graph_value = serde_json::to_value(&graph).unwrap_or_default();

    ResponseEnvelope::success(
        &req.protocol_version,
        &req.request_id,
        json!({
            "graph":  graph_value,
            "diff":   { "added": [], "removed": [], "modified": [] },
            "impact": [],
            "jumpIndex": {}
        }),
    )
}

/// Scan `workspace_path` for Swift files, parse each with `flowmap-swift-ast`,
/// and merge the per-file graphs into a single workspace graph.
///
/// If the Swift parser binary is unavailable or there are no Swift files,
/// an empty graph is returned so the caller always gets a valid response.
fn build_swift_graph(workspace_path: &str) -> BuiltGraph {
    let root = Path::new(workspace_path);
    let swift_files = scanner::find_swift_files(root);

    if swift_files.is_empty() {
        return BuiltGraph::default();
    }

    let binary = resolve_swift_ast_binary();
    let mut global = BuiltGraph::default();

    for file in swift_files {
        if let Some(file_graph) = swift_bridge::parse_swift_file(&binary, &file) {
            global.merge(file_graph);
        }
    }

    global
}

/// Locate the `flowmap-swift-ast` binary.
///
/// Search order:
/// 1. Same directory as the running `flowmap` binary — covers the case where
///    both artefacts live in `target/debug/` after `cargo build`.
/// 2. Bare name — delegates to PATH (brew / mise / manual install).
fn resolve_swift_ast_binary() -> String {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("flowmap-swift-ast");
            if candidate.exists() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    "flowmap-swift-ast".to_string()
}

// ── tests ─────────────────────────────────────────────────────────────────────

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
        let req = make_req("ping");
        let resp = handle_request(&req);
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
        let req = make_req("shutdown");
        let resp = handle_request(&req);
        assert!(resp.ok);
        let p = resp.payload.unwrap();
        assert_eq!(p["shutting_down"], true);
    }

    #[test]
    fn test_analyze_returns_valid_schema() {
        let req = make_req("analyze");
        let resp = handle_request(&req);
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
    fn test_analyze_with_path_payload() {
        let mut req = make_req("analyze");
        req.payload = json!({ "path": "/tmp" });
        let resp = handle_request(&req);
        assert!(resp.ok);
    }

    #[test]
    fn test_unknown_command() {
        let req = make_req("unknown_cmd");
        let resp = handle_request(&req);
        assert!(!resp.ok);
        assert_eq!(resp.error.unwrap().code, "UNKNOWN_COMMAND");
    }
}
