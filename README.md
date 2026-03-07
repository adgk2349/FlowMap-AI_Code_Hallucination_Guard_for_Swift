# FlowMap

> Swift code graph and impact analysis tool — understand and verify code structure, especially when reviewing AI-generated changes.

[한국어](README.ko.md) · [日本語](README.ja.md)

## What is FlowMap?

FlowMap parses Swift code, builds a workspace-level graph of files, types, functions, and call relationships, and visualizes that graph inside VS Code.

It answers questions like:

- What actually calls this function?
- What breaks if I change this file?
- Is this AI-generated code structurally sound, or just plausible-looking?
- What is the overall shape of this project?

FlowMap is not a compiler replacement. It makes real code structure visible at the workspace level so you can verify relationships directly rather than inferring them.

## Who it is for

- Developers using AI-assisted coding tools who want to verify what actually changed
- Engineers reviewing unfamiliar Swift codebases
- Anyone who wants a structural view of a Swift project without requiring a full build

## Current features

- Swift AST parsing via SwiftSyntax
- File / type / function graph generation
- Same-file and conservative cross-file call linking
- Graph diff for changed files
- Impact analysis over call edges
- VS Code visualization with three modes:
  - **Overview** — project / folder / file structure
  - **File Detail** — type and function drill-down within a file
  - **Calls** — call-cluster exploration across the workspace
- Auto-analyze on save

## Screenshots

### Overview mode

![Overview mode](docs/screenshots/overview.png)

### File detail mode

![File detail mode](docs/screenshots/file-detail.png)

### Calls mode

![Calls mode](docs/screenshots/calls.png)

## Demo

![FlowMap demo](docs/demo/flowmap-demo.gif)

## Installation

### Prerequisites

- macOS (required for the Swift parser)
- Rust toolchain ([rustup.rs](https://rustup.rs))
- Swift toolchain / Xcode command line tools
- Node.js v20 or later
- VS Code

### Build

**1. Clone the repository**

```bash
git clone https://github.com/adgk2349/FlowMap.git
cd FlowMap
```

**2. Build the Rust engine**

```bash
cargo build
```

**3. Build the Swift parser**

```bash
cd parsers/swift-ast
swift build -c release
cd ../..
```

**4. Compile the VS Code extension**

```bash
cd editor/vscode
npm install
npm run compile
cd ../..
```

### Run in VS Code

1. Open the `editor/vscode` folder in VS Code
2. Press `F5` to launch the Extension Development Host
3. In the new VS Code window, open a Swift workspace
4. Run **FlowMap: Analyze Workspace** from the command palette (`Cmd+Shift+P`)
5. Open the **FlowMap Graph** panel

## Usage

1. Open a Swift workspace in VS Code
2. Run **FlowMap: Analyze Workspace** via the command palette
3. Explore the graph:
   - **Overview** — browse project structure at a glance
   - **File Detail** — click into a file to inspect its types and functions
   - **Calls** — trace call clusters and follow how functions connect
4. Save a file to trigger automatic re-analysis

## Validation

FlowMap includes automated replay validation that replays real Git commit pairs and checks whether graph diff changes are detected in the expected direction.

- Commit replay runner: `scripts/run_commit_replay.mjs`
- Scenario runner (synthetic regression set): `scripts/run_sample_scenarios.mjs`
- Replay summary builder: `scripts/build_replay_summary.mjs`

Example:

```bash
node scripts/run_commit_replay.mjs \
  --repo /path/to/swift-repo \
  --count 100 \
  --report reports/replay-100.json
```

Current bundled validation output:

- `reports/replay-validation-bundle.md`
- `reports/replay-validation-bundle.json`

## License

FlowMap is source-available.

**Swift support**
- Personal and non-commercial use: free
- Commercial, team, or company use: a license is required

**Other languages**
Additional language support may be provided as separate commercial plugins in the future.

For commercial licensing inquiries, contact: adgk2349b@gmail.com

## Roadmap

- Improved Swift call resolution coverage
- Better handling of cross-file calls through extensions and protocols
- Additional language support
- Richer diff and impact visualization
- Improved export and sharing options

## Contributing

Issues and pull requests are welcome.

Good areas to contribute:

- Swift parsing edge cases
- Call resolution improvements
- Graph layout and visualization
- Documentation
- VS Code UX polish

## Status

FlowMap is actively evolving. The current version is a functional early-stage tool, not yet a finished platform. Feedback and contributions are encouraged.
