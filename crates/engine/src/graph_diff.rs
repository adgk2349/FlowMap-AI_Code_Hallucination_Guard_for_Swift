use crate::graph_builder::{BuiltEdge, BuiltGraph, BuiltNode};
use serde::Serialize;
use std::collections::HashMap;

/// The diff between two versions of a dependency graph.
///
/// Nodes are matched by `id`.  Edges are matched by the composite key
/// `(from, to, kind)` — if both endpoints and the relationship type are
/// identical the edge is considered unchanged.
#[derive(Debug, Default, Serialize)]
pub struct GraphDiff {
    /// Nodes present in `new` but absent in `old`.
    pub added_nodes: Vec<BuiltNode>,
    /// Nodes present in `old` but absent in `new`.
    pub removed_nodes: Vec<BuiltNode>,
    /// Nodes present in both graphs whose metadata (name / kind / uri / line)
    /// differs.
    pub changed_nodes: Vec<BuiltNode>,
    /// Edges present in `new` but absent in `old`.
    pub added_edges: Vec<BuiltEdge>,
    /// Edges present in `old` but absent in `new`.
    pub removed_edges: Vec<BuiltEdge>,
}

impl GraphDiff {
    /// `true` when no changes of any kind were detected.
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.added_nodes.is_empty()
            && self.removed_nodes.is_empty()
            && self.changed_nodes.is_empty()
            && self.added_edges.is_empty()
            && self.removed_edges.is_empty()
    }
}

/// Compare two dependency graphs and return the set of changes.
pub fn diff_graphs(old: &BuiltGraph, new: &BuiltGraph) -> GraphDiff {
    // ── Node diff ────────────────────────────────────────────────────────────
    let old_nodes: HashMap<&str, &BuiltNode> =
        old.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let new_nodes: HashMap<&str, &BuiltNode> =
        new.nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    let mut added_nodes = Vec::new();
    let mut removed_nodes = Vec::new();
    let mut changed_nodes = Vec::new();

    for (&id, &new_node) in &new_nodes {
        match old_nodes.get(id) {
            None => added_nodes.push(new_node.clone()),
            Some(&old_node) if node_metadata_changed(old_node, new_node) => {
                changed_nodes.push(new_node.clone());
            }
            _ => {} // unchanged
        }
    }

    for (&id, &old_node) in &old_nodes {
        if !new_nodes.contains_key(id) {
            removed_nodes.push(old_node.clone());
        }
    }

    // ── Edge diff ────────────────────────────────────────────────────────────
    let edge_key = |e: &BuiltEdge| format!("{}::{}::{}", e.from, e.to, e.kind);

    let old_edge_map: HashMap<String, &BuiltEdge> =
        old.edges.iter().map(|e| (edge_key(e), e)).collect();
    let new_edge_map: HashMap<String, &BuiltEdge> =
        new.edges.iter().map(|e| (edge_key(e), e)).collect();

    let added_edges = new_edge_map
        .iter()
        .filter(|(k, _)| !old_edge_map.contains_key(*k))
        .map(|(_, &e)| e.clone())
        .collect();

    let removed_edges = old_edge_map
        .iter()
        .filter(|(k, _)| !new_edge_map.contains_key(*k))
        .map(|(_, &e)| e.clone())
        .collect();

    GraphDiff {
        added_nodes,
        removed_nodes,
        changed_nodes,
        added_edges,
        removed_edges,
    }
}

/// Returns `true` when any user-visible metadata field differs between the
/// two versions of the same node.
fn node_metadata_changed(old: &BuiltNode, new: &BuiltNode) -> bool {
    old.name != new.name || old.kind != new.kind || old.uri != new.uri || old.line != new.line
}

// ── tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph_builder::{BuiltEdge, BuiltGraph, BuiltNode};

    fn node(id: &str, name: &str) -> BuiltNode {
        BuiltNode {
            id: id.to_string(),
            kind: "func".to_string(),
            name: name.to_string(),
            uri: None,
            line: None,
        }
    }

    fn edge(id: &str, from: &str, to: &str, kind: &str) -> BuiltEdge {
        BuiltEdge {
            id: id.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            kind: kind.to_string(),
        }
    }

    fn graph(nodes: Vec<BuiltNode>, edges: Vec<BuiltEdge>) -> BuiltGraph {
        BuiltGraph { nodes, edges }
    }

    #[test]
    fn test_node_added() {
        let old = graph(vec![], vec![]);
        let new = graph(vec![node("A", "A")], vec![]);
        let diff = diff_graphs(&old, &new);
        assert_eq!(diff.added_nodes.len(), 1);
        assert_eq!(diff.added_nodes[0].id, "A");
        assert!(diff.removed_nodes.is_empty());
        assert!(diff.changed_nodes.is_empty());
    }

    #[test]
    fn test_node_removed() {
        let old = graph(vec![node("A", "A")], vec![]);
        let new = graph(vec![], vec![]);
        let diff = diff_graphs(&old, &new);
        assert!(diff.added_nodes.is_empty());
        assert_eq!(diff.removed_nodes.len(), 1);
        assert_eq!(diff.removed_nodes[0].id, "A");
    }

    #[test]
    fn test_node_changed() {
        let old = graph(vec![node("A", "fetchUser")], vec![]);
        let new = graph(vec![node("A", "getUser")], vec![]);
        let diff = diff_graphs(&old, &new);
        assert!(diff.added_nodes.is_empty());
        assert!(diff.removed_nodes.is_empty());
        assert_eq!(diff.changed_nodes.len(), 1);
        assert_eq!(diff.changed_nodes[0].name, "getUser");
    }

    #[test]
    fn test_edge_added() {
        let old = graph(vec![], vec![]);
        let new = graph(vec![], vec![edge("e1", "A", "B", "calls")]);
        let diff = diff_graphs(&old, &new);
        assert_eq!(diff.added_edges.len(), 1);
        assert!(diff.removed_edges.is_empty());
    }

    #[test]
    fn test_edge_removed() {
        let old = graph(vec![], vec![edge("e1", "A", "B", "calls")]);
        let new = graph(vec![], vec![]);
        let diff = diff_graphs(&old, &new);
        assert!(diff.added_edges.is_empty());
        assert_eq!(diff.removed_edges.len(), 1);
    }

    #[test]
    fn test_no_diff_identical_graphs() {
        let g = graph(
            vec![node("A", "A"), node("B", "B")],
            vec![edge("e1", "A", "B", "calls")],
        );
        let diff = diff_graphs(&g, &g);
        assert!(diff.is_empty());
    }

    #[test]
    fn test_is_empty_default() {
        assert!(GraphDiff::default().is_empty());
    }
}
