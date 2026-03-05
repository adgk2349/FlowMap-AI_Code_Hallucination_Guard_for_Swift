use crate::graph_builder::{BuiltGraph, BuiltNode};
use std::collections::{HashMap, HashSet, VecDeque};

/// Return all nodes reachable from `start_node_ids` by following `calls` edges
/// in `graph` (forward BFS reachability).
///
/// The start nodes themselves are **excluded** from the result — only their
/// transitive dependants are returned.
///
/// Only `calls` edges are traversed; `contains` edges (which express parent/
/// child containment) are intentionally ignored so that structural hierarchy
/// does not inflate the impact set.
///
/// # Example
/// ```text
/// A → B → C
/// impacted_nodes(graph, ["A"]) == [B, C]
/// ```
pub fn impacted_nodes(graph: &BuiltGraph, start_node_ids: &[&str]) -> Vec<BuiltNode> {
    // Build adjacency map: from → [to] over "calls" edges only
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in &graph.edges {
        if edge.kind == "calls" {
            adj.entry(edge.from.as_str())
                .or_default()
                .push(edge.to.as_str());
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

    // Exclude the start nodes themselves — only downstream dependants
    visited
        .into_iter()
        .filter(|id| !starts.contains(id))
        .filter_map(|id| node_map.get(id).map(|&n| n.clone()))
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
        // A → B → C: changing A must impact B and C
        let g = build(
            vec![node("A"), node("B"), node("C")],
            vec![calls("A", "B"), calls("B", "C")],
        );
        assert_eq!(sorted_ids(impacted_nodes(&g, &["A"])), vec!["B", "C"]);
    }

    #[test]
    fn test_branching_propagation() {
        // A → B, A → C
        let g = build(
            vec![node("A"), node("B"), node("C")],
            vec![calls("A", "B"), calls("A", "C")],
        );
        assert_eq!(sorted_ids(impacted_nodes(&g, &["A"])), vec!["B", "C"]);
    }

    #[test]
    fn test_no_outgoing_edges() {
        let g = build(vec![node("A"), node("B")], vec![]);
        assert!(impacted_nodes(&g, &["A"]).is_empty());
    }

    #[test]
    fn test_cycle_does_not_infinite_loop() {
        // A → B → A (cycle)
        let g = build(
            vec![node("A"), node("B")],
            vec![calls("A", "B"), calls("B", "A")],
        );
        // Only B is downstream of A (A is the start and excluded from result)
        assert_eq!(sorted_ids(impacted_nodes(&g, &["A"])), vec!["B"]);
    }

    #[test]
    fn test_only_calls_edges_followed() {
        // "contains" edge should NOT be traversed
        let g = build(vec![node("A"), node("B")], vec![contains_edge("A", "B")]);
        assert!(impacted_nodes(&g, &["A"]).is_empty());
    }

    #[test]
    fn test_multiple_start_nodes() {
        // Start from both A and D; B and C reachable from A; E reachable from D
        let g = build(
            vec![node("A"), node("B"), node("C"), node("D"), node("E")],
            vec![calls("A", "B"), calls("B", "C"), calls("D", "E")],
        );
        let mut ids = sorted_ids(impacted_nodes(&g, &["A", "D"]));
        ids.sort();
        assert_eq!(ids, vec!["B", "C", "E"]);
    }

    #[test]
    fn test_unknown_start_node_returns_empty() {
        let g = build(vec![node("A")], vec![]);
        assert!(impacted_nodes(&g, &["Z"]).is_empty());
    }
}
