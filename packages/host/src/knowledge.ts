/**
 * Knowledge host service (W5; ADR 0024 and its 2026-10-23 amendment, ADR 0027): the calling
 * profile's vault index, served by the Rust core daemon.
 *
 * - Offered only with the native core flag on (`nativeCore: 'rust'`); with the TypeScript core the
 *   host leaves the knowledge methods out and the Knowledge page stays hidden.
 * - Results are the daemon's (`daemonKnowledge.ts`) forwarded unchanged; the host adds only the
 *   skipped-file list of the latest sync it ran (memory only, empty after a restart).
 * - `knowledgeStatus` never throws: an unavailable daemon (or one that does not serve the index) is
 *   an `unavailable` status with a reason. Every other method fails with a user-safe message.
 * - Every client value is validated by `@extalia/platform` before anything is sent. No method takes a
 *   profile or an absolute path; the daemon serves exactly one profile.
 * - A long sync holds the daemon's knowledge thread (knowledge requests run there one at a time, in
 *   order), so other knowledge requests wait for it here instead of running into their deadline (a
 *   timed-out request ends the daemon connection). Mission, permission and skill requests are answered
 *   meanwhile, out of order, by request id (ADR 0020 note of 2026-10-24).
 * - Opening the page refreshes a stale index: when the latest sync of this host is older than
 *   `autoSyncAfterMs` and the vault exists, `knowledgeStatus` runs an incremental sync first (waiting
 *   at most `autoSyncWaitMs` for it). It never creates the vault; the first sync is the user's.
 */
import {
  KNOWLEDGE_UI_LIMITS, normalizeKnowledgeCursor, normalizeKnowledgeGraphDepth, normalizeKnowledgeNodeId, normalizeKnowledgeNodeLookup, normalizeKnowledgeOverviewOptions,
  normalizeKnowledgeQuery, normalizeKnowledgeSyncMode, type AgentHostApi, type KnowledgeGraph, type KnowledgeLinkPage, type KnowledgeNodeLookup, type KnowledgeNoteResult,
  type KnowledgeOverview, type KnowledgeOverviewOptions, type KnowledgeSearchResult, type KnowledgeSkippedFile, type KnowledgeStatus, type KnowledgeSyncMode,
  type KnowledgeSyncOutcome, type KnowledgeSyncReport, type KnowledgeEditing,
} from '@extalia/platform';
import { DAEMON_KNOWLEDGE_LIMITS, DAEMON_KNOWLEDGE_OPS, type DaemonOperations } from '@extalia/protocol';
import { DaemonRequestError, DaemonUnavailableError, type DaemonClient, type DaemonSidecar } from './daemon/index.js';
import { editingOf } from './knowledgeEdit.js';

/** The knowledge methods on `AgentHostApi`. */
export type KnowledgeHostMethod =
  'knowledgeStatus' | 'syncKnowledge' | 'knowledgeNode' | 'knowledgeLinks' | 'knowledgeBacklinks' | 'searchKnowledge' | 'knowledgeGraph' | 'knowledgeOverview';
/** Operations every knowledge method needs. Optional ones (an older daemon does not advertise them): the overview and note editing (`knowledgeEdit.ts`, `editing` in the status). */
const OPTIONAL_KNOWLEDGE_OPS: readonly string[] = ['knowledge.overview', 'knowledge.read', 'knowledge.write', 'knowledge.history', 'knowledge.rollback', 'knowledge.importMemory'];
const REQUIRED_KNOWLEDGE_OPS = DAEMON_KNOWLEDGE_OPS.filter(op => !OPTIONAL_KNOWLEDGE_OPS.includes(op));
/** Default: refresh the index when the page asks for status and this host has not synced for 5 minutes. */
export const KNOWLEDGE_AUTO_SYNC_AFTER_MS = 5 * 60_000;
/** How long a status request waits for that refresh before answering with the current state. */
export const KNOWLEDGE_AUTO_SYNC_WAIT_MS = 1_500;
/** Deadlines: a sync walks the whole vault; a timed-out request ends the daemon connection, so be generous. */
const SYNC_DEADLINE_MS = 5 * 60_000;
const READ_DEADLINE_MS = 30_000;
/** The vault label of the host's profile when the daemon cannot report it. */
const VAULT_LABEL = 'vaults/default';

/** A refusal with a message safe to show (Desktop and the Bridge forward `UserError` messages). */
export class KnowledgeError extends Error {
  override readonly name = 'UserError';
}

class NotServedError extends Error {}

/** The chosen vault folder cannot be used (missing or no longer valid): the vault is unavailable, never another folder. */
export class VaultUnavailableError extends KnowledgeError {}

