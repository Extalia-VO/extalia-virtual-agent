import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import type { AgentHostApi, HermesObservedQuestion, SessionSummary } from '@extalia/platform';
import type { Messages } from '../i18n';
import { createObservedHermesControl, type ObservedHermesControl, type ObservedHermesView } from './observedHermesModel';
import './observedCodex.css';

export function ObservedHermesControls({ t, agents, session }: { t: Messages; agents: AgentHostApi; session: SessionSummary }) {
  const model = useMemo(() => createObservedHermesControl(agents, session.id), [agents, session.id]);
  const view = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => model.start(), [model]);
  if (session.control !== 'observed' || session.observation?.sourceId !== 'hermes') return null;
  return <ObservedHermesContent t={t} view={view} control={model} />;
}
export function ObservedHermesContent({ t, view, control }: { t: Messages; view: ObservedHermesView; control: ObservedHermesControl }) {
  const c = t.observedHermes, status = view.status, id = useId();
  const [profile, setProfile] = useState('');
  return <section className="observed-codex" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{c.title}</h3><p className="observed-codex-hint">{c.helper}</p>
    <p role="status">{view.phase === 'unsupported' ? c.unsupported : view.phase === 'loading' ? c.loading : view.phase === 'error' ? c.failed
      : status?.state === 'connected' ? c.connected : status?.state === 'unavailable' ? c.unavailable : c.disconnected}</p>
    {status?.problem && <p className="observed-codex-hint">{status.problem}</p>}
    {view.phase !== 'unsupported' && (status?.state === 'connected' ? <>
      <p className="observed-codex-thread">{c.session}: <code>{status.nativeSessionId}</code></p>
      <button type="button" disabled={view.busy} onClick={() => { void control.disconnect(); }}>{c.disconnect}</button>
      {status.delivery && <p role="status">{c.delivery[status.delivery]}</p>}
      {status.requests.map(question => <HermesQuestion key={`${status.connectionId}:${JSON.stringify(question)}`} t={t} question={question} disabled={view.busy || !status.canAnswer} control={control} />)}
      <form onSubmit={event => { event.preventDefault(); void control.send(); }}>
        <label htmlFor={`${id}-message`}>{c.message}</label>
        <textarea id={`${id}-message`} rows={3} value={view.draft} maxLength={16000} onChange={event => control.setDraft(event.target.value)} disabled={!status.canSend} />
        <button type="submit" disabled={view.busy || !status.canSend || !view.draft.trim()}>{c.send}</button>
      </form>
    </> : <form onSubmit={event => { event.preventDefault(); void control.connect(profile); }}>
      <label htmlFor={`${id}-profile`}>{c.profile}</label>
      <input id={`${id}-profile`} value={profile} maxLength={80} onChange={event => setProfile(event.target.value)} autoComplete="off" />
      <button type="submit" disabled={view.busy || view.phase === 'loading'}>{c.connect}</button>
    </form>)}
    {view.phase === 'error' && <button type="button" disabled={view.busy} onClick={() => { void control.refresh(); }}>{c.refresh}</button>}
  </section>;
}
export function HermesQuestion({ t, question, disabled, control }: { t: Messages; question: HermesObservedQuestion; disabled: boolean; control: ObservedHermesControl }) {
  const c = t.observedHermes, id = useId(), [value, setValue] = useState('');
  return <form className="observed-codex-request" onSubmit={event => {
    event.preventDefault(); if (disabled || !value.trim()) return;
    void control.answer({ requestId: question.id, executionGeneration: question.executionGeneration,
      ...(question.kind === 'approval' ? { choice: value } : { answer: value }) });
  }}>
    <fieldset disabled={disabled}><legend>{question.kind === 'approval' ? c.approval : c.question}</legend>
      <p className="observed-codex-question">{question.question}</p>
      {question.command && <code className="observed-codex-question">{question.command}</code>}
      {question.description && <p className="observed-codex-question">{question.description}</p>}
      {question.choices.length > 0 ? question.choices.map(choice => <label key={choice} className="observed-codex-option">
        <input type="radio" name={id} value={choice} checked={value === choice} onChange={() => setValue(choice)} />{choice}
      </label>) : <label>{c.answerLabel}<input value={value} maxLength={16000} autoComplete="off" onChange={event => setValue(event.target.value)} /></label>}
      <button type="submit" disabled={disabled || !value.trim()}>{c.answer}</button>
    </fieldset>
  </form>;
}
