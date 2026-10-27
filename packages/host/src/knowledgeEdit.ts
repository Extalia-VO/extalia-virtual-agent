/**
 * Knowledge note editing over the Rust core daemon (W5 slice 2b; ADR 0024 amendment 2026-10-23, ADR 0027):
 * `knowledge.read`, `knowledge.write`, `knowledge.history`, `knowledge.rollback` and `knowledge.importMemory`.
 *
 * - Capability-checked: an operation the daemon does not advertise fails with `KNOWLEDGE_EDIT_UNSUPPORTED` (or
 *   `KNOWLEDGE_IMPORT_UNSUPPORTED`), and `knowledgeStatus().editing` tells the page beforehand (`editingOf`).
 * - Writes, rollbacks and imports run in the knowledge service's sync queue: after the sync (or vault
 *   switch) before them, and a later sync waits for them. Reads wait for queued work like other reads.
 * - The host writes as the user only (`author: 'user'`); a write always names the version it replaces.
 * - Every client value is validated by `@extalia/platform`; daemon answers (validated by the wire contract)
 *   are forwarded unchanged. Failures are user-safe messages.
 */
import {
  KNOWLEDGE_EDIT_LIMITS, KNOWLEDGE_EDIT_UNSUPPORTED, KNOWLEDGE_IMPORT_UNSUPPORTED, normalizeKnowledgeMemoryImportRequest, normalizeKnowledgeNotePath,
  normalizeKnowledgeRollbackRequest, normalizeKnowledgeWriteRequest, type AgentHostApi, type KnowledgeEditing, type KnowledgeEditMethod, type KnowledgeHistory,
  type KnowledgeMemoryImport, type KnowledgeNoteFile, type KnowledgeWriteResult,
} from '@extalia/platform';
import type { DaemonOperations } from '@extalia/protocol';
import { DaemonRequestError, type DaemonClient } from './daemon/index.js';
import { KnowledgeError, userFacing, type KnowledgeService } from './knowledge.js';

/** Daemon operations of note editing; memory import is advertised separately. */
export const KNOWLEDGE_EDIT_OPS = ['knowledge.read', 'knowledge.write', 'knowledge.history', 'knowledge.rollback'] as const;
export const KNOWLEDGE_IMPORT_OP = 'knowledge.importMemory';
type EditOp = (typeof KNOWLEDGE_EDIT_OPS)[number] | typeof KNOWLEDGE_IMPORT_OP;

const READ_DEADLINE_MS = 30_000;
const WRITE_DEADLINE_MS = 60_000;
/** An import reads and writes every memory note of the workspace. */
const IMPORT_DEADLINE_MS = 5 * 60_000;

/** What the daemon serves of note editing, from its advertised operations. */
export function editingOf(capabilities: readonly string[]): KnowledgeEditing {
  return { notes: KNOWLEDGE_EDIT_OPS.every(op => capabilities.includes(op)), memoryImport: capabilities.includes(KNOWLEDGE_IMPORT_OP) };
}

/** Plain-language refusals of the write path by the daemon's stable reason. Never paths or note contents. */
const EDIT_REFUSALS: Record<string, string> = {
  invalid_path: 'This note path cannot be used in the vault.',
  too_large: 'The note is larger than the vault accepts.',
  not_utf8: 'The note text is not valid Unicode.',
  note_changed: 'The note changed while it was saved. Reload it and try again.',
  unsafe_path: 'A symbolic link, special file or hard link is on this note’s path, so Extalia does not write there.',
  unknown_version: 'That version is not in this note’s history any more.',
  history_unavailable: 'The note history cannot be read right now.',
};

/** The daemon reasons that mean "no such note". */
const NOT_FOUND = new Set(['note_not_found', 'node_not_found', 'not_found']);

function editFailure(error: unknown): Error {
  if (error instanceof DaemonRequestError && error.reason && EDIT_REFUSALS[error.reason]) {
    return new KnowledgeError(`${EDIT_REFUSALS[error.reason]} (${error.code}: ${error.reason})`);
  }
  return userFacing(error);
}

/** A client value the platform validator refused; its message is safe to show. */
function validated<T>(read: () => T): T {
  try { return read(); } catch (error) { throw new KnowledgeError(error instanceof Error ? error.message : 'Invalid request.'); }
}