/** Plain-language refusals by the daemon's stable reason. Never paths or note contents. */
const REFUSALS: Record<string, string> = {
  index_locked: 'Another Extalia process is using the knowledge index. Try again in a moment.',
  index_unavailable: 'The knowledge index cannot be opened right now.',
  index_newer_schema: 'The knowledge index was written by a newer version of Extalia. Update Extalia, or rebuild the index.',
  index_corrupt: 'The knowledge index is damaged. Rebuild it from your notes.',
  vault_unavailable: 'The vault folder is missing or cannot be read.',
  vault_too_large: 'The vault has more notes or files than the index accepts.',
  note_changed: 'The note changed while it was read. Try again.',
  node_not_found: 'That note is no longer in the index. Sync and try again.',
  result_too_large: 'The result is too large to show.',
  io_failure: 'The vault could not be read.',
};

function refusal(error: DaemonRequestError): KnowledgeError {
  const known = error.reason ? REFUSALS[error.reason] : undefined;
  const code = error.reason ? `${error.code}: ${error.reason}` : error.code;
  return new KnowledgeError(known ? `${known} (${code})` : `The native core refused this knowledge request (${code}).`);
}

function unavailable(code: string): KnowledgeError {
  if (code === 'not-served') return new KnowledgeError('This native core does not serve the knowledge index. Update Extalia.');
  return new KnowledgeError(`The native core is unavailable (${code}), so the knowledge index cannot be read. Try again, or restart Extalia.`);
}

/** A client value the platform validator refused; its message is safe to show. */
function validated<T>(read: () => T): T {
  try { return read(); } catch (error) { throw new KnowledgeError(error instanceof Error ? error.message : 'Invalid request.'); }
}

type KnowledgeOp = (typeof DAEMON_KNOWLEDGE_OPS)[number];
type Params<O extends KnowledgeOp> = DaemonOperations[O]['params'];
type Result<O extends KnowledgeOp> = DaemonOperations[O]['result'];

export interface KnowledgeServiceOptions {
  daemon: DaemonSidecar;
  /** Refresh a stale index on status (ms since this host's latest sync); `Infinity` turns it off. */
  autoSyncAfterMs?: number;
  /** How long a status request waits for that refresh. */
  autoSyncWaitMs?: number;
  now?(): number;
  log?(line: string): void;
  /**
   * The vault folder setting (`knowledgeVault.ts`): `check()` throws `VaultUnavailableError` while the chosen
   * folder cannot be used; `label()` names the root for an unavailable status.
   */
  vault?: { check(): void; label(): string };
}

export class KnowledgeService {
  /** Skipped files of the latest sync this host ran (at most `reportItems`). */
  private skipped: KnowledgeSkippedFile[] = [];
  /** When this host last finished a sync; undefined until the first one. */
  private syncedAt: number | undefined;
  private syncing: Promise<unknown> | undefined;
  /** A queued sync that has not reached the daemon yet: a change seen now is still included in it. */
  private waiting: Promise<KnowledgeSyncReport> | undefined;
  /** What the connected daemon serves of note editing (`knowledgeEdit.ts`); reported with the status. */
  private editing: KnowledgeEditing | undefined;

  constructor(private readonly options: KnowledgeServiceOptions) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private async client(): Promise<DaemonClient> {
    const client = await this.options.daemon.connect();
    if (!REQUIRED_KNOWLEDGE_OPS.every(op => client.capabilities.includes(op))) throw new NotServedError();
    this.editing = editingOf(client.capabilities);
    this.options.vault?.check();
    return client;
  }

  /** One daemon request as is: rejects with `NotServedError`, `DaemonUnavailableError` or `DaemonRequestError`. */
  private async request<O extends KnowledgeOp>(op: O, params: Params<O>, deadlineMs: number): Promise<Result<O>> {
    if (op !== 'knowledge.sync') await this.syncing?.catch(() => undefined);
    return (await this.client()).request(op, params, deadlineMs);
  }

  /** One daemon request for a user action; every failure becomes a user-safe message. */
  private async call<O extends KnowledgeOp>(op: O, params: Params<O>, deadlineMs = READ_DEADLINE_MS): Promise<Result<O>> {
    try { return await this.request(op, params, deadlineMs); } catch (error) { throw userFacing(error); }
  }

