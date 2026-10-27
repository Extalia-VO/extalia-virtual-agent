/**
 * Knowledge vault folder (W5, ADR 0024 decision 5): which folder the profile's knowledge index reads.
 * The default is `<data>/vaults/<profile>`; a user may instead choose an existing folder, for
 * example an Obsidian vault. Extalia never deletes or rewrites a user's notes there; only notes
 * marked `managed_by: extalia` are edited automatically, and a `.obsidian` folder is left untouched.
 *
 * The host validates the folder itself (absolute, an existing directory, not a symbolic link, not
 * the disk root or the home folder, not inside or around the Extalia data folder) and passes it to
 * the Rust core as `--vault-root`. This module only bounds what a client sends and names the host
 * event that tells the Knowledge page to refresh. Pure functions only.
 */
import type { ExtaliaEvent } from '@extalia/protocol';

/** How the host notices edits made outside Extalia: native recursive watching, polling, or not at all. */
export type KnowledgeVaultWatch = 'watching' | 'polling' | 'off';

/** The knowledge vault setting as Settings shows it. */
export interface KnowledgeVaultSettings {
  /** `default`: `<data>/vaults/<profile>`; `custom`: a folder the user chose. */
  kind: 'default' | 'custom';
  /** `vaults/<profile>` or `custom:<folder name>`, as the native core reports the root. */
  label: string;
  /** The chosen folder (custom only). */
  path?: string;
  /** False while the chosen folder is missing or no longer passes the checks; the vault is then unavailable (never another folder). */
  available: boolean;
  /** Why the chosen folder cannot be used, in plain language. */
  problem?: string;
  /** The folder contains `.obsidian`: an Obsidian vault. Expected and fine; Extalia leaves `.obsidian` untouched. */
  obsidian: boolean;
  /** How edits made outside Extalia reach the index right now. */
  watch: KnowledgeVaultWatch;
}

/** Host methods of this module, in `AGENT_HOST_METHODS` order. Optional on `AgentHostApi` (native core only). */
export const KNOWLEDGE_VAULT_HOST_METHODS = ['knowledgeSettings', 'setKnowledgeVaultRoot'] as const;

/** Longest folder path a client may send. */
export const KNOWLEDGE_VAULT_PATH_MAX = 4_096;

/**
 * A vault folder from a client: `null` (or `undefined`) for the default vault, otherwise an absolute
 * path (POSIX, a Windows drive path or a UNC path). The host checks the folder itself.
 */
export function normalizeKnowledgeVaultRoot(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('Choose a folder for the knowledge vault.');
  const folder = value.trim();
  if (!folder) throw new Error('Choose a folder for the knowledge vault.');
  if (folder.length > KNOWLEDGE_VAULT_PATH_MAX || /\p{Cc}/u.test(folder)) throw new Error('Invalid folder path.');
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(folder)) throw new Error('Enter the full path of the vault folder.');
  return folder;
}

/**
 * Live host events (`AgentHostApi.subscribe`) about the knowledge index use this session id and a
 * `session.updated` body (`revision` `knowledge-<generation>`). They carry no note data: the page
 * reloads the status and its results. Not stored, and not a real session.
 */
export const KNOWLEDGE_EVENT_SESSION_ID = 'extalia.knowledge';

/** Whether `event` says the knowledge index changed (an external edit was indexed, or the vault folder changed). */
export function isKnowledgeIndexEvent(event: Pick<ExtaliaEvent, 'sessionId' | 'body'>): boolean {
  return event.sessionId === KNOWLEDGE_EVENT_SESSION_ID && event.body.type === 'session.updated';
}
