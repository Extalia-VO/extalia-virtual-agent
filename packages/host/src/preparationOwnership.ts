import {
  DAEMON_PREPARATION_OPS, parseDaemonFrame,
  type DaemonPreparationAdmission, type DaemonPreparationBegin, type DaemonPreparationInspection, type DaemonPreparationObservationRecord,
} from '@extalia/protocol';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { DaemonRequestError, DaemonUnavailableError, type DaemonClient } from './daemon/client.js';
import { isNotFound, writeJsonAtomic } from './jsonStore.js';

const SCHEMA = 'extalia.native-preparation.v1';
const MAX_PENDING = 128;
const MAX_BYTES = 1024 * 1024;
const VALIDATION_ID = '00000000-0000-4000-8000-000000000001';
const metadataProblem = () => new Error('Native preparation ownership metadata is unavailable.');
const pendingProblem = () => new Error('This scope has active or unresolved native mission preparation.');
const malformedReply = () => new DaemonUnavailableError('malformed_reply');
const sameScope = (request: DaemonPreparationBegin, admission: DaemonPreparationAdmission) => request.invocationId === admission.invocationId
  && request.missionId === admission.missionId && request.supervisorId === admission.supervisorId
  && request.canonicalWorkspaceId === admission.canonicalWorkspaceId && request.sessionId === admission.sessionId
  && request.workspaceId === admission.workspaceId && request.connectionIds.length === admission.connectionIds.length
  && request.connectionIds.every((id, index) => id === admission.connectionIds[index]);
const validate = (kind: 'request' | 'response', op: 'preparation.begin' | 'preparation.observe' | 'preparation.inspect', value: unknown) => parseDaemonFrame({
  schemaVersion: 1, kind, requestId: VALIDATION_ID, op, [kind === 'request' ? 'params' : 'result']: value,
}).ok;
const clone = (params: DaemonPreparationBegin): DaemonPreparationBegin => Object.freeze({
  invocationId: params.invocationId, missionId: params.missionId, supervisorId: params.supervisorId,
  canonicalWorkspaceId: params.canonicalWorkspaceId, sessionId: params.sessionId, workspaceId: params.workspaceId,
  connectionIds: Object.freeze([...params.connectionIds]) as unknown as string[],
});
const checkClient = (client: DaemonClient) => { if (!client.usable) throw new DaemonUnavailableError(client.failure ?? 'shutting_down'); };

/** Local preparation promise ownership only; it proves no child or remote settlement. */
export interface OwnedPreparation { check(): void; settle(): Promise<void> }

/** Durable scope blockers for the pre-admission portion of native mission start. */
export class PreparationOwnership {
  private readonly pending = new Map<string, DaemonPreparationBegin>();
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly inspections = new Set<Promise<unknown>>();
  private closePromise?: Promise<void>;
  private constructor(private readonly file: string) {}

  static async open(file: string, recover?: () => Promise<DaemonClient>): Promise<PreparationOwnership> {
    const ownership = new PreparationOwnership(file);
    await ownership.load();
    if (ownership.pending.size && recover) await ownership.recover(recover);
    return ownership;
  }
  hasUnresolved(): boolean { return this.pending.size > 0; }
  /** Detached metadata; callers must never use it as proof of settlement. */
  copiedSnapshot(): DaemonPreparationBegin[] { return [...this.pending.values()].map(entry => ({ ...entry, connectionIds: [...entry.connectionIds] })); }

  /** Inspect only the selected inactive entries; no observation, replay or force-clear. */
  recheckInactive(invocationIds: readonly string[], connect: () => Promise<DaemonClient>, active: (sessionId: string) => boolean): Promise<{ inspected: number; retired: number; status: 'checked' | 'unsupported' | 'unavailable'; skippedActive: number }> {
    const work = this.inspectInactive(invocationIds, connect, active);
    this.inspections.add(work);
    void work.then(() => this.inspections.delete(work), () => this.inspections.delete(work));
    return work;
  }

