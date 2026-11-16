import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { AgentHostApi, ObservedControlRouteStatus, ObservedInboxStatus, SessionSummary } from '@extalia/platform';
import type { Messages } from '../i18n';
import { ConversationToolsTabs } from './ConversationToolsTabs';
import { Select } from '../ui/Select';
import { Icon } from '../ui/Icon';
import { useUnsavedDraft } from '../restart/unsavedDrafts';
import { createObservedReplyControl } from './observedReplyModel';
import { createObservedInboxControl, observedControlChoices, observedSessionControlFor, validObservedInboxStatus,
  OBSERVED_MESSAGE_LIMIT, type ObservedInboxControlModel, type ObservedInboxView, type ObservedSessionControlModel, type ObservedSessionControlView } from './observedSessionControlModel';
import './observedSessionControl.css';

type SessionControlProps = { agents: AgentHostApi; session: SessionSummary; t: Messages; disabled?: boolean; compact?: boolean; onOpenTools?: () => void; nativeControls?: ReactNode };
export function ObservedSessionControl({ agents, session, t, disabled = false, compact = false, onOpenTools }: SessionControlProps) {
  if (session.control !== 'observed') return null;
  return <SessionControls agents={agents} sessionId={session.id} t={t} disabled={disabled || !session.observation?.watching} compact={compact} onOpenTools={onOpenTools} />;
}
function SessionControls({ agents, sessionId, t, disabled = false, manual = false, compact = false, onOpenTools }: {
  agents: AgentHostApi; sessionId: string; t: Messages; disabled?: boolean; manual?: boolean; compact?: boolean; onOpenTools?: () => void;
}) {
  const model = useMemo(() => observedSessionControlFor(agents, sessionId), [agents, sessionId]);
  const view = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => model.start(), [model]);
  const [tools, setTools] = useState(false), id = useId();
  const openTools = onOpenTools ?? (() => setTools(true));
  return <div className="observed-session-controls">
    {!compact && <div className="observed-control-tabs" role="tablist" aria-label={t.characterConsole.tools}>
      {[false, true].map(isTools => <button key={String(isTools)} type="button" role="tab" id={`${id}-${isTools}-tab`}
        aria-controls={`${id}-${isTools}-panel`} aria-selected={tools === isTools} tabIndex={tools === isTools ? 0 : -1}
        onClick={() => setTools(isTools)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); const next = event.key === 'Home' ? false : event.key === 'End' ? true : !isTools;
          setTools(next); document.getElementById(`${id}-${next}-tab`)?.focus();
        }}>{isTools ? t.characterConsole.tools : t.characterConsole.messages}</button>)}
    </div>}
    <div className="observed-control-tab-panel" {...(!compact ? { id: `${id}-false-panel`, role: 'tabpanel', 'aria-labelledby': `${id}-false-tab`, hidden: tools } : {})}>
      <ObservedSessionControlContent t={t} view={view} control={model} disabled={disabled} onOpenTools={openTools} />
    </div>
    {!compact && <div className="observed-control-tab-panel" id={`${id}-true-panel`} role="tabpanel" aria-labelledby={`${id}-true-tab`} hidden={!tools}>
      {tools && <SessionTools agents={agents} sessionId={sessionId} t={t} disabled={disabled} manual={manual} />}
    </div>}
  </div>;
}