  /** Index state for the page. Never throws: an unavailable daemon or index is a status with a reason. */
  async status(): Promise<KnowledgeStatus> {
    let current: Result<'knowledge.status'>;
    try {
      current = await this.request('knowledge.status', {}, READ_DEADLINE_MS);
    } catch (error) {
      return { state: 'unavailable', reason: unavailableReason(error), vaultRoot: this.options.vault?.label() ?? VAULT_LABEL, vaultPresent: false, generation: 0, skipped: [] };
    }
    if (this.autoSyncDue(current)) {
      const sync = this.runSync('incremental').then(() => true, () => true);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = await Promise.race([sync, new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), this.options.autoSyncWaitMs ?? KNOWLEDGE_AUTO_SYNC_WAIT_MS); })]);
      clearTimeout(timer);
      if (waited) {
        try { current = await this.request('knowledge.status', {}, READ_DEADLINE_MS); } catch { /* Keep the status read before the sync. */ }
      } else this.options.log?.('Knowledge: the index refresh is still running; the page shows the previous state.');
    }
    return this.withSkipped(current);
  }

  /** Whether opening the page should refresh the index first (never for a vault that does not exist yet). */
  private autoSyncDue(current: Result<'knowledge.status'>): boolean {
    const after = this.options.autoSyncAfterMs ?? KNOWLEDGE_AUTO_SYNC_AFTER_MS;
    if (!Number.isFinite(after) || this.syncing || current.state !== 'ready' || !current.vaultPresent) return false;
    return this.syncedAt === undefined || this.now() - this.syncedAt >= after;
  }

  /** The daemon reports the totals; the list is the host's, and only while the daemon still knows that sync. */
  private withSkipped(current: Result<'knowledge.status'>): KnowledgeStatus {
    return { ...current, skipped: current.lastSync ? structuredClone(this.skipped) : [], ...(this.editing ? { editing: { ...this.editing } } : {}) };
  }

  /** Note editing (`knowledgeEdit.ts`): a client for a read, after the queued syncs and writes. */
  async ready(): Promise<DaemonClient> {
    await this.syncing?.catch(() => undefined);
    return this.client();
  }

  /**
   * Note editing (`knowledgeEdit.ts`): run a write in the sync queue, after the sync or vault switch before it;
   * a sync requested later waits for it (and reads the vault after the write). Failures reject as they are.
   */
  exclusive<T>(task: (client: DaemonClient) => Promise<T>): Promise<T> {
    const previous = this.syncing;
    const run = (async () => {
      await previous?.catch(() => undefined);
      return task(await this.client());
    })();
    this.syncing = run;
    this.waiting = undefined;
    void run.catch(() => undefined).finally(() => { if (this.syncing === run) this.syncing = undefined; });
    return run;
  }

  /** One sync at a time: a second request runs after the one before it. */
  private runSync(mode: KnowledgeSyncMode): Promise<KnowledgeSyncReport> {
    const previous = this.syncing;
    // The run checks itself after its first await, when `self.run` is set.
    const self: { run?: Promise<KnowledgeSyncReport> } = {};
    const run = (async () => {
      await previous?.catch(() => undefined);
      if (this.waiting === self.run) this.waiting = undefined;
      const report = await this.request('knowledge.sync', { mode }, SYNC_DEADLINE_MS);
      this.skipped = report.skipped.slice(0, DAEMON_KNOWLEDGE_LIMITS.reportItems);
      this.syncedAt = this.now();
      return report;
    })();
    self.run = run;
    this.syncing = run;
    if (previous) this.waiting = run;
    void run.catch(() => undefined).finally(() => { if (this.syncing === run) this.syncing = undefined; });
    return run;
  }

  /**
   * The vault watcher's sync: incremental, and joined with a sync that is queued but not sent yet
   * (it reads the vault after this change anyway). Failures reject as they are (the watcher backs off).
   */
  syncChanges(): Promise<KnowledgeSyncReport> {
    return this.waiting ?? this.runSync('incremental');
  }

  /**
   * Switch the vault folder in the sync queue: after the running sync, `apply()` restarts the daemon
   * with the new root, then the index is rebuilt from that vault when it exists (a default vault that
   * does not exist yet is not created). Resolves to the rebuild report, or `undefined` without one.
   */
  switchVault(apply: () => Promise<void>): Promise<KnowledgeSyncReport | undefined> {
    const previous = this.syncing;
    const run = (async () => {
      await previous?.catch(() => undefined);
      this.skipped = [];
      this.syncedAt = undefined;
      await apply();
      // Not `request()`: it would wait for this very run.
      const client = await this.client();
      if (!(await client.request('knowledge.status', {}, READ_DEADLINE_MS)).vaultPresent) return undefined;
      const report = await client.request('knowledge.sync', { mode: 'rebuild' }, SYNC_DEADLINE_MS);
      this.skipped = report.skipped.slice(0, DAEMON_KNOWLEDGE_LIMITS.reportItems);
      this.syncedAt = this.now();
      return report;
    })();
    this.syncing = run;
    this.waiting = undefined;
    void run.catch(() => undefined).finally(() => { if (this.syncing === run) this.syncing = undefined; });
    return run;
  }

  async sync(rawMode?: unknown): Promise<KnowledgeSyncOutcome> {
    const mode = validated(() => normalizeKnowledgeSyncMode(rawMode));
    let report: KnowledgeSyncReport;
    try { report = await this.runSync(mode); } catch (error) { throw userFacing(error); }
    const current = await this.call('knowledge.status', {});
    return { report, status: this.withSkipped(current) };
  }

  /** A note, or `null` when no visible note matches (missing and not permitted look the same). */
  async node(rawLookup: unknown): Promise<KnowledgeNoteResult | null> {
    const lookup: KnowledgeNodeLookup = validated(() => normalizeKnowledgeNodeLookup(rawLookup));
    try {
      return await this.request('knowledge.node', 'nodeId' in lookup ? { nodeId: lookup.nodeId } : { path: lookup.path }, READ_DEADLINE_MS);
    } catch (error) {
      if (error instanceof DaemonRequestError && error.reason === 'node_not_found') return null;
      throw userFacing(error);
    }
  }

  async links(rawNodeId: unknown, rawCursor?: unknown): Promise<KnowledgeLinkPage> {
    const nodeId = validated(() => normalizeKnowledgeNodeId(rawNodeId)), cursor = validated(() => normalizeKnowledgeCursor(rawCursor));
    return this.call('knowledge.links', { nodeId, cursor, limit: KNOWLEDGE_UI_LIMITS.linkPage });
  }

  async backlinks(rawNodeId: unknown, rawCursor?: unknown): Promise<KnowledgeLinkPage> {
    const nodeId = validated(() => normalizeKnowledgeNodeId(rawNodeId)), cursor = validated(() => normalizeKnowledgeCursor(rawCursor));
    return this.call('knowledge.backlinks', { nodeId, cursor, limit: KNOWLEDGE_UI_LIMITS.linkPage });
  }

  async search(rawQuery: unknown): Promise<KnowledgeSearchResult> {
    const query = validated(() => normalizeKnowledgeQuery(rawQuery));
    return this.call('knowledge.search', { query, limit: KNOWLEDGE_UI_LIMITS.searchResults });
  }

  async graph(rawNodeId: unknown, rawDepth?: unknown): Promise<KnowledgeGraph> {
    const nodeId = validated(() => normalizeKnowledgeNodeId(rawNodeId)), depth = validated(() => normalizeKnowledgeGraphDepth(rawDepth));
    return this.call('knowledge.graph', { nodeId, depth, limit: KNOWLEDGE_UI_LIMITS.graphNodes });
  }

  /** The whole vault graph; needs a daemon that advertises `knowledge.overview`. */
  async overview(rawOptions?: unknown): Promise<KnowledgeOverview> {
    const options: KnowledgeOverviewOptions = validated(() => normalizeKnowledgeOverviewOptions(rawOptions));
    try {
      await this.syncing?.catch(() => undefined);
      const client = await this.client();
      if (!client.capabilities.includes('knowledge.overview')) throw new KnowledgeError('This native core does not serve the knowledge graph overview yet. Update Extalia.');
      return await client.request('knowledge.overview', options, READ_DEADLINE_MS);
    } catch (error) { throw userFacing(error); }
  }
}

