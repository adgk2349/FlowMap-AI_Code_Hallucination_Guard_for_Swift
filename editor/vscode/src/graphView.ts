import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FlowAnalysis, FlowGraph } from './flowmapClient';

/** Panel titles per view mode. */
const VIEW_TITLES: Record<string, string> = {
  all: 'FlowMap Graph',
  diff: 'FlowMap: Graph Diff',
  impact: 'FlowMap: Impact Analysis',
};

export class GraphView {
  private static panel: vscode.WebviewPanel | undefined;

  /**
   * Restore a webview panel that VS Code serialized from a previous session.
   */
  static restore(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel
  ): void {
    GraphView.panel = panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, 'webview')),
      ],
    };
    panel.onDidDispose(
      () => {
        GraphView.panel = undefined;
      },
      null,
      context.subscriptions
    );
    GraphView.registerMessageHandler(context, panel);
    // Show an empty graph until the user runs analyze again
    const emptyAnalysis: FlowAnalysis = {
      graph: { nodes: [], edges: [] },
      diff: {
        added_nodes: [],
        removed_nodes: [],
        changed_nodes: [],
        added_edges: [],
        removed_edges: [],
      },
      impact: [],
    };
    panel.webview.html = GraphView.buildHtml(
      context,
      panel.webview,
      emptyAnalysis,
      'all'
    );
  }

  static show(
    context: vscode.ExtensionContext,
    analysis: FlowAnalysis,
    view: 'all' | 'diff' | 'impact' = 'all'
  ): void {
    const title = VIEW_TITLES[view] ?? 'FlowMap Graph';

    if (GraphView.panel) {
      GraphView.panel.title = title;
      GraphView.panel.reveal();
    } else {
      GraphView.panel = vscode.window.createWebviewPanel(
        'flowmapGraph',
        title,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [
            vscode.Uri.file(path.join(context.extensionPath, 'webview')),
          ],
        }
      );

      GraphView.panel.onDidDispose(
        () => {
          GraphView.panel = undefined;
        },
        null,
        context.subscriptions
      );

      GraphView.registerMessageHandler(context, GraphView.panel);
    }

    GraphView.panel.webview.html = GraphView.buildHtml(
      context,
      GraphView.panel.webview,
      analysis,
      view
    );
  }

  /**
   * Register the webview → extension message handler.
   * Handles { command: 'openFile', uri: string, line: number }.
   */
  private static registerMessageHandler(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel
  ): void {
    panel.webview.onDidReceiveMessage(
      async (message: { command: string; uri: string; line: number }) => {
        if (message.command === 'openFile' && message.uri) {
          try {
            const doc = await vscode.workspace.openTextDocument(
              vscode.Uri.parse(message.uri)
            );
            // Convert 1-based line from AST to 0-based VS Code range
            const line = Math.max(0, (message.line ?? 1) - 1);
            const range = new vscode.Range(line, 0, line, 0);
            await vscode.window.showTextDocument(doc, {
              viewColumn: vscode.ViewColumn.Beside,
              selection: range,
            });
          } catch (err) {
            vscode.window.showErrorMessage(
              `FlowMap: Cannot open file — ${(err as Error).message}`
            );
          }
        }
      },
      null,
      context.subscriptions
    );
  }

  private static buildHtml(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    analysis: FlowAnalysis,
    view: string
  ): string {
    const htmlPath = path.join(context.extensionPath, 'webview', 'graph.html');
    const jsUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(context.extensionPath, 'webview', 'graph.js'))
    );

    // Sanitize to prevent XSS via </script> injection
    const safeJson = JSON.stringify({ ...analysis, view })
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e');

    return fs
      .readFileSync(htmlPath, 'utf8')
      .replace('{{CSP_SOURCE}}', webview.cspSource)
      .replace('{{GRAPH_JS_URI}}', jsUri.toString())
      .replace('{{GRAPH_DATA}}', safeJson);
  }
}

// Keep FlowGraph importable from graphView for restore compatibility
export type { FlowGraph };
