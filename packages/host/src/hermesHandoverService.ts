import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHermesObservedRpc, type HermesObservedRpc, type HermesObservedRpcFactory } from './hermesObservedControl.js';
import { findHermes, hermesEnvironment } from './hermes.js';
import { isNotFound, writeJsonAtomic } from './jsonStore.js';

export interface HermesHandoverAuthority { id: string; cwd: string; profile: string; profileHome: string; fingerprint: string }
interface Options {
  file: string;
  /** The selected native profile and source workspace, revalidated before every effect. */
  authority(id: string): Promise<HermesHandoverAuthority | undefined>;
  env: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  rpcFactory?: HermesObservedRpcFactory;
}
export interface HermesHandoverDescription { state: 'ready' | 'setup-required' | 'unavailable'; revision?: string; cwd?: string; profile?: string; problem?: string }
export interface HermesHandoverCreation {
  state: 'created' | 'unknown' | 'rejected'; nativeSessionId?: string; cwd?: string; profileHome?: string; problem?: string; retryable: false;
}
interface Owner { profileId: string; instanceId: string; epoch: number }
interface Review { authority: HermesHandoverAuthority; owner: Owner; revision: string; expires: number }
interface Creation {
  operationId: string; requestId: string; authority: HermesHandoverAuthority; profileId: string;
  state: 'inflight' | 'created' | 'unknown'; nativeSessionId?: string; observationId?: string;
}
type Row = Record<string, unknown>;
const object = (value: unknown): Row | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
const nativeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
const absolute = (value: unknown): value is string => bounded(value, 4096) && path.isAbsolute(value);
const authorityValid = (value: unknown): value is HermesHandoverAuthority => {
  const row = object(value);
  return Boolean(row && id(row.id) && absolute(row.cwd) && absolute(row.profileHome) && bounded(row.fingerprint, 4096)
    && typeof row.profile === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(row.profile));
};
const uncertain = 'Hermes creation needs inspection. No user prompt or model turn was started. Inspect the same operation to recover its native receipt.';
const rejected = (): HermesHandoverCreation => ({ state: 'rejected', retryable: false });

/**
 * Explicit, empty native-session creation through Hermes' public authenticated gateway.
 * The journal retains the exact native request ID. Recovery can repeat only the owner's
 * idempotent session.create, never a prompt, configuration write or gateway start.
 * Atomic local publication supports process restart; the native receipt also survives
 * gateway restart. Windows directory flushing is not a strict power-loss guarantee.
 */
