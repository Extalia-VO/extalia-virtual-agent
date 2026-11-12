import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { workspaceCrossAccess, type Workspace } from '@extalia/core';
import type { AnyTool } from '@extalia/runtime';
import { createWorkspaceAccess, type WorkspaceAccess } from './workspaceAccess.js';
import { isWithin, WorkspacePathError } from './workspaceFs.js';

/** Refuse copying an inaccessible nested workspace into an owned Git checkout. */
export async function assertWorkspaceWorktreeAccess(workspace: Workspace, workspaces: readonly Workspace[], dataRoot: string): Promise<void> {
  const access = await createWorkspaceAccess({ workspaceId: workspace.id, workspaces, protectedRoots: [dataRoot] });
  const root = await access.resolve(workspace.projectLocation!, 'write');
  const git = await lstat(path.join(root.absolute, '.git')).catch(() => undefined);
  if (!git?.isDirectory() || git.isSymbolicLink()) throw new WorkspacePathError('Write-capable missions need a selected Git repository root with its own plain .git directory. Select the repository root or run the task read-only.');
  for (const other of workspaces) {
    if (other.id === workspace.id) continue;
    for (const selected of [other.projectLocation, ...(other.additionalProjectLocations ?? [])]) {
      if (!selected) continue;
      const target = await realpath(selected);
      if (isWithin(root.absolute, target) && !await access.canRead(target)) {
        throw new WorkspacePathError('This repository contains an inaccessible workspace folder. A write mission cannot copy it into a worktree. Choose separate repositories or run the task read-only.');
      }
    }
  }
}

/** A boundary change must never silently replay context gathered under older grants. */
export function workspaceBoundaryKey(workspaces: readonly Workspace[]): string {
  const policy = workspaces.map(workspace => ({ id: workspace.id, root: workspace.projectLocation,
    folders: [...(workspace.additionalProjectLocations ?? [])].sort(), access: workspaceCrossAccess(workspace) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

/**
 * History follows this workspace's effective grants, rather than unrelated
 * isolated projects. Registered paths are canonicalized by workspace saving.
 * Keep the unprefixed global key above for conservative legacy migration.
 */
export function workspaceSessionBoundaryKey(workspaceId: string, workspaces: readonly Workspace[]): string {
  const own = workspaces.find(workspace => workspace.id === workspaceId);
  if (!own) throw new WorkspacePathError('The workspace is not available.');
  const roots = workspaces.flatMap(workspace => [workspace.projectLocation, ...(workspace.additionalProjectLocations ?? [])]
    .flatMap((selected, index) => selected ? [{ id: workspace.id, root: path.resolve(selected), primary: index === 0,
      policy: workspaceCrossAccess(workspace), readable: workspace.id === workspaceId
        || (workspaceCrossAccess(own) !== 'isolated' && workspaceCrossAccess(workspace) !== 'isolated') }] : []));
  const readable = roots.filter(root => root.readable);
  // Denied nested folders restrict a readable tree; denied ancestors can restrict
  // the whole tree. Disjoint denied folders have never supplied this history.
  const relevant = roots.filter(root => root.readable || readable.some(allowed =>
    isWithin(root.root, allowed.root) || isWithin(allowed.root, root.root)))
    .sort((a, b) => a.id.localeCompare(b.id) || a.root.localeCompare(b.root));
  return `workspace-v1:${createHash('sha256').update(JSON.stringify({ workspaceId, policy: workspaceCrossAccess(own), roots: relevant })).digest('hex')}`;
}

/** Legacy history is usable only when its complete original grants still match. */
export function workspaceBoundaryMatches(recorded: string | undefined, workspaceId: string, workspaces: readonly Workspace[]): boolean {
  return recorded === workspaceSessionBoundaryKey(workspaceId, workspaces) || recorded === workspaceBoundaryKey(workspaces);
}

/** Isolated memory has no automatic import from a previously shared context. */
export function workspaceMemoryDirectory(base: string, workspace: Workspace): string {
  const name = workspaceCrossAccess(workspace) === 'isolated'
    ? `memory-isolated-${workspaceBoundaryKey([workspace]).slice(0, 24)}` : 'memory';
  return path.join(base, workspace.id, name);
}

export function workspaceFoldersTool(access: WorkspaceAccess): AnyTool {
  return {
    name: 'workspace_folders', access: 'read', kind: 'read',
    description: 'List the selected project folders and explicitly accessible folders of other workspaces. Use these absolute paths with file tools. This does not load another workspace\'s history, memory or instructions.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    describe: () => ({ label: 'Checking allowed workspace folders' }),
    run: async () => ({ ok: true, output: JSON.stringify(access.folders()) }),
  };
}
