import type { LocalState, Workspace } from '@extalia/core';
import type { LibrarySessionSummary, SessionSummary } from './agentHost.js';

export type SessionBrowserCollection = 'observed' | 'library';
export type SessionBrowserSection = 'harnesses' | 'projects' | 'unassigned';
export interface SessionBrowserQuery {
  collection: SessionBrowserCollection;
  query?: string;
  harness?: string;
  status?: 'all' | 'running' | 'attention' | 'paused';
  state?: LocalState;
  /** IDs with an outstanding source-reported question in the client's current snapshot. */
  attentionIds?: string[];
}
export interface SessionBrowserGroupsInput extends SessionBrowserQuery {
  section: SessionBrowserSection;
  cursor?: string;
  limit?: number;
}
export interface SessionBrowserSessionsInput extends SessionBrowserQuery {
  groupId: string;
  cursor?: string;
  limit?: number;
}
export interface SessionBrowserProjectIdentity { id: string; name: string; path: string }
export interface SessionBrowserGroup {
  id: string;
  name: string;
  section: SessionBrowserSection;
  /** Source metadata only. This does not register a workspace or authorize filesystem access. */
  projectPath?: string;
  workspaceId?: string;
  workspaceName?: string;
  /** Harness groups expose the exact source key used by child page filters. */
  sourceId?: string;
  sourceIds: string[];
  count: number;
  /** Source-reported live activity, present only for Observe groups. Imported active state is not execution. */
  runningCount?: number;
  attentionCount?: number;
  unreadCount?: number;
  latestAt: string;
}
export interface SessionBrowserGroupsPage {
  collection: SessionBrowserCollection;
  section: SessionBrowserSection;
  groups: SessionBrowserGroup[];
  totalGroups: number;
  totalSessions: number;
  nextCursor?: string;
}
export type SessionBrowserSessionsPage = {
  collection: 'observed'; sessions: SessionSummary[]; total: number; nextCursor?: string;
} | {
  collection: 'library'; sessions: LibrarySessionSummary[]; total: number; nextCursor?: string;
};
export type SessionBrowserRow = SessionSummary | LibrarySessionSummary;
export interface SessionBrowserSnapshotInput {
  collection: SessionBrowserCollection;
  /** Host group pages count metadata without retaining every session list. */
  includeSessions?: boolean;
  /** Restrict session materialization to the one expanded project group. */
  groupId?: string;
  observed?: SessionSummary[];
  library?: LibrarySessionSummary[];
  workspaces?: (Pick<Workspace, 'id' | 'name'> & Partial<Pick<Workspace, 'projectLocation' | 'additionalProjectLocations'>>)[];
  /** Verified host metadata only; never a filesystem authority. Keyed by lexical source identity. */
  projectIdentities?: ReadonlyMap<string, SessionBrowserProjectIdentity>;
}
export interface SessionBrowserSnapshot {
  groups: SessionBrowserGroup[];
  sessionsByGroup: Map<string, SessionBrowserRow[]>;
}

/** Lexical source identity, independent of the host OS. Never resolves or reads the source path. */
export function sessionBrowserProject(value: string | undefined): { id: string; name: string; path: string } | undefined {
  const source = value?.trim();
  if (!source || source.includes('\0')) return undefined;
  const windows = /^[a-z]:[\\/]/i.test(source) || /^\\\\/.test(source);
  const slash = windows ? source.replaceAll('\\', '/') : source;
  const prefix = slash.startsWith('//') ? '//' : slash.startsWith('/') ? '/' : '';
  const driveRoot = /^[a-z]:\//i.test(slash);
  const floor = driveRoot ? 1 : prefix === '//' ? 2 : 0;
  const parts: string[] = [];
  for (const part of slash.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > floor && parts.at(-1) !== '..') parts.pop();
      else if (!prefix && !driveRoot) parts.push(part);
    } else parts.push(part);
  }
  const path = prefix + parts.join('/') || prefix;
  if (!path) return undefined;
  // Drive letters are case-insensitive; other source components retain their exact identity.
  const identity = windows ? path.replace(/^[a-z]:/i, drive => drive.toLowerCase()) : path;
  return { id: `project:${JSON.stringify(identity)}`, name: parts.at(-1) ?? path, path };
}

export function sessionBrowserRowTime(row: SessionBrowserRow): string {
  return 'lastActiveAt' in row ? row.lastActiveAt : row.lastMessageAt;
}
export function compareSessionBrowserRows(a: SessionBrowserRow, b: SessionBrowserRow): number {
  return sessionBrowserRowTime(b).localeCompare(sessionBrowserRowTime(a)) || a.id.localeCompare(b.id);
}

