import type { WorkspacePermissions } from '@extalia/core';
import type { ToolAccess } from './tools.js';

export type PolicyDecision = 'allow' | 'ask';

/**
 * Decide whether a tool call may run without asking. Paths outside the
 * workspace and credential files are refused by the tools themselves; this
 * policy only covers actions inside the workspace boundary.
 */
export function decide(access: ToolAccess, permissions: WorkspacePermissions, sessionGrants: ReadonlySet<ToolAccess> = new Set()): PolicyDecision {
  if (access === 'read' || access === 'memory' || access === 'meta') return 'allow';
  if (sessionGrants.has(access)) return 'allow';
  if (access === 'write') return permissions.fileWrite === 'allow' ? 'allow' : 'ask';
  return permissions.commands === 'allow' ? 'allow' : 'ask';
}
