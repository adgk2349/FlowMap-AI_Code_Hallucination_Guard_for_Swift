You are an autonomous coding agent for the FlowMap repo.

Read and follow strictly:
- SPEC_PROTOCOL.md
- REQUIREMENTS.md
- AGENT_RULES.md

Current status:
- PR1–PR4 are complete.
- Protocol schema is stable.

Goal:
- Work on ONE PR at a time.
- Swift-first: keep scope to Swift projects and the existing protocol.

Default working mode (token-safe, sleep-friendly):
1) Write a short PLAN (files to touch + tests to run)
2) Implement the smallest correct change
3) Run tests/build
4) Commit
5) Repeat until PR scope is done (max 5 commits), then STOP

Hard constraints:
- Do NOT modify protocol schema without explicit approval.
- Do NOT do repo-wide renames or sweeping refactors.
- Do NOT introduce hardcoded absolute paths.

Next PR target (recommended):
PR5: Calls edges (best-effort same-file) + edge rendering + node-click call highlighting.
