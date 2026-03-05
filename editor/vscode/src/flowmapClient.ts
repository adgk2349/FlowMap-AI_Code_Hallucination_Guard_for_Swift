import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as crypto from 'crypto';

export interface FlowNode {
  id: string;
  kind?: string;
  name?: string;
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

export class FlowmapClient {
  private readonly configuredBinary: string;

  constructor() {
    const config = vscode.workspace.getConfiguration('flowmap');
    // Empty string means "resolve from workspace root at call time"
    this.configuredBinary = config.get<string>('binaryPath', '');
  }

  analyze(workspacePath: string): Promise<FlowGraph | undefined> {
    // Prefer the explicit setting; fall back to the build artefact inside
    // the open workspace so no absolute paths are ever hardcoded.
    const binary =
      this.configuredBinary ||
      path.join(workspacePath, 'target', 'debug', 'flowmap');

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

      let stdout = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        console.error('[flowmap]', chunk.toString());
      });

      proc.on('error', (err: Error) => {
        vscode.window.showErrorMessage(
          `FlowMap: Failed to start engine — ${err.message}`
        );
        resolve(undefined);
      });

      proc.on('close', () => {
        try {
          const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
          const resp = JSON.parse(lines[lines.length - 1]) as {
            ok: boolean;
            payload?: { graph?: FlowGraph };
            error?: { message?: string };
          };
          if (resp.ok && resp.payload?.graph) {
            resolve(resp.payload.graph);
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

      proc.stdin?.write(request);
      proc.stdin?.end();
    });
  }
}
