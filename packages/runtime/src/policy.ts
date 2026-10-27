import type { SessionPermissionMode, WorkspacePermissions } from '@extalia/core';
import type { ToolAccess } from './tools.js';

export type PolicyDecision = 'allow' | 'ask' | 'deny';

/** Inputs of one decision, as `decide()` takes them and the daemon's `permission.check` receives them (ADR 0026). */
export interface PermissionRequest {
  access: ToolAccess;
  mode: SessionPermissionMode;
  permissions: WorkspacePermissions;
  sessionGrants: ToolAccess[];
}
/** `policy_unavailable`: the decision point could not answer, so the call is denied (ADR 0026). */
export interface PermissionVerdict { decision: PolicyDecision; reason?: 'policy_unavailable' }
export const POLICY_UNAVAILABLE: PermissionVerdict = Object.freeze({ decision: 'deny', reason: 'policy_unavailable' });

/** A verdict from an external decision point; anything else is `policy_unavailable`, never a fallback to `decide()`. */
export function checkedVerdict(raw: unknown): PermissionVerdict {
  if (!raw || typeof raw !== 'object') return POLICY_UNAVAILABLE;
  const { decision, reason } = raw as { decision?: unknown; reason?: unknown };
  if (reason === 'policy_unavailable') return POLICY_UNAVAILABLE;
  return reason === undefined && (decision === 'allow' || decision === 'ask' || decision === 'deny') ? { decision } : POLICY_UNAVAILABLE;
}

/**
 * Decide whether a tool call may run without asking. Paths outside the
 * workspace and credential files are refused by the tools themselves; this
 * policy only covers actions inside the workspace boundary.
 *
 * The session's permission mode (v0.0.49) comes first:
 * - `plan`: edits and commands are denied, whatever the workspace allows;
 * - `ask`: edits and commands ask, even where the workspace allows them;
 * - `accept-edits`: edits are allowed inside the workspace; commands follow the workspace;
 * - `workspace` (default): edits and commands follow the workspace permissions.
 * Session grants ("allow for this session") apply in every mode except `plan`.
 */
export function decide(
  access: ToolAccess,
  permissions: WorkspacePermissions,
  sessionGrants: ReadonlySet<ToolAccess> = new Set(),
  mode: SessionPermissionMode = 'workspace',
): PolicyDecision {
  if (access === 'read' || access === 'memory' || access === 'meta') return 'allow';
  if (mode === 'plan') return 'deny';
  if (sessionGrants.has(access)) return 'allow';
  if (access === 'write') {
    if (mode === 'accept-edits') return 'allow';
    return mode === 'workspace' && permissions.fileWrite === 'allow' ? 'allow' : 'ask';
  }
  // Commands: `ask` always asks; `accept-edits` and `workspace` follow the workspace's command policy.
  return mode !== 'ask' && permissions.commands === 'allow' ? 'allow' : 'ask';
}

/** Whether a permission mode offers tools of this access level to the model at all (plan mode offers no edit or command tools). */
export function offersAccess(access: ToolAccess, mode: SessionPermissionMode = 'workspace'): boolean {
  return mode !== 'plan' || access === 'read' || access === 'memory' || access === 'meta';
}
