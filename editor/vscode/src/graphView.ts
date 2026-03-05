import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FlowGraph } from './flowmapClient';

export class GraphView {
  private static panel: vscode.WebviewPanel | undefined;

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

    GraphView.panel.webview.html = GraphView.buildHtml(
      context,
      GraphView.panel.webview,
      graph
    );
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

    return fs
      .readFileSync(htmlPath, 'utf8')
      .replace('{{CSP_SOURCE}}', webview.cspSource)
      .replace('{{GRAPH_JS_URI}}', jsUri.toString())
      .replace('{{GRAPH_DATA}}', JSON.stringify(graph));
  }
}
