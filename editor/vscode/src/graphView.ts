import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FlowAnalysis } from './flowmapClient';
import { LicenseStatus } from './license';

/** Panel titles per view mode. */
const VIEW_TITLES: Record<string, string> = {
  all: 'FlowMap Graph',
  diff: 'FlowMap: Graph Diff',
  impact: 'FlowMap: Impact Analysis',
};

export class GraphView {
  private static panel: vscode.WebviewPanel | undefined;
  /** Tracks the view mode so auto-analyze updates preserve the active mode. */
  private static lastViewMode: 'all' | 'diff' | 'impact' = 'all';
  /** Cached analysis from the last show()/update() call. Sent to the webview on restore via the handshake. */
  private static lastAnalysis: FlowAnalysis | undefined;
  /** Cached license status matching lastAnalysis. */
  private static lastLicenseStatus: LicenseStatus = 'free';

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
        vscode.Uri.file(path.join(context.extensionPath, 'node_modules')),
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
    // Show an empty graph initially; the webview will request the cached
    // analysis via the flowmap.requestAnalysisState handshake.
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
    view: 'all' | 'diff' | 'impact' = 'all',
    licenseStatus: LicenseStatus = 'free'
  ): void {
    GraphView.lastViewMode = view;
    GraphView.lastAnalysis = analysis;
    GraphView.lastLicenseStatus = licenseStatus;
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
            vscode.Uri.file(path.join(context.extensionPath, 'node_modules')),
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
      view,
      licenseStatus
    );
  }

  /**
   * Silently refresh the webview content without revealing the panel.
   *
   * Used by auto-analyze on save so the graph updates in the background
   * without stealing editor focus.  No-op if no panel is currently open.
   */
  static update(
    context: vscode.ExtensionContext,
    analysis: FlowAnalysis,
    licenseStatus: LicenseStatus = 'free'
  ): void {
    if (!GraphView.panel) {
      return;
    }
    GraphView.lastAnalysis = analysis;
    GraphView.lastLicenseStatus = licenseStatus;
    GraphView.panel.webview.html = GraphView.buildHtml(
      context,
      GraphView.panel.webview,
      analysis,
      GraphView.lastViewMode,
      licenseStatus
    );
  }

  /**
   * Push a license status update to the open panel via postMessage.
   *
   * Called after a license command (enter/deactivate) so the webview badge
   * reflects the new state without requiring a full re-analyze.
   * No-op if no panel is open.
   */
  static sendLicenseStatus(status: LicenseStatus): void {
    if (!GraphView.panel) {
      return;
    }
    void GraphView.panel.webview.postMessage({
      command: 'updateLicenseStatus',
      status,
    });
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
      async (message: { command: string; uri?: string; line?: number }) => {
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

        // ── Analysis handshake ────────────────────────────────────────────
        // Webview sends this on load when its embedded payload is empty
        // (e.g. after a panel restore). We respond with the cached analysis
        // so the graph can be rendered without a full HTML rebuild.
        if (message.command === 'flowmap.requestAnalysisState') {
          if (GraphView.lastAnalysis) {
            // Merge view + licenseStatus into the payload, matching the
            // shape that buildHtml() embeds in {{GRAPH_DATA}}.
            const payload = {
              ...GraphView.lastAnalysis,
              view: GraphView.lastViewMode,
              licenseStatus: GraphView.lastLicenseStatus,
            };
            void panel.webview.postMessage({
              command: 'flowmap.analysisState',
              analysis: payload,
            });
          } else {
            // No cached analysis yet — webview will show the analyze prompt.
            void panel.webview.postMessage({
              command: 'flowmap.analysisState',
              analysis: null,
            });
          }
        }

        // ── Analyze-button trigger ────────────────────────────────────────
        // Webview's empty-state "Analyze Workspace" button fires this.
        if (message.command === 'flowmap.runAnalyze') {
          void vscode.commands.executeCommand('flowmap.analyzeWorkspace');
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
    view: string,
    licenseStatus: LicenseStatus = 'free'
  ): string {
    const htmlPath = path.join(context.extensionPath, 'webview', 'graph.html');
    const jsUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(context.extensionPath, 'webview', 'graph.js'))
    );

    const cyUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(context.extensionPath, 'node_modules', 'cytoscape', 'dist', 'cytoscape.min.js'))
    );

    // Sanitize to prevent XSS via </script> injection
    const safeJson = JSON.stringify({ ...analysis, view, licenseStatus })
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e');

    return fs
      .readFileSync(htmlPath, 'utf8')
      .replace('{{CSP_SOURCE}}', webview.cspSource)
      .replace('{{GRAPH_JS_URI}}', jsUri.toString())
      .replace('{{CY_JS_URI}}', cyUri.toString())
      .replace('{{GRAPH_DATA}}', safeJson);
  }
}
