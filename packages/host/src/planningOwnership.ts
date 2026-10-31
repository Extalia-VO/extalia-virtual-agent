import {
  DAEMON_PLANNING_OPS, parseDaemonFrame,
  type DaemonPlanningAdmission, type DaemonPlanningBegin, type DaemonPlanningInspection, type DaemonPlanningObservationRecord,
} from '@extalia/protocol';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { DaemonRequestError, DaemonUnavailableError, type DaemonClient } from './daemon/client.js';
import { isNotFound, writeJsonAtomic } from './jsonStore.js';

const SCHEMA = 'extalia.native-planning.v1';
const MAX_PENDING = 128;
const MAX_BYTES = 1024 * 1024;
const VALIDATION_ID = '00000000-0000-4000-8000-000000000001';
const metadataProblem = () => new Error('Native planning ownership metadata is unavailable.');
const pendingProblem = () => new Error('This scope has active or unresolved native planning.');
const malformedReply = () => new DaemonUnavailableError('malformed_reply');
const sameScope = (request: DaemonPlanningBegin, admission: DaemonPlanningAdmission) => request.invocationId === admission.invocationId
  && request.supervisorId === admission.supervisorId && request.sessionId === admission.sessionId && request.workspaceId === admission.workspaceId
  && request.connectionIds.length === admission.connectionIds.length && request.connectionIds.every((id, index) => id === admission.connectionIds[index]);
const validate = (kind: 'request' | 'response', op: 'planning.begin' | 'planning.observe' | 'planning.inspect', value: unknown) => parseDaemonFrame({
  schemaVersion: 1, kind, requestId: VALIDATION_ID, op, [kind === 'request' ? 'params' : 'result']: value,
}).ok;
const clone = (params: DaemonPlanningBegin): DaemonPlanningBegin => Object.freeze({
  invocationId: params.invocationId, supervisorId: params.supervisorId, sessionId: params.sessionId, workspaceId: params.workspaceId,
  connectionIds: Object.freeze([...params.connectionIds]) as unknown as string[],
});
const checkClient = (client: DaemonClient) => {
  if (!client.usable) throw new DaemonUnavailableError(client.failure ?? 'shutting_down');
};

/** The original connection owns this local pipeline; settlement is no remote/child proof. */
export interface OwnedPlanning {
  check(): void;
  settle(): Promise<void>;
}

/** Persisted scope guards apply independently of the currently selected native backend. */
export class PlanningOwnership {
  private readonly pending = new Map<string, DaemonPlanningBegin>();
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  private constructor(private readonly file: string) {}

  static async open(file: string, recover?: () => Promise<DaemonClient>): Promise<PlanningOwnership> {
    const ownership = new PlanningOwnership(file);
    await ownership.load();
    if (ownership.pending.size && recover) await ownership.recover(recover);
    return ownership;
  }

  assertClear(sessionId?: string, connectionIds: readonly string[] = [], exceptInvocationId?: string): void {
    this.checkOpen();
    for (const entry of this.pending.values()) {
      if (entry.invocationId !== exceptInvocationId && ((sessionId !== undefined && entry.sessionId === sessionId)
        || entry.connectionIds.some(id => connectionIds.includes(id)))) throw pendingProblem();
    }
  }

  assertWorkspaceClear(workspaceId: string): void {
    this.checkOpen();
    if ([...this.pending.values()].some(entry => entry.workspaceId === workspaceId)) throw pendingProblem();
  }

