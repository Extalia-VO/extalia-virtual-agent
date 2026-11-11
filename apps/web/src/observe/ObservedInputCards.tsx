import { useId } from 'react';
import type { ObservedUserInputRequest } from '@extalia/platform';
import type { Messages } from '../i18n';
import { useObservedInputs } from './ObservedInputProvider';
import { observedInputAnswers, observedInputKey, type ObservedInputDraft } from './observedInputModel';
import './observedInput.css';

export function ObservedInputAlert({ t }: { t: Messages }) {
  const context = useObservedInputs();
  const pending = Object.entries(context?.view.entries ?? {}).flatMap(([sessionId, entry]) => entry.requests
    .filter(request => request.identityVerified !== false && (request.state === 'pending' || request.state === 'unknown')).map(request => ({ sessionId, request })));
  const first = pending[0];
  if (!first || !context) return null;
  return <aside className="observed-input-alert" role="status" aria-live="polite">
    <strong>{t.observedInput.alert(pending.length)}</strong>
    <button type="button" onClick={() => context.locate(first.sessionId, first.request.id)}>{t.observedInput.locate}</button>
  </aside>;
}

export function ObservedInputCards({ t, sessionId }: { t: Messages; sessionId: string }) {
  const context = useObservedInputs();
  const entry = context?.view.entries[sessionId];
  if (!context || !entry || entry.phase === 'loading' || (entry.phase === 'ready' && !entry.requests.length)) return null;
  const c = t.observedInput;
  return <section className="observed-input-cards" aria-label={c.title}>
    <h3>{c.title}</h3>
    {entry.phase !== 'ready' && <p role="status">{entry.phase === 'private' ? c.private : c.unavailable}</p>}
    {entry.requests.map(request => {
      const key = observedInputKey(sessionId, entry.source, request);
      return <ObservedInputCard key={key} t={t} request={request} draft={context.view.drafts[key]}
        busy={context.view.busy === key} uncertain={context.view.uncertain.has(key)}
        disabled={entry.phase !== 'ready' || !!context.view.busy || !request.canAnswer}
        onDraft={draft => context.control.setDraft(key, draft)} onSubmit={() => { void context.control.answer(sessionId, request); }} />;
    })}
  </section>;
}

/** Shared drafts are keyed by source and stable request revision, including across duplicate views. */
export function ObservedInputCard({ t, request, draft, disabled, busy, uncertain, onDraft, onSubmit }: {
  t: Messages; request: ObservedUserInputRequest; draft?: ObservedInputDraft | undefined; disabled: boolean; busy: boolean; uncertain: boolean;
  onDraft: (draft: ObservedInputDraft) => void; onSubmit: () => void;
}) {
  const id = useId(), c = t.observedInput;
  const data = draft ?? { choices: {}, texts: {} };
  const answers = observedInputAnswers(request, draft);
  const complete = request.questions.length > 0 && request.questions.every(question => !!answers[question.id]?.trim());
  const locked = disabled || uncertain || request.state !== 'pending';
  return <form className="observed-input-card" onSubmit={event => { event.preventDefault(); if (!locked && complete) onSubmit(); }}>
    <p className="observed-input-source">{request.origin === 'codex-async' ? c.sourceAsync : c.sourceNative}</p>
    {request.questions.map((question, index) => <fieldset key={question.id} disabled={locked}>
      <legend>{question.title}</legend>
      {question.options.map((option, optionIndex) => <label className="observed-input-option" key={optionIndex}>
        <input type="radio" name={`${id}-${index}`} checked={data.choices[question.id] === String(optionIndex)}
          onChange={() => onDraft({ ...data, choices: { ...data.choices, [question.id]: String(optionIndex) } })} />
        <span>{option}{question.optionDescriptions?.[optionIndex] && <small className="observed-input-option-description">{question.optionDescriptions[optionIndex]}</small>}</span>
      </label>)}
      {question.options.length > 0 && question.allowOther && <label className="observed-input-option">
        <input type="radio" name={`${id}-${index}`} checked={data.choices[question.id] === 'other'}
          onChange={() => onDraft({ ...data, choices: { ...data.choices, [question.id]: 'other' } })} />{c.other}
      </label>}
      {(question.options.length === 0 || question.allowOther) && <label className="observed-input-text">{c.answer}
        <input type={question.isSecret ? 'password' : 'text'} value={data.texts[question.id] ?? ''} autoComplete="off" spellCheck={false}
          disabled={locked || (question.options.length > 0 && data.choices[question.id] !== 'other')}
          onChange={event => onDraft({ ...data, texts: { ...data.texts, [question.id]: event.target.value } })} />
      </label>}
    </fieldset>)}
    {request.state === 'pending' && !request.canAnswer && !busy && <p className="observed-input-hint" role="status">{c.replyUnavailable}</p>}
    {uncertain || request.state === 'unknown' ? <p role="status">{c.unknown}</p>
      : request.state === 'queued' ? <p role="status">{c.queued}</p>
        : request.state === 'submitted' ? <p role="status">{c.submitted}</p>
          : <><button type="submit" disabled={locked || !complete} aria-busy={busy}>{busy ? c.sending : c.submit}</button>
            {!complete && <p className="observed-input-hint">{c.emptyAnswer}</p>}</>}
  </form>;
}