type Params<O extends EditOp> = DaemonOperations[O]['params'];
type Result<O extends EditOp> = DaemonOperations[O]['result'];

function served(client: DaemonClient, op: EditOp): void {
  const ops = op === KNOWLEDGE_IMPORT_OP ? [op] : KNOWLEDGE_EDIT_OPS;
  if (!ops.every(item => client.capabilities.includes(item))) {
    throw new KnowledgeError(op === KNOWLEDGE_IMPORT_OP ? KNOWLEDGE_IMPORT_UNSUPPORTED : KNOWLEDGE_EDIT_UNSUPPORTED);
  }
}

export interface KnowledgeEditOptions {
  /** Ids of the workspaces of this host's profile; a memory import names one of them. */
  workspaces(): readonly string[];
}

export class KnowledgeEditService {
  constructor(private readonly knowledge: KnowledgeService, private readonly options: KnowledgeEditOptions) {}

  /** The whole note file, or `null` when the vault has no such note. */
  async read(rawPath: unknown): Promise<KnowledgeNoteFile | null> {
    const path = validated(() => normalizeKnowledgeNotePath(rawPath));
    try {
      const client = await this.knowledge.ready();
      served(client, 'knowledge.read');
      return await client.request('knowledge.read', { path }, READ_DEADLINE_MS);
    } catch (error) {
      if (error instanceof DaemonRequestError && error.reason && NOT_FOUND.has(error.reason)) return null;
      throw editFailure(error);
    }
  }

  async write(rawRequest: unknown): Promise<KnowledgeWriteResult> {
    const { path, content, expectedSha256 } = validated(() => normalizeKnowledgeWriteRequest(rawRequest));
    return this.exclusive('knowledge.write', { path, content, expectedSha256, author: 'user' }, WRITE_DEADLINE_MS);
  }

  async history(rawPath: unknown): Promise<KnowledgeHistory> {
    const path = validated(() => normalizeKnowledgeNotePath(rawPath));
    try {
      const client = await this.knowledge.ready();
      served(client, 'knowledge.history');
      return await client.request('knowledge.history', { path, limit: KNOWLEDGE_EDIT_LIMITS.history }, READ_DEADLINE_MS);
    } catch (error) {
      if (error instanceof DaemonRequestError && error.reason && NOT_FOUND.has(error.reason)) return { path, entries: [] };
      throw editFailure(error);
    }
  }

  async rollback(rawRequest: unknown): Promise<KnowledgeWriteResult> {
    const request = validated(() => normalizeKnowledgeRollbackRequest(rawRequest));
    return this.exclusive('knowledge.rollback', request, WRITE_DEADLINE_MS);
  }

  async importMemory(rawRequest: unknown): Promise<KnowledgeMemoryImport> {
    const { workspaceId, dryRun } = validated(() => normalizeKnowledgeMemoryImportRequest(rawRequest));
    if (!this.options.workspaces().includes(workspaceId)) throw new KnowledgeError('Unknown workspace.');
    return this.exclusive(KNOWLEDGE_IMPORT_OP, { workspaceId, dryRun }, IMPORT_DEADLINE_MS);
  }

  /** A changing operation in the sync queue. */
  private async exclusive<O extends 'knowledge.write' | 'knowledge.rollback' | typeof KNOWLEDGE_IMPORT_OP>(op: O, params: Params<O>, deadlineMs: number): Promise<Result<O>> {
    try {
      return await this.knowledge.exclusive(client => {
        served(client, op);
        return client.request(op, params, deadlineMs);
      });
    } catch (error) { throw editFailure(error); }
  }
}

/** The `AgentHostApi` edit methods over `service`. */
export function knowledgeEditHostMethods(service: KnowledgeEditService): Pick<Required<AgentHostApi>, KnowledgeEditMethod> {
  return {
    readKnowledgeNote: path => service.read(path),
    writeKnowledgeNote: request => service.write(request),
    knowledgeHistory: path => service.history(path),
    rollbackKnowledgeNote: request => service.rollback(request),
    importMemoryNotes: request => service.importMemory(request),
  };
}