/** Advanced controls share the composer's controller and draft, without another message input. */
export function ObservedSessionTools({ agents, session, t, disabled = false, nativeControls }: SessionControlProps) {
  if (session.control !== 'observed') return null;
  return <SessionTools agents={agents} sessionId={session.id} t={t} disabled={disabled || !session.observation?.watching} nativeControls={nativeControls} />;
}
function SessionTools({ agents, sessionId, t, disabled, manual = false, nativeControls }: { agents: AgentHostApi; sessionId: string; t: Messages; disabled?: boolean; manual?: boolean; nativeControls?: ReactNode }) {
  const model = useMemo(() => observedSessionControlFor(agents, sessionId), [agents, sessionId]);
  const view = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => model.start(), [model]);
  const labels = t.characterConsole.toolTabs;
  return <ConversationToolsTabs label={t.characterConsole.tools} items={[
    { id: 'connection', label: labels.connection, render: active => <ObservedSessionToolsContent t={t} view={view} control={model} disabled={disabled || !active} /> },
    { id: 'pairing', label: labels.pairing, render: active => <div className="observed-session-tools">
      <InboxControls key={sessionId} agents={agents} sessionId={sessionId} t={t} disabled={disabled || !active} />
      {!manual && <ReplyPairing key={`reply:${sessionId}`} agents={agents} sessionId={sessionId} t={t} disabled={disabled || !active} />}
    </div> },
    ...(nativeControls ? [{ id: 'session', label: labels.session, render: () => nativeControls }] : []),
  ]} />;
}

export function ObservedSessionControlContent({ t, view, control, disabled = false, onOpenTools }: {
  t: Messages; view: ObservedSessionControlView; control: ObservedSessionControlModel; disabled?: boolean; compact?: boolean; onOpenTools?: () => void;
}) {
  const c = t.observedControl, id = useId(), area = useRef<HTMLTextAreaElement>(null), composing = useRef(false);
  const blocked = disabled || view.busy, available = !!observedControlChoices(view.status).length;
  const needsAction = view.phase === 'ready' && available && !view.busy && !view.notice && view.receipt?.state !== 'unknown' && !control.hasMessageAction();
  useUnsavedDraft(id, !!view.draft.trim());
  useLayoutEffect(() => {
    if (!area.current) return;
    area.current.style.height = 'auto'; area.current.style.height = `${Math.min(area.current.scrollHeight, 240)}px`;
  }, [view.draft]);
  const send = () => { if (!blocked) void control.sendMessage(); };
  return <div className="observed-session-prompt">
    {view.phase !== 'ready' || !available || needsAction ? <p className="observed-control-feedback" role="status">{view.phase === 'loading' ? c.loading
      : view.phase === 'error' ? c.failed : needsAction ? c.chooseInTools : c.needsTools}{view.phase !== 'loading' && onOpenTools && <button type="button" className="button small" onClick={onOpenTools}>{t.characterConsole.tools}</button>}</p> : null}
    {view.notice && <p className="observed-control-feedback" role="alert">{c[view.notice]}</p>}
    {view.receipt && <p className="observed-control-feedback" role="status" aria-live="polite">{c.receipts[view.receipt.state]}</p>}
    <form className="composer observed-session-control" onSubmit={event => { event.preventDefault(); send(); }}>
      <label className="visually-hidden" htmlFor={`${id}-message`}>{c.message}</label>
      <textarea ref={area} id={`${id}-message`} value={view.draft} rows={2} maxLength={OBSERVED_MESSAGE_LIMIT} placeholder={c.placeholder}
        autoComplete="off" disabled={disabled} onChange={event => control.setDraft(event.target.value)}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          event.preventDefault(); send();
        }} />
      <button className="send-button" type="submit" aria-busy={view.busy} aria-label={view.busy ? c.sending : c.send} title={view.busy ? c.sending : c.send}
        disabled={blocked || !control.canSendMessage()}><Icon name="send" /></button>
    </form>
  </div>;
}

