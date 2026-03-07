use crate::graph_builder::{BuiltGraph, BuiltNode};
use std::collections::{HashMap, HashSet, VecDeque};

/// Return caller-side impact reachable from `start_node_ids` by following
/// `calls` edges in reverse direction.
///
/// Traversal follows `callee -> caller`, because when a callee changes its
/// callers are impacted.
///
/// Only `calls` edges are traversed; `contains` edges (which express parent/
/// child containment) are intentionally ignored so that structural hierarchy
/// does not inflate the impact set.
///
/// # Example
/// ```text
/// A → B → C
/// impacted_nodes(graph, ["C"], ["C"]) == [B, A]
/// ```
pub fn impacted_nodes(
    graph: &BuiltGraph,
    start_node_ids: &[&str],
    exclude_node_ids: &[&str],
) -> Vec<BuiltNode> {
    // Build adjacency map: to → [from] over "calls" edges only.
    // Changing a node impacts its callers, so we must traverse edges BACKWARDS.
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in &graph.edges {
        if edge.kind == "calls" {
            adj.entry(edge.to.as_str())
                .or_default()
                .push(edge.from.as_str());
        }
    }

    // Build an id → node lookup for the result
    let node_map: HashMap<&str, &BuiltNode> =
        graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    let starts: HashSet<&str> = start_node_ids.iter().copied().collect();

    // BFS
    let mut visited: HashSet<&str> = HashSet::new();
    let mut queue: VecDeque<&str> = VecDeque::new();

    for &id in &starts {
        if !visited.contains(id) {
            visited.insert(id);
            queue.push_back(id);
        }
    }

    while let Some(current) = queue.pop_front() {
        if let Some(neighbors) = adj.get(current) {
            for &next in neighbors {
                if !visited.contains(next) {
                    visited.insert(next);
                    queue.push_back(next);
                }
            }
        }
    }

    let excludes: HashSet<&str> = exclude_node_ids.iter().copied().collect();
    // Exclude the nodes explicitly requested to be excluded — only downstream dependants
    visited
        .into_iter()
        .filter(|id| !excludes.contains(id))
        .filter_map(|id| node_map.get(id).copied().cloned())
        .collect()
}

// ── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph_builder::{BuiltEdge, BuiltGraph, BuiltNode};

    fn node(id: &str) -> BuiltNode {
        BuiltNode {
            id: id.to_string(),
            kind: "func".to_string(),
            name: id.to_string(),
            uri: None,
            line: None,
        }
    }

    fn calls(from: &str, to: &str) -> BuiltEdge {
        BuiltEdge {
            id: format!("{from}::{to}"),
            from: from.to_string(),
            to: to.to_string(),
            kind: "calls".to_string(),
        }
    }

    fn contains_edge(from: &str, to: &str) -> BuiltEdge {
        BuiltEdge {
            id: format!("{from}::{to}"),
            from: from.to_string(),
            to: to.to_string(),
            kind: "contains".to_string(),
        }
    }

    fn build(nodes: Vec<BuiltNode>, edges: Vec<BuiltEdge>) -> BuiltGraph {
        BuiltGraph { nodes, edges }
    }

    fn sorted_ids(nodes: Vec<BuiltNode>) -> Vec<String> {
        let mut ids: Vec<String> = nodes.into_iter().map(|n| n.id).collect();
        ids.sort();
        ids
    }

    #[test]
    fn test_linear_propagation() {
        // A → B → C: changing C impacts B and A (Callers are impacted)
        let g = build(
            vec![node("A"), node("B"), node("C")],
            vec![calls("A", "B"), calls("B", "C")],
        );
        assert_eq!(
            sorted_ids(impacted_nodes(&g, &["C"], &["C"])),
            vec!["A", "B"]
        );
    }

    #[test]
    fn test_branching_propagation() {
        // B → A, C → A (B and C call A)
        let g = build(
            vec![node("A"), node("B"), node("C")],
            vec![calls("B", "A"), calls("C", "A")],
        );
        assert_eq!(
            sorted_ids(impacted_nodes(&g, &["A"], &["A"])),
            vec!["B", "C"]
        );
    }

    #[test]
    fn test_no_incoming_edges() {
        let g = build(vec![node("A"), node("B")], vec![]);
        assert!(impacted_nodes(&g, &["A"], &["A"]).is_empty());
    }

    #[test]
    fn test_cycle_does_not_infinite_loop() {
        // A → B → A (cycle)
        let g = build(
            vec![node("A"), node("B")],
            vec![calls("A", "B"), calls("B", "A")],
        );
        // B and A call each other. B is impacted by A, A is impacted by B.
        assert_eq!(sorted_ids(impacted_nodes(&g, &["A"], &["A"])), vec!["B"]);
    }

    #[test]
    fn test_only_calls_edges_followed() {
        // "contains" edge should NOT be traversed
        // A contains B. Changing B should not impact A through contains.
        let g = build(vec![node("A"), node("B")], vec![contains_edge("A", "B")]);
        assert!(impacted_nodes(&g, &["B"], &["B"]).is_empty());
    }

    #[test]
    fn test_multiple_start_nodes() {
        // B -> A, C -> B, E -> D
        let g = build(
            vec![node("A"), node("B"), node("C"), node("D"), node("E")],
            vec![calls("B", "A"), calls("C", "B"), calls("E", "D")],
        );
        let mut ids = sorted_ids(impacted_nodes(&g, &["A", "D"], &["A", "D"]));
        ids.sort();
        assert_eq!(ids, vec!["B", "C", "E"]);
    }

    #[test]
    fn test_unknown_start_node_returns_empty() {
        let g = build(vec![node("A")], vec![]);
        assert!(impacted_nodes(&g, &["Z"], &["Z"]).is_empty());
    }
}
