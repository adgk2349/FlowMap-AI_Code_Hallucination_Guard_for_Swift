mod git_diff;
mod graph_builder;
mod graph_diff;
mod impact_analysis;
mod incremental_graph;
mod scanner;
mod swift_bridge;

use graph_builder::BuiltGraph;
use graph_diff::GraphDiff;
use protocol::{RequestEnvelope, ResponseEnvelope};
use serde_json::json;
use std::collections::HashSet;
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

    let binary = resolve_swift_ast_binary();

    // ── 1. Build the full workspace graph from the current working tree ───
    let full_graph = build_swift_graph(workspace_path, &binary);
    let root = Path::new(workspace_path);

    // ── 2. Detect changed Swift files via git diff ────────────────────────
    let changed_files = git_diff::changed_swift_files(root);

    // ── 3. Compute graph diff: HEAD fragment vs current fragment ──────────
    let diff = if changed_files.is_empty() {
        GraphDiff::default()
    } else {
        let old_fragment = incremental_graph::build_old_fragment(root, &changed_files, &binary);
        let new_fragment = incremental_graph::build_new_fragment(&changed_files, &binary);
        graph_diff::diff_graphs(&old_fragment, &new_fragment)
    };

    // ── 4. Impact analysis ────────────────────────────────────────────────
    // Start nodes: added/changed nodes + any node in the full graph that
    // calls a removed node (its dependency was deleted → it is affected).
    let removed_ids: HashSet<&str> = diff.removed_nodes.iter().map(|n| n.id.as_str()).collect();

    let mut start_ids: HashSet<&str> = diff
        .added_nodes
        .iter()
        .chain(diff.changed_nodes.iter())
        .map(|n| n.id.as_str())
        .collect();

    for edge in &full_graph.edges {
        if edge.kind == "calls" && removed_ids.contains(edge.to.as_str()) {
            start_ids.insert(edge.from.as_str());
        }
    }

    let start_refs: Vec<&str> = start_ids.into_iter().collect();
    let impacted = impact_analysis::impacted_nodes(&full_graph, &start_refs);
    let impact_ids: Vec<String> = impacted.into_iter().map(|n| n.id).collect();

    // ── 5. Serialize and respond ──────────────────────────────────────────
    let graph_value = serde_json::to_value(&full_graph).unwrap_or_default();
    let diff_value = serde_json::to_value(&diff).unwrap_or_default();

    ResponseEnvelope::success(
        &req.protocol_version,
        &req.request_id,
        json!({
            "graph":     graph_value,
            "diff":      diff_value,
            "impact":    impact_ids,
            "jumpIndex": {}
        }),
    )
}

// ── helpers ───────────────────────────────────────────────────────────────────

/// Scan `workspace_path` for Swift files, parse each with `flowmap-swift-ast`,
/// and merge the per-file graphs into a single workspace graph.
fn build_swift_graph(workspace_path: &str, binary: &str) -> BuiltGraph {
    let root = Path::new(workspace_path);
    let swift_files = scanner::find_swift_files(root);

    if swift_files.is_empty() {
        return BuiltGraph::default();
    }

    if !Path::new(binary).exists() && which_in_path(binary).is_none() {
        eprintln!(
            "[flowmap-engine] swift-ast binary not found: {binary}. \
             Returning empty graph."
        );
        return BuiltGraph::default();
    }

    let mut global = BuiltGraph::default();
    for file in &swift_files {
        if let Some(file_graph) = swift_bridge::parse_swift_file(binary, file) {
            global.merge(file_graph);
        }
    }
    global
}

/// Locate the `flowmap-swift-ast` binary.
///
/// 1. Same directory as the running `flowmap` binary (covers `target/debug/`).
/// 2. Bare name — delegates to PATH.
fn resolve_swift_ast_binary() -> String {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("flowmap-swift-ast");
            if candidate.exists() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    eprintln!(
        "[flowmap-engine] flowmap-swift-ast not found next to engine binary; \
         falling back to PATH lookup."
    );
    "flowmap-swift-ast".to_string()
}

/// Simple PATH lookup — returns `Some` if `name` resolves via PATH.
fn which_in_path(name: &str) -> Option<std::path::PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
    })
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
        // PR4 diff schema
        assert!(p["diff"]["added_nodes"].is_array());
        assert!(p["diff"]["removed_nodes"].is_array());
        assert!(p["diff"]["changed_nodes"].is_array());
        assert!(p["diff"]["added_edges"].is_array());
        assert!(p["diff"]["removed_edges"].is_array());
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
