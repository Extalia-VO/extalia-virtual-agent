import type { ExtaliaEvent } from '@extalia/protocol';
import type { AgentHostApi, AgentHostMethod } from './agentHost.js';

/**
 * Platform capabilities. Application code asks for a capability instead of
 * checking which host it runs in; Desktop implements capabilities natively,
 * Web through browser APIs or the local Extalia Bridge. A missing capability
 * is reported as unavailable, never emulated.
 */

export type HostKind = 'desktop' | 'web';

export interface DirectorySelection {
  /** Display name of the folder the user chose. */
  name: string;
  /** Absolute host path. Browsers do not reveal it, so Web selections omit it. */
  path?: string;
}

export interface FileSystemCapability {
  /** Ask the user to choose a folder. Resolves to null when the user cancels. */
  selectDirectory(): Promise<DirectorySelection | null>;
}

export interface TerminalCapability {
  /** Start a command inside a workspace root after the user approved it. */
  run(request: { workspaceRoot: string; command: string }): Promise<{ exitCode: number }>;
}

export interface GitCapability {
  status(workspaceRoot: string): Promise<{ branch?: string; changedFiles: number }>;
}

export interface SecureStorageCapability {
  /** Store a secret under an opaque reference; the secret never returns to the renderer in bulk. */
  set(reference: string, secret: string): Promise<void>;
  has(reference: string): Promise<boolean>;
  delete(reference: string): Promise<void>;
}

export interface NotificationCapability {
  notify(notification: { title: string; body?: string }): Promise<void>;
}

export type UpdateChannel = 'stable' | 'beta';

/**
 * Update state shared by Desktop (GitHub Releases through the app updater) and
 * the npm-installed Bridge (`npm i -g <package>@latest`).
 */
export interface UpdateStatus {
  current: string;
  latest?: string;
  channel: UpdateChannel;
  state: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'installing' | 'error' | 'unsupported';
  /** Download progress, 0–1, while downloading. */
  progress?: number;
  /** Why updates are unsupported or failed, safe to show. */
  detail?: string;
  /** Command the user can run themselves (npm installs). */
  command?: string;
  /** Seconds until an automatic restart, when one is scheduled. */
  restartInSeconds?: number;
}

export interface UpdateCapability {
  status(): Promise<UpdateStatus>;
  /** Ask the release feed now. */
  check(): Promise<UpdateStatus>;
  /** Install a downloaded or available update and restart at a safe point. */
  install(): Promise<void>;
  /** Cancel a scheduled automatic restart; the update installs on the next quit. */
  postpone(): Promise<void>;
  onStatus(listener: (status: UpdateStatus) => void): () => void;
}

export interface PlatformCapabilities {
  filesystem?: FileSystemCapability;
  terminal?: TerminalCapability;
  git?: GitCapability;
  secureStorage?: SecureStorageCapability;
  notifications?: NotificationCapability;
  updater?: UpdateCapability;
  /** Runs Extalia Native agents (Desktop main process or the local Bridge). */
  agents?: AgentHostApi;
}

export type CapabilityId = keyof PlatformCapabilities;
export const CAPABILITY_IDS: readonly CapabilityId[] = ['agents', 'filesystem', 'terminal', 'git', 'secureStorage', 'notifications', 'updater'];

export interface HostInfo {
  /** `web` covers both a static web build and the web client served by the local Bridge. */
  kind: HostKind;
  appVersion: string;
  /** Operating system family when the host knows it. */
  os?: 'macos' | 'windows' | 'linux' | 'other';
  arch?: string;
  /** Desktop shell runtime version, for diagnostics. */
  shellVersion?: string;
}

export interface Platform {
  info: HostInfo;
  capabilities: PlatformCapabilities;
}

/**
 * Contract between the Desktop preload script and the renderer, exposed as
 * `window.extaliaDesktop`. Each method maps to one audited IPC channel.
 */
export interface DesktopHostApi {
  info(): Promise<HostInfo>;
  selectDirectory(): Promise<DirectorySelection | null>;
  agents: {
    call(method: AgentHostMethod, args: unknown[]): Promise<unknown>;
    onEvent(listener: (event: ExtaliaEvent) => void): () => void;
  };
  updater: {
    status(): Promise<UpdateStatus>;
    check(): Promise<UpdateStatus>;
    install(): Promise<void>;
    postpone(): Promise<void>;
    onStatus(listener: (status: UpdateStatus) => void): () => void;
  };
}
export const DESKTOP_HOST_GLOBAL = 'extaliaDesktop';

export type CapabilityStatus = 'available' | 'requires-bridge' | 'unavailable';

/** Status of every capability for diagnostics and feature gating. */
export function describeCapabilities(platform: Platform): { id: CapabilityId; status: CapabilityStatus }[] {
  return CAPABILITY_IDS.map(id => {
    if (platform.capabilities[id]) return { id, status: 'available' };
    // Native-only capabilities can reach a browser through the local Bridge.
    const bridgeable = platform.info.kind === 'web' && (id === 'agents' || id === 'terminal' || id === 'git' || id === 'secureStorage');
    return { id, status: bridgeable ? 'requires-bridge' : 'unavailable' };
  });
}
