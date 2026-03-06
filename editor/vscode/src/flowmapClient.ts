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
  private stdoutBuffer: string = '';
  private pendingRequests = new Map<string, (result: FlowAnalysis | undefined) => void>();

  constructor() {
    const config = vscode.workspace.getConfiguration('flowmap');
    // Empty string means "resolve from workspace root at call time"
    this.configuredBinary = config.get<string>('binaryPath', '');
  }

  private getOrSpawnProcess(extensionPath: string): ChildProcess {
    if (this.activeProc && !this.activeProc.killed) {
      return this.activeProc;
    }

    const binary =
      this.configuredBinary ||
      path.join(extensionPath, '..', '..', 'target', 'debug', 'flowmap');

    this.activeProc = spawn(binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.stdoutBuffer = '';

    // --- Error handlers ---
    this.activeProc.stdin?.on('error', (err: Error) => {
      console.warn('[flowmap] stdin error (ignored):', err.message);
    });

    this.activeProc.stdout?.on('error', (err: Error) => {
      console.warn('[flowmap] stdout error (ignored):', err.message);
    });

    this.activeProc.stderr?.on('error', (err: Error) => {
      console.warn('[flowmap] stderr error (ignored):', err.message);
    });

    this.activeProc.on('error', (err: Error) => {
      vscode.window.showErrorMessage(`FlowMap: Engine process error — ${err.message}`);
      this.rejectAllPending();
      this.activeProc = undefined;
    });

    this.activeProc.on('close', (code: number | null) => {
      if (code !== 0 && code !== null) {
        vscode.window.showErrorMessage(`FlowMap: Engine exited with code ${code}.`);
      }
      this.rejectAllPending();
      this.activeProc = undefined;
    });

    // --- Data collection ---
    this.activeProc.stdout?.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString();
      this.processBuffer();
    });

    this.activeProc.stderr?.on('data', (chunk: Buffer) => {
      console.error('[flowmap]', chunk.toString());
    });

    return this.activeProc;
  }

  private rejectAllPending() {
    for (const resolve of this.pendingRequests.values()) {
      resolve(undefined);
    }
    this.pendingRequests.clear();
  }

  private processBuffer() {
    let newlineIndex: number;
    while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (line.length === 0) { continue; }

      try {
        const resp = JSON.parse(line) as {
          requestId?: string;
          ok: boolean;
          payload?: {
            graph?: FlowGraph;
            diff?: FlowDiff;
            impact?: string[];
          };
          error?: { message?: string };
        };

        if (resp.requestId) {
          const resolve = this.pendingRequests.get(resp.requestId);
          if (resolve) {
            this.pendingRequests.delete(resp.requestId);
            if (resp.ok && resp.payload?.graph) {
              resolve({
                graph: resp.payload.graph,
                diff: resp.payload.diff ?? EMPTY_DIFF,
                impact: resp.payload.impact ?? [],
              });
            } else {
              vscode.window.showErrorMessage(`FlowMap: Engine error — ${resp.error?.message ?? 'unknown'}`);
              resolve(undefined);
            }
          }
        }
      } catch {
        console.error('[flowmap] Failed to parse engine response:', line);
      }
    }
  }

  analyze(
    workspacePath: string,
    extensionPath: string
  ): Promise<FlowAnalysis | undefined> {
    return new Promise((resolve) => {
      const proc = this.getOrSpawnProcess(extensionPath);
      const reqId = crypto.randomUUID();
      this.pendingRequests.set(reqId, resolve);

      const request =
        JSON.stringify({
          protocolVersion: '0.1',
          requestId: reqId,
          cmd: 'analyze',
          payload: { path: workspacePath },
        }) + '\n';

      proc.stdin?.write(request);

      // --- Timeout guard ---
      setTimeout(() => {
        if (this.pendingRequests.has(reqId)) {
          this.pendingRequests.delete(reqId);
          vscode.window.showErrorMessage(
            `FlowMap: Engine timed out after ${ENGINE_TIMEOUT_MS / 1000}s.`
          );
          resolve(undefined);
        }
      }, ENGINE_TIMEOUT_MS);
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
    this.rejectAllPending();
  }
}
