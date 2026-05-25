mod cross_file_resolver;
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
use std::path::{Path, PathBuf};

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
    let mut diff = if changed_files.is_empty() {
        GraphDiff::default()
    } else {
        let (mut old_fragment, old_sites) =
            incremental_graph::build_old_fragment(root, &changed_files, &binary);
        let (mut new_fragment, new_sites) =
            incremental_graph::build_new_fragment(&changed_files, &binary);

        let old_context = build_resolution_context(&full_graph, &changed_files, &old_fragment);
        let old_index = cross_file_resolver::SymbolIndex::build(&old_context);
        let old_resolved = cross_file_resolver::resolve(&old_context, &old_sites, &old_index);
        old_fragment.edges.extend(old_resolved);

        let new_context = build_resolution_context(&full_graph, &changed_files, &new_fragment);
        let new_index = cross_file_resolver::SymbolIndex::build(&new_context);
        let new_resolved = cross_file_resolver::resolve(&new_context, &new_sites, &new_index);
        new_fragment.edges.extend(new_resolved);

        graph_diff::diff_graphs(&old_fragment, &new_fragment)
    };

    // ── 4. Impact analysis ────────────────────────────────────────────────
    // Start nodes: added/changed nodes + any node in the full graph that
    // calls a removed node (its dependency was deleted → it is affected).
    let removed_ids: HashSet<String> = diff.removed_nodes.iter().map(|n| n.id.clone()).collect();

    let mut start_ids: HashSet<String> = diff
        .added_nodes
        .iter()
        .chain(diff.changed_nodes.iter())
        .map(|n| n.id.clone())
        .collect();

    // Preserve exactly what nodes changed intrinsically to exclude them from the orange 'impact' set
    let mut primary_changed: HashSet<String> = start_ids.clone();

    for edge in &full_graph.edges {
        if edge.kind == "calls" && removed_ids.contains(&edge.to) {
            start_ids.insert(edge.from.clone());
        }
    }

    // Also trace callers from the old graph: if an edge was broken because the
    // target was removed, the caller is intrinsically impacted.
    for edge in &diff.removed_edges {
        if edge.kind == "calls" && removed_ids.contains(&edge.to) {
            start_ids.insert(edge.from.clone());
            primary_changed.insert(edge.from.clone());
        }
    }

    // Any new call edges? The caller should be impacted too
    for edge in &diff.added_edges {
        if edge.kind == "calls" {
            start_ids.insert(edge.from.clone());
            primary_changed.insert(edge.from.clone());
        }
    }

    // Add implicitly changed nodes to diff.changed_nodes so they get painted yellow
    let existing_changed_ids: HashSet<String> =
        diff.changed_nodes.iter().map(|n| n.id.clone()).collect();
    for id in &primary_changed {
        if !existing_changed_ids.contains(id) && !diff.added_nodes.iter().any(|n| &n.id == id) {
            if let Some(node) = full_graph.nodes.iter().find(|n| n.id == *id) {
                diff.changed_nodes.push(node.clone());
            }
        }
    }

    let start_refs: Vec<&str> = start_ids.iter().map(|s| s.as_str()).collect();
    let primary_changed_vec: Vec<&str> = primary_changed.iter().map(|s| s.as_str()).collect();
    let impacted = impact_analysis::impacted_nodes(&full_graph, &start_refs, &primary_changed_vec);
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
/// merge the per-file graphs into a single workspace graph, and then perform
/// cross-file call resolution using the workspace-wide symbol index.
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

    use rayon::prelude::*;

    let parsed_graphs: Vec<swift_bridge::SwiftGraph> = swift_files
        .par_iter()
        .filter_map(|file| swift_bridge::parse_swift_file(binary, file))
        .collect();

    // Collect all unresolved call sites before merging (merge consumes the graphs)
    let mut all_call_sites: Vec<swift_bridge::UnresolvedCallSite> = Vec::new();
    let mut global = BuiltGraph::default();
    for mut sg in parsed_graphs {
        all_call_sites.extend(std::mem::take(&mut sg.call_sites));
        global.merge(sg);
    }

    // Cross-file resolution: build a symbol index from the merged graph, then
    // resolve each unresolved call site and append the new edges.
    if !all_call_sites.is_empty() {
        let index = cross_file_resolver::SymbolIndex::build(&global);
        let cross_edges = cross_file_resolver::resolve(&global, &all_call_sites, &index);
        global.edges.extend(cross_edges);
    }

    global
}

/// Build a symbol-resolution context for one side of an incremental diff.
///
/// The context includes:
/// - all nodes from unchanged files (current graph)
/// - all nodes/edges from the target fragment (old or new side)
///
/// This avoids mixing old/new versions of changed files while still allowing
/// cross-file resolution against unchanged workspace symbols.
fn build_resolution_context(
    full_graph: &BuiltGraph,
    changed_files: &[PathBuf],
    fragment: &BuiltGraph,
) -> BuiltGraph {
    let mut context = BuiltGraph::default();
    let mut seen_ids: HashSet<String> = HashSet::new();

    for node in &full_graph.nodes {
        if node
            .uri
            .as_deref()
            .is_some_and(|uri| is_changed_file_uri(uri, changed_files))
        {
            continue;
        }
        if seen_ids.insert(node.id.clone()) {
            context.nodes.push(node.clone());
        }
    }

    for node in &fragment.nodes {
        if seen_ids.insert(node.id.clone()) {
            context.nodes.push(node.clone());
        }
    }

    // Deliberately use fragment edges only:
    // resolver duplicate suppression should not hide edges just because they
    // already exist in the full current workspace graph.
    context.edges = fragment.edges.clone();
    context
}

