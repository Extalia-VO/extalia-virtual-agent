import { useEffect, useId, useMemo, useSyncExternalStore } from 'react';
import type { AgentHostApi, SessionSummary } from '@extalia/platform';
import type { Messages } from '../i18n';
import { createCodexQueueControl, type CodexQueueControl, type CodexQueueView } from './observedCodexQueueModel';
import './observedCodex.css';

export function ObservedCodexQueueControls({ t, agents, session, settingsOnly = false }: { t: Messages; agents: AgentHostApi; session: SessionSummary; settingsOnly?: boolean }) {
  const model = useMemo(() => createCodexQueueControl(agents, session.id), [agents, session.id]);
  const view = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => model.start(), [model]);
  if (session.control !== 'observed' || session.observation?.sourceId !== 'codex') return null;
  return <CodexQueueContent t={t} view={view} control={model} settingsOnly={settingsOnly} />;
}
export function CodexQueueContent({ t, view, control, settingsOnly = false }: { t: Messages; view: CodexQueueView; control: CodexQueueControl; settingsOnly?: boolean }) {
  const c = t.observedCodexQueue, status = view.status, id = useId();
  return <section className="observed-codex" aria-labelledby={`${id}-title`}><h3 id={`${id}-title`}>{c.title}</h3>
    <p className="observed-codex-hint">{c.helper}</p>
    <p role="status">{view.phase === 'unsupported' ? c.unsupported : view.phase === 'loading' ? c.loading : view.phase === 'error' ? c.failed
      : status?.enabled ? c.enabled : c.disabled}</p>
    {status?.threadId && <p className="observed-codex-thread">{c.thread}: <code>{status.threadId}</code></p>}
    {status?.problem && <p className="observed-codex-hint">{status.problem}</p>}
    {view.phase !== 'unsupported' && <>
      <button type="button" disabled={view.busy || view.phase === 'loading'} onClick={() => { void control.setEnabled(!status?.enabled); }}>{status?.enabled ? c.disable : c.enable}</button>
      {status?.delivery && <p role="status">{status.delivery === 'queued' ? c.queued : c.unknown}</p>}
      {status?.messageId && <p className="observed-codex-thread">{c.receipt}: <code>{status.messageId}</code></p>}
      {!settingsOnly && status?.enabled && <form onSubmit={event => { event.preventDefault(); void control.send(); }}>
        <label htmlFor={`${id}-message`}>{c.message}</label>
        <textarea id={`${id}-message`} rows={3} value={view.draft} maxLength={16000} onChange={event => control.setDraft(event.target.value)} autoComplete="off" disabled={!status.canQueue} />
        <button type="submit" disabled={view.busy || !!status.busy || !status.canQueue || status.delivery === 'unknown' || !view.draft.trim()}>{c.send}</button>
      </form>}
      {view.phase === 'error' && <button type="button" disabled={view.busy} onClick={() => { void control.refresh(); }}>{c.refresh}</button>}
    </>}
  </section>;
}
