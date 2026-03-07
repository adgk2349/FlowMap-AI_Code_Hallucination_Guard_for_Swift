use crate::graph_builder::{BuiltEdge, BuiltGraph};
use crate::swift_bridge::UnresolvedCallSite;
use std::collections::{HashMap, HashSet};

// ── Symbol index ─────────────────────────────────────────────────────────────

/// A workspace-wide lookup structure built from the merged `BuiltGraph`.
///
/// The index maps bare function names to candidate node IDs, stratified by
/// whether the function is a method (keyed by `(TypeName, funcName)`) or a
/// global/free function (keyed by `funcName` alone).
pub struct SymbolIndex {
    /// `(TypeName, funcName)` → sorted list of matching node IDs.
    /// Used for `UpperCase.foo()` and `self.foo()` call sites.
    pub methods: HashMap<(String, String), Vec<String>>,
    /// `funcName` → sorted list of matching node IDs.
    /// Used for bare `foo()` call sites with no base expression.
    pub global_funcs: HashMap<String, Vec<String>>,
    /// Set of all type node IDs (kind == "type") for parent-of-node derivation.
    /// Retained for future use (e.g. type-hierarchy-aware resolution).
    #[allow(dead_code)]
    pub type_ids: HashSet<String>,
}

impl SymbolIndex {
    /// Build the symbol index from the already-merged workspace graph.
    pub fn build(graph: &BuiltGraph) -> Self {
        let type_ids: HashSet<String> = graph
            .nodes
            .iter()
            .filter(|n| n.kind == "type")
            .map(|n| n.id.clone())
            .collect();

        let mut methods: HashMap<(String, String), Vec<String>> = HashMap::new();
        let mut global_funcs: HashMap<String, Vec<String>> = HashMap::new();

        for node in &graph.nodes {
            if node.kind != "func" {
                continue;
            }
            let func_name = &node.name;
            // Derive the parent type name: strip the last dot-component (the func sig)
            // from the node ID, then check if the result is a known type node ID.
            if let Some(parent_id) = parent_type_id_of(&node.id, &type_ids) {
                // The parent is a type → this is a method.
                // The type name is the last component of the parent_id.
                let type_name = parent_id
                    .rsplit('.')
                    .next()
                    .unwrap_or(parent_id)
                    .to_string();
                methods
                    .entry((type_name, func_name.clone()))
                    .or_default()
                    .push(node.id.clone());
            } else {
                // No enclosing type → global / free function.
                global_funcs
                    .entry(func_name.clone())
                    .or_default()
                    .push(node.id.clone());
            }
        }

        Self {
            methods,
            global_funcs,
            type_ids,
        }
    }
}

/// Given a func node ID like `"Foo.swift.MyClass.connect()"`, return the
/// immediately enclosing type's node ID if it exists in `type_ids`.
///
/// Strategy: strip off the last dot-segment (everything after the last `.`
/// before a `(`), and check whether the remainder is a known type ID.
fn parent_type_id_of<'a>(node_id: &'a str, type_ids: &HashSet<String>) -> Option<&'a str> {
    // Find the start of the last segment.  For func nodes the ID ends with
    // something like `.funcName()` or `.funcName(label:)`.
    // We look for the last `.` that precedes a `(`.
    let paren_pos = node_id.find('(')?;
    let prefix = &node_id[..paren_pos]; // e.g. "Foo.swift.MyClass.connect"
    let last_dot = prefix.rfind('.')?;
    let parent = &node_id[..last_dot]; // e.g. "Foo.swift.MyClass"
    if type_ids.contains(parent) {
        Some(parent)
    } else {
        None
    }
}

// ── Cross-file resolver ───────────────────────────────────────────────────────

