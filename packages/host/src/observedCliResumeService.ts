import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ObservedCliFamily, ObservedCliResumePairInput, ObservedCliResumePreview, ObservedCliResumeReconcileInput, ObservedCliResumeStatus, ObservedControlAction } from '@extalia/platform';
import { findOnPath, isExecutable } from './connect/util.js';
import { isNotFound, writeJsonAtomic } from './jsonStore.js';
import { ObservedControlRefusal, type ObservedControlDriverSnapshot } from './observedControlService.js';
import { resumeArguments, resumeEnvironment, type ResumeArchiveCommand } from './observedCliResumeCommands.js';

export interface ObservedCliResumeTarget {
  family: ObservedCliFamily; sourceId: string; nativeSessionId: string; fingerprint: string; revision: string;
  watching: boolean; idle: boolean; cwd: string; profilePath: string; model?: string;
  resumeModel?: string; resumeModelSource?: 'profile' | 'project' | 'environment';
}
interface Options {
  file: string; env: Readonly<Record<string, string | undefined>>; homeDirectory: string;
  target(id: string): Promise<ObservedCliResumeTarget | undefined>;
  archiveCommand(target: ObservedCliResumeTarget): Promise<ResumeArchiveCommand | undefined>;
  changed?(id: string): void; spawn?: typeof nodeSpawn;
}
interface Pin { file: string; identity: string }
interface Review { target: ObservedCliResumeTarget; pin: Pin; preview: ObservedCliResumePreview }
interface Journal { operationId: string; digest: string; state: 'inflight' | 'completed' | 'failed' | 'unknown'; reconciled?: boolean }
interface Binding { sessionId: string; pairingId: string; target: ObservedCliResumeTarget; pin: Pin; version: string; connected: boolean; journals: Journal[] }
interface Owned { done: Promise<void>; stop(): void }
type Receipt = { state: 'queued' | 'resolved' | 'unknown'; messageId?: string };
const UNKNOWN = 'Delivery is uncertain. Inspect the original conversation before reconciling this operation.';
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
const nativeKey = (target: ObservedCliResumeTarget) => JSON.stringify([target.family, target.nativeSessionId, target.profilePath]);
const sourceKey = (target: ObservedCliResumeTarget) => JSON.stringify([target.family, target.sourceId, target.nativeSessionId, target.fingerprint, target.cwd, target.profilePath]);
const targetKey = (target: ObservedCliResumeTarget) => JSON.stringify([sourceKey(target), target.revision, target.model, target.resumeModel, target.resumeModelSource]);
const validTarget = (value: unknown): value is ObservedCliResumeTarget => {
  if (!value || typeof value !== 'object') return false;
  const t = value as ObservedCliResumeTarget;
  return ['codex', 'gemini', 'claude'].includes(t.family) && validId(t.nativeSessionId) && validId(t.sourceId)
    && typeof t.fingerprint === 'string' && t.fingerprint.length > 0 && t.fingerprint.length <= 4096
    && typeof t.revision === 'string' && t.revision.length <= 512 && typeof t.watching === 'boolean' && typeof t.idle === 'boolean'
    && [t.cwd, t.profilePath].every(p => typeof p === 'string' && path.isAbsolute(p) && p.length <= 4096 && !p.includes('\0'))
    && (t.model === undefined || typeof t.model === 'string' && t.model.length <= 200 && !/[\0\r\n]/.test(t.model))
    && (t.resumeModel === undefined || typeof t.resumeModel === 'string' && t.resumeModel.trim().length > 0 && t.resumeModel.length <= 200 && !/[\0\r\n]/.test(t.resumeModel))
    && (t.resumeModelSource === undefined || ['profile', 'project', 'environment'].includes(t.resumeModelSource))
    && (t.resumeModel === undefined) === (t.resumeModelSource === undefined);
};
async function executablePin(file: string): Promise<Pin> {
  const resolved = await realpath(file);
  if (!await isExecutable(resolved)) throw new ObservedControlRefusal('The selected CLI is unavailable.');
  const handle = await open(resolved, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 512 * 1024 * 1024) throw new ObservedControlRefusal('The selected CLI cannot be pinned.');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) { const chunk = await handle.read(buffer, 0, buffer.length, null); if (!chunk.bytesRead) break; hash.update(buffer.subarray(0, chunk.bytesRead)); }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new ObservedControlRefusal('The CLI changed during review.');
    return { file: resolved, identity: JSON.stringify([before.dev, before.ino, before.size, before.mtimeMs, before.mode, hash.digest('hex')]) };
  } finally { await handle.close(); }
}

