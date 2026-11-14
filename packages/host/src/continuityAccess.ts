import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { redact } from '@extalia/core';
import type { ContinuityNotes, ContinuityReadInput, ContinuityReadPage, ContinuitySnapshotSummary, ContinuityView } from '@extalia/platform';
import { isNotFound, readJson, writeJsonAtomic } from './jsonStore.js';
import type { ContinuityPacketContext } from './sessionContinuity.js';

export interface ContinuityAccessBinding {
  sessionId: string;
  sourceId: string;
  nativeSessionId: string;
  workspaceId: string;
  /** Current workspace/watch identity and boundary settings; not an ephemeral message status. */
  boundary: string;
  watching: boolean;
  persistent: boolean;
}
export interface ContinuityAccessOptions {
  file: string;
  now?: () => number;
  /** Must reject labels-only mode and unregistered, unwatched or no-longer-authorized targets. */
  binding(sessionId: string): Promise<ContinuityAccessBinding>;
  /** Reads immutable evidence through current chain privacy checks; never captures a new source. */
  read(sessionId: string, input: ContinuityReadInput): Promise<ContinuityReadPage>;
  allowCrossWorkspace?: (sourceWorkspaceId: string, destinationWorkspaceId: string) => boolean;
}
export interface ContinuityAccessRequest {
  accessCode: string;
  operation: 'status' | 'read';
  snapshotId?: string;
  offset?: number;
  limit?: number;
}
export interface ContinuityAccessStatus {
  canonicalId: string;
  expiresAt: string;
  notes: ContinuityNotes;
  notesOrigin: ContinuityView['notesOrigin'];
  snapshots: ContinuitySnapshotSummary[];
  offset: number;
  total: number;
  nextOffset?: number;
}
interface Grant {
  digest: string;
  packetDigest: string;
  canonicalId: string;
  sessionId: string;
  bindingDigest: string;
  persistent: boolean;
  expiresAt: number;
  notes: ContinuityNotes;
  notesOrigin: ContinuityView['notesOrigin'];
  snapshots: ContinuitySnapshotSummary[];
}
interface Pending { grant: Grant; expiresAt: number }
interface Store { version: 1; grants: Grant[] }
const CODE = /^sk-extalia-context-[a-f0-9]{64}$/;
const EXTRACT = /\bsk-extalia-context-[a-f0-9]{64}\b/g;
const HEX = /^[a-f0-9]{64}$/;
const MAX_GRANTS = 64;
const MAX_BYTES = 8 * 1024 * 1024;
const TTL = 24 * 60 * 60_000;
const PREVIEW_TTL = 10 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bindingHash = (value: ContinuityAccessBinding) => hash(JSON.stringify({ sessionId: value.sessionId, sourceId: value.sourceId, nativeSessionId: value.nativeSessionId, workspaceId: value.workspaceId, boundary: value.boundary }));
const copy = <T>(value: T): T => structuredClone(value);
function sanitized<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(item => sanitized(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, sanitized(nested)])) as T;
  return value;
}
const equal = (a: string, b: string) => HEX.test(a) && HEX.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const denied = () => new Error('Context access is unavailable, expired or does not match this conversation.');
const page = (input: ContinuityAccessRequest) => {
  const offset = input.offset ?? 0, limit = input.limit ?? 1;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 2) throw new Error('Use a nonnegative offset and a page limit of one or two.');
  return { offset, limit };
};

