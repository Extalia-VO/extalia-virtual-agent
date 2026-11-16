import type { ExtaliaEvent } from '@extalia/protocol';
import { resolveMessageFile, type MessageFileReference, type MessageFileScope, type WorkspaceSummary } from './messageFilePaths';

export interface SessionFileScope { workspaceId: string; projectLocation: string }
export interface SessionFileScopeBoundary extends SessionFileScope { throughEventId: string }
export type SessionFileRoots = ReadonlyMap<string, SessionFileScope | null>;

export function hasSessionFileScope(workspaces: readonly WorkspaceSummary[], scope: SessionFileScope): boolean {
  return workspaces.some(workspace => workspace.id === scope.workspaceId
    && [workspace.projectLocation, ...(workspace.additionalProjectLocations ?? [])].includes(scope.projectLocation));
}

/** Missing or unordered cutoffs cannot safely assign relative paths to a workspace. */
export function sessionFileRoots(events: readonly ExtaliaEvent[], scopes: unknown = []): SessionFileRoots {
  const roots = new Map<string, SessionFileScope | null>();
  const ambiguous = () => new Map(events.map(event => [event.id, null] as const));
  if (!Array.isArray(scopes)) return ambiguous();
  if (!scopes.length) return roots;
  const positions = new Map(events.map((event, index) => [event.id, index]));
  let start = 0;
  for (const scope of scopes) {
    if (!scope || typeof scope !== 'object' || ['throughEventId', 'workspaceId', 'projectLocation'].some(key =>
      typeof scope[key] !== 'string' || !scope[key].trim() || scope[key].includes('\0'))) return ambiguous();
    const end = positions.get(scope.throughEventId);
    if (end === undefined || end < start - 1 || !scope.workspaceId || !scope.projectLocation) {
      return ambiguous();
    }
    for (let index = start; index <= end; index++) roots.set(events[index]!.id, { workspaceId: scope.workspaceId, projectLocation: scope.projectLocation });
    start = end + 1;
  }
  return roots;
}

export function resolveSessionMessageFile(file: MessageFileReference, current: MessageFileScope, historical?: SessionFileScope | null) {
  if (historical === undefined) return resolveMessageFile(file, current);
  if (!historical || !hasSessionFileScope(current.workspaces, historical)) return undefined;
  return resolveMessageFile(file, { workspaces: current.workspaces, workspaceId: historical.workspaceId, projectPath: historical.projectLocation });
}

/** Resolve literal recorded tool paths without URL decoding or platform-specific Node imports. */
export function historicalSessionFilePath(file: string, scope: SessionFileScope): string | undefined {
  const resolved = resolveMessageFile({ name: file, path: file }, {
    workspaces: [{ id: scope.workspaceId, projectLocation: scope.projectLocation }],
    workspaceId: scope.workspaceId, projectPath: scope.projectLocation,
  });
  return resolved ? `${scope.projectLocation.replace(/[\\/]+$/, '')}/${resolved.path}` : undefined;
}
