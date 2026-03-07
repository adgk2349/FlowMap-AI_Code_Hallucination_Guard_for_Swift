use serde::Deserialize;
use std::path::Path;
use std::process::Command;

/// Mirrors the JSON output of the `flowmap-swift-ast` binary.
#[derive(Debug, Deserialize)]
pub struct SwiftNode {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub uri: Option<String>,
    pub line: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct SwiftEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub kind: String,
}

/// An unresolved call site emitted by the Swift parser when same-file
/// resolution fails.  The Rust engine resolves these across the workspace
/// using the `SymbolIndex` built from the merged `BuiltGraph`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedCallSite {
    /// Node ID of the calling function (e.g. `"Foo.swift.MyClass.doWork()"`).
    pub caller_id: String,
    /// Bare function name being called (e.g. `"connect"`).
    pub callee_name: String,
    /// Base expression before the dot, if any
    /// (`"self"`, `"NetworkManager"`, `"mgr"`, or `None` for bare calls).
    pub callee_base: Option<String>,
    /// Enclosing type name at the call site, if any (e.g. `"ViewController"`).
    pub caller_type: Option<String>,
    /// Absolute path of the source file containing the call.
    /// Retained for provenance / future diagnostics.
    #[allow(dead_code)]
    pub caller_file: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwiftGraph {
    pub nodes: Vec<SwiftNode>,
    pub edges: Vec<SwiftEdge>,
    /// Unresolved call sites for cross-file resolution.
    /// Defaults to empty if the parser binary is older and omits the field.
    #[serde(default)]
    pub call_sites: Vec<UnresolvedCallSite>,
}

/// Invoke `flowmap-swift-ast <swift_file>` and parse its stdout as a
/// `SwiftGraph`.  Returns `None` if the binary is not found, the process
/// fails, or the output is not valid JSON — the caller should treat this
/// as "no graph available for this file" and continue.
pub fn parse_swift_file(binary: &str, swift_file: &Path) -> Option<SwiftGraph> {
    let output = Command::new(binary).arg(swift_file).output().ok()?;

    if !output.status.success() {
        eprintln!(
            "[flowmap-engine] swift-ast parser returned non-zero for {:?}: {}",
            swift_file,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        return None;
    }

    match serde_json::from_slice::<SwiftGraph>(&output.stdout) {
        Ok(g) => Some(g),
        Err(e) => {
            eprintln!(
                "[flowmap-engine] failed to parse swift-ast output for {:?}: {e}",
                swift_file
            );
            None
        }
    }
}
