import * as vscode from 'vscode';
import { FlowmapClient } from './flowmapClient';
import { GraphView } from './graphView';
import {
  clearLicenseKey,
  isDevKeyConfigured,
  isProEnabled,
  LicenseState,
  recomputeLicenseState,
  setLicenseKey,
} from './license';

let client: FlowmapClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  client = new FlowmapClient();

  // ── Concurrency guard for auto-analyze ──────────────────────────────────
  let analyzeRunning = false;
  let analyzePending = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  // ── Status bar (license indicator) ─────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.command = 'flowmap.showLicenseStatus';
  statusBar.show();
  context.subscriptions.push(statusBar);

  function applyLicenseToUI(state: LicenseState): void {
    statusBar.text =
      state.status === 'pro' ? '★ FlowMap Pro' : 'FlowMap Free';
    statusBar.tooltip =
      `FlowMap license: ${state.status} (source: ${state.source})`;
    GraphView.sendLicenseStatus(state.status);
  }

  // Initialize license state and status bar on activation
  void recomputeLicenseState(context).then(applyLicenseToUI);

  // ── Helper: run analyze for the open workspace ──────────────────────────
  async function runAnalyze(
    view: 'all' | 'diff' | 'impact'
  ): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      vscode.window.showErrorMessage('FlowMap: No workspace folder open.');
      return;
    }

    const licState = await recomputeLicenseState(context);
    const analysis = await client!.analyze(folder, context.extensionPath);
    if (analysis) {
      GraphView.show(context, analysis, view, licState.status);
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
      const licState = await recomputeLicenseState(context);
      const analysis = await client!.analyze(folder, context.extensionPath);
      if (analysis) {
        // Silently update the panel without stealing focus
        GraphView.update(context, analysis, licState.status);
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

  // ── Graph commands ───────────────────────────────────────────────────────
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

  // ── License commands ─────────────────────────────────────────────────────

  /** Enter License Key — prompts for key in password mode, stores in SecretStorage. */
  const enterKeyCmd = vscode.commands.registerCommand(
    'flowmap.enterLicenseKey',
    async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your FlowMap license key',
        placeHolder: 'FLOWMAP-XXXX-XXXX-XXXX',
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) {
        return; // user cancelled
      }
      const state = await setLicenseKey(context, key.trim());
      applyLicenseToUI(state);
      vscode.window.showInformationMessage(
        state.status === 'pro'
          ? 'FlowMap: Pro activated successfully.'
          : 'FlowMap: Key not recognized — remaining on Free tier.'
      );
    }
  );

  /** Deactivate License — removes stored key, reverts to Free. */
  const deactivateCmd = vscode.commands.registerCommand(
    'flowmap.deactivateLicense',
    async () => {
      const state = await clearLicenseKey(context);
      applyLicenseToUI(state);
      vscode.window.showInformationMessage(
        'FlowMap: License deactivated. Running as Free.'
      );
    }
  );

  /** Show License Status — information toast with current tier. */
  const showStatusCmd = vscode.commands.registerCommand(
    'flowmap.showLicenseStatus',
    async () => {
      const state = await recomputeLicenseState(context);
      applyLicenseToUI(state);
      const tier = state.status === 'pro' ? 'Pro' : 'Free';
      vscode.window.showInformationMessage(
        `FlowMap ${tier} (source: ${state.source})`
      );
    }
  );

  /**
   * Copy License Debug Info — copies status metadata to clipboard.
   * Never copies the stored key itself.
   */
  const copyDebugCmd = vscode.commands.registerCommand(
    'flowmap.copyLicenseDebugInfo',
    async () => {
      const state = await recomputeLicenseState(context);
      const info = [
        'FlowMap License Debug Info',
        `status:           ${state.status}`,
        `source:           ${state.source}`,
        `lastUpdated:      ${state.lastUpdated}`,
        `devKeyConfigured: ${isDevKeyConfigured()}`,
      ].join('\n');
      await vscode.env.clipboard.writeText(info);
      vscode.window.showInformationMessage(
        'FlowMap: License debug info copied to clipboard (key not included).'
      );
    }
  );

  /**
   * Pro Feature Preview — placeholder gated command.
   * Free users see a prompt to enter a key; Pro users see confirmation.
   */
  const proPreviewCmd = vscode.commands.registerCommand(
    'flowmap.proFeaturePreview',
    async () => {
      const isPro = await isProEnabled(context);
      if (isPro) {
        vscode.window.showInformationMessage('FlowMap: Pro is enabled.');
      } else {
        const choice = await vscode.window.showInformationMessage(
          'FlowMap: This is a Pro feature. Upgrade to unlock it.',
          'Enter License Key'
        );
        if (choice === 'Enter License Key') {
          await vscode.commands.executeCommand('flowmap.enterLicenseKey');
        }
      }
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
      panel: vscode.WebviewPanel
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
    enterKeyCmd,
    deactivateCmd,
    showStatusCmd,
    copyDebugCmd,
    proPreviewCmd,
    saveListener,
    timerDisposable
  );
}

export function deactivate(): void {
  client?.dispose();
  client = undefined;
}
