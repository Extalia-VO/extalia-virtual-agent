/**
 * Knowledge note editing (W5 slice 2b; ADR 0024 amendment 2026-10-23 "safe note writes and memory
 * import", ADR 0027): read a note's full file, write it with compare-and-swap, list its history, roll
 * it back, and import a workspace's legacy memory notes. The host scopes every call to the caller's
 * profile and always writes as the user (`author: 'user'`); Extalia components never write through
 * these methods.
 *
 * These methods are optional and separate from `KNOWLEDGE_HOST_METHODS`: the Knowledge page shows with
 * the read methods alone and offers editing only when the host has these methods and its status says
 * the native core serves them (`KnowledgeStatus.editing`).
 *
 * Results are the daemon's (`@extalia/protocol` `daemonKnowledge.ts`: `knowledge.read`, `knowledge.write`,
 * `knowledge.history`, `knowledge.rollback`, `knowledge.importMemory`) forwarded unchanged. Every value a
 * client sends is validated here before the host acts on it.
 */
import {
  DAEMON_KNOWLEDGE_LIMITS, KNOWLEDGE_CONFLICT_REASONS, KNOWLEDGE_HISTORY_KINDS, KNOWLEDGE_IMPORT_OUTCOMES, KNOWLEDGE_WRITE_OUTCOMES,
  type DaemonKnowledgeOperations, type KnowledgeConflictReason, type KnowledgeHistoryEntry, type KnowledgeHistoryKind, type KnowledgeImportCounts, type KnowledgeImportedNote,
  type KnowledgeImportOutcome, type KnowledgeWriteOutcome, type KnowledgeWriteResult,
} from '@extalia/protocol';
import { normalizeKnowledgePath } from './knowledge.js';

export { KNOWLEDGE_CONFLICT_REASONS, KNOWLEDGE_HISTORY_KINDS, KNOWLEDGE_IMPORT_OUTCOMES, KNOWLEDGE_WRITE_OUTCOMES };
export type {
  KnowledgeConflictReason, KnowledgeHistoryEntry, KnowledgeHistoryKind, KnowledgeImportCounts, KnowledgeImportedNote, KnowledgeImportOutcome, KnowledgeWriteOutcome,
  KnowledgeWriteResult,
};

type Result<Op extends keyof DaemonKnowledgeOperations> = DaemonKnowledgeOperations[Op]['result'];

/** Edit methods of this module, in `AGENT_HOST_METHODS` order. All optional on `AgentHostApi`. */
export const KNOWLEDGE_EDIT_METHODS = ['readKnowledgeNote', 'writeKnowledgeNote', 'knowledgeHistory', 'rollbackKnowledgeNote', 'importMemoryNotes'] as const;
export type KnowledgeEditMethod = (typeof KNOWLEDGE_EDIT_METHODS)[number];
/** The methods note editing needs (memory import is separate). */
export const KNOWLEDGE_NOTE_EDIT_METHODS = ['readKnowledgeNote', 'writeKnowledgeNote', 'knowledgeHistory', 'rollbackKnowledgeNote'] as const satisfies readonly KnowledgeEditMethod[];

export const KNOWLEDGE_EDIT_LIMITS = {
  /**
   * Largest note the UI writes, in UTF-8 bytes. The daemon accepts up to 1 MiB, but a write travels in one
   * daemon frame and one Bridge request (both 1 MiB), and a larger note reads back truncated, so the UI
   * stays at the size `knowledge.read` returns whole.
   */
  contentBytes: DAEMON_KNOWLEDGE_LIMITS.readBytes,
  /** Note path: at most 1024 UTF-8 bytes and 32 folders (the walker's limits). */
  pathBytes: 1024,
  folders: 32,
  /** History entries per request (`knowledge.history` `limit`). */
  history: DAEMON_KNOWLEDGE_LIMITS.historyLimit,
  workspaceId: 64,
} as const;

/** Refusal shown when the native core does not serve editing yet; the UI hides the edit actions on it. */
export const KNOWLEDGE_EDIT_UNSUPPORTED = 'This native core does not support editing notes yet. Update Extalia.';
export const KNOWLEDGE_IMPORT_UNSUPPORTED = 'This native core does not support importing memory notes yet. Update Extalia.';

