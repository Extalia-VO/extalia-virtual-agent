import { useId, useRef, useState } from 'react';
import type { AgentHostApi, SessionSummary } from '@extalia/platform';
import type { Messages } from '../i18n';
import { useUnsavedDraft } from '../restart/unsavedDrafts';
import { supportsObservedPromptQueue } from '../observe/observedCodexPromptModel';
import { Icon } from '../ui/Icon';
import type { PromptQueueControl, PromptQueueDrag, PromptQueueView } from './promptQueueModel';
import { usePromptQueue } from './usePromptQueue';
import './promptQueue.css';

export interface PromptQueueControlsProps { t: Messages; agents: AgentHostApi; session: SessionSummary; disabled?: boolean }
export function PromptQueueControls(props: PromptQueueControlsProps) {
  if (props.session.control === 'observed' && !supportsObservedPromptQueue(props.session.observation?.sourceId)) return null;
  return <QueueSession key={`${props.session.id}:${props.session.observation?.nativeSessionId ?? ''}`} {...props} />;
}
function QueueSession({ t, agents, session, disabled }: PromptQueueControlsProps) {
  const { control, view, locked } = usePromptQueue(agents, session, disabled);
  return <PromptQueueContent t={t} control={control} view={view} disabled={locked} />;
}

export function PromptQueueContent({ t, control, view, disabled = false }: {
  t: Messages; control: PromptQueueControl; view: PromptQueueView; disabled?: boolean;
}) {
  const c = t.promptQueue, id = useId(), status = view.status;
  const drag = useRef<PromptQueueDrag | undefined>(undefined);
  const [dropTarget, setDropTarget] = useState<string>();
  const localLocked = disabled || view.disabled || view.busy || view.phase !== 'ready' || !status?.revision;
  const locked = localLocked || !status?.supported;
  const pending = status?.items.filter(item => item.state === 'pending') ?? [];
  // Keep actionable waiting prompts ahead of completed receipts in the bounded viewport.
  const rank = { unknown: 0, sending: 0, pending: 1, sent: 2 };
  const visibleItems = [...(status?.items ?? [])].sort((left, right) => rank[left.state] - rank[right.state]);
  const blocked = status?.items.some(item => item.state === 'unknown' || item.state === 'sending');
  const uncertain = status?.items.some(item => item.state === 'unknown');
  const staleEdit = !!view.edit && !status?.items.some(item => item.id === view.edit!.original.id && item.state === 'pending' && item.text === view.edit!.original.text);
  const canReorder = !locked && !view.edit && pending.length > 1;
  const stopDrag = () => { drag.current = undefined; setDropTarget(undefined); };
  useUnsavedDraft(id, !!view.edit && view.edit.text !== view.edit.original.text);
  return <details className="prompt-queue prompt-queue-list" open={pending.length > 0 || uncertain || view.phase === 'error' || undefined}>
    <summary title={c.sourceHint}>{c.title} <span className="badge">{pending.length}</span></summary>
    <div className="prompt-queue-body">
      <div className="prompt-queue-toolbar">
        <p className="prompt-queue-hint" role="status">{view.phase === 'unsupported' || status && !status.supported ? c.unsupported : view.phase === 'loading' ? c.loading
          : view.phase === 'error' ? c.failed : view.notice === 'stale' ? c.stale : uncertain ? c.blocked : status?.paused ? c.paused : c.running}</p>
        {view.phase !== 'unsupported' && <div className="prompt-queue-actions">
          <button type="button" disabled={locked || !!blocked && !!status?.paused || !!status?.paused && !pending.length}
            onClick={() => { void control.setPaused(!status?.paused); }}>{status?.paused ? c.start : c.pause}</button>
          <button type="button" disabled={view.busy} onClick={() => { void control.refresh(); }} aria-label={c.refresh} title={c.refresh}><Icon name="refresh" /></button>
        </div>}
      </div>
      {view.phase !== 'unsupported' && <>
        {view.edit && <form className="prompt-queue-item" onSubmit={event => { event.preventDefault(); if (!locked) void control.save(); }}>
          <label htmlFor={`${id}-edit`}>{c.edit}</label>
          <textarea id={`${id}-edit`} rows={3} value={view.edit.text} onChange={event => control.setEditDraft(event.target.value)} disabled={disabled || view.disabled || view.busy || staleEdit} />
          {(staleEdit || view.notice === 'stale') && <p role="status">{c.stale}</p>}
          {status && view.edit.text.length > status.maxTextLength && <p role="status">{c.tooLong}</p>}
          <div className="prompt-queue-actions"><button type="submit" disabled={locked || !control.canSave()}>{c.save}</button>
            <button type="button" disabled={view.busy} onClick={() => control.cancelEdit()}>{c.cancel}</button></div>
        </form>}
        {!status?.items.length && <p className="prompt-queue-hint">{c.empty}</p>}
        {canReorder && <p id={`${id}-drop`} className="prompt-queue-hint prompt-queue-drop-hint">{c.dropHint}</p>}
        <ol aria-label={c.queueLabel}>{visibleItems.map(item => <li className={`prompt-queue-item${dropTarget === item.id ? ' prompt-queue-drop-target' : ''}`} data-queue-state={item.state} key={item.id}
          onDragOver={event => {
            if (canReorder && item.state === 'pending' && drag.current && drag.current.item.id !== item.id) {
              event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(item.id);
            }
          }}
          onDragLeave={() => { if (dropTarget === item.id) setDropTarget(undefined); }}
          onDrop={event => {
            const source = drag.current; stopDrag();
            if (!canReorder || item.state !== 'pending' || !source) return;
            event.preventDefault(); void control.drop(source, item);
          }}>
          <div className="prompt-queue-item-heading">
            {item.state === 'pending' && <button type="button" className="prompt-queue-drag" disabled={!canReorder} draggable={canReorder}
              aria-label={c.dragHandle} title={c.dragHandle} aria-describedby={canReorder ? `${id}-drop` : undefined}
              onDragStart={event => {
                const source = control.beginDrag(item);
                if (!canReorder || !source) { event.preventDefault(); return; }
                drag.current = source; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id);
              }} onDragEnd={stopDrag}><Icon name="menu" /></button>}
            <p className={`prompt-queue-hint${item.state === 'pending' ? ' visually-hidden' : ''}`}>{c.states[item.state]}</p>
          </div>
          <pre title={item.text}>{item.text}</pre>
          {item.state === 'pending' ? <div className="prompt-queue-actions">
            {status?.canSteer && <button type="button" aria-label={c.steer} title={c.steer} disabled={locked || !!view.edit} onClick={() => { void control.steer(item); }}><Icon name="send" /></button>}
            <button type="button" aria-label={c.edit} title={c.edit} disabled={locked || !!view.edit} onClick={() => control.beginEdit(item)}><Icon name="edit" /></button>
            <button type="button" aria-label={c.delete} title={c.delete} disabled={localLocked} onClick={() => { void control.delete(item); }}><Icon name="trash" /></button>
            <button type="button" aria-label={c.moveUp} title={c.moveUp} disabled={!canReorder || pending[0]?.id === item.id} onClick={() => { void control.move(item, -1); }}><Icon name="chevron" className="queue-up" /></button>
            <button type="button" aria-label={c.moveDown} title={c.moveDown} disabled={!canReorder || pending.at(-1)?.id === item.id} onClick={() => { void control.move(item, 1); }}><Icon name="chevron" className="queue-down" /></button>
          </div> : <>
            <p className="prompt-queue-hint">{c.readonly}</p>
            {(item.state === 'unknown' || item.state === 'sent') && <><p className="prompt-queue-hint">{c.acknowledgeHint}</p>
              <button type="button" disabled={localLocked} onClick={() => { void control.acknowledge(item); }}>{c.acknowledge}</button></>}
          </>}
        </li>)}</ol>
        {view.busy && <p className="prompt-queue-hint" role="status">{c.busy}</p>}
      </>}
    </div>
  </details>;
}
