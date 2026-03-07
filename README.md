# FlowMap

> AST-based code structure and call-graph explorer for Swift, designed to help developers verify and understand real code paths — especially in AI-assisted workflows.

[한국어](README.ko.md) · [日本語](README.ja.md)

## What is FlowMap?

FlowMap is a developer tool that parses Swift code, builds a graph of files, types, functions, and calls, and visualizes that graph inside VS Code.

It is built for moments when you want to answer questions like:

- What actually calls this function?
- What changes if I modify this file?
- Did this AI-generated edit introduce a fake or broken dependency?
- How is this project structured at a glance?

FlowMap is not a compiler replacement. It is a practical, workspace-level analysis and visualization tool focused on readability, cautious call linking, and impact analysis.

## Current capabilities

- Swift AST parsing with SwiftSyntax
- File / type / function graph generation
- Same-file and conservative cross-file call linking
- Graph diff for changed code
- Impact analysis over call edges
- VS Code visualization with three modes:
  - **Overview** — project / folder / file structure
  - **File Detail** — file-local type / function drill-down
  - **Calls** — call-cluster exploration
- Auto-analyze on save
- Basic source-available licensing scaffold

## Why it exists

LLM-generated code often looks plausible before it is structurally correct.

FlowMap was created to make code structure visible, so developers can inspect actual relationships instead of trusting surface-level code that merely looks right.

## Screenshots

Add your screenshots here after making the repository public.

### Overview mode

![Overview mode](docs/screenshots/overview.png)

### File detail mode

![File detail mode](docs/screenshots/file-detail.png)

### Calls mode

![Calls mode](docs/screenshots/calls.png)

## Demo GIF

Add a short demo GIF here.

![FlowMap demo](docs/demo/flowmap-demo.gif)

Suggested demo sequence:

1. Open a Swift workspace
2. Run **FlowMap: Analyze Workspace**
3. Show Overview mode
4. Click into File Detail
5. Open Calls mode
6. Edit a file and show changed / impact state

## How it works

FlowMap is split into three main layers:

- **Swift parser**: extracts declarations and call-site information
- **Rust engine**: builds graphs, resolves conservative cross-file calls, computes diffs and impact
- **VS Code extension**: renders Overview / Detail / Calls modes and updates on analysis

## Supported call resolution in the current version

FlowMap currently performs conservative workspace-wide Swift call linking for:

- `foo()`
- `TypeName.method()`
- `self.method()`

Ambiguous matches are intentionally skipped instead of guessed.

## Installation

### Prerequisites

- macOS recommended for the current Swift parser workflow
- Rust toolchain
- Swift toolchain / Xcode command line tools
- Node.js
- VS Code

### Build

From the repository root:

```bash
cargo build
```

From the VS Code extension directory:

```bash
npm install
npm run compile
```

### Run in VS Code

1. Open the VS Code extension folder in VS Code
2. Press `F5` to launch the Extension Development Host
3. In the new VS Code window, open a Swift workspace
4. Run **FlowMap: Analyze Workspace**
5. Open **FlowMap Graph**

## Roadmap

- Better Swift resolution coverage
- Cross-file resolution improvements for extensions and more edge cases
- Additional language support as plugins
- Better export / sharing options
- Richer diff and impact views

## Licensing

FlowMap currently follows a source-available model.

### Swift support

- Personal / non-commercial use: free
- Commercial / team / company use: license required

### Other languages

Planned additional language support may be released as separate commercial plugins.

If you plan to use FlowMap commercially, add your contact details here.

## Contributing

Issues and pull requests are welcome.

Good contribution areas:

- Swift parsing edge cases
- Call resolution improvements
- Graph layout / visualization improvements
- Documentation
- VS Code UX polish

## Status

FlowMap is actively evolving. The current public version should be treated as an ambitious early tool rather than a finished platform.

## Repository assets to add

After making the repo public, add these files:

- `docs/screenshots/overview.png`
- `docs/screenshots/file-detail.png`
- `docs/screenshots/calls.png`
- `docs/demo/flowmap-demo.gif`