/** Any failure as a user-safe error. */
export function userFacing(error: unknown): Error {
  if (error instanceof KnowledgeError) return error;
  if (error instanceof DaemonRequestError) return refusal(error);
  if (error instanceof DaemonUnavailableError) return unavailable(error.code);
  if (error instanceof NotServedError) return unavailable('not-served');
  return new KnowledgeError('The knowledge index could not answer. Try again.');
}

/** A stable reason for an `unavailable` status: why the native core cannot answer. */
function unavailableReason(error: unknown): string {
  if (error instanceof VaultUnavailableError) return 'vault_unavailable';
  if (error instanceof NotServedError) return 'native_core_not_serving_knowledge';
  if (error instanceof DaemonUnavailableError) return `native_core_${error.code}`;
  if (error instanceof DaemonRequestError) return error.reason ?? `native_core_${error.code}`;
  return 'native_core_unavailable';
}

/** The `AgentHostApi` knowledge methods over `service`. */
export function knowledgeHostMethods(service: KnowledgeService): Pick<Required<AgentHostApi>, KnowledgeHostMethod> {
  return {
    knowledgeStatus: () => service.status(),
    syncKnowledge: mode => service.sync(mode),
    knowledgeNode: lookup => service.node(lookup),
    knowledgeLinks: (nodeId, cursor) => service.links(nodeId, cursor),
    knowledgeBacklinks: (nodeId, cursor) => service.backlinks(nodeId, cursor),
    searchKnowledge: query => service.search(query),
    knowledgeGraph: (nodeId, depth) => service.graph(nodeId, depth),
    knowledgeOverview: options => service.overview(options),
  };
}
