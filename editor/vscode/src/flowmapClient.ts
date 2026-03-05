import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as crypto from 'crypto';

export interface FlowNode {
  id: string;
  kind?: string;
  name?: string;
  uri?: string;
  line?: number;
}

export interface FlowEdge {
  id: string;
  kind?: string;
  from: string;
  to: string;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/** Graph diff returned by the engine's analyze command. */
export interface FlowDiff {
  /** Nodes present in current tree but absent in HEAD. */
  added_nodes: FlowNode[];
  /** Nodes present in HEAD but absent in current tree. */
  removed_nodes: FlowNode[];
  /** Nodes present in both whose metadata (name/kind/uri/line) changed. */
  changed_nodes: FlowNode[];
  /** Edges present in current tree but absent in HEAD. */
  added_edges: FlowEdge[];
  /** Edges present in HEAD but absent in current tree. */
  removed_edges: FlowEdge[];
}

/** Full analysis result returned by FlowmapClient.analyze(). */
export interface FlowAnalysis {
  graph: FlowGraph;
  diff: FlowDiff;
  /** Node IDs downstream of any changed/added/removed node. */
  impact: string[];
}

const EMPTY_DIFF: FlowDiff = {
  added_nodes: [],
  removed_nodes: [],
  changed_nodes: [],
  added_edges: [],
  removed_edges: [],
};

/** Timeout in milliseconds for engine responses. */
const ENGINE_TIMEOUT_MS = 15_000;

export class FlowmapClient {
  private readonly configuredBinary: string;
  private activeProc: ChildProcess | undefined;

  constructor() {
    const config = vscode.workspace.getConfiguration('flowmap');
    // Empty string means "resolve from workspace root at call time"
    this.configuredBinary = config.get<string>('binaryPath', '');
  }

  analyze(
    workspacePath: string,
    extensionPath: string
  ): Promise<FlowAnalysis | undefined> {
    // Priority: explicit setting > extension-relative path (works in any project)
    const binary =
      this.configuredBinary ||
      path.join(extensionPath, '..', '..', 'target', 'debug', 'flowmap');

    return new Promise((resolve) => {
      const request =
        JSON.stringify({
          protocolVersion: '0.1',
          requestId: crypto.randomUUID(),
          cmd: 'analyze',
          payload: { path: workspacePath },
        }) + '\n';

      const proc = spawn(binary, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.activeProc = proc;

      let stdout = '';
      let settled = false;

      // --- Timeout guard ---
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill('SIGTERM');
          vscode.window.showErrorMessage(
            `FlowMap: Engine timed out after ${ENGINE_TIMEOUT_MS / 1000}s.`
          );
          resolve(undefined);
        }
      }, ENGINE_TIMEOUT_MS);

      // --- Pipe error handlers (prevents uncaught SIGPIPE) ---
      proc.stdin?.on('error', (err: Error) => {
        console.warn('[flowmap] stdin error (ignored):', err.message);
      });

      proc.stdout?.on('error', (err: Error) => {
        console.warn('[flowmap] stdout error (ignored):', err.message);
      });

      proc.stderr?.on('error', (err: Error) => {
        console.warn('[flowmap] stderr error (ignored):', err.message);
      });

      // --- Data collection ---
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        console.error('[flowmap]', chunk.toString());
      });

      // --- Spawn failure ---
      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          vscode.window.showErrorMessage(
            `FlowMap: Failed to start engine — ${err.message}`
          );
          resolve(undefined);
        }
      });

      // --- Process exit ---
      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        this.activeProc = undefined;

        if (settled) {
          return;
        }
        settled = true;

        if (code !== 0 && code !== null) {
          vscode.window.showErrorMessage(
            `FlowMap: Engine exited with code ${code}.`
          );
          resolve(undefined);
          return;
        }

        try {
          const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
          if (lines.length === 0) {
            vscode.window.showErrorMessage(
              'FlowMap: Engine returned empty response.'
            );
            resolve(undefined);
            return;
          }
          const resp = JSON.parse(lines[lines.length - 1]) as {
            ok: boolean;
            payload?: {
              graph?: FlowGraph;
              diff?: FlowDiff;
              impact?: string[];
            };
            error?: { message?: string };
          };
          if (resp.ok && resp.payload?.graph) {
            resolve({
              graph: resp.payload.graph,
              diff: resp.payload.diff ?? EMPTY_DIFF,
              impact: resp.payload.impact ?? [],
            });
          } else {
            vscode.window.showErrorMessage(
              `FlowMap: Engine error — ${resp.error?.message ?? 'unknown'}`
            );
            resolve(undefined);
          }
        } catch {
          vscode.window.showErrorMessage(
            'FlowMap: Failed to parse engine response.'
          );
          resolve(undefined);
        }
      });

      // --- Send request (write callback ensures ordering) ---
      proc.stdin?.write(request, () => {
        proc.stdin?.end();
      });
    });
  }

  /**
   * Kill the active engine process, if any.
   * Called from extension deactivate().
   */
  dispose(): void {
    if (this.activeProc) {
      this.activeProc.kill('SIGTERM');
      this.activeProc = undefined;
    }
  }
}
