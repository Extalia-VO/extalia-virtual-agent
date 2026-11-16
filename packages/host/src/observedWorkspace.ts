import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '@extalia/core';
import type { SessionSummary } from '@extalia/platform';

const pathSyntax = (location: string) => /^[A-Za-z]:[\\/]/.test(location) || location.startsWith('\\\\') ? path.win32 : path.posix;

/** Remove separators, never filename bytes such as trailing spaces or POSIX backslashes. */
function normalize(location: string): string {
  const syntax = pathSyntax(location), root = syntax.parse(location).root;
  let end = location.length;
  while (end > root.length && (location[end - 1] === '/' || (syntax === path.win32 && location[end - 1] === '\\'))) end--;
  return location.slice(0, end);
}

const contains = (root: string, child: string) => {
  const syntax = pathSyntax(root);
  if (syntax !== pathSyntax(child)) return false;
  if (syntax === path.win32) {
    // win32.relative folds case even on case-sensitive Windows directories.
    const folder = normalize(syntax.normalize(root));
    const project = normalize(syntax.normalize(child));
    return project === folder || project.startsWith(folder.endsWith(syntax.sep) ? folder : folder + syntax.sep);
  }
  const relative = syntax.relative(root, child);
  return relative === '' || (!syntax.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${syntax.sep}`));
};
type WorkspaceFolders = Pick<Workspace, 'id' | 'projectLocation'> & Partial<Pick<Workspace, 'additionalProjectLocations'>>;

/**
 * The workspace whose project location equals or contains an observed session's
 * project path (case-sensitive, trailing slashes ignored). The deepest match
 * wins, so a nested project is not claimed by its parent folder. Equal-depth
 * matches in different workspaces remain ambiguous.
 */
export function workspaceForProject(
  workspaces: readonly WorkspaceFolders[], projectPath: string | undefined, resolve: (location: string) => string = location => location,
): string | undefined {
  if (!projectPath?.trim()) return undefined;
  const matches = projectWorkspaceMatches(workspaces, projectPath, resolve);
  const best = matches[0];
  return best && !matches.some(item => item.workspaceId !== best.workspaceId && item.depth === best.depth) ? best.workspaceId : undefined;
}

/**
 * Follows symlinks (for example `/var` → `/private/var` on macOS) and Windows short names, as `checkFolder`'s
 * `realpath` does. A project folder removed since keeps the canonical form of the part that still exists.
 */
function canonical(location: string, seen = new Set<string>()): string | undefined {
  if (seen.size >= 128 || seen.has(location)) return undefined;
  seen.add(location);
  try {
    const resolved = realpathSync.native(location);
    return statSync(resolved).isDirectory() ? resolved : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') return undefined;
    // A dangling link still has a destination: never turn it back into a
    // lexical prefix inside the selected root when its target is outside.
    try {
      if (lstatSync(location).isSymbolicLink()) {
        return canonical(path.resolve(path.dirname(location), readlinkSync(location)), seen);
      }
    } catch { /* Resolve the nearest existing parent of a historical folder. */ }
    const parent = path.dirname(location);
    if (parent === location) return undefined;
    const resolved = canonical(parent, seen);
    return resolved === undefined ? undefined : path.join(resolved, path.basename(location));
  }
}

export interface ProjectWorkspaceMatch { workspaceId: string; root: string; depth: number }

/** One deepest matching own root per workspace, never a cross-workspace access grant. */
export function projectWorkspaceMatches(workspaces: readonly WorkspaceFolders[], projectPath: string | undefined,
  resolve: (location: string) => string | undefined = canonical): ProjectWorkspaceMatch[] {
  if (!projectPath?.trim() || (resolve === canonical && !path.isAbsolute(projectPath))) return [];
  const projectLocation = resolve(projectPath);
  if (projectLocation === undefined) return [];
  const project = normalize(projectLocation);
  const matches: ProjectWorkspaceMatch[] = [];
  for (const workspace of workspaces) {
    let best: ProjectWorkspaceMatch | undefined;
    for (const location of [workspace.projectLocation, ...(workspace.additionalProjectLocations ?? [])]) {
      if (!location?.trim()) continue;
      const resolvedRoot = resolve(location);
      if (resolvedRoot === undefined) continue;
      const root = normalize(resolvedRoot);
      if (contains(root, project) && (!best || root.length > best.depth)) best = { workspaceId: workspace.id, root, depth: root.length };
    }
    if (best) matches.push(best);
  }
  return matches.sort((a, b) => b.depth - a.depth || a.workspaceId.localeCompare(b.workspaceId));
}

export function projectCanonicalPath(location: string, resolve: (location: string) => string | undefined = canonical): string | undefined {
  const resolved = resolve(location);
  return resolved === undefined ? undefined : normalize(resolved);
}

export function observedWorkspaceResolution(summary: SessionSummary, workspaces: readonly WorkspaceFolders[],
  resolve: (location: string) => string | undefined = canonical) {
  const project = summary.observation?.projectPath;
  const matches = project && path.isAbsolute(project) ? projectWorkspaceMatches(workspaces, project, resolve) : [];
  const linked = summary.observation?.workspaceLink;
  if (linked) {
    const candidate = matches.find(item => item.workspaceId === linked.workspaceId);
    const valid = linked.sourceMatches && candidate && candidate.root === linked.root
      && projectCanonicalPath(summary.observation?.projectPath ?? '', resolve) === linked.projectCanonicalPath;
    return { matches, workspaceId: valid ? candidate.workspaceId : undefined, mode: valid ? 'explicit' as const : 'invalid' as const };
  }
  const first = matches[0];
  const ambiguous = first && matches.some(item => item.workspaceId !== first.workspaceId && item.depth === first.depth);
  return { matches, workspaceId: !ambiguous ? first?.workspaceId : undefined,
    mode: ambiguous ? 'ambiguous' as const : first ? 'automatic' as const : 'unbound' as const };
}

/** Resolve actual project paths before matching; a lexical symlink prefix is not containment. */
export function mapObservedWorkspaces(summaries: readonly SessionSummary[], workspaces: readonly WorkspaceFolders[]): SessionSummary[] {
  // Resolve shared roots once per fresh projection. Do not retain filesystem
  // answers across requests, so changed symlinks and folders remain visible.
  const paths = new Map<string, string | undefined>();
  const resolve = (location: string): string | undefined => {
    if (paths.has(location)) return paths.get(location);
    const value = canonical(location); paths.set(location, value); return value;
  };
  return summaries.map(summary => {
    if (!summary.observation) return summary;
    const resolved = observedWorkspaceResolution(summary, workspaces, resolve);
    return { ...summary, workspaceId: resolved.workspaceId ?? '', observation: { ...summary.observation, workspaceLinkState: resolved.mode } };
  });
}
