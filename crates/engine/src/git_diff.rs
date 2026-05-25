use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Return absolute paths of changed Swift files in `workspace_root`.
///
/// Sources:
/// - tracked changes vs `HEAD` (modified/renamed/deleted)
/// - untracked Swift files (new files not yet committed)
///
/// Deleted files are intentionally kept in the result so callers can
/// reconstruct the old fragment from `HEAD` and emit removed nodes/edges.
pub fn changed_swift_files(workspace_root: &Path) -> Vec<PathBuf> {
    let mut rel_paths: BTreeSet<PathBuf> = BTreeSet::new();

    // Tracked deltas compared to HEAD.
    // If HEAD does not exist yet, this command fails; that's okay because we
    // still collect untracked files below.
    if let Ok(lines) = git_lines(
        workspace_root,
        &["diff", "--name-only", "HEAD", "--", "*.swift"],
    ) {
        rel_paths.extend(lines.into_iter().map(PathBuf::from));
    } else {
        // Fallback for commit-less repositories: get staged files from the index.
        if let Ok(lines) = git_lines(workspace_root, &["ls-files", "--", "*.swift"]) {
            rel_paths.extend(lines.into_iter().map(PathBuf::from));
        }
    }

    // Newly created, untracked Swift files.
    if let Ok(lines) = git_lines(
        workspace_root,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "--",
            "*.swift",
        ],
    ) {
        rel_paths.extend(lines.into_iter().map(PathBuf::from));
    }

    rel_paths
        .into_iter()
        .map(|rel| workspace_root.join(rel))
        .collect()
}

fn git_lines(workspace_root: &Path, args: &[&str]) -> Result<Vec<String>, ()> {
    let output = Command::new("git")
        .args(args)
        .current_dir(workspace_root)
        .output()
        .map_err(|_| ())?;

    if !output.status.success() {
        return Err(());
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect())
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
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    fn git_ok(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(root)
            .status()
            .expect("failed to run git");
        assert!(status.success(), "git {:?} failed", args);
    }

    #[test]
    fn test_changed_swift_files_non_git_dir() {
        // Directory that is not a git repo → must return empty, not panic
        let tmp = TempDir::new().unwrap();
        let result = changed_swift_files(tmp.path());
        assert!(result.is_empty());
    }

    #[test]
    fn test_changed_swift_files_includes_untracked_modified_deleted() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        git_ok(root, &["init"]);
        git_ok(root, &["config", "user.email", "flowmap-test@example.com"]);
        git_ok(root, &["config", "user.name", "FlowMap Test"]);

        let modified = root.join("Modified.swift");
        let deleted = root.join("Deleted.swift");
        let untracked = root.join("Untracked.swift");

        fs::write(&modified, "func a() {}\n").unwrap();
        fs::write(&deleted, "func b() {}\n").unwrap();
        git_ok(root, &["add", "."]);
        git_ok(root, &["commit", "-m", "init"]);

        fs::write(&modified, "func a() { print(1) }\n").unwrap();
        fs::remove_file(&deleted).unwrap();
        fs::write(&untracked, "func c() {}\n").unwrap();
        fs::write(root.join("README.md"), "ignore\n").unwrap();

        let result = changed_swift_files(root);
        assert!(result.contains(&modified));
        assert!(result.contains(&deleted));
        assert!(result.contains(&untracked));
        assert!(!result.contains(&root.join("README.md")));
    }

    #[test]
    fn test_changed_swift_files_in_repo_without_head_includes_untracked_swift() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        git_ok(root, &["init"]);
        let file = root.join("BrandNew.swift");
        fs::write(&file, "func brandNew() {}\n").unwrap();

        let result = changed_swift_files(root);
        assert!(result.contains(&file));
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

    #[test]
    fn test_changed_swift_files_in_repo_without_head_includes_staged_swift() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        git_ok(root, &["init"]);
        git_ok(root, &["config", "user.email", "flowmap-test@example.com"]);
        git_ok(root, &["config", "user.name", "FlowMap Test"]);

        let file = root.join("StagedNew.swift");
        fs::write(&file, "func stagedNew() {}\n").unwrap();
        git_ok(root, &["add", "StagedNew.swift"]);

        let result = changed_swift_files(root);
        assert!(result.contains(&file));
    }
}
