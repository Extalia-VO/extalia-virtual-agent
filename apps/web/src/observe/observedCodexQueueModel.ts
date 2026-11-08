import type { AgentHostApi, ObservedCodexQueueStatus } from '@extalia/platform';

export interface CodexQueueView { phase: 'loading' | 'ready' | 'error' | 'unsupported'; status?: ObservedCodexQueueStatus; busy: boolean; draft: string }
export function createCodexQueueControl(api: AgentHostApi, id: string) {
  const supported = !!(api.observedCodexQueueStatus && api.setObservedCodexQueue && api.queueObservedCodexMessage);
  let view: CodexQueueView = { phase: supported ? 'loading' : 'unsupported', busy: false, draft: '' };
  let active = false, generation = 0, reading = false, draftGeneration = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const update = (next: CodexQueueView) => {
    view = next;
    if (active && view.status?.enabled) timer ??= setInterval(() => { void refresh(); }, 2000);
    else { clearInterval(timer); timer = undefined; }
    listeners.forEach(listener => listener());
  };
  function receive(status: ObservedCodexQueueStatus) {
    if (!status || status.sessionId !== id || typeof status.enabled !== 'boolean' || typeof status.canQueue !== 'boolean'
      || status.threadId !== undefined && (typeof status.threadId !== 'string' || !/^[a-f0-9-]{36}$/i.test(status.threadId))
      || status.delivery !== undefined && !['queued', 'unknown'].includes(status.delivery)
      || status.busy !== undefined && typeof status.busy !== 'boolean'
      || status.enabled && !status.threadId) throw new Error('Invalid Codex queue status');
    update({ ...view, phase: 'ready', busy: false, status });
  }
  async function refresh() {
    if (!active || !supported || reading || view.busy) return;
    const epoch = ++generation; reading = true;
    try { const status = await api.observedCodexQueueStatus!(id); if (active && generation === epoch) receive(status); }
    catch { if (active && generation === epoch) update({ ...view, phase: 'error', status: undefined, busy: false }); }
    finally { if (generation === epoch) reading = false; }
  }
  async function mutate(operation: () => Promise<ObservedCodexQueueStatus>, sent = false) {
    if (!active || !supported || view.busy) return;
    const epoch = ++generation, draftEpoch = draftGeneration; reading = false; update({ ...view, busy: true });
    try {
      const status = await operation(); if (!active || generation !== epoch) return;
      receive(status);
      if (sent && status.delivery === 'queued' && draftEpoch === draftGeneration) update({ ...view, draft: '' });
    } catch { if (active && generation === epoch) update({ ...view, phase: 'error', status: undefined, busy: false }); }
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    start() { active = true; void refresh(); return () => { active = false; ++generation; reading = false; clearInterval(timer); timer = undefined; }; },
    refresh,
    setDraft(draft: string) { ++draftGeneration; update({ ...view, draft }); },
    setEnabled(enabled: boolean) { return mutate(() => api.setObservedCodexQueue!(id, enabled)); },
    send() {
      const text = view.draft;
      if (!view.status?.enabled || !view.status.canQueue || view.status.delivery === 'unknown' || !text.trim()) return Promise.resolve();
      return mutate(() => api.queueObservedCodexMessage!(id, { text }), true);
    },
  };
}
export type CodexQueueControl = ReturnType<typeof createCodexQueueControl>;
