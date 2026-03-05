use std::path::{Path, PathBuf};
use std::process::Command;

/// Run `git diff --name-only HEAD` in `workspace_root` and return the
/// absolute paths of changed `*.swift` files that still exist on disk.
///
/// Returns an empty vec when:
/// - `workspace_root` is not inside a git repository
/// - the repository has no commits yet
/// - no Swift files have changed relative to HEAD
/// - git is not installed
pub fn changed_swift_files(workspace_root: &Path) -> Vec<PathBuf> {
    let output = match Command::new("git")
        .args(["diff", "--name-only", "HEAD"])
        .current_dir(workspace_root)
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };

    if !output.status.success() {
        return Vec::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| l.ends_with(".swift"))
        .map(|l| workspace_root.join(l))
        .filter(|p| p.exists()) // skip deleted files (removed from disk)
        .collect()
}

/// Fetch the content of `file_path` at `HEAD` via `git show HEAD:<relpath>`.
///
/// Returns `None` when:
/// - `file_path` is not under `workspace_root`
/// - the file was newly added (did not exist at HEAD)
/// - git is unavailable or the repo has no commits
pub fn head_content(workspace_root: &Path, file_path: &Path) -> Option<String> {
    let rel = file_path.strip_prefix(workspace_root).ok()?;
    let rel_str = rel.to_str()?;

    let output = Command::new("git")
        .args(["show", &format!("HEAD:{rel_str}")])
        .current_dir(workspace_root)
        .output()
        .ok()?;

    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        None // file added in working tree — no HEAD version exists
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_changed_swift_files_non_git_dir() {
        // Directory that is not a git repo → must return empty, not panic
        let tmp = TempDir::new().unwrap();
        let result = changed_swift_files(tmp.path());
        assert!(result.is_empty());
    }

    #[test]
    fn test_head_content_non_git_dir() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("Foo.swift");
        let result = head_content(tmp.path(), &file);
        assert!(result.is_none());
    }

    #[test]
    fn test_head_content_file_not_under_root() {
        let tmp = TempDir::new().unwrap();
        let other = TempDir::new().unwrap();
        let file = other.path().join("Foo.swift");
        // strip_prefix will fail → None
        let result = head_content(tmp.path(), &file);
        assert!(result.is_none());
    }
}
