import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import type { AgentHostApi, CodexPermissionHookDecision, CodexPermissionHookRequest, CodexPermissionHookStatus, CodexPermissionSetupPlan, SessionSummary } from '@extalia/platform';
import type { Messages } from '../i18n';
import './observedCodex.css';

export interface CodexPermissionView {
  phase: 'loading' | 'ready' | 'error' | 'unsupported';
  status?: CodexPermissionHookStatus;
  busy: boolean;
  reading?: boolean;
  now: number;
  review?: { plan: CodexPermissionSetupPlan; undo: boolean; acknowledged: boolean };
}

/** One operation at a time; every answer rechecks the exact request before submission. */
export function createCodexPermissionControl(api: AgentHostApi, sessionId: string, now = Date.now) {
  const supported = !!(api.observedCodexPermissionStatus && api.previewObservedCodexPermissionHook
    && api.applyObservedCodexPermissionHook && api.answerObservedCodexPermission);
  let view: CodexPermissionView = { phase: supported ? 'loading' : 'unsupported', busy: false, now: now() };
  let active = false, epoch = 0, inFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const update = (next: CodexPermissionView) => { view = next; listeners.forEach(listener => listener()); };
  const validStatus = (status: CodexPermissionHookStatus) => {
    if (!status || status.sessionId !== sessionId || !['ready', 'unavailable'].includes(status.state)
      || !Array.isArray(status.requests) || status.requests.some(request => !request.requestId || !request.payloadDigest
        || typeof request.sourceJson !== 'string' || !Number.isFinite(Date.parse(request.expiresAt))
        || !Array.isArray(request.availableDecisions) || request.availableDecisions.some(choice => !['allow', 'deny', 'pass'].includes(choice)))) {
      throw new Error('Invalid permission status');
    }
    return status;
  };
  const freshRequest = (request: CodexPermissionHookRequest, decision: CodexPermissionHookDecision) =>
    view.phase === 'ready' && view.status?.state === 'ready' && Date.parse(request.expiresAt) > now()
    && request.availableDecisions.includes(decision)
    && view.status.requests.some(current => JSON.stringify(current) === JSON.stringify(request));
  async function run(operation: (current: () => boolean) => Promise<void>, busy: boolean) {
    if (!active || !supported || inFlight) return;
    const ticket = epoch;
    inFlight = true;
    const current = () => active && ticket === epoch;
    update({ ...view, busy, reading: !busy });
    try { await operation(current); }
    catch { if (current()) update({ ...view, phase: 'error', status: undefined, review: undefined }); }
    finally { inFlight = false; if (current()) update({ ...view, busy: false, reading: false, now: now() }); }
  }
  const receive = (status: CodexPermissionHookStatus) => update({ ...view, phase: 'ready', status: validStatus(status), now: now() });
  const refresh = () => run(async current => {
    const status = await api.observedCodexPermissionStatus!(sessionId);
    if (current()) receive(status);
  }, false);
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    start() {
      active = true; ++epoch;
      update({ ...view, busy: false, reading: inFlight });
      void refresh();
      timer = setInterval(() => { update({ ...view, now: now() }); void refresh(); }, 1000);
      return () => { active = false; ++epoch; clearInterval(timer); timer = undefined; };
    },
    refresh,
    preview(undo = false) {
      return run(async current => {
        const plan = await api.previewObservedCodexPermissionHook!(sessionId, undo);
        if (current()) update({ ...view, review: { plan, undo, acknowledged: false } });
      }, true);
    },
    acknowledge(acknowledged: boolean) {
      if (active && !view.busy && view.review) update({ ...view, review: { ...view.review, acknowledged } });
    },
    cancelReview() { if (!view.busy) update({ ...view, review: undefined }); },
    apply() {
      const review = view.review;
      if (!review?.acknowledged || !review.plan.changed) return Promise.resolve();
      return run(async current => {
        const status = await api.applyObservedCodexPermissionHook!(sessionId, review.plan.revision, review.undo);
        if (current()) { receive(status); update({ ...view, review: undefined }); }
      }, true);
    },
    answer(request: CodexPermissionHookRequest, decision: CodexPermissionHookDecision) {
      if (!freshRequest(request, decision)) return Promise.resolve();
      return run(async current => {
        const status = await api.observedCodexPermissionStatus!(sessionId);
        if (!current()) return;
        receive(status);
        if (!freshRequest(request, decision)) return;
        const result = await api.answerObservedCodexPermission!(sessionId, {
          requestId: request.requestId, payloadDigest: request.payloadDigest, decision,
        });
        if (current()) receive(result);
      }, true);
    },
  };
}
export type CodexPermissionControl = ReturnType<typeof createCodexPermissionControl>;

export function ObservedCodexPermissionControls(props: { t: Messages; agents: AgentHostApi; session: SessionSummary }) {
  if (props.session.control !== 'observed' || props.session.observation?.sourceId !== 'codex') return null;
  return <PermissionSession key={props.session.id} {...props} />;
}

