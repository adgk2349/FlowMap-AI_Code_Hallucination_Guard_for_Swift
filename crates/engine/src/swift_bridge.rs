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

#[derive(Debug, Deserialize)]
pub struct SwiftGraph {
    pub nodes: Vec<SwiftNode>,
    pub edges: Vec<SwiftEdge>,
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
