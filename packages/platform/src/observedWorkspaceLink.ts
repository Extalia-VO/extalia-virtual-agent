/** Workspace association metadata only. It never changes the external app's project folder or access grants. */
export interface ObservedWorkspaceLinkStatus {
  sessionId: string;
  revision: string;
  projectPath?: string;
  mode: 'automatic' | 'explicit' | 'unbound' | 'ambiguous' | 'invalid';
  workspaceId?: string;
  linkedWorkspaceId?: string;
  /** Host-resolved automatic destination, absent for ambiguous or unmatched folders. */
  automaticWorkspaceId?: string;
  lockedWorkspaceId?: string;
  /** Host-verified existing workspace roots that physically contain this observed project. */
  candidates: { workspaceId: string; name: string; root: string }[];
  reason?: 'no-project' | 'source-changed' | 'workspace-changed' | 'continuity-bound';
}

export interface ObservedWorkspaceLinkInput {
  revision: string;
  /** null returns to automatic association; no new workspace or filesystem authority is created. */
  workspaceId: string | null;
}

export function normalizeObservedWorkspaceLinkInput(raw: unknown): ObservedWorkspaceLinkInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Review a workspace association before applying it.');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'revision' && key !== 'workspaceId')
    || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)
    || (value.workspaceId !== null && (typeof value.workspaceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.workspaceId)))) {
    throw new Error('Choose an existing workspace using the current association revision.');
  }
  return { revision: value.revision, workspaceId: value.workspaceId as string | null };
}
