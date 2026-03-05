import * as vscode from 'vscode';
import { FlowmapClient } from './flowmapClient';
import { GraphView } from './graphView';

let client: FlowmapClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  client = new FlowmapClient();

  const cmd = vscode.commands.registerCommand(
    'flowmap.analyzeWorkspace',
    async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!folder) {
        vscode.window.showErrorMessage('FlowMap: No workspace folder open.');
        return;
      }

      const graph = await client!.analyze(folder, context.extensionPath);
      if (graph) {
        GraphView.show(context, graph);
      }
    }
  );

  // Register a webview serializer so VS Code can restore panels after restart
  vscode.window.registerWebviewPanelSerializer('flowmapGraph', {
    async deserializeWebviewPanel(
      panel: vscode.WebviewPanel,
      state: unknown
    ): Promise<void> {
      // Restore the panel reference so it can be reused
      GraphView.restore(context, panel);
    },
  });

  context.subscriptions.push(cmd);
}

export function deactivate(): void {
  client?.dispose();
  client = undefined;
}