export function ObservedSessionToolsContent({ t, view, control, disabled = false }: {
  t: Messages; view: ObservedSessionControlView; control: ObservedSessionControlModel; disabled?: boolean;
}) {
  const c = t.observedControl, id = useId(), choices = observedControlChoices(view.status), blocked = disabled || view.busy;
  const renderRoute = (route: ObservedControlRouteStatus) => <article className="observed-control-route" key={route.route}>
    <div className="observed-control-heading"><strong>{c.routes[route.route]}</strong><span className="badge small">{c.states[route.state]}</span></div>
    <p className="observed-control-evidence">{route.evidence === 'native-attachment' && route.state === 'unavailable' ? c.nativeUnverified : c.evidence[route.evidence]}</p><p className="observed-control-hint">{c.limits[route.limit]}</p>
    {!!route.capabilities.length && <ul className="observed-control-capabilities">{route.capabilities.map(capability => <li key={capability.action}>
      <span>{c.actions[capability.action]}</span><span>{capability.available && !!capability.capabilityId && route.state === 'ready' ? c.states.ready : c.states.unavailable}</span>
    </li>)}</ul>}
    {route.relatedControls.some(item => item.available) && <p className="observed-control-hint">{c.related}</p>}
    {route.problem && <p className="observed-control-hint">{route.problem}</p>}
  </article>;
  const visible = (route: ObservedControlRouteStatus) => route.state !== 'unavailable' || route.relatedControls.some(item => item.available);
  const mainRoutes = view.status?.routes.filter(visible) ?? [], otherRoutes = view.status?.routes.filter(route => !visible(route)) ?? [];
  return <section className="observed-session-control-settings" aria-labelledby={`${id}-title`}>
    <div className="observed-control-heading"><h3 id={`${id}-title`}>{c.title}</h3>
      <button className="button" type="button" disabled={blocked || view.phase === 'unsupported'} onClick={() => { void control.refresh(); }}>{c.refresh}</button></div>
    <p className="observed-control-hint">{c.helper}</p>
    <p role="status">{view.phase === 'unsupported' ? c.unsupported : view.phase === 'loading' ? c.loading : view.phase === 'error' ? c.failed : !choices.length ? c.unavailable : null}</p>
    <Select label={c.action} value={view.selected} placeholder={c.choose} disabled={blocked || !choices.length}
      options={choices.map(({ route, capability }) => ({ value: capability.capabilityId!, label: `${c.routes[route.route]} · ${c.actions[capability.action]}` }))}
      onChange={value => control.select(value)} />
    {!!mainRoutes.length && <div className="observed-control-routes">{mainRoutes.map(renderRoute)}</div>}
    {!!otherRoutes.length && <details className="observed-control-advanced"><summary>{c.otherConnections}</summary>
      <div className="observed-control-scroll"><div className="observed-control-routes">{otherRoutes.map(renderRoute)}</div></div>
    </details>}
  </section>;
}

