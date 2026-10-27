import type { PageId } from './i18n';

export type Workflow = 'managed' | 'observe';

/** Per-device landing memory: only the last-used workspace. The page is never remembered. */
export const LANDING_STORAGE_KEY = 'extalia.landing.v2';
/** v0.0.19 and earlier stored `{ mode, workspaceId }` here; read once to carry the workspace over, then removed. */
export const LEGACY_MODE_STORAGE_KEY = 'extalia.mode.v1';

export interface LandingMemory { workspaceId?: string }

/**
 * Whether Chat exists in this host. The observe workflow without any workspace
 * has no chat.
 */
export function chatAvailable(input: { agents: boolean; workflow: Workflow; hasWorkspaces: boolean }): boolean {
  return input.agents && !(input.workflow === 'observe' && !input.hasWorkspaces);
}

export interface NavigationInput {
  /** Whether the host can run agents (false in the static web build). */
  agents: boolean;
  workflow: Workflow;
  /** At least one workspace exists, so Chat, Missions, Files and Git have something to show. */
  canChat: boolean;
  /** The host serves the knowledge methods (W5); otherwise the Knowledge page is not listed. */
  knowledge?: boolean;
}

/**
 * Only pages that work in this host appear; nothing is shown as a placeholder. Skills sits in the Extalia group next
 * to Settings: it governs which instructions reach agents across the profile and every workspace (a review and
 * approval task like the settings it moved out of), not work inside one project.
 */
export function navigationGroups({ agents, workflow, canChat, knowledge = false }: NavigationInput): { section: 'work' | 'app'; pages: PageId[] }[] {
  // Knowledge belongs to the profile, not to a workspace, so it needs no workspace.
  const known: PageId[] = knowledge ? ['knowledge'] : [];
  return agents
    // Files and Git read a workspace's project folder, so they need one.
    ? [{ section: 'work', pages: workflow === 'observe' && !canChat ? ['office', 'observe', ...known, 'history', 'import', 'logs'] : ['office', 'chat', ...(canChat ? ['missions'] as const : []), 'observe', ...(canChat ? ['files', 'git'] as const : []), ...known, 'history', 'import', 'logs'] }, { section: 'app', pages: ['skills', 'settings', 'diagnostics'] }]
    : [{ section: 'app', pages: ['office', 'start', 'logs', 'diagnostics', 'settings'] }];
}

export interface LandingInput {
  /** Whether the host can run agents (false in the static web build). */
  agents: boolean;
}

/**
 * The page opened after setup and on every launch: always the 3D Office, whatever
 * page was used last. Without an agent host it is Get started (nothing to show yet).
 */
export function resolveLandingPage(input: LandingInput): PageId {
  return input.agents ? 'office' : 'start';
}

/** The remembered workspace when it still exists; otherwise undefined (the chat then picks the first). */
export function resolveLandingWorkspace(workspaces: readonly { id: string }[], remembered: string | undefined): string | undefined {
  return remembered && workspaces.some(workspace => workspace.id === remembered) ? remembered : undefined;
}

/** Reads `{ workspaceId }` from either the current or the legacy record; any `mode` field is ignored. */
export function parseLandingMemory(raw: string | null): LandingMemory {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return {};
    const workspaceId = (value as Record<string, unknown>).workspaceId;
    return typeof workspaceId === 'string' && workspaceId ? { workspaceId } : {};
  } catch {
    return {};
  }
}

type LandingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const deviceStorage = (): LandingStorage | undefined => (typeof localStorage !== 'undefined' ? localStorage : undefined);

/**
 * Per-device storage; every access is guarded (private mode, blocked storage, tests).
 * The legacy mode record is migrated once: its workspace is kept, its mode dropped,
 * and only that one key is removed, so other interface preferences stay intact.
 */
export function loadLandingMemory(storage: LandingStorage | undefined = deviceStorage()): LandingMemory {
  try {
    if (!storage) return {};
    const current = storage.getItem(LANDING_STORAGE_KEY);
    if (current !== null) return parseLandingMemory(current);
    const legacy = storage.getItem(LEGACY_MODE_STORAGE_KEY);
    if (legacy === null) return {};
    const migrated = parseLandingMemory(legacy);
    saveLandingMemory(migrated, storage);
    storage.removeItem(LEGACY_MODE_STORAGE_KEY);
    return migrated;
  } catch {
    return {};
  }
}

export function saveLandingMemory(next: LandingMemory, storage: LandingStorage | undefined = deviceStorage()): void {
  try {
    storage?.setItem(LANDING_STORAGE_KEY, JSON.stringify(next.workspaceId ? { workspaceId: next.workspaceId } : {}));
  } catch {
    /* Quota or private mode */
  }
}