  async begin(client: DaemonClient, params: DaemonPlanningBegin): Promise<OwnedPlanning> {
    this.checkOpen();
    checkClient(client);
    if (!DAEMON_PLANNING_OPS.every(op => client.capabilities.includes(op))) throw new DaemonUnavailableError('missing_capability');
    if (!validate('request', 'planning.begin', params)) throw new DaemonRequestError('invalid_request');
    const request = clone(params);
    this.assertClear(request.sessionId, request.connectionIds);
    if (this.pending.has(request.invocationId)) throw pendingProblem();
    if (this.pending.size >= MAX_PENDING) throw new DaemonRequestError('capacity_exceeded');
    // Install the guard before the first await. No admission can race this reservation.
    this.pending.set(request.invocationId, request);
    await this.persist();
    this.checkOpen();
    checkClient(client);
    let admission: DaemonPlanningAdmission;
    try { admission = await client.request('planning.begin', request); }
    catch (error) {
      this.checkOpen();
      if (error instanceof DaemonRequestError && ['invalid_request', 'conflict', 'capacity_exceeded'].includes(error.code)) {
        await this.remove(request);
        this.checkOpen();
      }
      throw error;
    }
    this.checkOpen();
    checkClient(client);
    if (!validate('response', 'planning.begin', admission) || !sameScope(request, admission)) throw malformedReply();
    const digest = admission.admissionDigest, admittedAt = admission.admittedAt;
    const check = () => {
      this.checkOpen();
      checkClient(client);
      if (this.pending.get(request.invocationId) !== request) throw pendingProblem();
      this.assertClear(request.sessionId, request.connectionIds, request.invocationId);
    };
    let completion: Promise<void> | undefined;
    return {
      check,
      settle: () => this.closed ? Promise.reject(new DaemonUnavailableError('shutting_down')) : completion ??= (async () => {
        check();
        const observation: DaemonPlanningObservationRecord = await client.request('planning.observe', {
          invocationId: request.invocationId, admissionDigest: digest, kind: 'local-pipeline-settled',
        });
        this.checkOpen();
        checkClient(client);
        if (!validate('response', 'planning.observe', observation) || observation.invocationId !== request.invocationId
          || observation.admissionDigest !== digest || Date.parse(observation.recordedAt) < Date.parse(admittedAt)) throw malformedReply();
        await this.remove(request);
        this.checkOpen();
      })(),
    };
  }

  /** Stop admission immediately and drain every queued write before releasing the profile lock. */
  close(): Promise<void> {
    this.closed = true;
    return this.writes;
  }

  private checkOpen(): void {
    if (this.closed) throw new DaemonUnavailableError('shutting_down');
  }

  private async load(): Promise<void> {
    try {
      const handle = await open(this.file, 'r');
      let bytes: Buffer;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_BYTES) throw metadataProblem();
        bytes = Buffer.alloc(MAX_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length > MAX_BYTES) throw metadataProblem();
        bytes = bytes.subarray(0, length);
      } finally { await handle.close(); }
      const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 2
        || !Object.hasOwn(raw, 'schema') || !Object.hasOwn(raw, 'pending')) throw metadataProblem();
      const envelope = raw as { schema: unknown; pending: unknown };
      if (envelope.schema !== SCHEMA || !Array.isArray(envelope.pending) || envelope.pending.length > MAX_PENDING) throw metadataProblem();
      for (const value of envelope.pending) {
        if (!validate('request', 'planning.begin', value)) throw metadataProblem();
        const entry = clone(value as DaemonPlanningBegin);
        if (this.pending.has(entry.invocationId)) throw metadataProblem();
        this.pending.set(entry.invocationId, entry);
      }
    } catch (error) { if (!isNotFound(error)) throw metadataProblem(); }
  }

  private async recover(connect: () => Promise<DaemonClient>): Promise<void> {
    let client: DaemonClient;
    try { client = await connect(); } catch { return; }
    if (this.closed) return;
    if (!client.usable || !client.capabilities.includes('planning.inspect')) return;
    for (const entry of this.pending.values()) {
      try {
        this.checkOpen();
        checkClient(client);
        const result: DaemonPlanningInspection = await client.request('planning.inspect', { invocationId: entry.invocationId });
        this.checkOpen();
        checkClient(client);
        if (validate('response', 'planning.inspect', result) && sameScope(entry, result.admission) && result.observation) {
          await this.remove(entry);
          this.checkOpen();
        }
      } catch { /* Missing or uncertain evidence keeps the saved guard; never observe on restart. */ }
      if (this.closed) return;
    }
  }

  private serialize(work: () => Promise<void>): Promise<void> {
    this.checkOpen();
    const next = this.writes.then(work, work);
    this.writes = next.catch(() => undefined);
    return next;
  }

  private persist(except?: DaemonPlanningBegin): Promise<void> {
    return this.serialize(async () => {
      const pending = [...this.pending.values()].filter(entry => entry !== except);
      const envelope = { schema: SCHEMA, pending };
      if (pending.length > MAX_PENDING || Buffer.byteLength(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8') > MAX_BYTES) throw metadataProblem();
      try {
        await writeJsonAtomic(this.file, envelope);
        // The marker must survive a rename before a durable daemon admission can run.
        if (process.platform !== 'win32') {
          const directory = await open(path.dirname(this.file), 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        }
      } catch { throw metadataProblem(); }
      if (!this.closed && except && this.pending.get(except.invocationId) === except) this.pending.delete(except.invocationId);
    });
  }

  private remove(entry: DaemonPlanningBegin): Promise<void> { return this.persist(entry); }
}
