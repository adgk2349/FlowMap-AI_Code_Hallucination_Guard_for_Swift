use crate::graph_builder::BuiltGraph;
use crate::swift_bridge;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

/// Parse the **HEAD-committed** version of each file in `changed_files`
/// using content fetched via `git show HEAD:<relpath>`, building a graph
/// fragment that represents the state of those files *before* the current
/// edits.
///
/// Files that did not exist at HEAD (newly created files) are skipped so that
/// purely additive changes do not produce phantom "removed" nodes.
pub fn build_old_fragment(
    workspace_root: &Path,
    changed_files: &[PathBuf],
    binary: &str,
) -> BuiltGraph {
    use rayon::prelude::*;

    let parsed_graphs: Vec<swift_bridge::SwiftGraph> = changed_files
        .par_iter()
        .filter_map(|file| {
            // Fetch the committed version of this file
            let content = crate::git_diff::head_content(workspace_root, file)?;

            // Write the content to a temp file so the Swift parser can read it
            let mut tmp = NamedTempFile::new().ok()?;
            if tmp.write_all(content.as_bytes()).is_err() {
                return None;
            }

            swift_bridge::parse_swift_file(binary, tmp.path())
        })
        .collect();

    let mut graph = BuiltGraph::default();
    for sg in parsed_graphs {
        graph.merge(sg);
    }

    graph
}

/// Parse the **current working-tree** version of each file in `changed_files`,
/// building a graph fragment that represents the files *after* the edits.
pub fn build_new_fragment(changed_files: &[PathBuf], binary: &str) -> BuiltGraph {
    use rayon::prelude::*;

    let parsed_graphs: Vec<swift_bridge::SwiftGraph> = changed_files
        .par_iter()
        .filter_map(|file| swift_bridge::parse_swift_file(binary, file))
        .collect();

    let mut graph = BuiltGraph::default();
    for sg in parsed_graphs {
        graph.merge(sg);
    }

    graph
}

/// Apply an incremental update to `old_graph`: remove all nodes and edges that
/// belong to `changed_files`, then re-parse those files from disk and merge
/// the fresh results.
///
/// This is useful when the caller already holds a cached workspace-level graph
/// and wants to avoid a full re-parse of the entire workspace.
#[allow(dead_code)]
pub fn update_graph(
    mut old_graph: BuiltGraph,
    changed_files: &[PathBuf],
    binary: &str,
) -> BuiltGraph {
    // URIs of files whose nodes should be evicted
    let changed_uris: HashSet<String> = changed_files
        .iter()
        .filter_map(|p| p.to_str())
        .map(String::from)
        .collect();

    // Collect IDs of stale nodes to also remove their edges
    let stale_ids: HashSet<String> = old_graph
        .nodes
        .iter()
        .filter(|n| n.uri.as_deref().is_some_and(|u| changed_uris.contains(u)))
        .map(|n| n.id.clone())
        .collect();

    old_graph.nodes.retain(|n| !stale_ids.contains(&n.id));
    old_graph
        .edges
        .retain(|e| !stale_ids.contains(&e.from) && !stale_ids.contains(&e.to));

    // Re-parse changed files and merge the updated nodes/edges
    for file in changed_files {
        if let Some(sg) = swift_bridge::parse_swift_file(binary, file) {
            old_graph.merge(sg);
        }
    }

    old_graph
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph_builder::{BuiltEdge, BuiltNode};
    use std::fs;
    use tempfile::TempDir;

    fn make_graph_with_node(id: &str, uri: &str) -> BuiltGraph {
        BuiltGraph {
            nodes: vec![BuiltNode {
                id: id.to_string(),
                kind: "func".to_string(),
                name: id.to_string(),
                uri: Some(uri.to_string()),
                line: Some(1),
            }],
            edges: vec![],
        }
    }

    #[test]
    fn test_build_new_fragment_missing_binary() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("Foo.swift");
        fs::write(&file, "class Foo {}").unwrap();

        // Binary does not exist → should return empty graph, not panic
        let result = build_new_fragment(&[file], "non_existent_binary_xyz");
        assert!(result.nodes.is_empty());
    }

    #[test]
    fn test_update_graph_removes_stale_nodes() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("Foo.swift");
        let uri = file_path.to_str().unwrap().to_string();

        let old = make_graph_with_node("FooFunc", &uri);
        // binary missing → no new nodes added; stale node removed
        let updated = update_graph(old, &[file_path], "non_existent_binary_xyz");
        assert!(updated.nodes.is_empty());
    }

    #[test]
    fn test_update_graph_removes_stale_edges() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("Foo.swift");
        let uri = file_path.to_str().unwrap().to_string();

        let old = BuiltGraph {
            nodes: vec![
                BuiltNode {
                    id: "FooFunc".to_string(),
                    kind: "func".to_string(),
                    name: "FooFunc".to_string(),
                    uri: Some(uri.clone()),
                    line: Some(1),
                },
                BuiltNode {
                    id: "BarFunc".to_string(),
                    kind: "func".to_string(),
                    name: "BarFunc".to_string(),
                    uri: Some("/other/Bar.swift".to_string()),
                    line: Some(1),
                },
            ],
            edges: vec![BuiltEdge {
                id: "FooFunc::BarFunc".to_string(),
                from: "FooFunc".to_string(),
                to: "BarFunc".to_string(),
                kind: "calls".to_string(),
            }],
        };

        let updated = update_graph(old, &[file_path], "non_existent_binary_xyz");

        // FooFunc node removed; its edge removed; BarFunc still present
        assert_eq!(updated.nodes.len(), 1);
        assert_eq!(updated.nodes[0].id, "BarFunc");
        assert!(updated.edges.is_empty());
    }
}
