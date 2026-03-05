use crate::swift_bridge::SwiftGraph;
use serde::Serialize;
use std::collections::HashSet;

/// A node in the merged dependency graph.
/// `kind` is one of: "file" | "type" | "func"
#[derive(Debug, Clone, Serialize)]
pub struct BuiltNode {
    pub id: String,
    pub kind: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

/// An edge in the merged dependency graph.
/// `kind` is one of: "contains" | "calls"
/// Uses `from`/`to` to match the FlowMap protocol.
#[derive(Debug, Clone, Serialize)]
pub struct BuiltEdge {
    pub id: String,
    pub kind: String,
    pub from: String,
    pub to: String,
}

/// The complete workspace-level dependency graph produced by merging
/// per-file `SwiftGraph`s.
#[derive(Debug, Default, Serialize)]
pub struct BuiltGraph {
    pub nodes: Vec<BuiltNode>,
    pub edges: Vec<BuiltEdge>,
}

impl BuiltGraph {
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Merge one file's `SwiftGraph` into the workspace-level graph.
    ///
    /// - Nodes are deduplicated by ID.
    /// - Edges use `from`/`to` (protocol convention) converted from
    ///   `source`/`target` (swift-ast convention).
    pub fn merge(&mut self, swift: SwiftGraph) {
        // Snapshot existing IDs to avoid O(n²) membership checks inside the loop
        let existing_node_ids: HashSet<String> = self.nodes.iter().map(|n| n.id.clone()).collect();
        let existing_edge_ids: HashSet<String> = self.edges.iter().map(|e| e.id.clone()).collect();

        for n in swift.nodes {
            if !existing_node_ids.contains(&n.id) {
                self.nodes.push(BuiltNode {
                    id: n.id,
                    kind: n.kind,
                    name: n.name,
                    uri: n.uri,
                    line: n.line,
                });
            }
        }

        for e in swift.edges {
            if !existing_edge_ids.contains(&e.id) {
                self.edges.push(BuiltEdge {
                    id: e.id,
                    kind: e.kind,
                    from: e.source,
                    to: e.target,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::swift_bridge::{SwiftEdge, SwiftNode};

    fn make_graph(nodes: Vec<SwiftNode>, edges: Vec<SwiftEdge>) -> SwiftGraph {
        SwiftGraph { nodes, edges }
    }

    #[test]
    fn test_merge_nodes() {
        let mut g = BuiltGraph::new();
        g.merge(make_graph(
            vec![SwiftNode {
                id: "File.swift".into(),
                kind: "file".into(),
                name: "File.swift".into(),
                uri: Some("/path/File.swift".into()),
                line: Some(1),
            }],
            vec![],
        ));
        assert_eq!(g.nodes.len(), 1);
        assert_eq!(g.nodes[0].kind, "file");
    }

    #[test]
    fn test_deduplication() {
        let mut g = BuiltGraph::new();
        let same = SwiftNode {
            id: "File.swift".into(),
            kind: "file".into(),
            name: "File.swift".into(),
            uri: None,
            line: None,
        };
        let sg1 = make_graph(vec![same], vec![]);
        g.merge(sg1);

        let dup = SwiftNode {
            id: "File.swift".into(),
            kind: "file".into(),
            name: "File.swift".into(),
            uri: None,
            line: None,
        };
        let sg2 = make_graph(vec![dup], vec![]);
        g.merge(sg2);

        assert_eq!(g.nodes.len(), 1, "duplicate node should be skipped");
    }

    #[test]
    fn test_edge_source_target_to_from_to() {
        let mut g = BuiltGraph::new();
        g.merge(make_graph(
            vec![],
            vec![SwiftEdge {
                id: "e1".into(),
                source: "A".into(),
                target: "B".into(),
                kind: "contains".into(),
            }],
        ));
        assert_eq!(g.edges[0].from, "A");
        assert_eq!(g.edges[0].to, "B");
    }
}
