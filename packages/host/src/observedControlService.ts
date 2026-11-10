import { createHash, randomUUID } from 'node:crypto';
import { OBSERVED_CONTROL_ROUTES, type ObservedControlAction, type ObservedControlDispatchInput, type ObservedControlReceipt,
  type ObservedControlRelatedControl, type ObservedControlRoute, type ObservedControlRouteStatus, type ObservedControlStatus } from '@extalia/platform';

export interface ObservedControlTarget {
  sourceId: string;
  nativeSessionId: string;
  /** Host-owned exact source reference; never returned to the renderer. */
  fingerprint: string;
  /** Must change across replacement, pause/resume and source rebinding (including ABA). */
  revision: string | number;
  watching: boolean;
}
export interface ObservedControlDriverSnapshot {
  /** Original native connection or cooperative channel identity; never a credential. */
  bindingId: string;
  /** Exact native turn/execution generation or cooperative inbox revision. */
  generation?: string | number;
  actions: readonly ObservedControlAction[];
  relatedControls?: readonly ObservedControlRelatedControl[];
  /** Optional source-independent diagnostic; never raw provider errors or secrets. */
  problem?: string;
}
export interface ObservedControlDriver {
  route: ObservedControlRoute;
  /** Inspect only. A status request must never attach, launch or configure an agent. */
  status(sessionId: string): ObservedControlDriverSnapshot | undefined | Promise<ObservedControlDriverSnapshot | undefined>;
  /** Must independently revalidate this exact snapshot immediately before its effect. No fallback or retry. */
  dispatch(sessionId: string, input: { action: ObservedControlAction; text: string }, snapshot: ObservedControlDriverSnapshot):
    Promise<{ state: 'queued' | 'submitted' | 'resolved' | 'unknown'; messageId?: string }>;
}
/** A driver may use this only when it positively refused before invoking any transport effect. */
export class ObservedControlRefusal extends Error {}
interface Options {
  target(sessionId: string): ObservedControlTarget | undefined;
  drivers: readonly ObservedControlDriver[];
  maxOperations?: number;
  maxSessions?: number;
}
interface Capability { id: string; signature: string; route: ObservedControlRoute; action: ObservedControlAction }
interface Binding { id: string; fingerprint: string; capabilities: Map<string, Capability>; uncertain: Set<string> }
interface Operation { fingerprint: string; result: Promise<ObservedControlReceipt> }
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
const targetKey = (target: ObservedControlTarget) => JSON.stringify([target.sourceId, target.nativeSessionId, target.fingerprint, target.revision, target.watching]);
const snapshotKey = (route: ObservedControlRoute, snapshot: ObservedControlDriverSnapshot) => JSON.stringify([route, snapshot.bindingId, snapshot.generation]);
const knownActions = new Set(OBSERVED_CONTROL_ROUTES.flatMap(route => route.actions));
const messageReceipt = (route: ObservedControlRoute) => route === 'codex-queue' || route === 'cooperative-inbox' ? 'queued' : 'submitted';

