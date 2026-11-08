import { useId, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { AgentHostApi, SessionSummary } from '@extalia/platform';
import type { Messages } from '../i18n';
import { useUnsavedDraft } from '../restart/unsavedDrafts';
import { Icon } from '../ui/Icon';
import { createPromptQueueControl, type PromptQueueControl, type PromptQueueView } from './promptQueueModel';

export interface PromptQueueControlsProps { t: Messages; agents: AgentHostApi; session: SessionSummary; disabled?: boolean }
export function PromptQueueControls(props: PromptQueueControlsProps) {
  if (props.session.control === 'observed' && props.session.observation?.sourceId !== 'codex') return null;
  return <QueueSession key={`${props.session.id}:${props.session.observation?.nativeSessionId ?? ''}`} {...props} />;
}
function QueueSession({ t, agents, session, disabled }: PromptQueueControlsProps) {
  const control = useMemo(() => createPromptQueueControl(agents, session.id), [agents, session.id]);
  const view = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  const locked = !!disabled || session.control === 'observed' && (!session.observation?.watching || session.observation.status !== 'watching');
  useLayoutEffect(() => { control.setDisabled(locked); }, [control, locked]);
  useLayoutEffect(() => control.start(), [control]);
  return <PromptQueueContent t={t} control={control} view={view} disabled={locked} />;
}

export function PromptQueueContent({ t, control, view, disabled = false }: {
  t: Messages; control: PromptQueueControl; view: PromptQueueView; disabled?: boolean;
}) {
  const c = t.promptQueue, id = useId(), status = view.status;
  const localLocked = disabled || view.disabled || view.busy || view.phase !== 'ready' || !status?.revision;
  const locked = localLocked || !status?.supported;
  const pending = status?.items.filter(item => item.state === 'pending') ?? [];
  const blocked = status?.items.some(item => item.state === 'unknown' || item.state === 'sending');
  const uncertain = status?.items.some(item => item.state === 'unknown');
  const staleEdit = !!view.edit && !status?.items.some(item => item.id === view.edit!.original.id && item.state === 'pending' && item.text === view.edit!.original.text);
  useUnsavedDraft(id, !!view.draft.trim() || !!view.edit && view.edit.text !== view.edit.original.text);
  return <details className="prompt-queue">
    <summary>{c.title} <span className="badge">{pending.length}</span></summary>
    <div className="prompt-queue-body">
      <p className="prompt-queue-hint">{c.helper}</p><p className="prompt-queue-hint">{c.sourceHint}</p>
      <p role="status">{view.phase === 'unsupported' || status && !status.supported ? c.unsupported : view.phase === 'loading' ? c.loading
        : view.phase === 'error' ? c.failed : view.notice === 'stale' ? c.stale : uncertain ? c.blocked : status?.paused ? c.paused : c.running}</p>
      {view.phase !== 'unsupported' && <>
        <div className="prompt-queue-actions">
          <button type="button" disabled={locked || !!blocked && !!status?.paused || !!status?.paused && !pending.length}
            onClick={() => { void control.setPaused(!status?.paused); }}>{status?.paused ? c.start : c.pause}</button>
          <button type="button" disabled={view.busy} onClick={() => { void control.refresh(); }}>{c.refresh}</button>
        </div>
        <form className="composer" onSubmit={event => { event.preventDefault(); if (!locked) void control.add(); }}>
          <label htmlFor={`${id}-add`}>{c.addLabel}</label>
          <textarea id={`${id}-add`} rows={2} value={view.draft} placeholder={c.addPlaceholder} disabled={disabled || view.disabled || !status?.supported}
            onChange={event => control.setDraft(event.target.value)} aria-describedby={`${id}-limit`} />
          <div className="composer-toolbar"><span id={`${id}-limit`} className="prompt-queue-hint">{c.limit}: {status?.maxTextLength ?? '—'}</span>
            <button type="submit" className="send-button" aria-label={c.add} title={c.add} disabled={locked || !control.canAdd()}><Icon name={view.busy ? 'refresh' : 'send'} className={view.busy ? 'spin' : ''} /></button></div>
          {status && view.draft.length > status.maxTextLength && <p role="status">{c.tooLong}</p>}
        </form>
        {view.edit && <form className="prompt-queue-item" onSubmit={event => { event.preventDefault(); if (!locked) void control.save(); }}>
          <label htmlFor={`${id}-edit`}>{c.edit}</label>
          <textarea id={`${id}-edit`} rows={3} value={view.edit.text} onChange={event => control.setEditDraft(event.target.value)} disabled={disabled || view.disabled || view.busy || staleEdit} />
          {(staleEdit || view.notice === 'stale') && <p role="status">{c.stale}</p>}
          {status && view.edit.text.length > status.maxTextLength && <p role="status">{c.tooLong}</p>}
          <div className="prompt-queue-actions"><button type="submit" disabled={locked || !control.canSave()}>{c.save}</button>
            <button type="button" disabled={view.busy} onClick={() => control.cancelEdit()}>{c.cancel}</button></div>
        </form>}
        {!status?.items.length && <p>{c.empty}</p>}
        <ol>{status?.items.map(item => <li className="prompt-queue-item" key={item.id}>
          <p className="prompt-queue-hint">{c.states[item.state]}</p><pre>{item.text}</pre>
          {item.state === 'pending' ? <div className="prompt-queue-actions">
            <button type="button" disabled={locked || !!view.edit} onClick={() => control.beginEdit(item)}>{c.edit}</button>
            <button type="button" disabled={localLocked} onClick={() => { void control.delete(item); }}>{c.delete}</button>
            <button type="button" disabled={locked || pending[0]?.id === item.id} onClick={() => { void control.move(item, -1); }}>{c.moveUp}</button>
            <button type="button" disabled={locked || pending.at(-1)?.id === item.id} onClick={() => { void control.move(item, 1); }}>{c.moveDown}</button>
          </div> : <>
            <p className="prompt-queue-hint">{c.readonly}</p>
            {(item.state === 'unknown' || item.state === 'sent') && <><p className="prompt-queue-hint">{c.acknowledgeHint}</p>
              <button type="button" disabled={localLocked} onClick={() => { void control.acknowledge(item); }}>{c.acknowledge}</button></>}
          </>}
        </li>)}</ol>
        {view.busy && <p role="status">{c.busy}</p>}
      </>}
    </div>
  </details>;
}