  private async inspectInactive(invocationIds: readonly string[], connect: () => Promise<DaemonClient>, active: (sessionId: string) => boolean): Promise<{ inspected: number; retired: number; status: 'checked' | 'unsupported' | 'unavailable'; skippedActive: number }> {
    let inspected = 0, retired = 0, skippedActive = 0;
    let status: 'checked' | 'unsupported' | 'unavailable' = 'checked';
    const summary = () => ({ inspected, retired, status, skippedActive });
    // Capture entry identities before connecting; replacements are never retired by old evidence.
    const entries = invocationIds.map(id => this.pending.get(id)).filter((entry): entry is DaemonPreparationBegin => !!entry);
    const eligible = (entry: DaemonPreparationBegin) => !this.closed && this.pending.get(entry.invocationId) === entry && !active(entry.sessionId);
    if (!entries.some(eligible)) { skippedActive = entries.filter(entry => active(entry.sessionId)).length; return summary(); }
    let client: DaemonClient;
    try { client = await connect(); } catch { status = 'unavailable'; return summary(); }
    if (this.closed || !client.usable) { status = 'unavailable'; return summary(); }
    if (!client.capabilities.includes('preparation.inspect')) { status = 'unsupported'; return summary(); }
    for (const entry of entries) {
      if (!eligible(entry)) { if (active(entry.sessionId)) skippedActive++; continue; }
      try {
        checkClient(client);
        inspected++;
        const result: DaemonPreparationInspection = await client.request('preparation.inspect', { invocationId: entry.invocationId });
        if (!eligible(entry)) { if (active(entry.sessionId)) skippedActive++; continue; }
        checkClient(client);
        if (validate('response', 'preparation.inspect', result) && sameScope(entry, result.admission) && result.observation
          && result.observation.invocationId === entry.invocationId && result.observation.admissionDigest === result.admission.admissionDigest
          && result.observation.kind === 'local-preparation-settled' && Date.parse(result.observation.recordedAt) >= Date.parse(result.admission.admittedAt)) {
          await this.persist(entry, () => eligible(entry));
          if (!this.closed && !this.pending.has(entry.invocationId)) retired++;
          else if (active(entry.sessionId)) skippedActive++;
        }
      } catch { status = 'unavailable'; /* Uncertain evidence retains the exact write-ahead guard. */ }
      if (this.closed) break;
    }
    return summary();
  }

