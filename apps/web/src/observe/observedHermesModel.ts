import type { AgentHostApi, HermesObservedAnswerInput, HermesObservedStatus } from '@extalia/platform';

export interface ObservedHermesView { phase: 'loading' | 'ready' | 'error' | 'unsupported'; status?: HermesObservedStatus; busy: boolean; draft: string }
function valid(value: HermesObservedStatus, id: string) {
  return value && value.sessionId === id && ['connected', 'disconnected', 'unavailable'].includes(value.state)
    && typeof value.running === 'boolean' && typeof value.canSend === 'boolean' && typeof value.canAnswer === 'boolean'
    && typeof value.nativeSessionId === 'string' && (value.state !== 'connected' || typeof value.connectionId === 'string' && !!value.connectionId
      && Number.isSafeInteger(value.executionGeneration) && value.executionGeneration! >= 0)
    && Array.isArray(value.requests) && value.requests.length <= 32 && value.requests.every(request => request && typeof request.id === 'string'
      && ['approval', 'clarify'].includes(request.kind) && Number.isSafeInteger(request.executionGeneration) && request.executionGeneration >= 0
      && request.multiSelect !== true && typeof request.question === 'string' && Array.isArray(request.choices)
      && request.choices.length <= 32 && request.choices.every(choice => typeof choice === 'string')
      && (request.kind !== 'approval' || request.choices.length > 0 && request.choices.every(choice => ['once', 'deny', 'session'].includes(choice))));
}
export function createObservedHermesControl(api: AgentHostApi, id: string) {
  const supported = !!(api.observedHermesStatus && api.connectObservedHermes && api.disconnectObservedHermes && api.sendObservedHermesMessage && api.answerObservedHermesInput);
  let view: ObservedHermesView = { phase: supported ? 'loading' : 'unsupported', busy: false, draft: '' };
  let active = false, epoch = 0, reading = false, draftEpoch = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  function update(next: ObservedHermesView) {
    view = next;
    if (active && view.status?.state === 'connected') timer ??= setInterval(() => { void refresh(); }, 2000);
    else { clearInterval(timer); timer = undefined; }
    listeners.forEach(listener => listener());
  }
  function receive(status: HermesObservedStatus) {
    if (!valid(status, id)) throw new Error('Invalid Hermes status');
    update({ ...view, status, phase: 'ready', busy: false });
  }
  async function refresh() {
    if (!active || !supported || reading || view.busy) return;
    const generation = ++epoch; reading = true;
    try { const status = await api.observedHermesStatus!(id); if (active && generation === epoch) receive(status); }
    catch { if (active && generation === epoch) update({ ...view, phase: 'error', status: undefined, busy: false }); }
    finally { if (generation === epoch) reading = false; }
  }
  async function mutate(operation: () => Promise<HermesObservedStatus>, sent = false) {
    if (!active || !supported || view.busy) return;
    const generation = ++epoch, draftGeneration = draftEpoch; reading = false;
    update({ ...view, busy: true });
    try {
      const status = await operation(); if (!active || generation !== epoch) return;
      receive(status);
      if (sent && status.delivery === 'submitted' && draftGeneration === draftEpoch) update({ ...view, draft: '' });
    } catch { if (active && generation === epoch) update({ ...view, phase: 'error', status: undefined, busy: false }); }
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    start() { active = true; void refresh(); return () => { active = false; ++epoch; reading = false; clearInterval(timer); timer = undefined; }; },
    refresh,
    setDraft(draft: string) { ++draftEpoch; update({ ...view, draft }); },
    connect(profile: string) { return mutate(() => api.connectObservedHermes!(id, profile.trim() || undefined)); },
    disconnect() { const status = view.status; return status?.connectionId ? mutate(() => api.disconnectObservedHermes!(id, status.connectionId!)) : Promise.resolve(); },
    send() {
      const status = view.status, text = view.draft;
      if (status?.state !== 'connected' || !status.canSend || !status.connectionId || !text.trim()) return Promise.resolve();
      return mutate(() => api.sendObservedHermesMessage!(id, { connectionId: status.connectionId!, text, executionGeneration: status.executionGeneration }), true);
    },
    answer(input: Omit<HermesObservedAnswerInput, 'connectionId'>) {
      const status = view.status, question = status?.requests.find(request => request.id === input.requestId);
      if (status?.state !== 'connected' || !status.canAnswer || !status.connectionId || !question || question.executionGeneration !== input.executionGeneration) return Promise.resolve();
      return mutate(() => api.answerObservedHermesInput!(id, { ...input, connectionId: status.connectionId! }));
    },
  };
}
export type ObservedHermesControl = ReturnType<typeof createObservedHermesControl>;
