import { OBSERVED_CONTROL_ROUTES, type AgentHostApi, type ObservedControlCapability, type ObservedControlReceipt, type ObservedControlRouteStatus, type ObservedControlStatus, type ObservedInboxStatus } from '@extalia/platform';
import { composerDraftStore } from '../chat/composerDrafts';

export interface ObservedSessionControlView {
  phase: 'loading' | 'ready' | 'error' | 'unsupported';
  status?: ObservedControlStatus;
  draft: string;
  selected: string;
  busy: boolean;
  receipt?: ObservedControlReceipt;
  notice?: 'stale' | 'failed';
}
export const OBSERVED_MESSAGE_LIMIT = 16_000;
const routes = ['codex-native', 'codex-queue', 'hermes-native', 'cooperative-tool', 'cooperative-inbox'];
const actions = ['start', 'steer', 'queue', 'reply-tool', 'inbox-send'];
export function validObservedControlStatus(value: ObservedControlStatus, id: string): boolean {
  return !!value && value.sessionId === id && ['ready', 'unavailable'].includes(value.state) && Array.isArray(value.routes)
    && value.routes.every(route => routes.includes(route.route) && ['ready', 'unavailable', 'busy', 'uncertain'].includes(route.state)
      && ['native-attachment', 'official-queue', 'paired-tool', 'paired-inbox'].includes(route.evidence)
      && ['existing-native-owner', 'queue-receipt-only', 'waiting-tool-only', 'paired-consumer-only'].includes(route.limit)
      && Array.isArray(route.capabilities) && route.capabilities.every(cap => actions.includes(cap.action) && typeof cap.available === 'boolean'
        && (!cap.available || typeof cap.capabilityId === 'string' && !!cap.capabilityId))
      && Array.isArray(route.relatedControls));
}
export function observedControlChoices(status?: ObservedControlStatus): { route: ObservedControlRouteStatus; capability: ObservedControlCapability }[] {
  return status?.state === 'ready' ? status.routes.flatMap(route => route.state === 'ready'
    ? route.capabilities.filter(capability => capability.available && !!capability.capabilityId).map(capability => ({ route, capability })) : []) : [];
}
function sourceBinding(status?: ObservedControlStatus) {
  return JSON.stringify([status?.bindingId, status?.sourceId, status?.nativeSessionId]);
}

