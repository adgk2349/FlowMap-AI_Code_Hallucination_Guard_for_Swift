import * as vscode from 'vscode';
import { FlowmapClient } from './flowmapClient';
import { GraphView } from './graphView';

export function activate(context: vscode.ExtensionContext): void {
  const cmd = vscode.commands.registerCommand(
    'flowmap.analyzeWorkspace',
    async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!folder) {
        vscode.window.showErrorMessage('FlowMap: No workspace folder open.');
        return;
      }

      const client = new FlowmapClient();
      const graph = await client.analyze(folder);
      if (graph) {
        GraphView.show(context, graph);
      }
    }
  );

  context.subscriptions.push(cmd);
}

export function deactivate(): void {}