interface SessionBrowserMatch {
  row: SessionBrowserRow;
  activity?: { runningCount: number; attentionCount: number; unreadCount: number };
  sourceId: string;
  project?: ReturnType<typeof sessionBrowserProject>;
  workspaceId?: string;
  workspaceName?: string;
}
function* matchingSessionBrowserRows(input: SessionBrowserSnapshotInput, query: SessionBrowserQuery): Generator<SessionBrowserMatch> {
  const workspaceNames = new Map(input.workspaces?.map(workspace => [workspace.id, workspace.name]));
  const attention = new Set(query.attentionIds);
  const search = query.query?.trim().toLocaleLowerCase() ?? '';
  const rows = input.collection === 'observed' ? input.observed ?? [] : input.library ?? [];
  for (const row of rows) {
    const observed = 'lastActiveAt' in row ? row : undefined;
    if (observed && observed.control !== 'observed') continue;
    const imported = 'lastMessageAt' in row ? row : undefined;
    if (imported && imported.state !== (query.state ?? 'active')) continue;
    const sourceId = observed?.observation?.sourceId ?? imported?.sourceId ?? 'unknown';
    if (query.harness && sourceId !== query.harness) continue;
    if (query.status === 'running' && !observed?.running) continue;
    if (query.status === 'attention' && !observed?.pendingApprovalId && !observed?.observation?.error && !attention.has(row.id)) continue;
    if (query.status === 'paused' && observed?.observation?.watching !== false) continue;
    const lexical = sessionBrowserProject(observed?.observation?.projectPath ?? imported?.projectLocation);
    const project = lexical ? input.projectIdentities?.get(lexical.id) ?? lexical : undefined;
    const workspaceId = observed?.workspaceId || undefined;
    const workspaceName = workspaceId ? workspaceNames.get(workspaceId) : imported?.workspaceName;
    if (search && ![row.title, sourceId, lexical?.path, project?.path, workspaceName, observed?.model].some(value => value?.toLocaleLowerCase().includes(search))) continue;
    yield { row, sourceId, project, workspaceId, workspaceName, ...(observed ? { activity: {
      runningCount: observed.running ? 1 : 0,
      unreadCount: observed.observation?.unreadOutput ? 1 : 0,
      attentionCount: observed.pendingApprovalId || observed.observation?.error || attention.has(row.id) ? 1 : 0,
    } } : {}) };
  }
}

/** Top-level source groups, without retaining sessions or reading transcript bodies. */
export function buildSessionBrowserHarnessGroups(input: SessionBrowserSnapshotInput, query: SessionBrowserQuery): SessionBrowserGroup[] {
  const groups = new Map<string, SessionBrowserGroup>();
  for (const { row, sourceId, activity } of matchingSessionBrowserRows(input, query)) {
    const id = `harness:${JSON.stringify(sourceId)}`;
    const group = groups.get(id);
    if (group) {
      group.count++;
      if (activity) { group.runningCount! += activity.runningCount; group.attentionCount! += activity.attentionCount; group.unreadCount! += activity.unreadCount; }
      if (sessionBrowserRowTime(row) > group.latestAt) group.latestAt = sessionBrowserRowTime(row);
    } else groups.set(id, { id, name: sourceId, section: 'harnesses', sourceId, sourceIds: [sourceId], count: 1, ...activity, latestAt: sessionBrowserRowTime(row) });
  }
  return [...groups.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt) || a.id.localeCompare(b.id));
}

/** Metadata-only grouping shared by the host and compatibility presentation for older hosts. */
export function buildSessionBrowserSnapshot(input: SessionBrowserSnapshotInput, query: SessionBrowserQuery): SessionBrowserSnapshot {
  const groups = new Map<string, SessionBrowserGroup>();
  const sessionsByGroup = new Map<string, SessionBrowserRow[]>();
  for (const { row, sourceId, project, workspaceId, workspaceName, activity } of matchingSessionBrowserRows(input, query)) {
    const id = project?.id ?? 'unassigned';
    if (input.groupId !== undefined && input.groupId !== id) continue;
    const section = project ? 'projects' : 'unassigned';
    let group = groups.get(id);
    if (!group) {
      group = { id, name: project?.name ?? '', section, sourceIds: [], count: 0, ...(activity ? { runningCount: 0, attentionCount: 0, unreadCount: 0 } : {}), latestAt: sessionBrowserRowTime(row),
        ...(project ? { projectPath: project.path } : {}), ...(workspaceId ? { workspaceId } : {}), ...(workspaceName ? { workspaceName } : {}) };
      groups.set(id, group);
      if (input.includeSessions !== false) sessionsByGroup.set(id, []);
    } else {
      // One source folder can contain sessions explicitly linked to different registered workspaces.
      if (group.workspaceId !== workspaceId) { delete group.workspaceId; delete group.workspaceName; }
      else if (group.workspaceName !== workspaceName) delete group.workspaceName;
    }
    if (!group.sourceIds.includes(sourceId)) group.sourceIds.push(sourceId);
    group.count++;
    if (activity) { group.runningCount! += activity.runningCount; group.attentionCount! += activity.attentionCount; group.unreadCount! += activity.unreadCount; }
    if (sessionBrowserRowTime(row) > group.latestAt) group.latestAt = sessionBrowserRowTime(row);
    sessionsByGroup.get(id)?.push(row);
  }
  for (const group of groups.values()) group.sourceIds.sort();
  for (const rows of sessionsByGroup.values()) rows.sort(compareSessionBrowserRows);
  return { groups: [...groups.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt) || a.id.localeCompare(b.id)), sessionsByGroup };
}