fn is_changed_file_uri(uri: &str, changed_files: &[PathBuf]) -> bool {
    let uri_clean = uri.strip_prefix("file://").unwrap_or(uri);
    let uri_path = Path::new(uri_clean);

    changed_files.iter().any(|changed| {
        let changed_clean = changed.to_string_lossy();
        let changed_clean = changed_clean
            .strip_prefix("file://")
            .unwrap_or(&changed_clean);
        let changed_path = Path::new(changed_clean);

        if uri_path == changed_path {
            return true;
        }

        match (uri_path.is_absolute(), changed_path.is_absolute()) {
            (true, false) => uri_path.ends_with(changed_path),
            (false, true) => changed_path.ends_with(uri_path),
            _ => false,
        }
    })
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
    use crate::graph_builder::{BuiltEdge, BuiltNode};
    use crate::swift_bridge::UnresolvedCallSite;
    use std::path::PathBuf;

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

    #[test]
    fn test_is_changed_file_uri_handles_relative_absolute_mismatch() {
        let changed_rel = vec![PathBuf::from("src/Changed.swift")];
        assert!(is_changed_file_uri(
            "/repo/workspace/src/Changed.swift",
            &changed_rel
        ));

        let changed_abs = vec![PathBuf::from("/repo/workspace/src/Changed.swift")];
        assert!(is_changed_file_uri("src/Changed.swift", &changed_abs));
    }

    #[test]
    fn test_build_resolution_context_drops_changed_nodes_from_full_graph() {
        let full_graph = BuiltGraph {
            nodes: vec![
                BuiltNode {
                    id: "src/Changed.swift.NewCaller()".to_string(),
                    kind: "func".to_string(),
                    name: "newCaller".to_string(),
                    uri: Some("src/Changed.swift".to_string()),
                    line: Some(10),
                },
                BuiltNode {
                    id: "src/Shared.swift.target()".to_string(),
                    kind: "func".to_string(),
                    name: "target".to_string(),
                    uri: Some("src/Shared.swift".to_string()),
                    line: Some(3),
                },
            ],
            edges: vec![BuiltEdge {
                id: "e1".to_string(),
                from: "src/Changed.swift.NewCaller()".to_string(),
                to: "src/Shared.swift.target()".to_string(),
                kind: "calls".to_string(),
            }],
        };

        let fragment = BuiltGraph {
            nodes: vec![BuiltNode {
                id: "src/Changed.swift.OldCaller()".to_string(),
                kind: "func".to_string(),
                name: "oldCaller".to_string(),
                uri: Some("src/Changed.swift".to_string()),
                line: Some(8),
            }],
            edges: vec![BuiltEdge {
                id: "old_e1".to_string(),
                from: "src/Changed.swift.OldCaller()".to_string(),
                to: "src/Changed.swift.helper()".to_string(),
                kind: "calls".to_string(),
            }],
        };

        let context = build_resolution_context(
            &full_graph,
            &[PathBuf::from("src/Changed.swift")],
            &fragment,
        );

        assert!(context
            .nodes
            .iter()
            .all(|n| n.id != "src/Changed.swift.NewCaller()"));
        assert!(context
            .nodes
            .iter()
            .any(|n| n.id == "src/Changed.swift.OldCaller()"));
        assert_eq!(context.edges.len(), 1);
        assert_eq!(context.edges[0].id, "old_e1");
    }

    #[test]
    fn test_resolve_not_suppressed_by_edges_outside_fragment() {
        let full_graph = BuiltGraph {
            nodes: vec![
                BuiltNode {
                    id: "src/Changed.swift.Caller()".to_string(),
                    kind: "func".to_string(),
                    name: "caller".to_string(),
                    uri: Some("src/Changed.swift".to_string()),
                    line: Some(1),
                },
                BuiltNode {
                    id: "src/Shared.swift.target()".to_string(),
                    kind: "func".to_string(),
                    name: "target".to_string(),
                    uri: Some("src/Shared.swift".to_string()),
                    line: Some(2),
                },
            ],
            edges: vec![BuiltEdge {
                id: "existing_full_edge".to_string(),
                from: "src/Changed.swift.Caller()".to_string(),
                to: "src/Shared.swift.target()".to_string(),
                kind: "calls".to_string(),
            }],
        };

        let fragment = BuiltGraph {
            nodes: vec![BuiltNode {
                id: "src/Changed.swift.Caller()".to_string(),
                kind: "func".to_string(),
                name: "caller".to_string(),
                uri: Some("src/Changed.swift".to_string()),
                line: Some(1),
            }],
            edges: vec![],
        };

        let context = build_resolution_context(
            &full_graph,
            &[PathBuf::from("src/Changed.swift")],
            &fragment,
        );
        let index = crate::cross_file_resolver::SymbolIndex::build(&context);
        let sites = vec![UnresolvedCallSite {
            caller_id: "src/Changed.swift.Caller()".to_string(),
            callee_name: "target".to_string(),
            callee_base: None,
            caller_type: None,
            caller_file: "src/Changed.swift".to_string(),
        }];

        let resolved = crate::cross_file_resolver::resolve(&context, &sites, &index);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].from, "src/Changed.swift.Caller()");
        assert_eq!(resolved[0].to, "src/Shared.swift.target()");
    }
}
