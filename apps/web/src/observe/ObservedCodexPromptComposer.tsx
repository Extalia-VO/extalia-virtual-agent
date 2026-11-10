import { useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { AgentHostApi, SessionSummary } from '@extalia/platform';
import type { Messages } from '../i18n';
import { useUnsavedDraft } from '../restart/unsavedDrafts';
import { Icon } from '../ui/Icon';
import { PromptQueueContent } from '../chat/PromptQueueControls';
import { usePromptQueue } from '../chat/usePromptQueue';
import { useComposerDraft } from '../chat/useComposerDraft';
import { PromptDeliveryStatus } from '../chat/PromptDeliveryStatus';
import { ObservedCodexNativeQueue } from './ObservedCodexNativeQueue';
import { PromptSuggestions } from '../chat/PromptSuggestions';
import { CODEX_PROMPT_LIMIT, createObservedCodexPromptControl, type ObservedCodexPromptControl, type ObservedCodexPromptView } from './observedCodexPromptModel';
import './observedCodex.css';

export interface ObservedCodexPromptComposerProps { t: Messages; agents: AgentHostApi; session: SessionSummary; disabled?: boolean; showNativeQueue?: boolean }
export function ObservedCodexPromptComposer(props: ObservedCodexPromptComposerProps) {
  if (props.session.control !== 'observed' || props.session.observation?.sourceId !== 'codex') return null;
  const key = `${props.session.id}:${props.session.observation.sourceId}:${props.session.observation.nativeSessionId}`;
  return <>{props.showNativeQueue !== false && <ObservedCodexNativeQueue key={`native:${key}`} {...props} />}
    {props.agents.promptQueueStatus && props.agents.changePromptQueue
      ? <QueuedPromptSession key={key} {...props} /> : <PromptSession key={key} {...props} />}
    <PromptSuggestions t={props.t} agents={props.agents} session={props.session} disabled={props.disabled} />
  </>;
}

/** One host-owned input keeps waiting prompts editable until their actual handoff. */
function QueuedPromptSession({ t, agents, session, disabled }: ObservedCodexPromptComposerProps) {
  const queue = usePromptQueue(agents, session, disabled);
  const draftState = useComposerDraft(agents, session);
  const { text: draft, setText: setDraft, sending } = draftState;
  const id = useId(), area = useRef<HTMLTextAreaElement>(null), composing = useRef(false);
  const pending = queue.view.status?.items.some(item => item.state === 'pending');
  const busySession = session.running || !!session.pendingApprovalId || pending;
  const locked = !!disabled || queue.view.disabled;
  const blocked = queue.view.status?.items.some(item => item.state === 'unknown');
  const retryBlocked = blocked || queue.view.status?.items.some(item => item.state === 'sending');
  const canSend = !locked && !queue.locked && !sending && !queue.view.busy && !blocked && draftState.delivery !== 'unknown'
    && queue.view.delivery !== 'unknown' && queue.view.phase === 'ready' && !!queue.view.status?.supported
    && !!draft.trim() && !draft.includes('\0') && draft.length <= (queue.view.status?.maxTextLength ?? CODEX_PROMPT_LIMIT);
  useUnsavedDraft(id, !!draft.trim());
  useLayoutEffect(() => {
    if (!area.current) return;
    area.current.style.height = 'auto';
    area.current.style.height = `${Math.min(area.current.scrollHeight, 240)}px`;
  }, [draft]);
  async function send() {
    if (!canSend) return;
    const text = draft, lease = draftState.beginSend();
    if (!lease) return;
    try { lease.finish(await queue.control.submit(text) ? 'accepted' : queue.control.getSnapshot().delivery === 'unknown' ? 'unknown' : 'failed'); }
    catch { lease.finish('unknown'); }
  }
  return <>
    {!!queue.view.status?.items.length && <PromptQueueContent t={t} control={queue.control} view={queue.view} disabled={locked} />}
    <PromptDeliveryStatus t={t} queueView={queue.view} phase={draftState.delivery} observed
      onRecheck={() => { void queue.control.refresh(); }} rechecking={queue.view.busy}
      onRetryConfirmed={draftState.delivery === 'unknown' && queue.view.phase === 'ready' && !retryBlocked ? () => {
        if (queue.control.allowRetry()) draftState.allowRetry();
      } : undefined} />
    <form className="composer observed-codex-prompt" onSubmit={event => { event.preventDefault(); void send(); }}>
      <label className="visually-hidden" htmlFor={`${id}-input`}>{t.observedCodexPrompt.label}</label>
      <textarea ref={area} id={`${id}-input`} rows={2} value={draft} disabled={locked}
        placeholder={busySession ? t.promptQueue.placeholder : t.observedCodexPrompt.placeholder} autoComplete="off"
        onChange={event => setDraft(event.target.value)} onKeyDown={event => {
          if (!codexPromptEnterSends({ key: event.key, shiftKey: event.shiftKey, isComposing: composing.current || event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) return;
          event.preventDefault(); void send();
        }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
      <button type="submit" className="send-button" disabled={!canSend} aria-busy={sending}
        aria-label={sending ? t.observedCodexPrompt.sending : busySession ? t.promptQueue.queueLabel : t.observedCodexPrompt.send}
        title={sending ? t.observedCodexPrompt.sending : busySession ? t.promptQueue.queueLabel : t.observedCodexPrompt.send}>
        <Icon name={sending ? 'refresh' : 'send'} className={sending ? 'spin' : ''} />
      </button>
      {(locked || queue.view.phase !== 'ready' || !queue.view.status?.supported || draft.length > CODEX_PROMPT_LIMIT) && <p role="status" className="observed-codex-prompt-hint">
        {locked ? t.observedCodexPrompt.paused : draft.length > CODEX_PROMPT_LIMIT ? t.observedCodexPrompt.tooLong
          : queue.view.phase === 'loading' ? t.promptQueue.loading : queue.view.phase === 'error' ? t.promptQueue.failed : t.promptQueue.unsupported}
      </p>}
      {(queue.view.phase === 'error' || queue.view.notice) && queue.view.delivery !== 'unknown' && <p role="status">{queue.view.notice === 'stale' ? t.promptQueue.stale : t.promptQueue.failed}
        <button type="button" disabled={queue.view.busy} onClick={() => { void queue.control.refresh(); }}>{t.promptQueue.refresh}</button>
      </p>}
    </form>
  </>;
}
function PromptSession({ t, agents, session, disabled }: ObservedCodexPromptComposerProps) {
  const draft = useComposerDraft(agents, session);
  const nativeSessionId = session.observation?.nativeSessionId;
  const control = useMemo(() => createObservedCodexPromptControl(agents, session.id, nativeSessionId), [agents, session.id, nativeSessionId]);
  const view = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  const paused = !!disabled || !session.observation?.watching || session.observation.status !== 'watching';
  useLayoutEffect(() => { control.setDisabled(paused); }, [control, paused]);
  useLayoutEffect(() => control.start(), [control]);
  return <ObservedCodexPromptContent t={t} control={control} view={view} disabled={paused} draft={draft} />;
}

export function codexPromptEnterSends(event: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

export function ObservedCodexPromptContent({ t, control, view, disabled = false, draft }: {
  t: Messages; control: ObservedCodexPromptControl; view: ObservedCodexPromptView; disabled?: boolean; draft?: ReturnType<typeof useComposerDraft>;
}) {
  const c = t.observedCodexPrompt, id = useId(), area = useRef<HTMLTextAreaElement>(null), composing = useRef(false);
  const locked = disabled || view.disabled || view.phase === 'unsupported';
  const text = draft?.text ?? view.draft, setText = draft?.setText ?? control.setDraft;
  const busy = !!draft?.sending || view.busy || !!view.status?.busy;
  useUnsavedDraft(id, text.trim().length > 0);
  useLayoutEffect(() => {
    if (!area.current) return;
    area.current.style.height = 'auto';
    area.current.style.height = `${Math.min(area.current.scrollHeight, 240)}px`;
  }, [text]);
  const canSend = !locked && !busy && draft?.delivery !== 'unknown' && control.canSend(text);
  async function send() {
    if (!canSend) return;
    const lease = draft?.beginSend();
    if (draft && !lease) return;
    try { const result = await control.send(text); lease?.finish(result); }
    catch { lease?.finish('unknown'); }
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!codexPromptEnterSends({ key: event.key, shiftKey: event.shiftKey, isComposing: composing.current || event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) return;
    event.preventDefault();
    if (canSend) void send();
  }
  const notice = view.notice === 'unknown' || view.status?.delivery === 'unknown' ? c.unknown
    : view.notice === 'queued' ? c.queued : view.notice === 'failed' || view.phase === 'error' ? c.failed
      : view.notice === 'unavailable' || view.phase === 'ready' && (!view.status?.threadId || view.status.enabled && !view.status.canQueue && !view.status.busy) ? c.unavailable
        : view.phase === 'unsupported' ? c.unsupported : view.phase === 'loading' ? c.loading : undefined;
  const delivery = draft?.delivery === 'unknown' || view.notice === 'unknown' ? 'unknown'
    : busy ? 'submitting' : view.notice === 'queued' || view.status?.delivery === 'queued' ? 'accepted' : draft?.delivery;
  return <><PromptDeliveryStatus t={t} phase={delivery} observed onRecheck={() => { void control.refresh(); }} rechecking={busy}
    onRetryConfirmed={draft?.delivery === 'unknown' && control.canRetry() ? () => { if (control.allowRetry()) draft.allowRetry(); } : undefined} />
  <form className="composer observed-codex-prompt" onSubmit={event => { event.preventDefault(); if (canSend) void send(); }}
    onDragOver={event => { if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault(); }}
    onDrop={event => { if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault(); }}>
    <label className="visually-hidden" htmlFor={`${id}-input`}>{c.label}</label>
    <textarea ref={area} id={`${id}-input`} rows={2} value={text}
      placeholder={c.placeholder} disabled={locked} aria-describedby={`${id}-status`} autoComplete="off"
      onChange={event => setText(event.target.value)} onKeyDown={keyDown}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
    <button type="submit" className="send-button" disabled={!canSend} aria-label={busy ? c.sending : c.send} title={busy ? c.sending : c.send} aria-busy={busy}>
      <Icon name={busy ? 'refresh' : 'send'} className={busy ? 'spin' : ''} />
    </button>
    <p className="observed-codex-prompt-hint" id={`${id}-status`} role="status">{disabled || view.disabled ? c.paused
      : text.length > CODEX_PROMPT_LIMIT ? c.tooLong : delivery ? undefined : notice}</p>
    {view.phase === 'error' && <button type="button" disabled={view.busy || locked} onClick={() => { void control.refresh(); }}>{c.refresh}</button>}
  </form></>;
}