/** Ephemeral ownership fence over existing transports. No native control is inferred from hooks or transcripts. */
export class ObservedControlService {
  private readonly bindings = new Map<string, Binding>();
  private readonly operations = new Map<string, Operation>();
  private readonly busy = new Set<string>();
  private readonly drivers: Map<ObservedControlRoute, ObservedControlDriver>;
  private closed = false;
  constructor(private readonly options: Options) {
    this.drivers = new Map(options.drivers.map(driver => [driver.route, driver]));
    if (this.drivers.size !== options.drivers.length) throw new Error('Observed control routes must have one owner.');
  }
  private target(id: string) {
    if (this.closed || !validId(id)) return undefined;
    try { return this.options.target(id); } catch { return undefined; }
  }
  private binding(id: string, target: ObservedControlTarget): Binding | undefined {
    if (!target.watching) { this.bindings.delete(id); return undefined; }
    const fingerprint = targetKey(target), previous = this.bindings.get(id);
    if (previous?.fingerprint === fingerprint) return previous;
    this.bindings.delete(id);
    if (this.bindings.size >= (this.options.maxSessions ?? 128)) return undefined;
    const binding: Binding = { id: randomUUID(), fingerprint, capabilities: new Map(), uncertain: new Set() };
    this.bindings.set(id, binding);
    return binding;
  }
  private current(id: string, binding: Binding): boolean {
    const target = this.target(id);
    return !!target?.watching && this.bindings.get(id) === binding && targetKey(target) === binding.fingerprint;
  }
  private async inspect(driver: ObservedControlDriver, id: string) {
    try {
      const snapshot = await driver.status(id);
      if (!snapshot || typeof snapshot.bindingId !== 'string' || !snapshot.bindingId || snapshot.bindingId.length > 512 ||
        !Array.isArray(snapshot.actions) || snapshot.actions.some(action => !knownActions.has(action)) ||
        snapshot.generation !== undefined && (typeof snapshot.generation !== 'string' && typeof snapshot.generation !== 'number' ||
          typeof snapshot.generation === 'number' && !Number.isSafeInteger(snapshot.generation) || typeof snapshot.generation === 'string' && snapshot.generation.length > 512)) return undefined;
      return { ...snapshot, actions: [...snapshot.actions], relatedControls: snapshot.relatedControls?.map(control => ({ ...control })) };
    } catch { return undefined; }
  }
  async status(sessionId: string): Promise<ObservedControlStatus> {
    const target = this.target(sessionId), binding = target && this.binding(sessionId, target);
    const snapshots = binding ? await Promise.all(OBSERVED_CONTROL_ROUTES.map(async route => {
      const driver = this.drivers.get(route.route);
      return driver ? this.inspect(driver, sessionId) : undefined;
    })) : [];
    const current = !!binding && this.current(sessionId, binding);
    const routes: ObservedControlRouteStatus[] = OBSERVED_CONTROL_ROUTES.map((route, index) => {
      const snapshot = current ? snapshots[index] : undefined;
      const signature = snapshot ? snapshotKey(route.route, snapshot) : '';
      const uncertain = !!binding?.uncertain.has(signature), busy = this.busy.has(sessionId);
      const capabilities = route.actions.map(action => {
        const available = !!snapshot?.actions.includes(action) && !busy && !uncertain;
        const key = `${route.route}:${action}`;
        let capability = binding?.capabilities.get(key);
        if (!available) { binding?.capabilities.delete(key); return { action, available: false }; }
        if (capability?.signature !== signature) {
          capability = { id: randomUUID(), signature, route: route.route, action };
          binding!.capabilities.set(key, capability);
        }
        return { action, available: true, capabilityId: capability.id };
      });
      return { route: route.route, evidence: route.evidence, limit: route.limit,
        state: uncertain ? 'uncertain' : busy && current ? 'busy' : capabilities.some(capability => capability.available) ? 'ready' : 'unavailable',
        capabilities, relatedControls: snapshot?.relatedControls?.map(control => ({ kind: control.kind, available: control.available === true })) ?? [],
        ...(uncertain ? { problem: 'Delivery was not confirmed. Inspect the source before reconnecting.' } : snapshot?.problem ? { problem: snapshot.problem } : {}) };
    });
    return { sessionId, state: routes.some(route => route.state === 'ready') ? 'ready' : 'unavailable', routes,
      ...(current ? { bindingId: binding.id, sourceId: target!.sourceId, nativeSessionId: target!.nativeSessionId } : {}) };
  }
  dispatch(sessionId: string, input: ObservedControlDispatchInput): Promise<ObservedControlReceipt> {
    const reject = (problem: string): Promise<ObservedControlReceipt> => Promise.resolve({ sessionId,
      operationId: typeof input?.operationId === 'string' ? input.operationId.slice(0, 200) : '', state: 'rejected', problem, retryable: false });
    if (!validId(sessionId) || !validId(input?.operationId) || !validId(input?.capabilityId) || typeof input?.text !== 'string' || !input.text.trim() || input.text.includes('\0') || input.text.length > 16_000 || Buffer.byteLength(input.text) > 16 * 1024) return reject('Choose a current control capability and a bounded message.');
    const operationKey = JSON.stringify([sessionId, input.operationId]);
    const fingerprint = createHash('sha256').update(JSON.stringify([input.capabilityId, input.text])).digest('hex');
    const previous = this.operations.get(operationKey);
    if (previous) return previous.fingerprint === fingerprint ? previous.result.then(result => ({ ...result })) : reject('This operation ID already belongs to a different message.');
    if (this.operations.size >= (this.options.maxOperations ?? 512)) return reject('The control receipt limit has been reached. Restart the host before sending more messages.');
    const binding = this.bindings.get(sessionId);
    const capability = binding && [...binding.capabilities.values()].find(value => value.id === input.capabilityId);
    if (!binding || !capability || !this.current(sessionId, binding)) return reject('The observed source or control capability changed. Refresh its status.');
    if (this.busy.has(sessionId)) return reject('Wait for the current observed control operation to finish.');
    const driver = this.drivers.get(capability.route);
    if (!driver) return reject('This observed control route is unavailable.');
    this.busy.add(sessionId);
    // Consume admission synchronously. A concurrent call cannot reuse this authority.
    binding.capabilities.clear();
    const immutableInput = { text: input.text, operationId: input.operationId };
    const result = this.execute(sessionId, immutableInput, binding, capability, driver).finally(() => this.busy.delete(sessionId));
    this.operations.set(operationKey, { fingerprint, result });
    return result.then(receipt => ({ ...receipt }));
  }
  private async execute(id: string, input: { text: string; operationId: string }, binding: Binding, capability: Capability, driver: ObservedControlDriver): Promise<ObservedControlReceipt> {
    const receipt = (state: ObservedControlReceipt['state'], problem?: string, messageId?: string): ObservedControlReceipt => ({ sessionId: id,
      operationId: input.operationId, route: capability.route, action: capability.action, state, retryable: false, ...(problem ? { problem } : {}), ...(messageId ? { messageId } : {}) });
    const snapshot = await this.inspect(driver, id);
    if (!this.current(id, binding) || !snapshot || snapshotKey(driver.route, snapshot) !== capability.signature ||
      !snapshot.actions.includes(capability.action) || binding.uncertain.has(capability.signature)) return receipt('rejected', 'The observed source, attachment or current turn changed.');
    try {
      const result = await driver.dispatch(id, { action: capability.action, text: input.text }, snapshot);
      // These actions admit messages. No transport may promote admission into proof of consumption.
      if (!this.current(id, binding) || !result || result.state !== 'unknown' && result.state !== messageReceipt(capability.route)) throw new Error('Unconfirmed delivery.');
      if (result.state === 'unknown') binding.uncertain.add(capability.signature);
      return receipt(result.state, result.state === 'unknown' ? 'Delivery was not confirmed. Do not resend automatically.' : undefined,
        typeof result.messageId === 'string' && validId(result.messageId) ? result.messageId : undefined);
    } catch (error) {
      if (error instanceof ObservedControlRefusal) return receipt('rejected', 'The selected control action is no longer available. Refresh its status.');
      binding.uncertain.add(capability.signature);
      return receipt('unknown', 'Delivery was not confirmed. Do not resend automatically.');
    }
  }
  /** Parent calls this synchronously before pause/delete/replacement persistence. */
  drop(sessionId: string): void { this.bindings.delete(sessionId); }
  close(): void { this.closed = true; this.bindings.clear(); }
}