function PermissionSession({ t, agents, session }: { t: Messages; agents: AgentHostApi; session: SessionSummary }) {
  const control = useMemo(() => createCodexPermissionControl(agents, session.id), [agents, session.id]);
  const view = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  useEffect(() => control.start(), [control]);
  return <ObservedCodexPermissionContent t={t} view={view} control={control} />;
}

export function ObservedCodexPermissionContent({ t, view, control }: { t: Messages; view: CodexPermissionView; control: CodexPermissionControl }) {
  const c = t.observedCodexPermission, id = useId(), status = view.status, review = view.review;
  const locked = view.busy || !!view.reading;
  const live = status?.requests.filter(request => Date.parse(request.expiresAt) > view.now) ?? [];
  return <section className="observed-codex" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{c.title}</h3><p className="observed-codex-hint">{c.helper}</p>
    <p role="status">{view.phase === 'unsupported' ? c.unsupported : view.phase === 'loading' ? c.loading
      : view.phase === 'error' ? c.failed : status?.state === 'unavailable' ? c.unavailable
        : live.length ? c.waiting : status?.installed ? c.awaitingReview : c.notInstalled}</p>
    {status?.problem && <p className="observed-codex-question">{status.problem}</p>}
    {view.phase !== 'unsupported' && <>
      <p className="observed-codex-hint">{c.trust}</p>
      <div className="observed-codex-actions">
        <button type="button" disabled={locked || view.phase === 'loading'} onClick={() => { void control.preview(); }}>{c.previewInstall}</button>
        {status?.installed && <button type="button" disabled={locked} onClick={() => { void control.preview(true); }}>{c.previewUndo}</button>}
        {view.phase === 'error' && <button type="button" disabled={locked} onClick={() => { void control.refresh(); }}>{c.refresh}</button>}
      </div>
      {review && <fieldset disabled={locked}>
        <legend>{c.review}</legend>
        <p className="observed-codex-thread">{c.thread}: <code>{review.plan.nativeSessionId}</code></p>
        <p className="observed-codex-thread">{c.revision}: <code>{review.plan.revision}</code></p>
        <p>{c.diff}</p><pre>{review.plan.diff || c.noChanges}</pre>
        <p className="observed-codex-thread">{c.backup}: <code>{review.plan.backupDirectory}</code></p>
        <p>{c.undoCommand}</p><pre>{review.plan.undoCommand}</pre>
        <p>{c.files}</p><pre>{JSON.stringify(review.plan.files, null, 2)}</pre>
        <label className="observed-codex-option"><input type="checkbox" style={{ width: 14, height: 14, padding: 0 }} checked={review.acknowledged}
          onChange={event => control.acknowledge(event.target.checked)} />{c.reviewed}</label>
        <div className="observed-codex-actions">
          <button type="button" disabled={!review.acknowledged || !review.plan.changed} onClick={() => { void control.apply(); }}>{review.undo ? c.confirmUndo : c.confirmInstall}</button>
          <button type="button" onClick={() => control.cancelReview()}>{c.cancel}</button>
        </div>
      </fieldset>}
      {(status?.requests ?? []).map(request => <PermissionRequestCard key={JSON.stringify(request)} t={t} request={request}
        expired={Date.parse(request.expiresAt) <= view.now} disabled={locked || view.phase !== 'ready' || status?.state !== 'ready'}
        onAnswer={decision => { void control.answer(request, decision); }} />)}
      {view.busy && <p role="status">{c.busy}</p>}
    </>}
  </section>;
}

function PermissionRequestCard({ t, request, expired, disabled, onAnswer }: {
  t: Messages; request: CodexPermissionHookRequest; expired: boolean; disabled: boolean; onAnswer: (decision: CodexPermissionHookDecision) => void;
}) {
  const c = t.observedCodexPermission, id = useId(), [decision, setDecision] = useState<CodexPermissionHookDecision>();
  return <form className="observed-codex-request" onSubmit={event => {
    event.preventDefault();
    if (!disabled && !expired && Date.parse(request.expiresAt) > Date.now() && decision && request.availableDecisions.includes(decision)) onAnswer(decision);
  }}><fieldset disabled={disabled || expired}>
    <legend>{c.request}: {request.toolName}</legend>
    <p className="observed-codex-thread">{c.thread}: <code>{request.nativeSessionId}</code></p>
    <p className="observed-codex-thread">{c.turn}: <code>{request.turnId}</code></p>
    <p className="observed-codex-thread">{c.digest}: <code>{request.payloadDigest}</code></p>
    <p>{c.expiresAt}: <time dateTime={request.expiresAt}>{request.expiresAt}</time></p>
    <p>{c.sourceJson}</p><pre>{request.sourceJson}</pre>
    <p className="observed-codex-hint">{c.scope}</p>
    {request.availableDecisions.map(choice => <label key={choice} className="observed-codex-option">
      <input type="radio" name={id} value={choice} checked={decision === choice} onChange={() => setDecision(choice)} />{c.decisions[choice]}
    </label>)}
    {expired ? <p role="status">{c.expired}</p> : <button type="submit" disabled={!decision}>{c.submit}</button>}
  </fieldset></form>;
}
