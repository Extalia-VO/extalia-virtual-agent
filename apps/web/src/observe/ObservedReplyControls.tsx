import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import type { AgentHostApi, SessionSummary } from '@extalia/platform';
import type { Messages } from '../i18n';
import { createObservedReplyControl, validReplyStatus, type ObservedReplyControl, type ObservedReplyView } from './observedReplyModel';
import './observedCodex.css';

export function ObservedReplyControls({ agents, session, t }: { agents: AgentHostApi; session: SessionSummary; t: Messages }) {
  if (session.control !== 'observed') return null;
  return <ReplySessionControls agents={agents} sessionId={session.id} t={t} />;
}
function ReplySessionControls({ agents, sessionId, t, onCreate, busy = false }: { agents: AgentHostApi; sessionId: string; t: Messages; onCreate?: () => Promise<void>; busy?: boolean }) {
  const model = useMemo(() => createObservedReplyControl(agents, sessionId), [agents, sessionId]);
  const view = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => model.start(), [model]);
  return <ObservedReplyContent t={t} view={busy ? { ...view, busy: true } : view} control={onCreate ? { ...model, create: onCreate } : model} />;
}

/** A pairing record only; ordinary Chat clients need no invented native observation. */
export function ManualReplyControls({ agents, t }: { agents: AgentHostApi; t: Messages }) {
  const [pairs, setPairs] = useState<ReadonlyMap<AgentHostApi, string>>(() => new Map());
  const [pending, setPending] = useState<AgentHostApi | null>(null), [failure, setFailure] = useState<AgentHostApi | null>(null);
  const sessionId = pairs.get(agents) ?? '', busy = pending === agents, failed = failure === agents;
  async function createPair() {
    if (busy || !agents.createManualReply) return;
    setPending(agents); setFailure(null);
    try {
      const status = await agents.createManualReply();
      if (!validReplyStatus(status, status.sessionId) || status.state !== 'waitingForAgent') throw new Error('Unavailable channel');
      setPairs(current => new Map(current).set(agents, status.sessionId));
    } catch { setFailure(agents); }
    finally { setPending(current => current === agents ? null : current); }
  }
  if (sessionId) return <><ReplySessionControls key={sessionId} agents={agents} sessionId={sessionId} t={t} onCreate={createPair} busy={busy} />
    {failed && <p role="alert">{t.observedReply.failed}</p>}</>;
  return <section className="card observed-codex"><h3>{t.observedReply.manualTitle}</h3>
    <p>{t.observedReply.manualHint}</p>
    {!agents.createManualReply ? <p>{t.observedReply.unsupported}</p> : <button type="button" disabled={busy} onClick={() => { void createPair(); }}>{t.observedReply.create}</button>}
    {failed && <p role="alert">{t.observedReply.failed}</p>}
  </section>;
}

export function ObservedReplyContent({ t, view, control }: { t: Messages; view: ObservedReplyView; control: ObservedReplyControl }) {
  const c = t.observedReply, status = view.status, id = useId();
  const waiting = status?.state === 'waitingForAgent' || status?.state === 'waitingForReply';
  const command = status?.state === 'waitingForAgent' ? `extalia reply --url '${status.url}' --token '${status.token}'` : '';
  return <section className="observed-codex" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{c.title}</h3>
    <p className="observed-codex-hint">{c.helper}</p>
    <p role="status">{view.phase === 'unsupported' ? c.unsupported : view.phase === 'loading' ? c.loading
      : view.phase === 'error' ? c.failed : c.states[status?.state ?? 'disconnected']}</p>
    {status?.problem && <p className="observed-codex-hint">{status.problem}</p>}
    {view.phase !== 'unsupported' && <>
      {status?.state === 'waitingForAgent' && <>
        <label htmlFor={`${id}-command`}>{c.instruction}</label>
        <textarea id={`${id}-command`} rows={5} readOnly value={`${c.prompt}\n\n${command}`} autoComplete="off" spellCheck={false} />
        <p className="observed-codex-hint">{c.mcpHint}</p>
      </>}
      {status?.state === 'waitingForReply' && <form onSubmit={event => { event.preventDefault(); void control.answer(); }}>
        {status.question && <p className="observed-codex-question">{status.question}</p>}
        <label htmlFor={`${id}-answer`}>{c.answerLabel}</label>
        <textarea id={`${id}-answer`} rows={3} value={view.draft} maxLength={16000} autoComplete="off" onChange={event => control.setDraft(event.target.value)} />
        <p className="observed-codex-hint">{c.replyHint}</p>
        <button type="submit" disabled={view.busy || !view.draft.trim()}>{c.answer}</button>
      </form>}
      <div className="observed-codex-actions">
        {waiting ? <button type="button" disabled={view.busy} onClick={() => { void control.close(); }}>{c.close}</button>
          : <button type="button" disabled={view.busy || view.phase === 'loading'} onClick={() => { void control.create(); }}>{c.create}</button>}
        {view.phase === 'error' && <button type="button" disabled={view.busy} onClick={() => { void control.refresh(); }}>{c.refresh}</button>}
      </div>
    </>}
  </section>;
}
