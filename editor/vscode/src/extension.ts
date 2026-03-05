import * as vscode from 'vscode';
import { FlowmapClient } from './flowmapClient';
import { GraphView } from './graphView';

let client: FlowmapClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  client = new FlowmapClient();

  // ── Concurrency guard for auto-analyze ──────────────────────────────────
  let analyzeRunning = false;
  let analyzePending = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

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
    // flowmapClient already shows error toasts on failure; nothing more needed
  }

  // ── Auto-analyze: debounced + single pending re-run ─────────────────────
  async function runAutoAnalyze(): Promise<void> {
    if (analyzeRunning) {
      // Another run is in progress — queue exactly one re-run for after it
      analyzePending = true;
      return;
    }

    analyzeRunning = true;
    analyzePending = false;

    try {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!folder) {
        return;
      }
      const analysis = await client!.analyze(folder, context.extensionPath);
      if (analysis) {
        // Silently update the panel without stealing focus
        GraphView.update(context, analysis);
      }
      // On failure flowmapClient already showed a toast; panel keeps last render
    } catch (err) {
      vscode.window.showErrorMessage(
        `FlowMap: Unexpected analysis error — ${(err as Error).message}`
      );
    } finally {
      analyzeRunning = false;
      if (analyzePending) {
        analyzePending = false;
        void runAutoAnalyze();
      }
    }
  }

  function scheduleAutoAnalyze(): void {
    const cfg = vscode.workspace.getConfiguration('flowmap');
    if (!cfg.get<boolean>('autoAnalyzeOnSave', true)) {
      return;
    }
    const debounceMs = cfg.get<number>('autoAnalyzeDebounceMs', 500);

    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      void runAutoAnalyze();
    }, debounceMs);
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

  const toggleCmd = vscode.commands.registerCommand(
    'flowmap.toggleAutoAnalyzeOnSave',
    async () => {
      const cfg = vscode.workspace.getConfiguration('flowmap');
      const current = cfg.get<boolean>('autoAnalyzeOnSave', true);
      await cfg.update(
        'autoAnalyzeOnSave',
        !current,
        vscode.ConfigurationTarget.Global
      );
      vscode.window.showInformationMessage(
        `FlowMap: Auto analyze on save ${!current ? 'enabled' : 'disabled'}.`
      );
    }
  );

  // ── Save listener: trigger auto-analyze on Swift file saves ─────────────
  const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
    const isSwift =
      doc.languageId === 'swift' || doc.fileName.endsWith('.swift');
    if (isSwift) {
      scheduleAutoAnalyze();
    }
  });

  // Register a webview serializer so VS Code can restore panels after restart
  vscode.window.registerWebviewPanelSerializer('flowmapGraph', {
    async deserializeWebviewPanel(
      panel: vscode.WebviewPanel,
      _state: unknown
    ): Promise<void> {
      GraphView.restore(context, panel);
    },
  });

  // Clean up the debounce timer on deactivation
  const timerDisposable: vscode.Disposable = {
    dispose() {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
      }
    },
  };

  context.subscriptions.push(
    analyzeCmd,
    diffCmd,
    impactCmd,
    toggleCmd,
    saveListener,
    timerDisposable
  );
}

export function deactivate(): void {
  client?.dispose();
  client = undefined;
}
