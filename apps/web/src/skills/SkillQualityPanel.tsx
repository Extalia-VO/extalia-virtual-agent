import type { AgentHostApi, HostState, SkillActionResult, SkillRegistryReport, SkillRevisionDetails, SkillRevisionSummary } from '@extalia/platform';
import { useEffect, useRef, useState } from 'react';
import type { Messages } from '../i18n';
import { errorMessage } from '../host/remote';
import { Select } from '../ui/Select';
import { shortDigest } from './skillCenterModel';

type Quality = NonNullable<SkillRevisionDetails['learnedQuality']>;
type Baseline = Pick<SkillRevisionSummary, 'revisionId' | 'treeSha256'> | undefined;

/** A stored receipt applies only to these exact candidate and active baseline bytes. */
export function skillEvaluationCurrent(revision: Pick<SkillRevisionSummary, 'revisionId' | 'treeSha256'>, baseline: Baseline, evaluation: NonNullable<Quality['evaluation']>): boolean {
  return evaluation.revisionId === revision.revisionId && evaluation.treeSha256 === revision.treeSha256
    && (baseline?.revisionId === revision.revisionId && baseline.treeSha256 === revision.treeSha256
      || evaluation.baselineRevisionId === baseline?.revisionId && evaluation.baselineTreeSha256 === baseline?.treeSha256);
}

export function skillCandidateReady(revision: SkillRevisionSummary, baseline: Baseline, quality?: Quality): boolean {
  const evaluation = quality?.evaluation;
  return quality?.complete === true && quality.missingSections.length === 0 && quality.testCount > 0 && !!evaluation
    && evaluation.status === 'passed' && evaluation.total > 0 && evaluation.passed === evaluation.total
    && skillEvaluationCurrent(revision, baseline, evaluation);
}

export function SkillQualityDetails({ t, revision, baseline, quality }: { t: Messages; revision: SkillRevisionSummary; baseline: Baseline; quality?: Quality | undefined }) {
  const s = t.skillCenter.quality;
  const evaluation = quality?.evaluation;
  const status = evaluation ? !skillEvaluationCurrent(revision, baseline, evaluation) ? 'stale'
    : evaluation.status === 'passed' && (!evaluation.total || evaluation.passed !== evaluation.total) ? 'insufficient-evidence' : evaluation.status : undefined;
  const complete = quality?.complete === true && quality.missingSections.length === 0 && quality.testCount > 0;
  return <div className="skill-quality-details">
    <p className="small"><strong>{s.completeness}: </strong>{!quality ? s.unchecked : complete ? s.complete : s.incomplete}</p>
    {quality && <>
      <p className="muted small">{s.testCount(quality.testCount)}</p>
      {!!quality.missingSections.length && <p className="small">{s.missingSections}: {quality.missingSections.join(', ')}</p>}
    </>}
    <dl className="skill-quality-identities small">
      <div><dt>{s.candidate}</dt><dd><code title={revision.revisionId}>{revision.revisionId}</code><code title={revision.treeSha256}>{shortDigest(revision.treeSha256)}</code></dd></div>
      <div><dt>{s.baseline}</dt><dd>{baseline ? <><code title={baseline.revisionId}>{baseline.revisionId}</code><code title={baseline.treeSha256}>{shortDigest(baseline.treeSha256)}</code></> : s.noBaseline}</dd></div>
      {evaluation && <div><dt>{s.evaluatedBaseline}</dt><dd>{evaluation.baselineRevisionId ? <><code>{evaluation.baselineRevisionId}</code>{evaluation.baselineTreeSha256 && <code>{evaluation.baselineTreeSha256}</code>}</> : s.noBaseline}</dd></div>}
    </dl>
    {!evaluation ? <p className="muted small">{s.notEvaluated}</p> : <section className="skill-quality-result" aria-label={s.result} role="status">
      <strong className={`badge ${status === 'passed' ? 'ok' : 'warn'}`}>{s.statuses[status!]}</strong>
      <p className="small">{s.checks(evaluation.passed, evaluation.total)}</p>
      {evaluation.baselinePassed !== undefined && <p className="small">{s.baselineChecks(evaluation.baselinePassed)}</p>}
      <p className="muted small">{s.evaluatedAt(evaluation.evaluatedAt)}</p>
      <p className="muted small">{s.scope}</p>
      {status === 'stale' && <p className="note small">{s.staleHint}</p>}
      {!!evaluation.issues?.length && <ul>{evaluation.issues.map((issue, index) => <li key={`${index}:${issue}`} className="small">{issue}</li>)}</ul>}
    </section>}
    <p className="muted small">{s.noActivation}</p>
  </div>;
}

