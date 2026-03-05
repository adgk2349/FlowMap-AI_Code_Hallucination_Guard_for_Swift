import * as vscode from 'vscode';
import { FlowmapClient } from './flowmapClient';
import { GraphView } from './graphView';

let client: FlowmapClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  client = new FlowmapClient();

  // ── Helper: run analyze for the open workspace ──────────────────────────
  async function runAnalyze(
    view: 'all' | 'diff' | 'impact'
  ): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      vscode.window.showErrorMessage('FlowMap: No workspace folder open.');
      return;
    }

    const analysis = await client!.analyze(folder, context.extensionPath);
    if (analysis) {
      GraphView.show(context, analysis, view);
    }
  }

  // ── Commands ────────────────────────────────────────────────────────────
  const analyzeCmd = vscode.commands.registerCommand(
    'flowmap.analyzeWorkspace',
    () => runAnalyze('all')
  );

  const diffCmd = vscode.commands.registerCommand(
    'flowmap.showGraphDiff',
    () => runAnalyze('diff')
  );

  const impactCmd = vscode.commands.registerCommand(
    'flowmap.showImpactAnalysis',
    () => runAnalyze('impact')
  );

  // Register a webview serializer so VS Code can restore panels after restart
  vscode.window.registerWebviewPanelSerializer('flowmapGraph', {
    async deserializeWebviewPanel(
      panel: vscode.WebviewPanel,
      _state: unknown
    ): Promise<void> {
      GraphView.restore(context, panel);
    },
  });

  context.subscriptions.push(analyzeCmd, diffCmd, impactCmd);
}

export function deactivate(): void {
  client?.dispose();
  client = undefined;
}
