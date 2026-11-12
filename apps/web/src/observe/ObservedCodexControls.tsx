import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import type { AgentHostApi, ObservedCodexApprovalDecision, ObservedCodexApprovalRequest, ObservedCodexInputRequest, SessionSummary } from '@extalia/platform';
import type { Messages } from '../i18n';
import { createObservedCodexControl, type ObservedCodexControl, type ObservedCodexView } from './observedCodexModel';
import './observedCodex.css';

export interface ObservedCodexControlsProps { t: Messages; agents: AgentHostApi; session: SessionSummary; showQuestions?: boolean }

/** Separate explicit capability; ordinary observed conversation composers remain read-only. */
export function ObservedCodexControls(props: ObservedCodexControlsProps) {
  if (props.session.control !== 'observed' || props.session.observation?.sourceId !== 'codex') return null;
  return <CodexSessionControls key={props.session.id} {...props} />;
}

function CodexSessionControls({ t, agents, session, showQuestions = true }: ObservedCodexControlsProps) {
  const control = useMemo(() => createObservedCodexControl(agents, session.id), [agents, session.id]);
  const view = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  useEffect(() => control.start(), [control]);
  return <ObservedCodexControlsContent t={t} view={view} control={control} showQuestions={showQuestions} />;
}

/** Pure content boundary also supports server-rendered presentation verification. */
export function ObservedCodexControlsContent({ t, view, control, showQuestions = true }: { t: Messages; view: ObservedCodexView; control: ObservedCodexControl; showQuestions?: boolean }) {
  const c = t.observedCodex;
  const id = useId();
  const [socketPath, setSocketPath] = useState('');
  const status = view.status;
  const connected = status?.state === 'connected';
  const disabled = !!view.busy;
  return <section className="observed-codex" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{c.title}</h3>
    {view.phase === 'unsupported' ? <p>{c.unsupported}</p> : <>
      <p className="observed-codex-hint">{c.helper}</p>
      <p role="status">{view.phase === 'loading' ? c.loading : view.phase === 'error' ? c.failed
        : connected ? c.connected : status?.state === 'unavailable' ? c.unavailable : c.disconnected}</p>
      {status?.problem && <p className="observed-codex-hint">{status.problem}</p>}
      {connected ? <>
        <p className="observed-codex-thread">{c.thread}: <code>{status.threadId}</code></p>
        <button type="button" disabled={disabled} onClick={() => { void control.disconnect(); }}>{c.disconnect}</button>
        {status.delivery && <p role="status">{status.delivery === 'submitted' ? c.submitted : status.delivery === 'resolved' ? c.resolved : c.unknown}</p>}
        {showQuestions && status.requests.map(request => <CodexQuestionCard key={`${status.connectionId}:${JSON.stringify(request)}`}
          t={t} request={request} disabled={disabled || !status.canAnswer} onAnswer={answers => { void control.answer(request, answers); }} />)}
        {(status.approvals ?? []).map(request => <CodexApprovalCard key={`${status.connectionId}:${JSON.stringify(request)}`} t={t}
          request={request} disabled={disabled || !status.canApprove} onAnswer={decision => { void control.approve(request, decision); }} />)}
      </> : <form onSubmit={event => { event.preventDefault(); void control.connect(socketPath); }}>
        <label htmlFor={`${id}-socket`}>{c.socket}</label>
        <input id={`${id}-socket`} value={socketPath} onChange={event => setSocketPath(event.target.value)}
          placeholder={c.socketPlaceholder} autoComplete="off" spellCheck={false} disabled={disabled || view.phase === 'loading'} />
        <div className="observed-codex-actions">
          <button type="submit" disabled={disabled || view.phase === 'loading' || !socketPath.trim()}>{view.busy === 'connect' ? c.busy : c.connect}</button>
          {view.phase === 'error' && <button type="button" disabled={disabled} onClick={() => { void control.refresh(); }}>{c.refresh}</button>}
        </div>
      </form>}
    </>}
  </section>;
}

