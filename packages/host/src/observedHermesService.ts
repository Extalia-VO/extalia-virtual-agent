import type { HermesObservedAnswerInput, HermesObservedMessageInput, HermesObservedStatus } from '@extalia/platform';
import { HermesObservedControl, type HermesObservedRpcFactory } from './hermesObservedControl.js';
import { findOnPath, isExecutable } from './connect/util.js';

interface Target { app: string; nativeSessionId: string; watching: boolean }
interface Options { target(id: string): Target | undefined; env: Readonly<Record<string, string | undefined>>; rpcFactory?: HermesObservedRpcFactory }

/** Registry authorizes only the host's watched Hermes source and never starts a gateway. */
export class ObservedHermesService {
  private readonly controls = new Map<string, { nativeId: string; control: HermesObservedControl }>();
  private readonly work = new Map<string, Promise<unknown>>();
  private readonly blocked = new Set<string>();
  private readonly generations = new Map<string, number>();
  private readonly cleanup = new Map<string, Promise<void>>();
  private readonly cleanupFailures = new Set<string>();
  private closed = false;
  constructor(private readonly options: Options) {}
  private target(id: string) {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Choose an observed Hermes session.');
    const target = this.options.target(id);
    return target?.app === 'hermes' ? target : undefined;
  }
  private unavailable(id: string, problem: string): HermesObservedStatus {
    return { sessionId: id, nativeSessionId: this.target(id)?.nativeSessionId ?? '', state: 'unavailable', running: false, canSend: false, canAnswer: false, requests: [], problem };
  }
  private stop(id: string, control: HermesObservedControl) {
    const stopped = control.close();
    const pending = Promise.all([this.cleanup.get(id), stopped]).then(() => undefined);
    this.cleanup.set(id, pending);
    void pending.then(() => { if (this.cleanup.get(id) === pending) this.cleanup.delete(id); }, () => {
      this.cleanupFailures.add(id); if (this.cleanup.get(id) === pending) this.cleanup.delete(id);
    });
    return pending;
  }
  status(id: string): HermesObservedStatus {
    const target = this.target(id), entry = this.controls.get(id);
    if (this.closed || !target?.watching || this.blocked.has(id) || entry && entry.nativeId !== target.nativeSessionId) {
      if (entry) { this.controls.delete(id); void this.stop(id, entry.control).catch(() => undefined); }
      return this.unavailable(id, 'Choose a watched Hermes gateway session.');
    }
    if (this.cleanupFailures.has(id)) return this.unavailable(id, 'Hermes connection cleanup could not be confirmed.');
    return entry?.control.status() ?? { sessionId: id, nativeSessionId: target.nativeSessionId, state: 'disconnected', running: false, canSend: false, canAnswer: false, requests: [] };
  }
  private mutate<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.target(id);
    if (this.closed || this.work.has(id)) return Promise.reject(new Error('Wait for the current Hermes operation to finish.'));
    const promise = Promise.resolve().then(action); this.work.set(id, promise);
    void promise.finally(() => { if (this.work.get(id) === promise) this.work.delete(id); }).catch(() => undefined);
    return promise;
  }
  connect(id: string, profile?: string): Promise<HermesObservedStatus> {
    return this.mutate(id, async () => {
      const generation = this.generations.get(id) ?? 0, target = this.target(id);
      if (this.blocked.has(id) || !target?.watching) return this.unavailable(id, 'Resume observation before connecting.');
      await this.cleanup.get(id);
      if (this.cleanupFailures.has(id)) throw new Error('Hermes connection cleanup could not be confirmed.');
      if (profile !== undefined && (typeof profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(profile))) throw new Error('Choose a valid Hermes profile.');
      const previous = this.controls.get(id); this.controls.delete(id); if (previous) await this.stop(id, previous.control);
      const override = this.options.env.EXTALIA_HERMES_BIN;
      const bin = override && await isExecutable(override) ? override : !override ? await findOnPath('hermes', this.options.env, process.platform) : undefined;
      if (!bin) return this.unavailable(id, 'Hermes with the public gateway attach command was not found.');
      if (this.closed || this.blocked.has(id) || generation !== (this.generations.get(id) ?? 0) || this.target(id)?.nativeSessionId !== target.nativeSessionId || !this.target(id)?.watching) throw new Error('The observed Hermes session changed.');
      const control = new HermesObservedControl({ sessionId: id, nativeSessionId: target.nativeSessionId, bin, env: { ...this.options.env }, ...(profile ? { profile } : {}), ...(this.options.rpcFactory ? { rpcFactory: this.options.rpcFactory } : {}) });
      this.controls.set(id, { nativeId: target.nativeSessionId, control });
      try {
        const status = await control.connect();
        if (this.closed || this.blocked.has(id) || generation !== (this.generations.get(id) ?? 0) || this.target(id)?.nativeSessionId !== target.nativeSessionId || !this.target(id)?.watching) { await this.stop(id, control); throw new Error('The observed Hermes session changed.'); }
        return status;
      } catch (error) { await this.stop(id, control); throw error; }
    });
  }
  private current(id: string, connectionId: string) {
    const status = this.status(id), entry = this.controls.get(id);
    if (!entry || status.state !== 'connected' || !connectionId || status.connectionId !== connectionId) throw new Error('The original Hermes connection is no longer active.');
    return entry.control;
  }
  send(id: string, input: HermesObservedMessageInput) { return this.mutate(id, () => this.current(id, input?.connectionId).send(input)); }
  answer(id: string, input: HermesObservedAnswerInput) { return this.mutate(id, () => this.current(id, input?.connectionId).answer(input)); }
  disconnect(id: string, connectionId: string) {
    return this.mutate(id, async () => { const control = this.current(id, connectionId); this.controls.delete(id); await this.stop(id, control); return this.status(id); });
  }
  async drop(id: string): Promise<void> {
    this.blocked.add(id); this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const entry = this.controls.get(id); this.controls.delete(id);
    if (entry) await this.stop(id, entry.control);
    await this.work.get(id)?.catch(() => undefined); await this.cleanup.get(id);
    if (this.cleanupFailures.has(id)) throw new Error('Hermes connection cleanup could not be confirmed.');
  }
  resume(id: string) { this.blocked.delete(id); }
  async close() {
    this.closed = true;
    const entries = [...this.controls.entries()]; this.controls.clear();
    const stopped = entries.map(([id, entry]) => this.stop(id, entry.control));
    const results = await Promise.allSettled([...stopped, ...this.cleanup.values()]);
    await Promise.allSettled([...this.work.values()]);
    if (this.cleanupFailures.size || results.some(result => result.status === 'rejected')) throw new Error('Hermes connection cleanup could not be confirmed.');
  }
}
