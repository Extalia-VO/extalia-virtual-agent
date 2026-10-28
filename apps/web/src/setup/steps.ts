import type { RuntimeId, Workspace } from '@extalia/core';
import type { ConnectionView, HostState } from '@extalia/platform';

/**
 * First-run setup flow as pure data, so the step order, prefill and the rules
 * for moving on can be unit tested without rendering the wizard.
 *
 * `connection` and an optional `workspace` write host configuration;
 * `welcome`, `profile` and `agentApps` are cosmetic or informational and can
 * never complete setup on their own. Completion happens on `done` through
 * `completeSetup()`, and only when `canFinish` holds (or via observe mode).
 */
export const SETUP_STEPS = ['welcome', 'profile', 'connection', 'workspace', 'agentApps', 'done'] as const;
export type SetupStepId = typeof SETUP_STEPS[number];

export const stepIndex = (step: SetupStepId): number => SETUP_STEPS.indexOf(step);
export const nextStep = (step: SetupStepId): SetupStepId => SETUP_STEPS[Math.min(stepIndex(step) + 1, SETUP_STEPS.length - 1)]!;
export const previousStep = (step: SetupStepId): SetupStepId => SETUP_STEPS[Math.max(stepIndex(step) - 1, 0)]!;

/** Display names are optional; the host validates them again. */
export const DISPLAY_NAME_MAX = 64;
export type DisplayNameError = 'tooLong' | 'invalid';
export function validateDisplayName(value: string): DisplayNameError | undefined {
  const name = value.trim();
  if (name.length > DISPLAY_NAME_MAX) return 'tooLong';
  // Control characters would end up in the profile file and the Office labels.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'invalid';
  return undefined;
}

/** What an earlier (older or migrated) configuration already has, so setup can be confirmed instead of redone. */
export interface ExistingSetup {
  found: boolean;
  connection?: ConnectionView;
  workspace?: Workspace;
}

/**
 * Pick the workspace and connection to preselect. The first workspace wins,
 * with the connection it uses; otherwise the first connection on its own.
 */
export function detectExistingSetup(state: Pick<HostState, 'connections' | 'workspaces'>): ExistingSetup {
  const workspace = state.workspaces[0];
  const linked = workspace?.providerProfileId ? state.connections.find(item => item.id === workspace.providerProfileId) : undefined;
  const connection = linked ?? state.connections[0];
  if (!workspace && !connection) return { found: false };
  return { found: true, ...(connection ? { connection } : {}), ...(workspace ? { workspace } : {}) };
}

export interface AdvanceContext {
  busy: boolean;
  /** Profile step: the display name passes `validateDisplayName`. */
  displayNameValid: boolean;
  /** Connection step: Hermes Agent was chosen (it needs no model connection). */
  hermes: boolean;
  /** Hermes was chosen but this computer does not have it. */
  hermesBlocked: boolean;
  connectionValid: boolean;
  workspaceValid: boolean;
}

/** Whether the primary action of a step may be pressed. `done` is governed by `canFinish`. */
export function canAdvance(step: SetupStepId, context: AdvanceContext): boolean {
  if (context.busy) return false;
  switch (step) {
    case 'welcome': return true;
    case 'profile': return context.displayNameValid;
    case 'connection': return !context.hermesBlocked && (context.hermes || context.connectionValid);
    case 'workspace': return context.workspaceValid;
    case 'agentApps': return true;
    case 'done': return false;
  }
}

/**
 * A workspace can be explicitly deferred once a saved Native connection or an
 * available Hermes runtime is ready. A workspace chosen now must still be saved
 * and have its Native connection. Cosmetic steps never count.
 */
export interface DeferredWorkspaceSetup {
  runtimeId: RuntimeId;
  connectionId?: string;
  hermesAvailable: boolean;
}

export function canFinish(state: Pick<HostState, 'connections' | 'workspaces'>, workspaceId: string | undefined, deferred?: DeferredWorkspaceSetup): boolean {
  if (deferred) return deferred.runtimeId === 'hermes'
    ? deferred.hermesAvailable
    : Boolean(deferred.connectionId && state.connections.some(item => item.id === deferred.connectionId));
  const workspace = workspaceId ? state.workspaces.find(item => item.id === workspaceId) : undefined;
  if (!workspace) return false;
  if ((workspace.runtimeId ?? 'extalia-native') === 'hermes') return true;
  return Boolean(workspace.providerProfileId && state.connections.some(item => item.id === workspace.providerProfileId));
}

/** Data folder shown to the user: the contract's `dataDirectory`, with the older `storage` field as fallback. */
export function dataDirectoryOf(state: Pick<HostState, 'storage'> & { dataDirectory?: string }): string {
  return state.dataDirectory || state.storage.dataDirectory;
}