/** Explicit model evaluation is separate from inspection, review, approval and activation. */
export function SkillQualityPanel({ t, agents, report, revision, workspaces, detail, busy = false, onBusy, onEvaluated, onInspected }: {
  t: Messages; agents?: AgentHostApi | undefined; report: SkillRegistryReport; revision: SkillRevisionSummary;
  workspaces?: HostState['workspaces'] | undefined; detail?: SkillRevisionDetails | undefined; busy?: boolean;
  onBusy?: ((busy: boolean) => void) | undefined; onInspected?: ((detail: SkillRevisionDetails) => void) | undefined; onEvaluated?: ((result: SkillActionResult, detail: SkillRevisionDetails) => void) | undefined;
}) {
  const s = t.skillCenter.quality;
  const baseline = report.revisions.find(item => item.packageId === revision.packageId && item.active);
  const scope = JSON.stringify([revision.revisionId, revision.treeSha256, baseline?.revisionId, baseline?.treeSha256]);
  const [open, setOpen] = useState(false);
  const [workspaceId, setWorkspace] = useState('');
  const [loaded, setLoaded] = useState<{ scope: string; detail: SkillRevisionDetails }>();
  const [failure, setFailure] = useState<{ scope: string; message: string }>();
  const [pending, setPending] = useState<{ scope: string; workspaceId: string }>();
  const generation = useRef(0);
  const inFlight = useRef(false);
  const nativeWorkspaces = (workspaces ?? []).filter(workspace => workspace.mode === 'managed' && workspace.runtimeId === 'extalia-native' && Boolean(workspace.providerProfileId));
  const selectedWorkspace = nativeWorkspaces.some(workspace => workspace.id === workspaceId) ? workspaceId : '';
  const available = report.evaluation === true && typeof agents?.evaluateSkill === 'function';
  const eligible = revision.origin === 'generated' && !revision.active && ['validated', 'awaiting_approval', 'approved'].includes(revision.state);
  const currentDetail = loaded?.scope === scope ? loaded.detail : detail;
  const quality = currentDetail?.learnedQuality;
  const evaluating = pending?.scope === scope && pending.workspaceId === selectedWorkspace;
  useEffect(() => {
    let live = true;
    if (open && agents && !detail) void agents.inspectSkill(revision.revisionId).then(found => {
      if (live && found.revision.revisionId === revision.revisionId && found.revision.treeSha256 === revision.treeSha256) { setLoaded({ scope, detail: found }); onInspected?.(found); }
    }, error => { if (live) setFailure({ scope, message: errorMessage(error) }); });
    return () => { live = false; };
  }, [agents, scope, open, detail, revision.revisionId, revision.treeSha256, onInspected]);
  useEffect(() => {
    generation.current++;
    const retire = () => { generation.current++; };
    return retire;
  }, [agents, scope]);
  const evaluate = async () => {
    if (!available || !eligible || !agents?.evaluateSkill || !selectedWorkspace || !currentDetail || !quality?.complete || !quality.testCount || quality.missingSections.length > 0 || busy || evaluating || inFlight.current) return;
    inFlight.current = true;
    const token = ++generation.current;
    setPending({ scope, workspaceId: selectedWorkspace }); setFailure(undefined); onBusy?.(true);
    try {
      const result = await agents.evaluateSkill({ revisionId: revision.revisionId, workspaceId: selectedWorkspace });
      if (generation.current !== token) return;
      const inspected = await agents.inspectSkill(revision.revisionId);
      if (generation.current !== token) return;
      if (inspected.revision.revisionId !== revision.revisionId || inspected.revision.treeSha256 !== revision.treeSha256) throw new Error(s.staleHint);
      setLoaded({ scope, detail: inspected }); onEvaluated?.(result, inspected);
    } catch (error) { if (generation.current === token) setFailure({ scope, message: errorMessage(error) }); }
    finally { inFlight.current = false; if (generation.current === token) setPending(undefined); onBusy?.(false); }
  };
  return <details className="skill-quality-panel" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{s.title}<span className="muted small"> · {!quality ? s.unchecked : quality.complete && !quality.missingSections.length && quality.testCount > 0 ? s.complete : s.incomplete}</span></summary>
    {open && <>
      {!currentDetail && failure?.scope !== scope && agents && <p className="muted small" role="status">{t.skillCenter.loadingDetails}</p>}
      <SkillQualityDetails t={t} revision={revision} baseline={baseline} quality={quality} />
      {!available ? <p className="muted small">{s.unsupported}</p> : <>
        <div className="field"><span>{s.workspace}</span><Select aria-label={s.workspace} value={selectedWorkspace} disabled={busy || evaluating} onChange={value => { generation.current++; setWorkspace(value); setFailure(undefined); }}
          options={[{ value: '', label: s.chooseWorkspace }, ...nativeWorkspaces.map(workspace => ({ value: workspace.id, label: workspace.name }))]} /></div>
        {!nativeWorkspaces.length && <p className="muted small">{s.noWorkspace}</p>}
        <p className="muted small">{s.modelUse}</p>
        {!eligible && <p className="note small">{s.needsSecurity}</p>}
        {quality && (!quality.complete || !quality.testCount || quality.missingSections.length > 0) && <p className="note small">{s.needsContent}</p>}
        <button type="button" className="button small" disabled={busy || evaluating || !eligible || !selectedWorkspace || !currentDetail || !quality?.complete || !quality.testCount || quality.missingSections.length > 0} onClick={() => void evaluate()}>{evaluating ? s.evaluating : s.evaluate}</button>
      </>}
      {failure?.scope === scope && <p className="form-error small" role="alert">{failure.message}</p>}
    </>}
  </details>;
}