/** Scoped bearer capabilities. A matching app/thread label binds the grant, but does not attest the caller process. */
export class ContinuityAccess {
  private grants?: Grant[];
  private readonly pending = new Map<string, Pending>();
  private lane: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly reads = new Set<Promise<unknown>>();
  private readonly now: () => number;
  constructor(private readonly options: ContinuityAccessOptions) { this.now = options.now ?? Date.now; }
  private allowsWorkspace(sourceWorkspaceId: string, destinationWorkspaceId: string): boolean {
    return this.options.allowCrossWorkspace ? this.options.allowCrossWorkspace(sourceWorkspaceId, destinationWorkspaceId) : sourceWorkspaceId === destinationWorkspaceId;
  }
  private serial<T>(task: () => Promise<T>, completing = false): Promise<T> {
    if (this.closed && !completing) return Promise.reject(new Error('Context access is closed.'));
    const next = this.lane.then(async () => { await this.load(); return task(); });
    this.lane = next.catch(() => undefined); return next;
  }
  private async load(): Promise<void> {
    if (this.grants) return;
    try { if ((await stat(this.options.file)).size > MAX_BYTES) throw new Error('Context access storage exceeds its bounded size.'); }
    catch (error) { if (!isNotFound(error)) throw error; }
    const state = await readJson<Store>(this.options.file, { version: 1, grants: [] });
    if (state.version !== 1 || !Array.isArray(state.grants) || state.grants.length > MAX_GRANTS) throw new Error('Invalid context access storage; left unchanged.');
    const digests = new Set<string>();
    for (const grant of state.grants) {
      if (!grant || !HEX.test(grant.digest) || !HEX.test(grant.packetDigest) || !HEX.test(grant.bindingDigest) || digests.has(grant.digest)
        || typeof grant.sessionId !== 'string' || typeof grant.canonicalId !== 'string' || grant.persistent !== true
        || !Number.isSafeInteger(grant.expiresAt) || !Array.isArray(grant.snapshots) || grant.snapshots.length > 256
        || !grant.notes || !['source-excerpt', 'user-reviewed'].includes(grant.notesOrigin)) throw new Error('Invalid context access grant; storage left unchanged.');
      for (const value of Object.values(grant.notes)) if (typeof value !== 'string' || value.length > 4000) throw new Error('Invalid context access notes.');
      if (Object.keys(grant.notes).length !== 6 || grant.snapshots.some(snapshot => !snapshot || typeof snapshot.id !== 'string' || !snapshot.coverage)) throw new Error('Invalid context access archive.');
      digests.add(grant.digest);
    }
    this.grants = state.grants.filter(grant => grant.expiresAt > this.now());
  }
  private async save(grants: Grant[]): Promise<void> {
    const store: Store = { version: 1, grants: grants.filter(grant => grant.persistent && grant.expiresAt > this.now()) };
    if (Buffer.byteLength(JSON.stringify(grants)) > MAX_BYTES) throw new Error('Context access storage is full. Existing grants were preserved.');
    await writeJsonAtomic(this.options.file, store); this.grants = grants;
  }
  private async current(sessionId: string): Promise<ContinuityAccessBinding> {
    const binding = await this.options.binding(sessionId);
    if (binding.sessionId !== sessionId || !binding.watching || !binding.nativeSessionId || !binding.sourceId || !binding.workspaceId || !binding.boundary) throw denied();
    return binding;
  }
  prepare(packet: string, context: ContinuityPacketContext): Promise<string> {
    return this.serial(async () => {
      if (context.target.kind === 'native' || !context.destination.sessionId) return packet;
      const binding = await this.current(context.destination.sessionId);
      if (!this.allowsWorkspace(context.source.workspaceId, binding.workspaceId)) throw denied();
      for (const [id, value] of this.pending) if (value.expiresAt <= this.now()) this.pending.delete(id);
      if (this.pending.size >= MAX_GRANTS) throw new Error('Too many pending context access reviews. Wait for an earlier review to expire.');
      const accessCode = `sk-extalia-context-${randomBytes(32).toString('hex')}`;
      const suffix = `\nScoped archive access for this destination only (expires in 24 hours after activation):\n${accessCode}\nUse extalia_continuity_status with access_code and this conversation session_id to page the pinned archive manifest; extalia_continuity_read additionally accepts snapshot_id and offset. Pages contain at most two items. This bearer code permits only the reviewed source archives, not future conversation content. Do not quote or forward the code. If these tools are unavailable, inspect the retained archive in Extalia.\n`;
      const decorated = packet + suffix;
      if (Buffer.byteLength(decorated) > 14 * 1024 || decorated.length > 16_000) throw new Error('The context access packet exceeds its transport limit.');
      const grant: Grant = { digest: hash(accessCode), packetDigest: hash(decorated), canonicalId: context.canonicalId, sessionId: binding.sessionId,
        bindingDigest: bindingHash(binding), persistent: context.persistent && binding.persistent, expiresAt: 0,
        notes: sanitized(context.notes), notesOrigin: context.notesOrigin, snapshots: sanitized([...context.snapshots]) };
      if (Buffer.byteLength(JSON.stringify([...this.pending.values(), { grant }])) > MAX_BYTES) throw new Error('Pending context access reviews exceed their bounded size.');
      this.pending.set(grant.digest, { grant, expiresAt: this.now() + PREVIEW_TTL });
      return decorated;
    });
  }
  /** Called only after the handover journal reserves its exact destination, before any delivery. */
  activate(packet: string, targetSessionId: string): Promise<void> {
    return this.serial(async () => {
      const codes = packet.match(EXTRACT) ?? [];
      if (!codes.length) return;
      if (codes.length !== 1) throw denied();
      const digest = hash(codes[0]!), packetDigest = hash(packet);
      const existing = this.grants!.find(grant => equal(grant.digest, digest));
      if (existing) {
        if (existing.sessionId !== targetSessionId || !equal(existing.packetDigest, packetDigest) || existing.expiresAt <= this.now()) throw denied();
        const binding = await this.current(targetSessionId);
        if (!equal(existing.bindingDigest, bindingHash(binding))) throw denied();
        if (!binding.persistent && existing.persistent) await this.save(this.grants!.map(grant => grant === existing ? { ...grant, persistent: false } : grant));
        return;
      }
      const pending = this.pending.get(digest);
      if (!pending || pending.expiresAt <= this.now() || pending.grant.sessionId !== targetSessionId || !equal(pending.grant.packetDigest, packetDigest)) throw denied();
      const binding = await this.current(targetSessionId);
      if (!equal(bindingHash(binding), pending.grant.bindingDigest)) throw denied();
      const grants = this.grants!.filter(grant => grant.expiresAt > this.now());
      if (grants.length >= MAX_GRANTS) throw new Error('Context access grant limit reached. Revoke or expire an earlier grant.');
      await this.save([...grants, { ...pending.grant, expiresAt: this.now() + TTL, persistent: pending.grant.persistent && binding.persistent }]);
      this.pending.delete(digest);
    });
  }
  private async authorized(sessionId: string, input: ContinuityAccessRequest): Promise<Grant> {
    if (!input || !CODE.test(input.accessCode) || !['status', 'read'].includes(input.operation)) throw denied();
    const digest = hash(input.accessCode), grant = this.grants!.find(value => equal(value.digest, digest));
    if (!grant || grant.sessionId !== sessionId || grant.expiresAt <= this.now()) throw denied();
    const binding = await this.current(sessionId);
    if (!equal(grant.bindingDigest, bindingHash(binding))) throw denied();
    if (!binding.persistent && grant.persistent) {
      grant.persistent = false; await this.save(this.grants!);
      if (!equal(grant.bindingDigest, bindingHash(await this.current(sessionId)))) throw denied();
    }
    return grant;
  }
  request(sessionId: string, input: ContinuityAccessRequest): Promise<ContinuityAccessStatus | ContinuityReadPage> {
    // Never hold the grant lane while entering the continuity archive lane. Preview decoration
    // enters them in the reverse direction, so an archive read must release this lane first.
    const request = (async () => {
      const admission = await this.serial(async () => {
        const grant = await this.authorized(sessionId, input), { offset, limit } = page(input);
        if (input.operation === 'status') {
          if (offset > grant.snapshots.length) throw new Error('The requested archive page is outside this grant.');
          const end = Math.min(offset + limit, grant.snapshots.length);
          const status: ContinuityAccessStatus = { canonicalId: grant.canonicalId, expiresAt: new Date(grant.expiresAt).toISOString(), notes: copy(grant.notes), notesOrigin: grant.notesOrigin,
            snapshots: copy(grant.snapshots.slice(offset, end)), offset, total: grant.snapshots.length, ...(end < grant.snapshots.length ? { nextOffset: end } : {}) };
          return { status };
        }
        if (!grant.snapshots.some(snapshot => snapshot.id === input.snapshotId)) throw denied();
        return { grant: copy(grant), offset, limit };
      });
      if (admission.status) return admission.status;
      const result = await this.options.read(sessionId, { snapshotId: input.snapshotId!, offset: admission.offset!, limit: admission.limit! });
      return this.serial(async () => {
        // Revocation, expiry, retention and live target identity can all change during archive I/O.
        const grant = await this.authorized(sessionId, input);
        if (!equal(grant.digest, admission.grant!.digest) || !grant.snapshots.some(snapshot => snapshot.id === input.snapshotId)
          || result.canonicalId !== grant.canonicalId || result.snapshot.id !== input.snapshotId) throw denied();
        return copy(result);
      }, true);
    })();
    this.reads.add(request);
    void request.then(() => this.reads.delete(request), () => this.reads.delete(request));
    return request;
  }
  /** Actual committed history-off transition, never a preview of a private destination. */
  demote(canonicalId: string): Promise<void> {
    return this.serial(async () => {
      for (const pending of this.pending.values()) if (pending.grant.canonicalId === canonicalId) pending.grant.persistent = false;
      if (this.grants!.some(grant => grant.canonicalId === canonicalId && grant.persistent)) {
        await this.save(this.grants!.map(grant => grant.canonicalId === canonicalId ? { ...grant, persistent: false } : grant));
      }
    });
  }
  revoke(sessionId?: string): Promise<void> {
    return this.serial(async () => {
      for (const [id, pending] of this.pending) if (sessionId === undefined || pending.grant.sessionId === sessionId) this.pending.delete(id);
      await this.save(this.grants!.filter(grant => sessionId !== undefined && grant.sessionId !== sessionId));
    });
  }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled([this.lane, ...this.reads]); this.pending.clear(); this.grants = undefined; }
}
