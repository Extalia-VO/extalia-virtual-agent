import { useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { AgentHostApi, SessionSummary } from '@extalia/platform';
import type { Messages } from '../i18n';
import { useUnsavedDraft } from '../restart/unsavedDrafts';
import { Icon } from '../ui/Icon';
import { CODEX_PROMPT_LIMIT, createObservedCodexPromptControl, type ObservedCodexPromptControl, type ObservedCodexPromptView } from './observedCodexPromptModel';
import './observedCodex.css';

export interface ObservedCodexPromptComposerProps { t: Messages; agents: AgentHostApi; session: SessionSummary; disabled?: boolean }
export function ObservedCodexPromptComposer(props: ObservedCodexPromptComposerProps) {
  if (props.session.control !== 'observed' || props.session.observation?.sourceId !== 'codex') return null;
  return <PromptSession key={`${props.session.id}:${props.session.observation.nativeSessionId}:${props.session.observation.projectPath ?? ''}`} {...props} />;
}
function PromptSession({ t, agents, session, disabled }: ObservedCodexPromptComposerProps) {
  const nativeSessionId = session.observation?.nativeSessionId;
  const control = useMemo(() => createObservedCodexPromptControl(agents, session.id, nativeSessionId), [agents, session.id, nativeSessionId]);
  const view = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  const paused = !!disabled || !session.observation?.watching || session.observation.status !== 'watching';
  useLayoutEffect(() => { control.setDisabled(paused); }, [control, paused]);
  useLayoutEffect(() => control.start(), [control]);
  return <ObservedCodexPromptContent t={t} control={control} view={view} disabled={paused} />;
}

export function codexPromptEnterSends(event: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

export function ObservedCodexPromptContent({ t, control, view, disabled = false }: {
  t: Messages; control: ObservedCodexPromptControl; view: ObservedCodexPromptView; disabled?: boolean;
}) {
  const c = t.observedCodexPrompt, id = useId(), area = useRef<HTMLTextAreaElement>(null), composing = useRef(false);
  const locked = disabled || view.disabled || view.phase === 'unsupported';
  useUnsavedDraft(id, view.draft.trim().length > 0);
  useLayoutEffect(() => {
    if (!area.current) return;
    area.current.style.height = 'auto';
    area.current.style.height = `${Math.min(area.current.scrollHeight, 240)}px`;
  }, [view.draft]);
  const canSend = !locked && control.canSend();
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!codexPromptEnterSends({ key: event.key, shiftKey: event.shiftKey, isComposing: composing.current || event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) return;
    event.preventDefault();
    if (canSend) void control.send();
  }
  const notice = view.notice === 'unknown' || view.status?.delivery === 'unknown' ? c.unknown
    : view.notice === 'queued' ? c.queued : view.notice === 'failed' || view.phase === 'error' ? c.failed
      : view.notice === 'unavailable' || view.phase === 'ready' && (!view.status?.threadId || view.status.enabled && !view.status.canQueue && !view.status.busy) ? c.unavailable
        : view.phase === 'unsupported' ? c.unsupported : view.phase === 'loading' ? c.loading : undefined;
  return <form className="composer observed-codex-prompt" onSubmit={event => { event.preventDefault(); if (canSend) void control.send(); }}
    onDragOver={event => { if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault(); }}
    onDrop={event => { if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault(); }}>
    <label className="visually-hidden" htmlFor={`${id}-input`}>{c.label}</label>
    <textarea ref={area} id={`${id}-input`} rows={2} value={view.draft}
      placeholder={c.placeholder} disabled={locked} aria-describedby={`${id}-status`} autoComplete="off"
      onChange={event => control.setDraft(event.target.value)} onKeyDown={keyDown}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
    <button type="submit" className="send-button" disabled={!canSend} aria-label={view.busy ? c.sending : c.send} title={view.busy ? c.sending : c.send} aria-busy={view.busy}>
      <Icon name={view.busy ? 'refresh' : 'send'} className={view.busy ? 'spin' : ''} />
    </button>
    <p className="observed-codex-prompt-hint" id={`${id}-status`} role="status">{disabled || view.disabled ? c.paused
      : view.draft.length > CODEX_PROMPT_LIMIT ? c.tooLong : notice}</p>
    {view.phase === 'error' && <button type="button" disabled={view.busy || locked} onClick={() => { void control.refresh(); }}>{c.refresh}</button>}
  </form>;
}
