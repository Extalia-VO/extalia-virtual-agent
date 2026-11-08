import type { AgentHostApi, ObservedReplyStatus } from '@extalia/platform';

export interface ObservedReplyView {
  phase: 'loading' | 'ready' | 'error' | 'unsupported';
  status?: ObservedReplyStatus;
  busy: boolean;
  draft: string;
}

export function validReplyStatus(value: ObservedReplyStatus, id: string): boolean {
  if (!value || value.sessionId !== id || !['disconnected', 'waitingForAgent', 'waitingForReply', 'answered', 'expired', 'unavailable'].includes(value.state)) return false;
  if (value.question !== undefined && (typeof value.question !== 'string' || value.question.length > 2000)) return false;
  if (value.problem !== undefined && typeof value.problem !== 'string') return false;
  if (['waitingForAgent', 'waitingForReply'].includes(value.state) && !/^[a-f0-9-]{36}$/i.test(value.channelId ?? '')) return false;
  if (value.state === 'waitingForAgent') {
    if (!/^[a-f0-9]{64}$/i.test(value.token ?? '')) return false;
    try {
      const url = new URL(value.url!);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash
        || url.pathname !== `/reply/${value.channelId}`) return false;
    } catch { return false; }
  }
  return true;
}

/** Read and mutation generations prevent replies from crossing selected conversations. */
export function createObservedReplyControl(api: AgentHostApi, id: string) {
  const supported = !!(api.observedReplyStatus && api.createObservedReply && api.answerObservedReply && api.closeObservedReply);
  let view: ObservedReplyView = { phase: supported ? 'loading' : 'unsupported', busy: false, draft: '' };
  let active = false, epoch = 0, reading = false, draftEpoch = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  function update(next: ObservedReplyView) {
    view = next;
    if (active && (view.status?.state === 'waitingForAgent' || view.status?.state === 'waitingForReply')) timer ??= setInterval(() => { void refresh(); }, 1000);
    else { clearInterval(timer); timer = undefined; }
    listeners.forEach(listener => listener());
  }
  function receive(status: ObservedReplyStatus) {
    if (!validReplyStatus(status, id)) throw new Error('Invalid reply channel');
    update({ ...view, status, phase: 'ready', busy: false });
  }
  async function refresh() {
    if (!active || !supported || reading || view.busy) return;
    const generation = ++epoch; reading = true;
    try { const status = await api.observedReplyStatus!(id); if (active && generation === epoch) receive(status); }
    catch { if (active && generation === epoch) update({ ...view, phase: 'error', status: undefined, busy: false }); }
    finally { if (generation === epoch) reading = false; }
  }
  async function mutate(operation: () => Promise<ObservedReplyStatus>, answered = false) {
    if (!active || !supported || view.busy) return;
    const generation = ++epoch, draftGeneration = draftEpoch;
    reading = false; update({ ...view, busy: true });
    try {
      const status = await operation();
      if (!active || generation !== epoch) return;
      receive(status);
      if (answered && status.state === 'answered' && draftGeneration === draftEpoch) update({ ...view, draft: '' });
    } catch { if (active && generation === epoch) update({ ...view, phase: 'error', status: undefined, busy: false }); }
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    start() { active = true; void refresh(); return () => { active = false; ++epoch; reading = false; clearInterval(timer); timer = undefined; }; },
    refresh,
    setDraft(draft: string) { ++draftEpoch; update({ ...view, draft }); },
    create: () => mutate(() => api.createObservedReply!(id)),
    close: () => mutate(() => api.closeObservedReply!(id)),
    answer() {
      const status = view.status, text = view.draft;
      if (status?.state !== 'waitingForReply' || !status.channelId || !text.trim()) return Promise.resolve();
      return mutate(() => api.answerObservedReply!(id, { channelId: status.channelId!, text }), true);
    },
  };
}
export type ObservedReplyControl = ReturnType<typeof createObservedReplyControl>;
