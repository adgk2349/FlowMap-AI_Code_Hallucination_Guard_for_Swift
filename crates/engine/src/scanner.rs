use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Recursively find all `*.swift` files under `root`.
/// Returns an empty vec if `root` does not exist or cannot be read.
pub fn find_swift_files(root: &Path) -> Vec<PathBuf> {
    if !root.exists() {
        return Vec::new();
    }
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path()
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("swift"))
        })
        .map(|e| e.path().to_path_buf())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_finds_swift_files() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("Foo.swift"), "").unwrap();
        fs::write(dir.path().join("Bar.swift"), "").unwrap();
        fs::write(dir.path().join("README.md"), "").unwrap();

        let found = find_swift_files(dir.path());
        assert_eq!(found.len(), 2);
        assert!(found.iter().all(|p| p.extension().unwrap() == "swift"));
    }

    #[test]
    fn test_missing_root_returns_empty() {
        let found = find_swift_files(Path::new("/nonexistent/path/xyz"));
        assert!(found.is_empty());
    }
}