  assertClear(sessionId?: string, connectionIds: readonly string[] = [], exceptInvocationId?: string): void {
    this.checkOpen();
    for (const entry of this.pending.values()) if (entry.invocationId !== exceptInvocationId
      && ((sessionId !== undefined && entry.sessionId === sessionId) || entry.connectionIds.some(id => connectionIds.includes(id)))) throw pendingProblem();
  }
  assertWorkspaceClear(workspaceId: string): void {
    this.checkOpen();
    if ([...this.pending.values()].some(entry => entry.workspaceId === workspaceId)) throw pendingProblem();
  }
  async begin(client: DaemonClient, params: DaemonPreparationBegin): Promise<OwnedPreparation> {
    this.checkOpen(); checkClient(client);
    if (!DAEMON_PREPARATION_OPS.every(op => client.capabilities.includes(op))) throw new DaemonUnavailableError('missing_capability');
    if (!validate('request', 'preparation.begin', params)) throw new DaemonRequestError('invalid_request');
    const request = clone(params);
    this.assertClear(request.sessionId, request.connectionIds);
    if (this.pending.has(request.invocationId)) throw pendingProblem();
    if (this.pending.size >= MAX_PENDING) throw new DaemonRequestError('capacity_exceeded');
    this.pending.set(request.invocationId, request);
    await this.persist();
    this.checkOpen(); checkClient(client);
    let admission: DaemonPreparationAdmission;
    try { admission = await client.request('preparation.begin', request); }
    catch (error) {
      this.checkOpen();
      if (error instanceof DaemonRequestError && ['invalid_request', 'conflict', 'capacity_exceeded'].includes(error.code)) { await this.remove(request); this.checkOpen(); }
      throw error;
    }
    this.checkOpen(); checkClient(client);
    if (!validate('response', 'preparation.begin', admission) || !sameScope(request, admission)) throw malformedReply();
    const digest = admission.admissionDigest, admittedAt = admission.admittedAt;
    const check = () => { this.checkOpen(); checkClient(client); if (this.pending.get(request.invocationId) !== request) throw pendingProblem(); this.assertClear(request.sessionId, request.connectionIds, request.invocationId); };
    let completion: Promise<void> | undefined;
    return { check, settle: () => this.closed ? Promise.reject(new DaemonUnavailableError('shutting_down')) : completion ??= (async () => {
      check();
      const observation: DaemonPreparationObservationRecord = await client.request('preparation.observe', { invocationId: request.invocationId, admissionDigest: digest, kind: 'local-preparation-settled' });
      this.checkOpen(); checkClient(client);
      if (!validate('response', 'preparation.observe', observation) || observation.invocationId !== request.invocationId
        || observation.admissionDigest !== digest || Date.parse(observation.recordedAt) < Date.parse(admittedAt)) throw malformedReply();
      await this.remove(request); this.checkOpen();
    })() };
  }
  close(): Promise<void> { this.closed = true; return this.closePromise ??= Promise.all([...this.inspections]).then(() => this.writes); }
  private checkOpen(): void { if (this.closed) throw new DaemonUnavailableError('shutting_down'); }
  private async load(): Promise<void> {
    try {
      const handle = await open(this.file, 'r'); let bytes: Buffer;
      try {
        const info = await handle.stat(); if (!info.isFile() || info.size > MAX_BYTES) throw metadataProblem();
        bytes = Buffer.alloc(MAX_BYTES + 1); let length = 0;
        while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
        if (length > MAX_BYTES) throw metadataProblem(); bytes = bytes.subarray(0, length);
      } finally { await handle.close(); }
      const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 2 || !Object.hasOwn(raw, 'schema') || !Object.hasOwn(raw, 'pending')) throw metadataProblem();
      const envelope = raw as { schema: unknown; pending: unknown };
      if (envelope.schema !== SCHEMA || !Array.isArray(envelope.pending) || envelope.pending.length > MAX_PENDING) throw metadataProblem();
      for (const value of envelope.pending) {
        if (!validate('request', 'preparation.begin', value)) throw metadataProblem();
        const entry = clone(value as DaemonPreparationBegin); if (this.pending.has(entry.invocationId)) throw metadataProblem(); this.pending.set(entry.invocationId, entry);
      }
    } catch (error) { if (!isNotFound(error)) throw metadataProblem(); }
  }
  private async recover(connect: () => Promise<DaemonClient>): Promise<void> {
    await this.recheckInactive([...this.pending.keys()], connect, () => false);
  }

  private serialize(work: () => Promise<void>): Promise<void> {
    this.checkOpen(); const next = this.writes.then(work, work); this.writes = next.catch(() => undefined); return next;
  }
  private persist(except?: DaemonPreparationBegin, eligible?: () => boolean): Promise<void> {
    return this.serialize(async () => {
      if (eligible && !eligible()) return;
      const pending = [...this.pending.values()].filter(entry => entry !== except), envelope = { schema: SCHEMA, pending };
      if (pending.length > MAX_PENDING || Buffer.byteLength(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8') > MAX_BYTES) throw metadataProblem();
      try {
        await writeJsonAtomic(this.file, envelope);
        if (process.platform !== 'win32') { const directory = await open(path.dirname(this.file), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
      } catch { throw metadataProblem(); }
      if (!this.closed && except && this.pending.get(except.invocationId) === except) this.pending.delete(except.invocationId);
    });
  }
  private remove(entry: DaemonPreparationBegin): Promise<void> { return this.persist(entry); }
}