/**
 * `knowledge.read`: the whole file exactly as stored (front matter included) and the SHA-256 of all its bytes, which a
 * later write sends back as `expectedSha256`. `managed`: front matter says `managed_by: extalia`. A `truncated` file
 * must not be written back.
 */
export type KnowledgeNoteFile = Result<'knowledge.read'>;
/** A write as the user: `expectedSha256` is the hash of the read the edit started from, `null` for a new note. */
export interface KnowledgeWriteRequest { path: string; content: string; expectedSha256: string | null }
/** `knowledge.history`: the note's journal, newest first. */
export type KnowledgeHistory = Result<'knowledge.history'>;
/** Restore `toSha256` from the note's own history; `expectedSha256` is the version on screen (`null`: the note was deleted). */
export interface KnowledgeRollbackRequest { path: string; toSha256: string; expectedSha256: string | null }
export interface KnowledgeMemoryImportRequest { workspaceId: string; dryRun: boolean }
/** `knowledge.importMemory`: per legacy note where it goes (`Projects/<workspace>/Memory/<name>.md`) and what happens. */
export type KnowledgeMemoryImport = Result<'knowledge.importMemory'>;

const record = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
};
/** UTF-8 length without platform APIs (this module also runs where `TextEncoder` is not typed). Lone surrogates count 3. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
const SHA256 = /^[0-9a-f]{64}$/;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A note file path: a vault path (`normalizeKnowledgePath`) to a `.md` file within the walker's limits. */
export function normalizeKnowledgeNotePath(value: unknown): string {
  const path = normalizeKnowledgePath(value);
  const segments = path.split('/');
  if (!/^.+\.md$/i.test(segments[segments.length - 1]!) || segments.length - 1 > KNOWLEDGE_EDIT_LIMITS.folders || utf8Bytes(path) > KNOWLEDGE_EDIT_LIMITS.pathBytes) {
    throw new Error('Choose a note path that ends in .md, such as Knowledge/Topic.md.');
  }
  return path;
}

/** A version hash: lowercase hex SHA-256. */
export function normalizeKnowledgeSha256(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error('Invalid note version.');
  return value;
}

/** Note text: a string of at most `KNOWLEDGE_EDIT_LIMITS.contentBytes` UTF-8 bytes without NUL characters. */
export function normalizeKnowledgeContent(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\u0000')) throw new Error('Invalid note text.');
  if (utf8Bytes(value) > KNOWLEDGE_EDIT_LIMITS.contentBytes) throw new Error(`The note is larger than ${KNOWLEDGE_EDIT_LIMITS.contentBytes / 1024} KiB. Shorten it or edit it in another editor.`);
  return value;
}

/** A write: `expectedSha256` is required, `null` only for a note that must not exist yet (no blind overwrites). */
export function normalizeKnowledgeWriteRequest(value: unknown): KnowledgeWriteRequest {
  const input = record(value, 'Invalid note write.');
  const path = normalizeKnowledgeNotePath(input.path);
  const content = normalizeKnowledgeContent(input.content);
  if (input.expectedSha256 === undefined) throw new Error('A write must name the version it replaces.');
  const expectedSha256 = input.expectedSha256 === null ? null : normalizeKnowledgeSha256(input.expectedSha256);
  return { path, content, expectedSha256 };
}

export function normalizeKnowledgeRollbackRequest(value: unknown): KnowledgeRollbackRequest {
  const input = record(value, 'Invalid rollback.');
  if (input.expectedSha256 === undefined) throw new Error('A rollback must name the version it replaces.');
  const expectedSha256 = input.expectedSha256 === null ? null : normalizeKnowledgeSha256(input.expectedSha256);
  return { path: normalizeKnowledgeNotePath(input.path), toSha256: normalizeKnowledgeSha256(input.toSha256), expectedSha256 };
}

/** Workspace id (the host's `w_…`, a UUID, or a mock id) and whether to only preview; previews by default. */
export function normalizeKnowledgeMemoryImportRequest(value: unknown): KnowledgeMemoryImportRequest {
  const input = record(value, 'Invalid memory import.');
  if (typeof input.workspaceId !== 'string' || !WORKSPACE_ID.test(input.workspaceId)) throw new Error('Choose a workspace.');
  if (input.dryRun !== undefined && input.dryRun !== null && typeof input.dryRun !== 'boolean') throw new Error('Invalid memory import.');
  return { workspaceId: input.workspaceId, dryRun: input.dryRun !== false };
}