function InboxControls({ agents, sessionId, t, disabled }: { agents: AgentHostApi; sessionId: string; t: Messages; disabled?: boolean }) {
  const model = useMemo(() => createObservedInboxControl(agents, sessionId), [agents, sessionId]);
  const view = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => model.start(), [model]);
  return <ObservedInboxContent t={t} control={model} view={view} disabled={disabled} />;
}
export function ObservedInboxContent({ t, view, control, disabled = false }: {
  t: Messages; view: ObservedInboxView; control: ObservedInboxControlModel; disabled?: boolean;
}) {
  const c = t.observedControl, id = useId(), status = view.status, connected = status?.state === 'connected', blocked = disabled || view.busy;
  const command = connected && view.revealed ? `extalia inbox --url '${status.url}' --token '${status.token}' --wait-ms 25000\n\nextalia inbox --url '${status.url}' --token '${status.token}' --ack MESSAGE_ID` : '';
  return <section className="observed-control-pairing" aria-labelledby={`${id}-title`}>
    <h4 id={`${id}-title`}>{c.pairing}</h4><p className="observed-control-hint">{c.pairingHint}</p>
    <p role="status">{view.phase === 'unsupported' ? c.inboxUnsupported : view.phase === 'error' ? c.inboxFailed
      : view.phase === 'loading' ? c.loading : c.inboxStates[status?.state ?? 'disconnected']}</p>
    {connected && <><p className="observed-control-hint">{status.polling ? c.polling : c.notPolling} · {c.queuedCount(status.queued ?? 0)}</p>
      <button className="button" type="button" disabled={blocked} aria-expanded={view.revealed} aria-controls={`${id}-pair`} onClick={() => control.reveal(!view.revealed)}>{view.revealed ? c.hide : c.reveal}</button>
      {view.revealed && <div id={`${id}-pair`} className="observed-control-instructions"><p>{c.instruction}</p>
        <label htmlFor={`${id}-cli`}>{c.command}</label><textarea id={`${id}-cli`} value={command} rows={5} readOnly autoComplete="off" spellCheck={false} />
        <label htmlFor={`${id}-mcp`}>{c.mcp}</label><textarea id={`${id}-mcp`} value={`poll_inbox(${JSON.stringify({ url: status.url, token: status.token, waitMs: 25000 })})\n\npoll_inbox(${JSON.stringify({ url: status.url, token: status.token, ack: 'MESSAGE_ID' })})`} rows={5} readOnly autoComplete="off" spellCheck={false} />
        <p className="observed-control-hint">{c.ackHint}</p><p className="observed-control-hint">{c.secretHint}</p></div>}
      {!!status.receipts?.length && <ul className="observed-control-receipts">{status.receipts.map(receipt => <li key={receipt.messageId}><code>{receipt.messageId}</code> · {c.inboxReceipts[receipt.state]}</li>)}</ul>}
    </>}
    {status?.problem && <p className="observed-control-hint">{status.problem}</p>}
    {view.phase !== 'unsupported' && <div className="observed-control-actions">
      {connected ? <button className="button" type="button" disabled={blocked} onClick={() => { void control.close(); }}>{c.close}</button>
        : <button className="button primary" type="button" disabled={blocked || view.phase === 'loading'} onClick={() => { void control.create(); }}>{c.create}</button>}
      <button className="button" type="button" disabled={blocked} onClick={() => { void control.refresh(); }}>{c.refreshInbox}</button>
    </div>}
  </section>;
}

function ReplyPairing({ agents, sessionId, t, disabled }: { agents: AgentHostApi; sessionId: string; t: Messages; disabled?: boolean }) {
  const model = useMemo(() => createObservedReplyControl(agents, sessionId), [agents, sessionId]);
  const view = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => model.start(), [model]);
  const c = t.observedReply, status = view.status, waiting = status?.state === 'waitingForAgent' || status?.state === 'waitingForReply';
  return <details className="observed-control-pairing"><summary>{c.title}</summary><p className="observed-control-hint">{c.helper}</p>
    <p role="status">{view.phase === 'unsupported' ? c.unsupported : view.phase === 'error' ? c.failed : view.phase === 'loading' ? c.loading : c.states[status?.state ?? 'disconnected']}</p>
    {status?.question && <p>{status.question}</p>}
    {status?.state === 'waitingForAgent' && <ReplyPairInstructions key={status.channelId} status={status} t={t} />}
    {view.phase !== 'unsupported' && <button className={waiting ? 'button' : 'button primary'} type="button" disabled={disabled || view.busy || view.phase === 'loading'} onClick={() => { void (waiting ? model.close() : model.create()); }}>{waiting ? c.close : c.create}</button>}
  </details>;
}
function ReplyPairInstructions({ status, t }: { status: { url?: string; token?: string }; t: Messages }) {
  const [revealed, setRevealed] = useState(false), id = useId(), c = t.observedControl;
  return <><button className="button" type="button" aria-expanded={revealed} onClick={() => setRevealed(!revealed)}>{revealed ? c.hide : c.reveal}</button>
    {revealed && <><label htmlFor={id}>{t.observedReply.instruction}</label><textarea id={id} readOnly rows={5} autoComplete="off" spellCheck={false}
      value={`${t.observedReply.prompt}\n\nextalia reply --url '${status.url}' --token '${status.token}'`} /><p>{t.observedReply.mcpHint}</p></>}</>;
}