/** Presentation state only. Every action and its exact authority comes from the host. */
export function createObservedSessionControl(api: AgentHostApi, sessionId: string) {
  const supported = !!(api?.observedControlStatus && api?.dispatchObservedControl);
  const store = api ? composerDraftStore(api) : undefined;
  const draftEntry = store?.entry(`observed-control:${sessionId}`);
  const initialDraft = draftEntry?.getSnapshot().text ?? '';
  let view: ObservedSessionControlView = { phase: supported ? 'loading' : 'unsupported', draft: initialDraft, selected: '', busy: false };
  let mounts = 0, epoch = 0, revision = 0;
  let reading: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined;
  const uncertain = new Set<string>(), listeners = new Set<() => void>();
  const update = (next: ObservedSessionControlView) => { view = next; listeners.forEach(listener => listener()); };
  const receive = (status: ObservedControlStatus) => {
    if (!validObservedControlStatus(status, sessionId)) throw new Error('Invalid observed status');
    const changedDraftSource = !!view.status && !!view.draft && sourceBinding(status) !== sourceBinding(view.status);
    const selected = !changedDraftSource && observedControlChoices(status).some(choice => choice.capability.capabilityId === view.selected) ? view.selected : '';
    update({ ...view, status, selected, phase: 'ready', ...(changedDraftSource || view.selected && !selected ? { notice: 'stale' as const } : {}) });
  };
  function refresh(): Promise<void> {
    if (!mounts || !supported || view.busy) return Promise.resolve();
    if (reading) return reading;
    const ticket = epoch;
    const pending = (async () => {
      try { const status = await api.observedControlStatus!(sessionId); if (mounts && ticket === epoch) receive(status); }
      catch (err: unknown) {
        if (mounts && ticket === epoch) {
          const msg = err instanceof Error ? err.message : String(err ?? '');
          const unsupported = /unknown method/i.test(msg) || /not a function/i.test(msg) || /unsupported/i.test(msg);
          update({ ...view, phase: unsupported ? 'unsupported' : 'error', status: undefined, selected: '', notice: unsupported ? undefined : 'failed' });
        }
      }
    })();
    reading = pending;
    void pending.finally(() => { if (reading === pending) reading = undefined; });
    return pending;
  }
  function readyToSend() {
    return !!mounts && supported && view.phase === 'ready' && !view.busy && !!view.draft.trim()
      && view.draft.length <= OBSERVED_MESSAGE_LIMIT && new TextEncoder().encode(view.draft).byteLength <= 16 * 1024
      && !view.draft.includes('\0');
  }
  function canSend() {
    return readyToSend() && !uncertain.has(view.selected)
      && observedControlChoices(view.status).some(choice => choice.capability.capabilityId === view.selected);
  }
  // Eligibility never selects an action. Resolve a default only for the simple
  // composer, and pin it before preflight so a changed source cannot retarget it.
  function messageCapability() {
    const choices = observedControlChoices(view.status);
    const explicit = choices.find(choice => choice.capability.capabilityId === view.selected);
    if (explicit) return uncertain.has(view.selected) ? undefined : view.selected;
    if (view.selected || view.notice || view.receipt?.state === 'unknown') return undefined;
    const compatible = choices.filter(({ route, capability }) => OBSERVED_CONTROL_ROUTES.some(supported => supported.route === route.route
      && supported.evidence === route.evidence && supported.limit === route.limit && supported.actions.includes(capability.action)));
    const native = compatible.filter(({ route, capability }) => (route.evidence === 'native-attachment' || route.evidence === 'official-queue')
      && capability.action !== 'steer');
    const queues = native.filter(({ capability }) => capability.action === 'queue');
    const candidates = queues.length ? queues : native.length ? native
      : compatible.filter(({ capability }) => capability.action === 'reply-tool' || capability.action === 'inbox-send');
    const selected = candidates.length === 1 ? candidates[0]!.capability.capabilityId : undefined;
    return selected && !uncertain.has(selected) ? selected : undefined;
  }
  function canSendMessage() { return readyToSend() && !!messageCapability(); }
  async function sendCapability(selected: string) {
    const text = view.draft, draftRevision = revision;
    const source = sourceBinding(view.status);
    const ticket = ++epoch, operationId = crypto.randomUUID();
    reading = undefined;
    let dispatched = false;
    update({ ...view, busy: true, receipt: undefined, notice: undefined });
    const current = () => !!mounts && epoch === ticket;
    try {
      const status = await api.observedControlStatus!(sessionId);
      if (!current()) return;
      receive(status);
      if (sourceBinding(status) !== source || !observedControlChoices(status).some(choice => choice.capability.capabilityId === selected)) {
        update({ ...view, selected: '', notice: 'stale' }); return;
      }
      dispatched = true;
      const receipt = await api.dispatchObservedControl!(sessionId, { operationId, capabilityId: selected, text });
      if (!receipt || receipt.sessionId !== sessionId || receipt.operationId !== operationId
        || !['rejected', 'queued', 'submitted', 'resolved', 'unknown'].includes(receipt.state)) throw new Error('Invalid observed receipt');
      if (receipt.state === 'unknown') uncertain.add(selected);
      const accepted = receipt.state !== 'rejected' && receipt.state !== 'unknown';
      // Successful dispatch consumes its capability. Clear that choice before the
      // next status read so its expected replacement is not a stale-source warning.
      if (accepted && revision === draftRevision) draftEntry?.setText('');
      update({ ...view, receipt, ...(accepted ? { selected: '', notice: undefined, ...(revision === draftRevision ? { draft: '' } : {}) } : {}) });
    } catch {
      if (dispatched) uncertain.add(selected);
      if (current() || dispatched) update({ ...view, ...(dispatched ? { receipt: { sessionId, operationId, state: 'unknown', retryable: false } as ObservedControlReceipt }
        : { phase: 'error' as const, status: undefined, selected: '', notice: 'failed' as const }) });
    } finally {
      update({ ...view, busy: false });
      if (mounts) await refresh();
    }
  }
  async function send() {
    if (canSend()) await sendCapability(view.selected);
  }
  async function sendMessage() {
    if (!readyToSend()) return;
    const selected = messageCapability();
    if (selected) await sendCapability(selected);
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    start() {
      if (++mounts === 1) { ++epoch; void refresh(); timer = setInterval(() => { void refresh(); }, 2000); }
      return () => { if (--mounts === 0) { ++epoch; reading = undefined; clearInterval(timer); timer = undefined; } };
    },
    setDraft(draft: string) {
      ++revision;
      draftEntry?.setText(draft);
      update({ ...view, draft });
    },
    select(selected: string) { if (!view.busy) update({ ...view, selected, notice: undefined }); },
    refresh, send, canSend, sendMessage, canSendMessage, hasMessageAction: () => !!messageCapability(),
  };
}
export type ObservedSessionControlModel = ReturnType<typeof createObservedSessionControl>;
const models = new WeakMap<AgentHostApi, Map<string, ObservedSessionControlModel>>();
/** Drafts and uncertain operations survive switching between Observe and Office. */
export function observedSessionControlFor(api: AgentHostApi, sessionId: string) {
  if (!api) return createObservedSessionControl(api, sessionId);
  let sessions = models.get(api);
  if (!sessions) { sessions = new Map(); models.set(api, sessions); }
  let model = sessions.get(sessionId);
  if (!model) { model = createObservedSessionControl(api, sessionId); sessions.set(sessionId, model); }
  return model;
}

