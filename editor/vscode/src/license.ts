/**
 * license.ts — local-only licensing scaffolding for FlowMap.
 *
 * This is intentionally dev-simple and NOT cryptographically secure.
 * It exists to wire up the UI and gating helpers before a real licensing
 * backend is introduced.
 *
 * Validation model:
 *   A key is considered Pro if it matches the configured dev key, which is
 *   resolved (in priority order) from:
 *     1. env var  FLOWMAP_DEV_LICENSE_KEY
 *     2. VS Code setting  flowmap.devLicenseKey  (default: "")
 *   If no dev key is configured the validator always returns "free".
 *
 * Storage:
 *   - License key         → SecretStorage  (context.secrets)
 *   - Cached LicenseState → globalState    (context.globalState)
 */

import * as vscode from 'vscode';

// ── Types ─────────────────────────────────────────────────────────────────────

export type LicenseStatus = 'free' | 'pro';
export type LicenseSource = 'none' | 'localKey';

export interface LicenseState {
  status: LicenseStatus;
  /** Where the active Pro entitlement came from. */
  source: LicenseSource;
  /** ISO-8601 timestamp of the last recompute. */
  lastUpdated: string;
}

// ── Storage keys ──────────────────────────────────────────────────────────────

const SECRET_KEY = 'flowmap.licenseKey';
const GLOBAL_STATE_KEY = 'flowmap.licenseState';

// ── Dev key resolution ────────────────────────────────────────────────────────

/**
 * Returns true if a dev key is currently configured (env var or VS Code
 * setting).  Does NOT reveal the key itself.
 */
export function isDevKeyConfigured(): boolean {
  return resolveDevKey().length > 0;
}

/** Env var takes priority over the VS Code setting. */
function resolveDevKey(): string {
  const env = (process.env['FLOWMAP_DEV_LICENSE_KEY'] ?? '').trim();
  if (env.length > 0) {
    return env;
  }
  const cfg = vscode.workspace.getConfiguration('flowmap');
  return cfg.get<string>('devLicenseKey', '').trim();
}

// ── Key validation (local-only) ───────────────────────────────────────────────

function validateKey(key: string): LicenseStatus {
  const devKey = resolveDevKey();
  if (!devKey) {
    // No dev key configured — Pro can never be enabled in this session.
    return 'free';
  }
  return key === devKey ? 'pro' : 'free';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return the cached LicenseState, computing it from SecretStorage on first
 * call (or when the cache is missing).
 */
export async function getLicenseState(
  context: vscode.ExtensionContext
): Promise<LicenseState> {
  const cached = context.globalState.get<LicenseState>(GLOBAL_STATE_KEY);
  if (cached) {
    return cached;
  }
  return recomputeLicenseState(context);
}

/**
 * Store a new license key and recompute the license state.
 * Returns the new state so the caller can refresh the UI immediately.
 */
export async function setLicenseKey(
  context: vscode.ExtensionContext,
  key: string
): Promise<LicenseState> {
  await context.secrets.store(SECRET_KEY, key);
  return recomputeLicenseState(context);
}

/**
 * Remove the stored license key and recompute state (back to Free).
 * Returns the new state so the caller can refresh the UI immediately.
 */
export async function clearLicenseKey(
  context: vscode.ExtensionContext
): Promise<LicenseState> {
  await context.secrets.delete(SECRET_KEY);
  return recomputeLicenseState(context);
}

/**
 * Read the stored key from SecretStorage, validate it, persist the result in
 * globalState, and return it.  Call whenever the dev key setting changes or
 * the extension starts.
 */
export async function recomputeLicenseState(
  context: vscode.ExtensionContext
): Promise<LicenseState> {
  const stored = await context.secrets.get(SECRET_KEY);

  let status: LicenseStatus = 'free';
  let source: LicenseSource = 'none';

  if (stored && stored.length > 0) {
    const validated = validateKey(stored);
    if (validated === 'pro') {
      status = 'pro';
      source = 'localKey';
    }
  }

  const state: LicenseState = {
    status,
    source,
    lastUpdated: new Date().toISOString(),
  };

  await context.globalState.update(GLOBAL_STATE_KEY, state);
  return state;
}

/** Convenience wrapper: returns true when the current state is Pro. */
export async function isProEnabled(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const state = await getLicenseState(context);
  return state.status === 'pro';
}
