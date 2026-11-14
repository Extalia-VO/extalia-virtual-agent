import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_PERMISSIONS, workspaceCrossAccess, type Workspace } from '@extalia/core';
import type { PermissionMode, SessionMovePreview } from '@extalia/platform';
import type { SessionRecord } from './sessions.js';
import type { WorkspaceAccess } from './workspaceAccess.js';
import { workspaceSessionBoundaryKey } from './workspaceBoundary.js';

interface Snapshot {
  record: SessionRecord;
  source: Workspace;
  destination: Workspace;
  workspaces: readonly Workspace[];
  messages: readonly unknown[];
  access: WorkspaceAccess;
  permissionMode: PermissionMode;
  lastEventId?: string;
}
const fingerprint = (snapshot: Snapshot): string => createHash('sha256').update(JSON.stringify([
  snapshot.record, snapshot.source, snapshot.destination, snapshot.messages,
  workspaceSessionBoundaryKey(snapshot.source.id, snapshot.workspaces),
  workspaceSessionBoundaryKey(snapshot.destination.id, snapshot.workspaces), snapshot.access.folders(), snapshot.lastEventId,
])).digest('hex');
const workspaceView = (workspace: Workspace) => ({ id: workspace.id, name: workspace.name,
  folders: [workspace.projectLocation, ...(workspace.additionalProjectLocations ?? [])].filter((folder): folder is string => !!folder),
  crossWorkspaceAccess: workspaceCrossAccess(workspace), permissions: { ...(workspace.permissions ?? DEFAULT_PERMISSIONS) } });

/** Bounded, ephemeral user reviews. No prompt, filesystem copy or permission effect. */
export class SessionMoveReviews {
  private readonly reviews = new Map<string, { digest: string; expires: number }>();
  preview(snapshot: Snapshot): SessionMovePreview {
    const now = Date.now();
    for (const [id, entry] of this.reviews) if (entry.expires <= now) this.reviews.delete(id);
    while (this.reviews.size >= 64) this.reviews.delete(this.reviews.keys().next().value!);
    const reviewId = randomUUID(), expires = now + 10 * 60_000;
    this.reviews.set(reviewId, { digest: fingerprint(snapshot), expires });
    return { sessionId: snapshot.record.id, reviewId, expiresAt: new Date(expires).toISOString(),
      source: workspaceView(snapshot.source), destination: workspaceView(snapshot.destination),
      transfersHistory: snapshot.messages.length > 0,
      permissionMode: snapshot.permissionMode,
      accessibleFolders: snapshot.access.folders().map(({ workspaceId, path, access }) => ({ workspaceId, path, access })),
    };
  }
  verify(reviewId: unknown, snapshot: Snapshot): void {
    const review = typeof reviewId === 'string' ? this.reviews.get(reviewId) : undefined;
    if (!review || review.expires <= Date.now() || review.digest !== fingerprint(snapshot)) {
      throw new Error('Session or workspace settings changed, or the review expired. Review the destination again.');
    }
  }
  consume(reviewId: string): void { this.reviews.delete(reviewId); }
}

/** Reorder only existing own grants; never use run-owned roots for a session choice. */
export function sessionProjectWorkspace(workspace: Workspace, record: Pick<SessionRecord, 'runtime' | 'projectLocation'>): Workspace {
  if (record.runtime || record.projectLocation === undefined) return workspace;
  const roots = [workspace.projectLocation, ...(workspace.additionalProjectLocations ?? [])].filter((root): root is string => typeof root === 'string' && !!root);
  if (typeof record.projectLocation !== 'string' || !roots.includes(record.projectLocation)) {
    throw new Error('This session’s selected project folder is no longer registered. Choose an available folder in its workspace.');
  }
  return { ...workspace, projectLocation: record.projectLocation, additionalProjectLocations: roots.filter(root => root !== record.projectLocation) };
}

export function sessionProjectWorkspaces(workspaces: readonly Workspace[], record: SessionRecord): Workspace[] {
  return structuredClone(workspaces.map(workspace => workspace.id === record.workspaceId ? sessionProjectWorkspace(workspace, record) : workspace));
}
