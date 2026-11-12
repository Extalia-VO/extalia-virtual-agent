import type { PageId } from './i18n';
import { profileClientStateStorage } from './profileClientState';

export type Workflow = 'managed' | 'observe';

/** Profile-backed landing memory: only the last-used workspace. The page is never remembered. */
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
  /** Legacy capability hint; Knowledge remains visible on agent hosts. */
  knowledge?: boolean;
}

export type NavigationSection = 'work' | 'library' | 'activity' | 'app';
export interface NavigationGroup { section: NavigationSection; pages: PageId[] }

/** Group by purpose and prioritize the current workflow without widening feature availability. */
export function navigationGroups({ agents, workflow, canChat }: NavigationInput): NavigationGroup[] {
  if (!agents) return [
    { section: 'work', pages: ['office', 'start'] },
    { section: 'activity', pages: ['logs'] },
    { section: 'app', pages: ['settings', 'diagnostics'] },
  ];
  const work: PageId[] = ['office'];
  if (workflow === 'observe') work.push('observe');
  if (chatAvailable({ agents, workflow, hasWorkspaces: canChat })) work.push('chat');
  if (canChat) work.push('missions');
  if (workflow === 'managed') work.push('observe');
  // Files and Git read a workspace's project folder, so they need one.
  if (canChat) work.push('files', 'git');
  return [
    { section: 'work', pages: work },
    // These collections belong to the profile and need no workspace.
    { section: 'library', pages: ['knowledge', 'skills'] },
    { section: 'activity', pages: ['history', 'import', 'logs'] },
    { section: 'app', pages: ['settings', 'diagnostics'] },
  ];
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
const deviceStorage = (): LandingStorage => profileClientStateStorage;

/**
 * Host-backed storage, or device storage without a host; every access is guarded.
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