/** Exclusive, reviewed resumes of a persisted source; never creates a replacement conversation. */
export class ObservedCliResumeService {
  private readonly bindings = new Map<string, Binding>();
  private readonly reviews = new Map<string, Review>();
  private readonly owned = new Map<string, Owned>();
  private readonly loading: Promise<void>;
  private lane: Promise<unknown> = Promise.resolve();
  private closed = false;
  private persistenceFailed = false;
  constructor(private readonly options: Options) { this.loading = this.load(); }
  static async create(options: Options): Promise<ObservedCliResumeService> { const service = new ObservedCliResumeService(options); await service.loading; return service; }
  private async load() {
    let handle;
    try { handle = await open(this.options.file, 'r'); } catch (error) { if (isNotFound(error)) return; throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid CLI resume state.');
      const value = JSON.parse(await handle.readFile('utf8')) as { version: number; bindings: Binding[] };
      if (value.version !== 1 || !Array.isArray(value.bindings) || value.bindings.length > 128) throw new Error('Invalid CLI resume state.');
      for (const binding of value.bindings) {
        if (!validId(binding.sessionId) || !validId(binding.pairingId) || !validTarget(binding.target) || typeof binding.connected !== 'boolean'
          || typeof binding.version !== 'string' || binding.version.length > 256 || !binding.pin || typeof binding.pin.file !== 'string' || !path.isAbsolute(binding.pin.file)
          || typeof binding.pin.identity !== 'string' || binding.pin.identity.length > 1024 || !Array.isArray(binding.journals) || binding.journals.length > 128
          || binding.journals.some(j => !validId(j.operationId) || !/^[a-f0-9]{64}$/.test(j.digest) || !['inflight', 'completed', 'failed', 'unknown'].includes(j.state) || j.reconciled !== undefined && (typeof j.reconciled !== 'boolean' || j.state !== 'unknown'))
          || this.bindings.has(binding.sessionId)) throw new Error('Invalid CLI resume binding.');
        for (const journal of binding.journals) if (journal.state === 'inflight') { journal.state = 'unknown'; delete journal.reconciled; }
        this.bindings.set(binding.sessionId, binding);
      }
    } finally { await handle.close(); }
  }
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.lane.then(async () => { await this.loading; return work(); });
    this.lane = operation.catch(() => undefined); return operation;
  }
  private async save() {
    try { await writeJsonAtomic(this.options.file, { version: 1, bindings: [...this.bindings.values()] }); }
    catch { this.persistenceFailed = true; throw new ObservedControlRefusal('CLI resume state could not be saved. No further submission is allowed.'); }
  }
  private changed(id: string) { try { this.options.changed?.(id); } catch { /* Observers cannot own process lifetime. */ } }
  private async target(id: string) {
    if (this.closed || !validId(id)) return undefined;
    try {
      const target = await this.options.target(id);
      return validTarget(target) && target.watching ? { ...target } : undefined;
    } catch { return undefined; }
  }
  private uncertain(binding: Binding) { return binding.journals.some(j => j.state === 'unknown' && !j.reconciled || j.state === 'inflight' && !this.owned.has(binding.sessionId)); }
  private ownerFor(target: ObservedCliResumeTarget) {
    return [...this.owned.keys()].some(id => { const binding = this.bindings.get(id); return binding && nativeKey(binding.target) === nativeKey(target); });
  }
  private uncertaintyFor(target: ObservedCliResumeTarget) {
    return [...this.bindings.values()].some(binding => nativeKey(binding.target) === nativeKey(target) && this.uncertain(binding));
  }
  async status(id: string): Promise<ObservedCliResumeStatus> {
    await this.loading;
    const target = await this.target(id), binding = this.bindings.get(id), last = binding?.journals.at(-1);
    const base = { sessionId: id, ...(binding ? { family: binding.target.family, pairingId: binding.pairingId, nativeSessionId: binding.target.nativeSessionId,
      executable: binding.pin.file, version: binding.version, projectPath: binding.target.cwd, profilePath: binding.target.profilePath,
      ...(last ? { operationId: last.operationId, ...(last.state !== 'inflight' ? { lastOutcome: last.state === 'completed' ? 'completed' as const : last.state === 'failed' ? 'failed' as const : 'unknown' as const } : {}) } : {}) } : {}) };
    if (binding && this.uncertain(binding) || this.persistenceFailed) return { ...base, state: 'uncertain', problem: UNKNOWN };
    if (this.owned.has(id)) return { ...base, state: 'running' };
    if (!target) return { ...base, state: 'unavailable' };
    if (this.uncertaintyFor(target)) return { ...base, state: 'uncertain', problem: UNKNOWN };
    if (this.ownerFor(target)) return { ...base, state: 'unavailable', problem: 'This original conversation already has an owned process.' };
    if (!binding?.connected) return { ...base, family: target.family, state: 'disconnected' };
    if (targetKey(target) !== targetKey(binding.target) || !target.idle) return { ...base, state: 'unavailable', problem: 'The original source or its idle state changed. Review the connection again.' };
    return { ...base, state: 'ready' };
  }
  async preview(id: string): Promise<ObservedCliResumePreview> {
    return this.mutate(async () => {
      const target = await this.target(id), binding = this.bindings.get(id);
      if (!target?.idle || this.ownerFor(target) || this.persistenceFailed || this.uncertaintyFor(target) || binding && this.uncertain(binding)) throw new ObservedControlRefusal('An idle, inspected original source is required.');
      const override = this.options.env[`EXTALIA_${target.family.toUpperCase()}_BIN`];
      const candidate = override || await findOnPath(target.family, this.options.env, process.platform);
      if (!candidate) throw new ObservedControlRefusal('The official CLI is not installed.');
      const pin = await executablePin(candidate);
      const version = await this.version(pin.file, target);
      const current = await this.target(id);
      if (!current?.idle || targetKey(target) !== targetKey(current)) throw new ObservedControlRefusal('The source changed during review.');
      const reviewId = randomUUID();
      const preview: ObservedCliResumePreview = { sessionId: id, reviewId, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), family: target.family,
        nativeSessionId: target.nativeSessionId, executable: pin.file, version, projectPath: target.cwd, profilePath: target.profilePath,
        ...(target.model ? { model: target.model } : {}), ...(target.resumeModel ? { resumeModel: target.resumeModel, resumeModelSource: target.resumeModelSource } : {}), arguments: resumeArguments(target) };
      this.reviews.delete(id); this.reviews.set(id, { target, pin, preview });
      while (this.reviews.size > 128) this.reviews.delete(this.reviews.keys().next().value!);
      return { ...preview, arguments: [...preview.arguments] };
    });
  }
  private version(command: string, target: ObservedCliResumeTarget): Promise<string> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = (this.options.spawn ?? nodeSpawn)(command, ['--version'], { cwd: target.cwd, env: resumeEnvironment(target, this.options.env, this.options.homeDirectory), stdio: 'pipe', shell: false, windowsHide: true }) as ChildProcessWithoutNullStreams; }
      catch { reject(new ObservedControlRefusal('The CLI version probe failed.')); return; }
      let output = '', bytes = 0, failed = false;
      const stop = () => { failed = true; child.kill('SIGKILL'); };
      const timer = setTimeout(stop, 5000); timer.unref();
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4096) stop(); else output += chunk.toString('utf8'); });
      child.once('error', () => { failed = true; });
      child.stdin.on('error', () => undefined); child.stdin.end();
      child.once('close', code => {
        clearTimeout(timer);
        const version = output.trim();
        if (failed || code !== 0 || version.length > 256 || !/^[\w .+()/-]*\d[\w .+()/-]*$/.test(version)) reject(new ObservedControlRefusal('The CLI version probe failed.'));
        else resolve(version);
      });
    });
  }
  async pair(id: string, input: ObservedCliResumePairInput): Promise<ObservedCliResumeStatus> {
    await this.mutate(async () => {
      const review = this.reviews.get(id), current = await this.target(id), binding = this.bindings.get(id);
      if (!input.exclusiveOwnerConfirmed || !review || input.reviewId !== review.preview.reviewId || Date.parse(review.preview.expiresAt) < Date.now()
        || !current?.idle || targetKey(current) !== targetKey(review.target) || this.ownerFor(current) || this.persistenceFailed || this.uncertaintyFor(current) || binding && this.uncertain(binding)) throw new ObservedControlRefusal('Review this exact idle source and confirm exclusive ownership first.');
      if (JSON.stringify(await executablePin(review.pin.file)) !== JSON.stringify(review.pin)) throw new ObservedControlRefusal('The reviewed executable changed.');
      const latest = await this.target(id);
      if (!latest?.idle || targetKey(latest) !== targetKey(current)) throw new ObservedControlRefusal('The source changed during pairing.');
      if (!this.bindings.has(id) && this.bindings.size >= 128) throw new ObservedControlRefusal('Too many CLI resume connections.');
      this.bindings.set(id, { sessionId: id, pairingId: randomUUID(), target: current, pin: review.pin, version: review.preview.version, connected: true, journals: binding?.journals ?? [] });
      await this.save(); this.reviews.delete(id); this.changed(id);
    });
    return this.status(id);
  }
  async driverStatus(id: string): Promise<ObservedControlDriverSnapshot | undefined> {
    const status = await this.status(id), binding = this.bindings.get(id);
    return status.state === 'ready' && binding ? { bindingId: binding.pairingId, generation: binding.target.revision, actions: ['start'],
      relatedControls: [{ kind: 'approvals', available: false }, { kind: 'questions', available: false }] } : undefined;
  }
  async dispatch(id: string, input: { action: ObservedControlAction; text: string; operationId: string }, snapshot: ObservedControlDriverSnapshot): Promise<Receipt> {
    return this.mutate(async () => {
      if (!validId(input.operationId) || input.action !== 'start' || typeof input.text !== 'string' || !input.text.trim() || input.text.includes('\0') || Buffer.byteLength(input.text) > 16 * 1024) throw new ObservedControlRefusal('A bounded prompt and operation identity are required.');
      const binding = this.bindings.get(id), digest = createHash('sha256').update(JSON.stringify([binding && sourceKey(binding.target), input.text])).digest('hex');
      const previous = binding?.journals.find(j => j.operationId === input.operationId);
      if (previous) {
        if (previous.digest !== digest) throw new ObservedControlRefusal('This operation belongs to another prompt.');
        return { state: previous.state === 'completed' ? 'resolved' : previous.state === 'inflight' && this.owned.has(id) ? 'queued' : 'unknown' };
      }
      const target = await this.target(id);
      if (this.closed || this.persistenceFailed || !binding?.connected || !target?.idle || targetKey(target) !== targetKey(binding.target)
        || !snapshot || snapshot.bindingId !== binding.pairingId || snapshot.generation !== target.revision || !snapshot.actions.includes('start') || this.ownerFor(target) || this.uncertaintyFor(target)) throw new ObservedControlRefusal('The reviewed idle connection is no longer current.');
      if (binding.journals.length >= 128) throw new ObservedControlRefusal('The operation journal is full.');
      if (JSON.stringify(await executablePin(binding.pin.file)) !== JSON.stringify(binding.pin)) throw new ObservedControlRefusal('The reviewed executable changed.');
      const archive = await this.options.archiveCommand(target);
      if (!archive || !path.isAbsolute(archive.command) || archive.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new ObservedControlRefusal('The scoped archive reader is unavailable.');
      const args = resumeArguments(target, archive), env = resumeEnvironment(target, this.options.env, this.options.homeDirectory);
      const latest = await this.target(id);
      if (!latest?.idle || targetKey(latest) !== targetKey(target)) throw new ObservedControlRefusal('The source changed before submission.');
      const journal: Journal = { operationId: input.operationId, digest, state: 'inflight' };
      binding.journals.push(journal); await this.save();
      const finalTarget = await this.target(id);
      if (!finalTarget?.idle || targetKey(finalTarget) !== targetKey(target)) {
        journal.state = 'failed'; await this.save();
        throw new ObservedControlRefusal('The source changed before process creation.');
      }
      let child: ChildProcessWithoutNullStreams;
      try { child = (this.options.spawn ?? nodeSpawn)(binding.pin.file, args, { cwd: target.cwd, env, stdio: 'pipe', shell: false, windowsHide: true }) as ChildProcessWithoutNullStreams; }
      catch { journal.state = 'failed'; await this.save(); throw new ObservedControlRefusal('The CLI could not be started.'); }
      this.own(id, child, target, archive, input.text, journal);
      this.changed(id);
      return { state: 'queued' };
    });
  }
  private own(id: string, child: ChildProcessWithoutNullStreams, target: ObservedCliResumeTarget, archive: ResumeArchiveCommand, text: string, journal: Journal) {
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    let spawned = false, spawnFailed = false, invalid = false, identity = false, success = false, closed = false;
    let stdoutBytes = 0, stderrBytes = 0, pending = '', acpStage = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      invalid = true;
      if (closed) return;
      child.kill('SIGTERM');
      if (!killTimer) { killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 1000); killTimer.unref(); }
    };
    const write = (value: unknown) => { if (!closed && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`); };
    const rpc = (requestId: number, method: string, params: unknown) => write({ jsonrpc: '2.0', id: requestId, method, params });
    const line = (value: string) => {
      if (!value.trim()) return;
      let event: Record<string, unknown>;
      try { const parsed: unknown = JSON.parse(value); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); event = parsed as Record<string, unknown>; }
      catch { stop(); return; }
      if (target.family === 'gemini') {
        const params = event.params as Record<string, unknown> | undefined;
        if (params?.sessionId !== undefined && params.sessionId !== target.nativeSessionId) { stop(); return; }
        if (event.method && event.id !== undefined) {
          if (event.method === 'session/request_permission') {
            write({ jsonrpc: '2.0', id: event.id, result: { outcome: { outcome: 'cancelled' } } });
          } else write({ jsonrpc: '2.0', id: event.id, error: { code: -32601, message: 'Client capability unavailable.' } });
          return;
        }
        if (event.id === 1 && acpStage === 1) {
          const result = event.result as { agentCapabilities?: { loadSession?: boolean } } | undefined;
          if (event.error || result?.agentCapabilities?.loadSession !== true) { stop(); return; }
          acpStage = 2;
          rpc(2, 'session/load', { sessionId: target.nativeSessionId, cwd: target.cwd, mcpServers: [{ name: 'extalia_handover', command: archive.command,
            args: archive.args, env: Object.entries(archive.env ?? {}).map(([name, value]) => ({ name, value })) }] });
        } else if (event.id === 2 && acpStage === 2) {
          if (event.error || !event.result || typeof event.result !== 'object') { stop(); return; }
          const loaded = event.result as { sessionId?: unknown };
          if (loaded.sessionId !== undefined && loaded.sessionId !== target.nativeSessionId) { stop(); return; }
          identity = true; acpStage = 3;
          rpc(3, 'session/prompt', { sessionId: target.nativeSessionId, prompt: [{ type: 'text', text }] });
        } else if (event.id === 3 && acpStage === 3) {
          const result = event.result as { stopReason?: unknown } | undefined;
          success = !event.error && result?.stopReason === 'end_turn';
          acpStage = 4; child.stdin.end();
        }
        return;
      }
      const nativeId = target.family === 'codex' ? event.thread_id : event.session_id;
      if (nativeId !== undefined) {
        if (nativeId !== target.nativeSessionId) { stop(); return; }
        identity = true;
      }
      if (target.family === 'codex' && event.type === 'turn.completed') success = true;
      if (target.family === 'codex' && (event.type === 'turn.failed' || event.type === 'error')) invalid = true;
      if (target.family === 'claude' && event.type === 'result') success = event.subtype === 'success' && event.is_error !== true;
    };
    this.owned.set(id, { done, stop });
    const timeout = setTimeout(stop, 10 * 60_000); timeout.unref();
    child.once('spawn', () => {
      spawned = true;
      if (invalid || this.closed) { stop(); return; }
      if (target.family === 'gemini') {
        acpStage = 1;
        rpc(1, 'initialize', { protocolVersion: 1, clientInfo: { name: 'extalia', version: '1' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      } else child.stdin.end(text);
    });
    child.once('error', () => { spawnFailed = !spawned; invalid = true; });
    child.stdin.on('error', () => { invalid = true; });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 8 * 1024 * 1024) { stop(); return; }
      pending += chunk.toString('utf8');
      for (;;) { const end = pending.indexOf('\n'); if (end < 0) break; const value = pending.slice(0, end); pending = pending.slice(end + 1); line(value); }
      if (pending.length > 1024 * 1024) stop();
    });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) stop(); });
    child.once('close', code => {
      closed = true; clearTimeout(timeout); if (killTimer) clearTimeout(killTimer);
      if (pending.trim()) line(pending);
      void this.mutate(async () => {
        journal.state = spawnFailed ? 'failed' : code === 0 && identity && success && !invalid ? 'completed' : 'unknown';
        try { await this.save(); } catch { journal.state = 'unknown'; }
        this.owned.delete(id); this.changed(id);
      }).finally(finish);
    });
  }
  async disconnect(id: string): Promise<ObservedCliResumeStatus> {
    let owned: Owned | undefined, failure: unknown;
    try {
      await this.mutate(async () => {
        this.reviews.delete(id);
        owned = this.owned.get(id); owned?.stop();
        const binding = this.bindings.get(id);
        if (binding) { binding.connected = false; await this.save(); }
        this.changed(id);
      });
    } catch (error) { failure = error; }
    await owned?.done;
    if (failure) throw failure;
    return this.status(id);
  }
  async drop(id: string): Promise<ObservedCliResumeStatus> { return this.disconnect(id); }
  async reconcile(id: string, input: ObservedCliResumeReconcileInput): Promise<ObservedCliResumeStatus> {
    await this.mutate(async () => {
      const binding = this.bindings.get(id), target = await this.target(id);
      if (!input.inspected || !validId(input.operationId) || !binding || !target?.idle || this.ownerFor(target)
        || sourceKey(target) !== sourceKey(binding.target)) throw new ObservedControlRefusal('Inspect the exact original idle conversation after the owned process exits.');
      const journal = binding.journals.find(j => j.operationId === input.operationId);
      if (!journal || !['unknown', 'inflight'].includes(journal.state)) throw new ObservedControlRefusal('There is no matching uncertain operation.');
      // Reconciliation permits future, distinct operations; it never replays or claims delivery.
      journal.state = 'unknown'; journal.reconciled = true; binding.connected = false; await this.save(); this.changed(id);
    });
    return this.status(id);
  }
  isBusy(): boolean { return this.owned.size > 0; }
  async close(): Promise<void> {
    this.closed = true;
    await this.lane;
    const work = [...this.owned.values()];
    for (const operation of work) operation.stop();
    await Promise.all(work.map(operation => operation.done));
  }
}
