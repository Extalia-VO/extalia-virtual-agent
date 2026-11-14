import type { Workspace } from '@extalia/core';
import type { SessionSummary } from '@extalia/platform';

export type ObserveSessionFilter = 'all' | 'running' | 'attention' | 'paused';
export interface ObserveProjectGroup {
  id: string;
  workspaceId?: string;
  workspaceName?: string;
  projectPath?: string;
  folderName?: string;
  sessions: SessionSummary[];
}
export interface ObserveHarnessGroup { id: string; projects: ObserveProjectGroup[]; count: number }

/** Display the host's actual association; a shared path never assigns or changes a workspace. */
export function observeProject(session: SessionSummary, workspaces: readonly Workspace[]): Omit<ObserveProjectGroup, 'sessions'> {
  const workspace = workspaces.find(item => item.id === session.workspaceId);
  const projectPath = session.observation?.projectPath;
  const folderName = projectPath?.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || projectPath;
  return { id: JSON.stringify([workspace?.id ?? '', projectPath ?? '']),
    ...(workspace ? { workspaceId: workspace.id, workspaceName: workspace.name } : {}),
    ...(projectPath ? { projectPath, folderName } : {}) };
}

/** Presentation grouping and search only. Session identity, ownership and scope remain host-owned. */
export function groupObserveSessions(sessions: readonly SessionSummary[], workspaces: readonly Workspace[], query = '', filter: ObserveSessionFilter = 'all', attentionIds: ReadonlySet<string> = new Set()): ObserveHarnessGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  const harnesses = new Map<string, ObserveHarnessGroup>();
  for (const session of [...sessions].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt) || a.id.localeCompare(b.id))) {
    if (session.control !== 'observed') continue;
    if (filter === 'running' && !session.running || filter === 'attention' && !session.pendingApprovalId && !attentionIds.has(session.id)
      || filter === 'paused' && session.observation?.watching !== false) continue;
    const project = observeProject(session, workspaces), id = session.observation?.sourceId || 'other';
    if (needle && ![session.title, id, session.model, project.workspaceName, project.projectPath].some(value => value?.toLocaleLowerCase().includes(needle))) continue;
    let harness = harnesses.get(id);
    if (!harness) { harness = { id, projects: [], count: 0 }; harnesses.set(id, harness); }
    let group = harness.projects.find(item => item.id === project.id);
    if (!group) { group = { ...project, sessions: [] }; harness.projects.push(group); }
    group.sessions.push(session); harness.count++;
  }
  return [...harnesses.values()];
}