export class HermesHandoverService {
  private readonly creations: Creation[] = [];
  private readonly reviews = new Map<string, Review>();
  private readonly requests = new Set<AbortController>();
  private readonly loading: Promise<void>;
  private lane: Promise<unknown> = Promise.resolve();
  private closed = false;
  private broken = false;
  private cleanupFailed = false;
  private active = 0;
  constructor(private readonly options: Options) { this.loading = this.load(); }
  private async load() {
    let handle;
    try {
      const before = await lstat(this.options.file);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 * 1024) throw new Error();
      handle = await open(this.options.file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
      const current = await handle.stat();
      if (!current.isFile() || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino || current.size > 1024 * 1024) throw new Error();
      const value = object(JSON.parse(await handle.readFile('utf8')));
      if (value?.version !== 1 || !Array.isArray(value.creations) || value.creations.length > 128) throw new Error();
      const operations = new Set<string>();
      for (const raw of value.creations) {
        const row = object(raw);
        if (!row || !id(row.operationId) || operations.has(row.operationId) || !id(row.requestId) || !authorityValid(row.authority) || !bounded(row.profileId, 4096)
          || !['inflight', 'created', 'unknown'].includes(String(row.state)) || row.nativeSessionId !== undefined && !nativeId(row.nativeSessionId)
          || row.state === 'created' && !nativeId(row.nativeSessionId) || row.observationId !== undefined && !id(row.observationId)
          || row.requestId !== this.requestId(row.operationId, row.authority)) throw new Error();
        operations.add(row.operationId);
        const creation = row as unknown as Creation;
        if (creation.state === 'inflight') creation.state = 'unknown';
        this.creations.push(creation);
      }
    } catch (error) { if (!isNotFound(error)) this.broken = true; }
    finally { await handle?.close(); }
  }
  private requestId(operationId: string, authority: HermesHandoverAuthority) { return `extalia-${digest([operationId, authority])}`; }
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    this.active++;
    const pending = this.lane.then(async () => { await this.loading; return work(); }).finally(() => { this.active--; });
    this.lane = pending.catch(() => undefined); return pending;
  }
  private async save() {
    try {
      await writeJsonAtomic(this.options.file, { version: 1, creations: this.creations });
      if (process.platform !== 'win32') {
        const directory = await open(path.dirname(this.options.file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch { this.broken = true; throw new Error('Hermes creation state could not be saved.'); }
  }
  private async authority(scopeId: string): Promise<HermesHandoverAuthority> {
    const raw = await this.options.authority(scopeId);
    if (this.closed || this.broken || !authorityValid(raw) || raw.id !== scopeId) throw new Error('The selected Hermes creation scope is unavailable.');
    const value: HermesHandoverAuthority = { id: raw.id, cwd: await realpath(raw.cwd), profile: raw.profile,
      profileHome: await realpath(raw.profileHome), fingerprint: raw.fingerprint };
    if (!(await stat(value.cwd)).isDirectory() || !(await stat(value.profileHome)).isDirectory()) throw new Error('The selected native folders are unavailable.');
    return value;
  }
  private async assertCurrent(authority: HermesHandoverAuthority) {
    if (digest(await this.authority(authority.id)) !== digest(authority)) throw new Error('The selected native creation scope changed.');
  }
  private async closeRpc(rpc: HermesObservedRpc) {
    try { await rpc.close(); }
    catch { this.broken = true; this.cleanupFailed = true; throw new Error('Hermes gateway cleanup could not be confirmed.'); }
  }
  private async gateway<T>(authority: HermesHandoverAuthority, run: (rpc: HermesObservedRpc, owner: Owner, check: () => void) => Promise<T>): Promise<T> {
    await this.assertCurrent(authority);
    const bin = await findHermes(this.options.env, this.options.homeDirectory);
    if (!bin) throw new Error('Hermes with the public gateway attach command was not found.');
    await this.assertCurrent(authority);
    const controller = new AbortController(); this.requests.add(controller);
    let rpc: HermesObservedRpc | undefined, lost = false;
    const check = () => { if (this.closed || this.broken || lost || controller.signal.aborted) throw new Error('The native gateway attachment changed.'); };
    try {
      rpc = await (this.options.rpcFactory ?? createHermesObservedRpc)({ bin, env: { ...hermesEnvironment(this.options.env), HERMES_HOME: authority.profileHome },
        expectedProfileId: authority.profileHome, signal: controller.signal, onMessage() {}, onClose: () => { lost = true; } });
      check();
      if (rpc.profileId !== authority.profileHome) throw new Error('Hermes attached a different native profile.');
      const value = object(await rpc.request('runtime.describe', {})), contract = object(value?.session_create), parameters = contract?.parameters;
      if (value?.profile_id !== rpc.profileId || value.instance_id !== rpc.instanceId || !Number.isSafeInteger(value.authority_epoch) || Number(value.authority_epoch) < 0
        || !Array.isArray(value.capabilities) || value.capabilities.length > 128 || !value.capabilities.includes('durable-admission-v1')
        || !Array.isArray(contract?.sources) || contract.sources.length > 32 || !contract.sources.includes('cli')
        || !Array.isArray(parameters) || parameters.length > 128 || !['request_id', 'source', 'cwd'].every(name => parameters.includes(name))) throw new Error('This Hermes gateway does not advertise the required idempotent creation contract.');
      await this.assertCurrent(authority); check();
      return await run(rpc, { profileId: rpc.profileId, instanceId: rpc.instanceId, epoch: value.authority_epoch as number }, check);
    } finally {
      controller.abort(); this.requests.delete(controller);
      if (rpc) await this.closeRpc(rpc);
    }
  }
  /** Passive filesystem availability only; an executable is not a ready gateway capability. */
  async describe(scopeId: string): Promise<HermesHandoverDescription> {
    await this.loading;
    try {
      const authority = await this.authority(scopeId), bin = await findHermes(this.options.env, this.options.homeDirectory);
      if (!bin) throw new Error();
      const executable = await realpath(bin), info = await stat(executable);
      await this.assertCurrent(authority);
      return { state: 'setup-required', revision: digest([authority, executable, info.dev, info.ino, info.size, info.mtimeMs]), cwd: authority.cwd, profile: authority.profile };
    } catch { return { state: 'unavailable', problem: 'The selected Hermes installation or profile is unavailable.' }; }
  }
  /** Only an explicit creation action may attach and inspect the authenticated native contract. */
  prepare(scopeId: string): Promise<HermesHandoverDescription> {
    return this.mutate(async () => {
      try {
        const authority = await this.authority(scopeId);
        return await this.gateway(authority, async (_rpc, owner) => {
          const revision = digest([authority, owner]);
          this.reviews.set(scopeId, { authority, owner, revision, expires: Date.now() + 60_000 });
          while (this.reviews.size > 128) this.reviews.delete(this.reviews.keys().next().value!);
          return { state: 'ready', revision, cwd: authority.cwd, profile: authority.profile };
        });
      } catch { this.reviews.delete(scopeId); return { state: 'unavailable', problem: 'A current authenticated Hermes gateway with native session creation is required.' }; }
    });
  }
  private receipt(row: Creation): HermesHandoverCreation {
    return { state: row.state === 'created' && !this.broken ? 'created' : 'unknown', cwd: row.authority.cwd, profileHome: row.authority.profileHome,
      ...(row.nativeSessionId ? { nativeSessionId: row.nativeSessionId } : {}), retryable: false,
      ...(row.state !== 'created' || this.broken ? { problem: uncertain } : {}) };
  }
  private async createExact(row: Creation, expectedOwner?: Owner): Promise<HermesHandoverCreation> {
    try {
      await this.gateway(row.authority, async (rpc, owner, check) => {
        if (owner.profileId !== row.profileId || expectedOwner && digest(owner) !== digest(expectedOwner)) throw new Error('The reviewed gateway changed.');
        await this.assertCurrent(row.authority); check();
        const value = object(await rpc.request('session.create', { request_id: row.requestId, source: 'cli', cwd: row.authority.cwd })), info = object(value?.info);
        if (!value || !nativeId(value.session_id) || value.stored_session_id !== value.session_id || row.nativeSessionId && value.session_id !== row.nativeSessionId
          || value.authority_epoch !== owner.epoch || info?.desktop_protocol !== 'hermes-gateway-v1' || info.profile_id !== owner.profileId || info.cwd !== row.authority.cwd) throw new Error('Hermes did not confirm the exact created identity.');
        row.nativeSessionId = value.session_id;
        await this.assertCurrent(row.authority); check();
      });
      row.state = 'created'; await this.save();
    } catch { row.state = 'unknown'; try { await this.save(); } catch { /* Keep the exact request fenced. */ } }
    return this.receipt(row);
  }
  create(scopeId: string, input: { revision: string; operationId: string }): Promise<HermesHandoverCreation> {
    return this.mutate(async () => {
      if (!id(input?.operationId) || typeof input.revision !== 'string' || this.closed || this.broken) return rejected();
      const previous = this.creations.find(row => row.operationId === input.operationId);
      if (previous) {
        if (previous.authority.id !== scopeId) return rejected();
        try { await this.assertCurrent(previous.authority); } catch { return rejected(); }
        return this.receipt(previous);
      }
      const review = this.reviews.get(scopeId);
      if (!review || review.revision !== input.revision || review.expires < Date.now() || this.creations.length >= 128
        || this.creations.some(row => row.authority.id === scopeId && (row.state !== 'created' || !row.observationId))) return rejected();
      try { await this.assertCurrent(review.authority); } catch { return rejected(); }
      const row: Creation = { operationId: input.operationId, requestId: this.requestId(input.operationId, review.authority), authority: review.authority,
        profileId: review.owner.profileId, state: 'inflight' };
      this.creations.push(row);
      try { await this.save(); } catch { return this.receipt(row); }
      return this.createExact(row, review.owner);
    });
  }
  async creationStatus(scopeId: string, operationId: string): Promise<HermesHandoverCreation | undefined> {
    await this.loading;
    const row = this.creations.find(value => value.operationId === operationId && value.authority.id === scopeId);
    if (!row) return undefined;
    try { await this.assertCurrent(row.authority); } catch { return rejected(); }
    return this.receipt(row);
  }
  async pendingCreation(scopeId: string) {
    await this.loading;
    const row = [...this.creations].reverse().find(value => value.authority.id === scopeId && (value.state !== 'created' || !value.observationId));
    if (!row) return undefined;
    try { await this.assertCurrent(row.authority); } catch { return undefined; }
    return { operationId: row.operationId, ...(row.nativeSessionId ? { nativeSessionId: row.nativeSessionId } : {}), state: row.state === 'created' && !this.broken ? 'created' as const : 'unknown' as const };
  }
  /** User-requested recovery repeats the exact idempotent create receipt, never inference. */
  inspectCreation(scopeId: string, operationId: string): Promise<HermesHandoverCreation | undefined> {
    return this.mutate(async () => {
      const row = this.creations.find(value => value.operationId === operationId && value.authority.id === scopeId);
      if (!row) return undefined;
      try { await this.assertCurrent(row.authority); } catch { return rejected(); }
      return row.state === 'created' ? this.receipt(row) : this.createExact(row);
    });
  }
  markRegistered(operationId: string, observationId: string): Promise<boolean> {
    return this.mutate(async () => {
      const row = this.creations.find(value => value.operationId === operationId);
      if (!row || row.state !== 'created' || !id(observationId) || row.observationId && row.observationId !== observationId) return false;
      try { await this.assertCurrent(row.authority); row.observationId = observationId; await this.save(); return true; } catch { return false; }
    });
  }
  isBusy() { return this.active > 0 || this.cleanupFailed; }
  async close() {
    this.closed = true; for (const request of this.requests) request.abort(); await this.lane;
    if (this.cleanupFailed) throw new Error('Hermes gateway cleanup could not be confirmed.');
  }
}
