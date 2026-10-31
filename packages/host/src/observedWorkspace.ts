import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '@extalia/core';
import type { SessionSummary } from '@extalia/platform';

/** Removes trailing separators so `/a/b/` and `/a/b` compare equal; the root stays `/`. */
function normalize(location: string): string {
  const trimmed = location.trim().replace(/[\\/]+$/, '');
  return trimmed || location.trim().slice(0, 1);
}

const contains = (root: string, child: string) => child === root || (/[\\/]$/.test(root) ? child.startsWith(root) : child.startsWith(`${root}/`) || child.startsWith(`${root}\\`));

/**
 * The workspace whose project location equals or contains an observed session's
 * project path (case-sensitive, trailing slashes ignored). The deepest match
 * wins, so a nested project is not claimed by its parent folder.
 */
export function workspaceForProject(
  workspaces: readonly Pick<Workspace, 'id' | 'projectLocation'>[], projectPath: string | undefined, resolve: (location: string) => string = location => location,
): string | undefined {
  if (!projectPath?.trim()) return undefined;
  const project = normalize(resolve(projectPath));
  let best: { id: string; length: number } | undefined;
  for (const workspace of workspaces) {
    if (!workspace.projectLocation?.trim()) continue;
    const root = normalize(resolve(workspace.projectLocation));
    if (contains(root, project) && (!best || root.length > best.length)) best = { id: workspace.id, length: root.length };
  }
  return best?.id;
}

/**
 * Follows symlinks (for example `/var` → `/private/var` on macOS) and Windows short names, as `checkFolder`'s
 * `realpath` does. A project folder removed since keeps the canonical form of the part that still exists.
 */
function canonical(location: string): string {
  try { return realpathSync.native(location); }
  catch {
    const parent = path.dirname(location);
    return parent === location ? location : path.join(canonical(parent), path.basename(location));
  }
}

/** Observed summaries carry no workspace of their own; map them by project path. */
export function mapObservedWorkspaces(summaries: readonly SessionSummary[], workspaces: readonly Pick<Workspace, 'id' | 'projectLocation'>[]): SessionSummary[] {
  return summaries.map(summary => {
    const project = summary.observation?.projectPath;
    const id = summary.workspaceId || workspaceForProject(workspaces, project) || workspaceForProject(workspaces, project, canonical);
    return id && id !== summary.workspaceId ? { ...summary, workspaceId: id } : summary;
  });
}