export interface ObservedInboxView {
  phase: 'loading' | 'ready' | 'error' | 'unsupported';
  status?: ObservedInboxStatus;
  busy: boolean;
  revealed: boolean;
}
export function validObservedInboxStatus(value: ObservedInboxStatus, sessionId: string): boolean {
  if (!value || value.sessionId !== sessionId || !['disconnected', 'connected', 'expired', 'unavailable'].includes(value.state)) return false;
  if (value.state !== 'connected') return true;
  if (!/^[a-f0-9-]{36}$/i.test(value.channelId ?? '') || !/^[a-f0-9]{64}$/i.test(value.token ?? '')) return false;
  try {
    const url = new URL(value.url!);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === `/inbox/${value.channelId}`;
  } catch { return false; }
}

export function createObservedInboxControl(api: AgentHostApi, sessionId: string) {
  const supported = !!(api?.observedInboxStatus && api?.createObservedInbox && api?.closeObservedInbox);
  let view: ObservedInboxView = { phase: supported ? 'loading' : 'unsupported', busy: false, revealed: false };
  let active = false, epoch = 0, reading = false, timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const update = (next: ObservedInboxView) => { view = next; listeners.forEach(listener => listener()); };
  const receive = (status: ObservedInboxStatus) => {
    if (!validObservedInboxStatus(status, sessionId)) throw new Error('Invalid inbox');
    update({ ...view, phase: 'ready', status, revealed: view.revealed && status.state === 'connected'
      && view.status?.channelId === status.channelId && view.status?.url === status.url && view.status?.token === status.token });
  };
  async function refresh() {
    if (!active || !supported || reading || view.busy) return;
    const ticket = epoch; reading = true;
    try { const status = await api.observedInboxStatus!(sessionId); if (active && epoch === ticket) receive(status); }
    catch { if (active && epoch === ticket) update({ ...view, phase: 'error', status: undefined, revealed: false }); }
    finally { if (epoch === ticket) reading = false; }
  }
  async function mutate(operation: () => Promise<ObservedInboxStatus>) {
    if (!active || !supported || view.busy) return;
    const ticket = ++epoch; reading = false; update({ ...view, busy: true, revealed: false });
    try { const status = await operation(); if (active && epoch === ticket) receive(status); }
    catch { if (active && epoch === ticket) update({ ...view, phase: 'error', status: undefined, revealed: false }); }
    finally { if (active && epoch === ticket) update({ ...view, busy: false }); }
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    start() {
      active = true; ++epoch; void refresh(); timer = setInterval(() => { void refresh(); }, 2000);
      return () => { active = false; ++epoch; reading = false; clearInterval(timer); timer = undefined; };
    },
    reveal(revealed: boolean) { update({ ...view, revealed: revealed && view.status?.state === 'connected' }); },
    refresh,
    create: () => mutate(() => api.createObservedInbox!(sessionId)),
    close: () => mutate(() => api.closeObservedInbox!(sessionId)),
  };
}
export type ObservedInboxControlModel = ReturnType<typeof createObservedInboxControl>;
