import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FlowGraph } from './flowmapClient';

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
    // Show an empty graph until the user runs analyze again
    const emptyGraph: FlowGraph = { nodes: [], edges: [] };
    panel.webview.html = GraphView.buildHtml(context, panel.webview, emptyGraph);
  }

  static show(context: vscode.ExtensionContext, graph: FlowGraph): void {
    if (GraphView.panel) {
      GraphView.panel.reveal();
    } else {
      GraphView.panel = vscode.window.createWebviewPanel(
        'flowmapGraph',
        'FlowMap Graph',
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
    }

    const html = GraphView.buildHtml(context, GraphView.panel.webview, graph);
    GraphView.panel.webview.html = html;
  }

  private static buildHtml(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    graph: FlowGraph
  ): string {
    const htmlPath = path.join(context.extensionPath, 'webview', 'graph.html');
    const jsUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(context.extensionPath, 'webview', 'graph.js'))
    );

    // Sanitize graph data to prevent XSS via </script> injection
    const safeJson = JSON.stringify(graph)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e');

    return fs
      .readFileSync(htmlPath, 'utf8')
      .replace('{{CSP_SOURCE}}', webview.cspSource)
      .replace('{{GRAPH_JS_URI}}', jsUri.toString())
      .replace('{{GRAPH_DATA}}', safeJson);
  }
}