/// Attempt to resolve each `UnresolvedCallSite` against the workspace
/// `SymbolIndex`, producing new `BuiltEdge`s for confirmed matches.
///
/// # Conservative resolution rules
///
/// **Rule A — UpperCase base (explicit type receiver)**
/// `NetworkManager.connect()` → look up `methods[("NetworkManager","connect")]`.
/// Emit the edge only if there is exactly **one** candidate (avoids false positives
/// when multiple types expose the same method name).
///
/// **Rule B — `self` base (same-type method)**
/// `self.helper()` → look up `methods[(callerType,"helper")]`.
/// Requires `callerType` to be non-None.  Emit only for a single candidate.
///
/// **Rule C — bare call, no base (global/free function)**
/// `helper()` → look up `global_funcs["helper"]`.
/// Emit only for a single candidate.
///
/// **Rule D — lowercase-variable base (instance variable, cannot resolve)**
/// `mgr.connect()` → skip; we cannot infer the type of `mgr` statically.
///
/// Duplicate edges (same `from`/`to` pair already present in `graph.edges`)
/// are suppressed.
pub fn resolve(
    graph: &BuiltGraph,
    call_sites: &[UnresolvedCallSite],
    index: &SymbolIndex,
) -> Vec<BuiltEdge> {
    // Build a set of existing from→to pairs to avoid duplicates.
    let existing_pairs: HashSet<(&str, &str)> = graph
        .edges
        .iter()
        .map(|e| (e.from.as_str(), e.to.as_str()))
        .collect();

    let mut new_edges: Vec<BuiltEdge> = Vec::new();
    // Track newly generated pairs within this batch too.
    let mut seen_pairs: HashSet<(String, String)> = HashSet::new();

    let mut edge_seq: usize = 0;

    for site in call_sites {
        let target_candidates: Option<&Vec<String>> = match site.callee_base.as_deref() {
            // Rule A: UpperCase explicit-type receiver
            Some(base)
                if base
                    .chars()
                    .next()
                    .map(|c| c.is_uppercase())
                    .unwrap_or(false) =>
            {
                index
                    .methods
                    .get(&(base.to_string(), site.callee_name.clone()))
            }

            // Rule B: self receiver
            Some("self") => {
                if let Some(caller_type) = &site.caller_type {
                    index
                        .methods
                        .get(&(caller_type.clone(), site.callee_name.clone()))
                } else {
                    None
                }
            }

            // Rule D: lowercase variable base — cannot resolve
            Some(_) => None,

            // Rule C: bare call with no base
            None => index.global_funcs.get(&site.callee_name),
        };

        // Emit only if exactly one candidate exists (conservative)
        if let Some(candidates) = target_candidates {
            if candidates.len() == 1 {
                let target_id = &candidates[0];
                let from = &site.caller_id;
                let to = target_id;

                // Skip if already present in the graph or in this batch
                if existing_pairs.contains(&(from.as_str(), to.as_str())) {
                    continue;
                }
                let pair = (from.clone(), to.clone());
                if seen_pairs.contains(&pair) {
                    continue;
                }
                seen_pairs.insert(pair);

                edge_seq += 1;
                new_edges.push(BuiltEdge {
                    id: format!("xfile_e{edge_seq}"),
                    from: from.clone(),
                    to: to.clone(),
                    kind: "calls".to_string(),
                });
            }
        }
    }

    new_edges
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph_builder::{BuiltEdge, BuiltNode};

    fn make_graph(nodes: Vec<BuiltNode>, edges: Vec<BuiltEdge>) -> BuiltGraph {
        BuiltGraph { nodes, edges }
    }

    fn type_node(id: &str, name: &str) -> BuiltNode {
        BuiltNode {
            id: id.to_string(),
            kind: "type".to_string(),
            name: name.to_string(),
            uri: Some("/src/Foo.swift".to_string()),
            line: Some(1),
        }
    }

    fn func_node(id: &str, name: &str) -> BuiltNode {
        BuiltNode {
            id: id.to_string(),
            kind: "func".to_string(),
            name: name.to_string(),
            uri: Some("/src/Foo.swift".to_string()),
            line: Some(5),
        }
    }

    fn site(
        caller_id: &str,
        callee_name: &str,
        callee_base: Option<&str>,
        caller_type: Option<&str>,
    ) -> UnresolvedCallSite {
        UnresolvedCallSite {
            caller_id: caller_id.to_string(),
            callee_name: callee_name.to_string(),
            callee_base: callee_base.map(str::to_string),
            caller_type: caller_type.map(str::to_string),
            caller_file: "/src/Bar.swift".to_string(),
        }
    }

    // Rule A: UpperCase base → method lookup
    #[test]
    fn test_rule_a_uppercase_base() {
        let graph = make_graph(
            vec![
                type_node("Net.swift.NetworkManager", "NetworkManager"),
                func_node("Net.swift.NetworkManager.connect()", "connect"),
            ],
            vec![],
        );
        let index = SymbolIndex::build(&graph);
        let sites = vec![site(
            "App.swift.ViewController.viewDidLoad()",
            "connect",
            Some("NetworkManager"),
            Some("ViewController"),
        )];
        let edges = resolve(&graph, &sites, &index);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].from, "App.swift.ViewController.viewDidLoad()");
        assert_eq!(edges[0].to, "Net.swift.NetworkManager.connect()");
        assert_eq!(edges[0].kind, "calls");
    }

    // Rule B: self base → same-type method lookup
    #[test]
    fn test_rule_b_self_base() {
        let graph = make_graph(
            vec![
                type_node("Foo.swift.MyClass", "MyClass"),
                func_node("Foo.swift.MyClass.helper()", "helper"),
            ],
            vec![],
        );
        let index = SymbolIndex::build(&graph);
        let sites = vec![site(
            "Bar.swift.MyClass.doWork()",
            "helper",
            Some("self"),
            Some("MyClass"),
        )];
        let edges = resolve(&graph, &sites, &index);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].to, "Foo.swift.MyClass.helper()");
    }

    // Rule C: bare call → global function lookup
    #[test]
    fn test_rule_c_bare_call() {
        let graph = make_graph(
            vec![func_node("Utils.swift.formatDate()", "formatDate")],
            vec![],
        );
        let index = SymbolIndex::build(&graph);
        let sites = vec![site(
            "App.swift.ViewController.viewDidLoad()",
            "formatDate",
            None,
            Some("ViewController"),
        )];
        let edges = resolve(&graph, &sites, &index);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].to, "Utils.swift.formatDate()");
    }

    // Rule D: lowercase base → skip (no edges)
    #[test]
    fn test_rule_d_lowercase_base_skipped() {
        let graph = make_graph(
            vec![
                type_node("Net.swift.NetworkManager", "NetworkManager"),
                func_node("Net.swift.NetworkManager.connect()", "connect"),
            ],
            vec![],
        );
        let index = SymbolIndex::build(&graph);
        let sites = vec![site(
            "App.swift.ViewController.viewDidLoad()",
            "connect",
            Some("mgr"), // lowercase variable — Rule D
            Some("ViewController"),
        )];
        let edges = resolve(&graph, &sites, &index);
        assert!(edges.is_empty(), "lowercase base must be skipped");
    }

    // Ambiguous: two methods with same (Type, name) → no edge (conservative)
    #[test]
    fn test_ambiguous_candidates_suppressed() {
        // Two different NetworkManager types both have `connect()`
        let graph = make_graph(
            vec![
                type_node("A.swift.NetworkManager", "NetworkManager"),
                func_node("A.swift.NetworkManager.connect()", "connect"),
                type_node("B.swift.NetworkManager", "NetworkManager"),
                func_node("B.swift.NetworkManager.connect()", "connect"),
            ],
            vec![],
        );
        let index = SymbolIndex::build(&graph);
        let sites = vec![site(
            "App.swift.VC.go()",
            "connect",
            Some("NetworkManager"),
            Some("VC"),
        )];
        let edges = resolve(&graph, &sites, &index);
        assert!(
            edges.is_empty(),
            "ambiguous targets must not produce an edge"
        );
    }

    // Duplicate suppression: same from→to pair in graph already → no new edge
    #[test]
    fn test_no_duplicate_edges() {
        let existing_edge = BuiltEdge {
            id: "e1".to_string(),
            from: "App.swift.VC.go()".to_string(),
            to: "Net.swift.NetworkManager.connect()".to_string(),
            kind: "calls".to_string(),
        };
        let graph = make_graph(
            vec![
                type_node("Net.swift.NetworkManager", "NetworkManager"),
                func_node("Net.swift.NetworkManager.connect()", "connect"),
            ],
            vec![existing_edge],
        );
        let index = SymbolIndex::build(&graph);
        let sites = vec![site(
            "App.swift.VC.go()",
            "connect",
            Some("NetworkManager"),
            Some("VC"),
        )];
        let edges = resolve(&graph, &sites, &index);
        assert!(edges.is_empty(), "existing edge must not be duplicated");
    }
}