export function CodexApprovalCard({ t, request, disabled, onAnswer }: { t: Messages; request: ObservedCodexApprovalRequest; disabled: boolean; onAnswer: (decision: ObservedCodexApprovalDecision) => void }) {
  const c = t.observedCodex, id = useId(), [decision, setDecision] = useState<ObservedCodexApprovalDecision>();
  const locked = disabled || request.state === 'submitted';
  return <form className="observed-codex-request" onSubmit={event => {
    event.preventDefault(); if (!locked && decision && request.availableDecisions.includes(decision)) onAnswer(decision);
  }}>
    <fieldset disabled={locked}><legend>{c.approvalKinds[request.kind]}</legend>
      {request.reason && <p className="observed-codex-question">{request.reason}</p>}
      {request.cwd && <p className="observed-codex-question">{c.workingFolder}: <code>{request.cwd}</code></p>}
      {request.environmentId && <p className="observed-codex-question">{c.environment}: <code>{request.environmentId}</code></p>}
      {request.kind === 'commandExecution' && <>
        <p>{c.commandKinds[request.commandKind]}</p>
        {request.command && <pre className="observed-codex-question">{request.commandKind === 'writeStdin' ? JSON.stringify(request.command) : request.command}</pre>}
        {request.networkApprovalContext && <p className="observed-codex-question">{c.networkTarget}: <code>{request.networkApprovalContext.protocol}://{request.networkApprovalContext.host}</code></p>}
        {request.commandActions?.length ? <pre className="observed-codex-question">{JSON.stringify(request.commandActions, null, 2)}</pre> : null}
        {request.additionalPermissions && <><p>{c.requestedPermissions}</p><pre className="observed-codex-question">{JSON.stringify(request.additionalPermissions, null, 2)}</pre></>}
      </>}
      {request.kind === 'fileChange' && <>
        {request.grantRoot && <><p className="observed-codex-question">{c.grantRoot}: <code>{request.grantRoot}</code></p><p className="observed-codex-hint">{c.rootGrantSourceOnly}</p></>}
        {request.changes.map((change, index) => <div key={index}><p className="observed-codex-question"><code>{change.path}</code> · {change.kind.type}</p>
          {change.kind.type === 'update' && change.kind.move_path && <p className="observed-codex-question">{c.moveTo}: <code>{change.kind.move_path}</code></p>}
          <pre className="observed-codex-question">{change.diff}</pre></div>)}
      </>}
      {request.kind === 'permissions' && <><p>{c.requestedPermissions}</p><pre className="observed-codex-question">{JSON.stringify(request.permissions, null, 2)}</pre></>}
      <p className="observed-codex-hint">{c.approvalScope}</p>
      {request.availableDecisions.map(choice => <label key={choice} className="observed-codex-option">
        <input type="radio" name={id} value={choice} checked={decision === choice} onChange={() => setDecision(choice)} />{c.approvalDecisions[choice]}
      </label>)}
      {request.state === 'submitted' ? <p role="status">{c.submitted}</p> : <button type="submit" disabled={locked || !decision}>{c.submitApproval}</button>}
    </fieldset>
  </form>;
}

export function CodexQuestionCard({ t, request, disabled, onAnswer }: {
  t: Messages; request: ObservedCodexInputRequest; disabled: boolean; onAnswer: (answers: Record<string, string>) => void;
}) {
  const c = t.observedCodex;
  const id = useId();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const answers = Object.fromEntries(request.questions.map(question => [question.id,
    question.options.length === 0 || choices[question.id] === 'other' ? texts[question.id] ?? ''
      : question.options[Number(choices[question.id])]?.label ?? '',
  ]));
  const submitted = request.state === 'submitted';
  const locked = disabled || submitted;
  return <form className="observed-codex-request" onSubmit={event => {
    event.preventDefault();
    if (!locked && request.questions.length > 0 && request.questions.every(question => answers[question.id]?.trim())) onAnswer(answers);
  }}>
    <p role="status">{submitted ? c.submitted : c.waiting}</p>
    {request.questions.map((question, questionIndex) => <fieldset key={question.id} disabled={locked}>
      <legend>{question.header}</legend>
      <p className="observed-codex-question">{question.question}</p>
      {question.options.map((option, optionIndex) => <label className="observed-codex-option" key={optionIndex}>
        <input type="radio" name={`${id}-${questionIndex}`} value={String(optionIndex)} checked={choices[question.id] === String(optionIndex)}
          onChange={() => setChoices(previous => ({ ...previous, [question.id]: String(optionIndex) }))} />
        <span>{option.label}{option.description && <small>{option.description}</small>}</span>
      </label>)}
      {question.isOther && question.options.length > 0 && <label className="observed-codex-option">
        <input type="radio" name={`${id}-${questionIndex}`} value="other" checked={choices[question.id] === 'other'}
          onChange={() => setChoices(previous => ({ ...previous, [question.id]: 'other' }))} />{c.other}
      </label>}
      {(question.isOther || question.options.length === 0) && <label>{c.freeform}
        <input type={question.isSecret ? 'password' : 'text'} value={texts[question.id] ?? ''} autoComplete="off"
          disabled={locked || (question.options.length > 0 && choices[question.id] !== 'other')}
          onChange={event => setTexts(previous => ({ ...previous, [question.id]: event.target.value }))} />
      </label>}
    </fieldset>)}
    {!submitted && <button type="submit" disabled={locked || !request.questions.length || request.questions.some(question => !answers[question.id]?.trim())}>{c.answer}</button>}
  </form>;
}
