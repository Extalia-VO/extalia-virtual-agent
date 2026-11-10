import type { AgentHostApi, ObservedCodexQueueStatus } from '@extalia/platform';

export const CODEX_PROMPT_LIMIT = 16_000;
export type ObservedCodexSendResult = 'accepted' | 'unknown' | 'failed';
export interface ObservedCodexPromptView {
  phase: 'loading' | 'ready' | 'error' | 'unsupported';
  draft: string;
  busy: boolean;
  disabled: boolean;
  status?: ObservedCodexQueueStatus;
  notice?: 'failed' | 'unavailable' | 'queued' | 'unknown';
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Text-only submission to the host's existing observed source; never creates an agent session. */
export function createObservedCodexPromptControl(api: AgentHostApi, sessionId: string, nativeSessionId?: string) {
  const supported = !!(api.observedCodexQueueStatus && api.setObservedCodexQueue && api.queueObservedCodexMessage);
  let view: ObservedCodexPromptView = { phase: supported ? 'loading' : 'unsupported', draft: '', busy: false, disabled: false };
  let active = false, epoch = 0, draftRevision = 0, submitting = false, uncertain = false, retryReady = false;
  let read: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const update = (next: ObservedCodexPromptView) => { view = next; listeners.forEach(listener => listener()); };
  const validate = (status: ObservedCodexQueueStatus) => {
    if (!status || status.sessionId !== sessionId || typeof status.enabled !== 'boolean' || typeof status.canQueue !== 'boolean'
      || status.threadId !== undefined && (typeof status.threadId !== 'string' || !UUID.test(status.threadId)
        || nativeSessionId !== undefined && status.threadId !== nativeSessionId)
      || status.enabled && !status.threadId || status.busy !== undefined && typeof status.busy !== 'boolean'
      || status.delivery !== undefined && !['queued', 'unknown'].includes(status.delivery)) throw new Error('Invalid source status');
    return status;
  };
  const receive = (status: ObservedCodexQueueStatus) => {
    validate(status);
    // The host writes uncertainty ahead of CLI execution. While its operation is
    // still busy this is sending progress, not a settled ambiguous outcome.
    if (status.delivery === 'unknown' && !status.busy) uncertain = true;
    update({ ...view, phase: 'ready', status, ...(uncertain ? { notice: 'unknown' as const }
      : status.delivery === 'queued' ? { notice: 'queued' as const } : {}) });
  };
  function refresh(): Promise<void> {
    if (!active || !supported || submitting) return Promise.resolve();
    if (read) return read;
    const ticket = epoch;
    const current = () => active && ticket === epoch;
    const pending = (async () => {
      try {
        const status = validate(await api.observedCodexQueueStatus!(sessionId));
        if (current()) {
          retryReady = !status.busy && status.delivery !== 'unknown' && status.enabled && status.canQueue && !!status.threadId;
          receive(status);
        }
      }
      catch { if (current()) update({ ...view, phase: 'error', status: undefined, notice: uncertain ? 'unknown' : 'failed' }); }
    })();
    read = pending;
    void pending.finally(() => { if (read === pending) read = undefined; });
    return pending;
  }
  function canSend(text = view.draft) {
    return supported && active && !view.disabled && !submitting && !uncertain && view.phase !== 'loading'
      && !view.status?.busy && !!text.trim() && text.length <= CODEX_PROMPT_LIMIT && !text.includes('\0')
      && !(view.status?.enabled && !view.status.canQueue) && !!view.status?.threadId;
  }
  async function send(text = view.draft): Promise<ObservedCodexSendResult> {
    if (!canSend(text)) return uncertain ? 'unknown' : 'failed';
    const ticket = ++epoch, revision = draftRevision, originalDraft = view.draft, expectedThread = view.status?.threadId;
    const current = () => active && epoch === ticket && !view.disabled;
    submitting = true;
    update({ ...view, busy: true, notice: undefined });
    let dispatched = false;
    try {
      // A prior mount/poll read cannot overwrite this explicit send's fresh source check.
      await read;
      if (!current()) return 'failed';
      let status = validate(await api.observedCodexQueueStatus!(sessionId));
      if (!current()) return 'failed';
      receive(status);
      if (!status.threadId || status.threadId !== expectedThread || status.busy || uncertain) {
        update({ ...view, notice: uncertain ? 'unknown' : 'unavailable' }); return uncertain ? 'unknown' : 'failed';
      }
      if (!status.enabled) {
        status = validate(await api.setObservedCodexQueue!(sessionId, true));
        if (!current()) return 'failed';
        receive(status);
      }
      if (!current() || !status.enabled || !status.canQueue || status.busy || uncertain || status.threadId !== expectedThread) {
        if (current()) update({ ...view, notice: uncertain ? 'unknown' : 'unavailable' }); return uncertain ? 'unknown' : 'failed';
      }
      dispatched = true;
      retryReady = false;
      const result = await api.queueObservedCodexMessage!(sessionId, { text });
      validate(result);
      const accepted = result.threadId === expectedThread && result.delivery === 'queued';
      if (!accepted || !current()) uncertain = true;
      if (current()) {
        receive(result);
        if (uncertain) update({ ...view, notice: 'unknown' });
        else update({ ...view, notice: 'queued', ...(draftRevision === revision && originalDraft === text ? { draft: '' } : {}) });
      }
      // A positive receipt settles the original keyed draft even after unmount.
      // The obsolete control remains conservative about its own UI authority.
      return accepted ? 'accepted' : 'unknown';
    } catch {
      // Once the queue call begins, transport failure cannot establish that nothing was submitted.
      if (dispatched) uncertain = true;
      if (current()) update({ ...view, phase: 'error', status: undefined, notice: uncertain ? 'unknown' : 'failed' });
      return dispatched ? 'unknown' : 'failed';
    } finally {
      submitting = false;
      if (active) update({ ...view, busy: false, ...(uncertain ? { notice: 'unknown' } : {}) });
    }
  }
  const canRetry = () => active && !view.disabled && !submitting && retryReady && view.phase === 'ready'
    && !!view.status?.threadId && view.status.enabled && view.status.canQueue && !view.status.busy && view.status.delivery !== 'unknown';
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    start() {
      active = true; ++epoch;
      void refresh();
      timer = setInterval(() => { void refresh(); }, 2000);
      return () => { active = false; ++epoch; clearInterval(timer); timer = undefined; };
    },
    setDisabled(disabled: boolean) {
      if (disabled !== view.disabled) { ++epoch; update({ ...view, disabled }); }
    },
    setDraft(draft: string) { ++draftRevision; update({ ...view, draft }); },
    canRetry,
    /** User inspection clears only local uncertainty after a fresh safe source read. */
    allowRetry() {
      if (!canRetry()) return false;
      uncertain = false; retryReady = false;
      update({ ...view, notice: view.status?.delivery === 'queued' ? 'queued' : undefined });
      return true;
    },
    refresh, canSend, send,
  };
}
export type ObservedCodexPromptControl = ReturnType<typeof createObservedCodexPromptControl>;
