# FlowMap Hallucination Guard for Swift (Public Beta)

FlowMap Hallucination Guard for Swift helps you catch risky AI-generated Swift changes by showing what actually changed in the code graph.

It turns Swift files, types, functions, and calls into a visual graph, then highlights added, removed, changed, and impacted relationships so you can verify AI output before trusting it.

- GitHub repository: https://github.com/adgk2349/FlowMap-AI_Code_Hallucination_Guard_for_Swift
- Issues / bug reports: https://github.com/adgk2349/FlowMap-AI_Code_Hallucination_Guard_for_Swift/issues

## What it does

- Parses Swift code into a structural graph (file/type/function/call)
- Visualizes project structure inside VS Code
- Highlights added, removed, and changed graph elements
- Shows impact based on call edges
- Re-analyzes automatically on save
- Helps catch structural hallucinations in AI-generated Swift edits

## Requirements

- macOS (currently required for the Swift parser path/toolchain assumptions)
- A built `flowmap` engine binary

## Quick Start

1. Install the extension.
2. Set `flowmap.binaryPath` to your built engine binary path.
3. Open a Swift workspace.
4. Run `FlowMap: Analyze Workspace`.
5. Open the `FlowMap Graph` panel.

## Public Beta Notice

This extension is in public beta.
Behavior around advanced cross-file call resolution (protocols/extensions/generics) is conservative by design and will be improved incrementally.

FlowMap is not a compiler or type checker. It is a graph-based review aid for spotting suspicious structural changes faster.