/** A labelled pairing registry, with no fabricated observed session or Office presence. */
export function ManualObservedInboxControls({ agents, t }: { agents: AgentHostApi; t: Messages }) {
  const [records, setRecords] = useState<ReadonlyMap<AgentHostApi, ObservedInboxStatus[]>>(() => new Map());
  const [selection, setSelection] = useState<ReadonlyMap<AgentHostApi, string>>(() => new Map());
  const [label, setLabel] = useState(''), [pending, setPending] = useState<AgentHostApi | null>(null), [failure, setFailure] = useState<AgentHostApi | null>(null);
  const requests = useRef(new Map<AgentHostApi, number>());
  const c = t.observedControl, id = useId(), pairs = records.get(agents) ?? [], selected = selection.get(agents) ?? '', busy = pending === agents;
  const refreshRecords = useCallback(async () => {
    if (!agents?.listManualObservedInboxes) return;
    const ticket = (requests.current.get(agents) ?? 0) + 1; requests.current.set(agents, ticket);
    try {
      const statuses = await agents.listManualObservedInboxes();
      if (!Array.isArray(statuses) || !statuses.every(status => validObservedInboxStatus(status, status.sessionId))) throw new Error('Invalid manual inboxes');
      if (requests.current.get(agents) === ticket) { setRecords(current => new Map(current).set(agents, statuses)); setFailure(current => current === agents ? null : current); }
    } catch { if (requests.current.get(agents) === ticket) setFailure(agents); }
  }, [agents]);
  useEffect(() => {
    const generations = requests.current;
    let active = true;
    void Promise.resolve().then(() => { if (active) return refreshRecords(); });
    return () => { active = false; generations.set(agents, (generations.get(agents) ?? 0) + 1); };
  }, [agents, refreshRecords]);
  async function create() {
    if (busy || !agents?.createManualObservedInbox || !label.trim()) return;
    requests.current.set(agents, (requests.current.get(agents) ?? 0) + 1);
    setPending(agents); setFailure(null);
    try {
      const status = await agents.createManualObservedInbox(label.trim());
      if (!validObservedInboxStatus(status, status.sessionId) || status.state !== 'connected') throw new Error('Invalid manual inbox');
      setRecords(current => new Map(current).set(agents, [...(current.get(agents) ?? []).filter(pair => pair.sessionId !== status.sessionId), status]));
      setSelection(current => new Map(current).set(agents, status.sessionId));
    } catch { setFailure(agents); }
    finally { setPending(current => current === agents ? null : current); }
  }
  return <section className="observed-manual-inboxes"><h3>{c.manualTitle}</h3><p>{c.manualHint}</p>
    {!agents?.createManualObservedInbox ? <p>{c.inboxUnsupported}</p> : <form onSubmit={event => { event.preventDefault(); void create(); }}>
      <label htmlFor={`${id}-label`}>{c.label}</label><input id={`${id}-label`} value={label} maxLength={80} placeholder={c.labelPlaceholder} onChange={event => setLabel(event.target.value)} />
      <button className="button primary" type="submit" disabled={busy || !label.trim()}>{c.manualCreate}</button></form>}
    {failure === agents && <p role="alert">{c.inboxFailed}</p>}
    {agents?.listManualObservedInboxes && <button className="button" type="button" disabled={busy} onClick={() => { void refreshRecords(); }}>{c.refreshInbox}</button>}
    {pairs.length ? <Select label={c.manualList} placeholder={c.choose} value={selected}
      options={pairs.map(pair => ({ value: pair.sessionId, label: pair.label || pair.sessionId }))}
      onChange={value => setSelection(current => new Map(current).set(agents, value))} /> : <p>{c.manualEmpty}</p>}
    {selected && pairs.some(pair => pair.sessionId === selected) && <SessionControls agents={agents} sessionId={selected} t={t} manual />}
  </section>;
}
