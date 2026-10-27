import type { PermissionMode, RuntimeId, WorkspacePermissions } from '@extalia/core';
import type { Messages } from '../i18n';

/** Hermes cannot ask through Extalia, so its approvals are bypassed only when both permissions allow everything. */
export const bypassesHermesApprovals = (permissions: Partial<WorkspacePermissions> | undefined) =>
  permissions?.fileWrite === 'allow' && permissions?.commands === 'allow';

/** The permissions a Hermes workspace stores: everything allowed, or Hermes' own rules. */
export const hermesPermissions = (bypass: boolean): WorkspacePermissions => bypass ? { fileWrite: 'allow', commands: 'allow' } : { fileWrite: 'ask', commands: 'ask' };

/** One line describing a workspace's permissions; Hermes workspaces are managed by Hermes. */
export function permissionsLabel(t: Messages, runtimeId: RuntimeId | undefined, permissions: Partial<Record<keyof WorkspacePermissions, PermissionMode>> | undefined): string {
  if (runtimeId === 'hermes') return bypassesHermesApprovals(permissions) ? t.workspace.hermesPermissions.bypassSummary : t.workspace.hermesPermissions.managed;
  const mode = (value: PermissionMode | undefined) => t.workspace.modes[value ?? 'ask'];
  return t.setup.permissionSummary(mode(permissions?.fileWrite), mode(permissions?.commands));
}
