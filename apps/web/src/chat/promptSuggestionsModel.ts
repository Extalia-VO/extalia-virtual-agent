import { normalizePromptSuggestions, type AgentHostApi, type PromptSuggestionsStatus, type SessionSummary } from '@extalia/platform';
import { composerDraftKey, composerDraftStore } from './composerDrafts';

/** Presentation changes do not change a target; native identity and model changes do. */
export function promptSuggestionsKey(session: SessionSummary): string {
  return JSON.stringify([composerDraftKey(session), session.workspaceId, session.connectionId, session.runtime?.id,
    session.runtime?.profile, session.runtime?.sessionId, session.model, session.options?.model, session.options?.effort]);
}

/** Last-moment store checks protect against typing/sending in another mounted composer. */
export function fillPromptSuggestion(agents: AgentHostApi, session: SessionSummary, prompt: string): boolean {
  const entry = composerDraftStore(agents).entry(composerDraftKey(session));
  const current = entry.getSnapshot();
  if (current.text || current.sending || current.delivery === 'unknown') return false;
  entry.setText(text => text || prompt);
  return true;
}

const attempts = new WeakMap<AgentHostApi, Map<string, Set<string>>>();
function attemptedAnchors(api: AgentHostApi, key: string): Set<string> {
  let targets = attempts.get(api);
  if (!targets) { targets = new Map(); attempts.set(api, targets); }
  let anchors = targets.get(key);
  if (!anchors) {
    anchors = new Set(); targets.set(key, anchors);
    // App-memory only, with no unbounded conversation or prompt history.
    if (targets.size > 128) targets.delete(targets.keys().next().value!);
  }
  return anchors;
}

function validate(value: PromptSuggestionsStatus, sessionId: string): PromptSuggestionsStatus {
  if (!value || value.sessionId !== sessionId || !['pending', 'ready', 'unavailable', 'unsupported', 'private'].includes(value.state)
    || !['native', 'harness'].includes(value.origin) || typeof value.canRequest !== 'boolean'
    || value.anchor !== undefined && (typeof value.anchor !== 'string' || !value.anchor.trim() || value.anchor.length > 1024
      || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value.anchor))) throw new Error('Invalid suggestions status');
  const prompts = normalizePromptSuggestions(value.prompts);
  // Private/unsupported responses cannot carry old suggestions into the view.
  return { sessionId, state: value.state, origin: value.origin, canRequest: value.canRequest,
    anchor: value.anchor, prompts: value.state === 'ready' ? prompts : [] };
}

export interface PromptSuggestionsView { status?: PromptSuggestionsStatus }

/** No prompt execution: only a capability-gated request and bounded status reads. */
export function createPromptSuggestionsControl(api: AgentHostApi, sessionId: string, targetKey: string) {
  let view: PromptSuggestionsView = {}, active = false, enabled = false, epoch = 0, polls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const anchors = attemptedAnchors(api, targetKey);
  const update = (status?: PromptSuggestionsStatus) => { view = { status }; listeners.forEach(listener => listener()); };
  const current = (ticket: number) => active && enabled && ticket === epoch;
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  function schedule(ticket: number) {
    if (!current(ticket) || polls >= 60) return;
    clearTimer();
    timer = setTimeout(() => { void refresh(); }, view.status?.state === 'pending' ? 1000 : 2000);
  }
  function refresh(): Promise<void> {
    if (!active || !enabled || !api.promptSuggestions) return Promise.resolve();
    if (reading) return reading;
    const ticket = epoch;
    ++polls;
    const pending = (async () => {
      try {
        const status = validate(await api.promptSuggestions!(sessionId), sessionId);
        if (!current(ticket)) return;
        update(status);
        if (current(ticket) && status.canRequest && status.anchor && status.state !== 'pending'
          && status.state !== 'private' && status.state !== 'unsupported' && !status.prompts.length
          && api.requestPromptSuggestions && !anchors.has(status.anchor)) {
          anchors.add(status.anchor);
          // Keep a bounded record, including failed requests, across UI remounts.
          if (anchors.size > 128) anchors.delete(anchors.values().next().value!);
          const result = validate(await api.requestPromptSuggestions(sessionId, status.anchor), sessionId);
          if (!current(ticket)) return;
          // A request receipt may never replace a newer completed-turn snapshot.
          if (result.anchor !== status.anchor) { update(); return; }
          update(result);
        }
      } catch {
        if (current(ticket)) update();
      }
    })();
    reading = pending;
    void pending.finally(() => {
      if (reading === pending) reading = undefined;
      if (current(ticket)) schedule(ticket);
      // A working→idle wakeup can precede settlement of its old read.
      else if (active && enabled && !reading && !timer) void refresh();
    });
    return pending;
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    start() {
      active = true; ++epoch; polls = 0;
      if (enabled) void refresh();
      return () => { active = false; ++epoch; clearTimer(); update(); };
    },
    setEnabled(next: boolean) {
      if (next === enabled) return;
      enabled = next; ++epoch; polls = 0; clearTimer(); update();
      if (active && enabled) void refresh();
    },
    refresh,
  };
}
