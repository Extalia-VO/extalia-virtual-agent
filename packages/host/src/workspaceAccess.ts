import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { safeLabel, type Workspace } from '@extalia/core';
import { checkAllowed, isWithin, realTarget, WorkspacePathError, type PathPurpose, type ResolvedPath } from './workspaceFs.js';

export interface WorkspaceFolder {
  readonly workspaceId: string;
  readonly path: string;
  readonly primary: boolean;
  readonly access: 'read-only' | 'read-write';
}

export interface WorkspaceAccess {
  resolve(requested: string, purpose: PathPurpose): Promise<ResolvedPath>;
  canRead(absolute: string): Promise<boolean>;
  folders(): readonly WorkspaceFolder[];
}

interface RegisteredRoot {
  workspaceId: string;
  lexical: string;
  canonical: string;
  primary: boolean;
  access: 'isolated' | 'read-only' | 'read-write';
}

/**
 * Capture registered folders and both sides of cross-workspace policy for one run.
 * This is a cooperative host boundary, not an OS sandbox against hostile filesystem races.
 */
export async function createWorkspaceAccess({ workspaceId, workspaces, ownedRoots, protectedRoots = [] }: {
  workspaceId: string;
  workspaces: readonly Workspace[];
  /** Run-owned worktree folders replace this workspace's selected folders. */
  ownedRoots?: readonly string[];
  /** Host application data is never generic file-tool context. */
  protectedRoots?: readonly string[];
}): Promise<WorkspaceAccess> {
  const own = workspaces.find(workspace => workspace.id === workspaceId);
  if (!own || workspaces.filter(workspace => workspace.id === workspaceId).length !== 1) throw new WorkspacePathError('The workspace is not available.');
  const ownPolicy = own.crossWorkspaceAccess ?? 'read-only';
  const roots: RegisteredRoot[] = [];
  for (const workspace of workspaces) {
    const selected = workspace.id === workspaceId && ownedRoots !== undefined
      ? [...ownedRoots]
      : [workspace.projectLocation, ...(workspace.additionalProjectLocations ?? [])].filter((value): value is string => typeof value === 'string' && !!value.trim());
    if (selected.length > 16) throw new WorkspacePathError('A workspace may register at most 16 folders.');
    const policy = workspace.crossWorkspaceAccess ?? 'read-only';
    const access = workspace.id === workspaceId ? 'read-write'
      : ownPolicy === 'isolated' || policy === 'isolated' ? 'isolated'
      : ownPolicy === 'read-write' && policy === 'read-write' ? 'read-write' : 'read-only';
    for (const [index, selectedPath] of selected.entries()) {
      if (!path.isAbsolute(selectedPath) || selectedPath.includes('\0')) throw new WorkspacePathError('Workspace folders must be absolute local paths.');
      const lexical = path.resolve(selectedPath);
      let canonical: string;
      try {
        canonical = await realpath(lexical);
        if (!(await stat(canonical)).isDirectory()) throw new Error('Not a directory');
      } catch { throw new WorkspacePathError('A registered workspace folder is not available.'); }
      roots.push({ workspaceId: workspace.id, lexical, canonical, primary: index === 0, access });
    }
  }
  const protectedFolders: { lexical: string; canonical: string }[] = [];
  for (const protectedPath of protectedRoots) {
    if (!path.isAbsolute(protectedPath) || protectedPath.includes('\0')) throw new WorkspacePathError('Protected folders must be absolute local paths.');
    try { protectedFolders.push({ lexical: path.resolve(protectedPath), canonical: await realpath(protectedPath) }); }
    catch { throw new WorkspacePathError('A protected host folder is not available.'); }
  }
  const primary = roots.find(root => root.workspaceId === workspaceId);
  if (!primary) throw new WorkspacePathError('The workspace folder is not available.');

  const checkMembership = (absolute: string, canonical: boolean, purpose: PathPurpose, label: string) => {
    const containing = roots.filter(root => isWithin(canonical ? root.canonical : root.lexical, absolute));
    // A canonical spelling is also accepted, including the system's /var aliases.
    const accepted = canonical ? containing : [...containing, ...roots.filter(root => isWithin(root.canonical, absolute))];
    if (!accepted.length) throw new WorkspacePathError(`"${label}" is outside the registered workspace folders.`);
    if (accepted.some(root => root.access === 'isolated' || (purpose === 'write' && root.access !== 'read-write'))) {
      throw new WorkspacePathError(`"${label}" is not permitted by workspace access policy.`);
    }
    if (purpose === 'write' && ownedRoots !== undefined && !roots.some(root => root.workspaceId === workspaceId &&
      (isWithin(root.canonical, absolute) || (!canonical && isWithin(root.lexical, absolute))))) {
      throw new WorkspacePathError(`"${label}" is outside the run-owned workspace folders.`);
    }
    for (const protectedFolder of protectedFolders) {
      const insideProtected = isWithin(protectedFolder.canonical, absolute) || (!canonical && isWithin(protectedFolder.lexical, absolute));
      if (!insideProtected) continue;
      // Only the host's explicit run-owned worktree override can open a narrow
      // subtree of its data folder. Selecting that data folder cannot grant it.
      const ownedException = ownedRoots !== undefined && roots.some(root =>
        root.workspaceId === workspaceId && root.canonical !== protectedFolder.canonical &&
        isWithin(protectedFolder.canonical, root.canonical) &&
        (isWithin(root.canonical, absolute) || (!canonical && isWithin(root.lexical, absolute))),
      );
      if (!ownedException) throw new WorkspacePathError(`"${label}" is inside protected host data.`);
    }
    checkAllowed(absolute, label, purpose);
  };
  const resolve = async (requestedPath: string, purpose: PathPurpose): Promise<ResolvedPath> => {
    if (typeof requestedPath !== 'string' || requestedPath.includes('\0')) throw new WorkspacePathError('The path must be plain text.');
    const requested = requestedPath.trim() || '.';
    const label = safeLabel(requested, 160);
    const absolute = path.resolve(primary.lexical, requested);
    checkMembership(absolute, false, purpose, label);
    const canonical = await realTarget(absolute, label);
    checkMembership(canonical, true, purpose, label);
    // Hard links can alias an unregistered or credential file without any symlink.
    const info = await lstat(canonical).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (info && !info.isFile() && !info.isDirectory()) throw new WorkspacePathError(`"${label}" is not a regular file or directory.`);
    if (info?.isFile() && info.nlink > 1) throw new WorkspacePathError(`"${label}" is a hard-linked file. Agent file access is refused.`);
    const ownBase = isWithin(primary.canonical, canonical) ? primary.canonical : undefined;
    return { absolute: canonical, relative: ownBase ? path.relative(ownBase, canonical).split(path.sep).join('/') || '.' : canonical };
  };
  const canRead = async (absolute: string) => {
    if (!path.isAbsolute(absolute)) return false;
    try { await resolve(absolute, 'read'); return true; } catch { return false; }
  };
  const visibleFolders: WorkspaceFolder[] = [];
  for (const root of roots) {
    if (!await canRead(root.lexical) || !await canRead(root.canonical)) continue;
    let access: WorkspaceFolder['access'] = 'read-write';
    try {
      checkMembership(root.lexical, false, 'write', '.');
      checkMembership(root.canonical, true, 'write', '.');
    } catch { access = 'read-only'; }
    visibleFolders.push(Object.freeze({ workspaceId: root.workspaceId, path: root.canonical, primary: root.primary, access }));
  }
  const folders = Object.freeze(visibleFolders);
  return { resolve, canRead, folders: () => folders };
}
