import { normalizeSkillRouting, normalizeSkillRoutingReport, type AgentHostApi, type SkillRegistryReport, type SkillRoutingInput, type SkillRoutingReport } from '@extalia/platform';
import { useEffect, useId, useRef, useState } from 'react';
import type { Messages } from '../i18n';
import { shortDigest } from './skillCenterModel';
import { skillPreflightContext } from './skillPreflightContext';

type Workspace = { id: string; name: string };
type Props = { agents: AgentHostApi; report: SkillRegistryReport; workspaces: readonly Workspace[]; t: Messages };

/** Context changes unmount pending requests before their results can become current. */
export function SkillRoutingPanel(props: Props) {
  const context = JSON.stringify([skillPreflightContext(props.agents, props.report), props.report.mode,
    props.report.routingPreview, props.report.truncated, props.workspaces.map(item => [item.id, item.name]).sort()]);
  return <SkillRoutingForm key={context} {...props} />;
}

const selectors = (text: string) => text.trim() ? [...new Set(text.split(',').map(item => item.trim()).filter(Boolean))] : [];

function SkillRoutingForm({ agents, report, workspaces, t }: Props) {
  const s = t.skillRouting;
  const id = useId();
  const [categories, setCategories] = useState('');
  const [intents, setIntents] = useState('');
  const [candidates, setCandidates] = useState<string[]>([]);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [workspaceId, setWorkspace] = useState('');
  const [limit, setLimit] = useState(8);
  const [result, setResult] = useState<SkillRoutingReport>();
  const [error, setError] = useState<'invalid' | 'failed'>();
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const invalidate = () => { generation.current++; setResult(undefined); setError(undefined); setBusy(false); };
  const available = report.status === 'ready' && report.routingPreview === true && typeof agents.previewSkillRouting === 'function';
  const chosenPackages = new Set(report.revisions.filter(item => candidates.includes(item.revisionId)).map(item => item.packageId));
  const label = (revisionId: string) => {
    const item = report.revisions.find(revision => revision.revisionId === revisionId);
    return item ? `${item.packageId} · ${item.version} · ${shortDigest(item.treeSha256)}` : revisionId;
  };
  const run = async () => {
    if (!available || busy) return;
    const current = ++generation.current;
    setResult(undefined); setError(undefined);
    let input: SkillRoutingInput;
    try {
      input = normalizeSkillRouting({ categories: selectors(categories), intents: selectors(intents),
        candidateRevisionIds: [...candidates], pins: { ...pins }, maxResults: limit, ...(workspaceId ? { workspaceId } : {}) });
    } catch { setError('invalid'); return; }
    setBusy(true);
    try {
      const found = normalizeSkillRoutingReport(await agents.previewSkillRouting!(input), input);
      if (current === generation.current) setResult(found);
    } catch { if (current === generation.current) setError('failed'); }
    finally { if (current === generation.current) setBusy(false); }
  };
  return <section className="card settings-section skill-routing" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{s.title}</h3><p className="muted small">{s.lead}</p>
    {!available ? <p className="muted small">{s.unsupported}</p> : <>
      <p className="note small">{s.limits}</p>
      {report.truncated && <p className="muted small">{t.skillPreflight.incompleteCatalog}</p>}
      <div className="skill-routing-fields">
        <label>{s.categories}<input value={categories} maxLength={4096} onChange={event => { invalidate(); setCategories(event.target.value); }} /></label>
        <label>{s.intents}<input value={intents} maxLength={4096} onChange={event => { invalidate(); setIntents(event.target.value); }} /></label>
        <label>{s.workspace}<select value={workspaceId} onChange={event => { invalidate(); setWorkspace(event.target.value); }}>
          <option value="">{s.noWorkspace}</option>{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label>{s.maxResults}<input type="number" min={1} max={16} value={limit} onChange={event => { invalidate(); setLimit(Number(event.target.value)); }} /></label>
      </div>
      <p className="muted small">{s.selectorsHint}</p>
      <fieldset className="skill-routing-candidates"><legend>{s.candidates}</legend><p className="muted small">{s.candidateHint}</p>
        {!report.revisions.length && <p className="muted small">{s.noCandidates}</p>}
        {report.revisions.map(item => <label key={item.revisionId}><input type="checkbox" checked={candidates.includes(item.revisionId)}
          disabled={!candidates.includes(item.revisionId) && (candidates.length >= 16 || chosenPackages.has(item.packageId))}
          onChange={event => { invalidate(); setCandidates(current => event.target.checked ? [...current, item.revisionId] : current.filter(value => value !== item.revisionId)); }} />
          <span>{label(item.revisionId)}</span></label>)}
      </fieldset>
      <label>{s.pins}<select value="" disabled={Object.keys(pins).length >= 128} onChange={event => {
        const item = report.revisions.find(value => value.revisionId === event.target.value);
        if (item) { invalidate(); setPins(current => ({ ...current, [item.packageId]: item.revisionId })); }
      }}><option value="">{s.choosePin}</option>{report.revisions.filter(item => !Object.hasOwn(pins, item.packageId)).map(item =>
        <option key={item.revisionId} value={item.revisionId}>{label(item.revisionId)}</option>)}</select></label>
      {!Object.keys(pins).length && <p className="muted small">{s.noPins}</p>}
      <ul className="skill-preflight-pins">{Object.entries(pins).map(([packageId, revision]) => <li key={packageId}><span>{label(revision)}</span>
        <button type="button" className="button small" aria-label={t.skillPreflight.removePin(packageId)} onClick={() => { invalidate(); setPins(({ [packageId]: _removed, ...rest }) => rest); }}>{t.skillPreflight.remove}</button></li>)}</ul>
      <button type="button" className="button small" disabled={busy || !candidates.length || (!categories.trim() && !intents.trim())} onClick={() => void run()}>{busy ? s.busy : s.run}</button>
      {error && <p className="form-error" role="alert">{error === 'invalid' ? s.invalidInput : s.failed}</p>}
      {result && <SkillRoutingResult result={result} t={t} />}
    </>}
  </section>;
}

/** A matched report remains inert diagnostic data, including dependency orderings. */
export function SkillRoutingResult({ result, t }: { result: SkillRoutingReport; t: Messages }) {
  const s = t.skillRouting;
  const identity = (item: SkillRoutingReport['candidates'][number]['identity']) => <>{item.packageId} · {item.version} · <code title={item.treeSha256}>{shortDigest(item.treeSha256)}</code></>;
  return <div className="skill-routing-result" role="status">
    <p><strong>{s.statuses[result.status]}</strong> {s.noAuthority}</p><p>{s.counts(result.eligibleCount, result.topTieCount)}</p>
    {!!result.issues.length && <ul>{result.issues.map(issue => <li key={issue}>{s.inputIssue(issue)}</li>)}</ul>}
    <ol>{result.candidates.map(candidate => <li key={candidate.identity.revisionId}>
      <strong>{identity(candidate.identity)}</strong>
      {!!candidate.matches.exactIntents.length && <p>{s.exactIntents}: {candidate.matches.exactIntents.join(', ')}</p>}
      {!!candidate.matches.exactCategories.length && <p>{s.exactCategories}: {candidate.matches.exactCategories.join(', ')}</p>}
      {!!candidate.matches.descendantCategories.length && <p>{s.descendants}: {candidate.matches.descendantCategories.map(pair => `${pair.requested} → ${pair.declared}`).join(', ')}</p>}
      {candidate.matches.rationaleTruncated && <p>{s.rationaleTruncated}</p>}
      <details><summary>{s.ordering}</summary><ol>{candidate.plan.slice(0, 16).map(item => <li key={item.revisionId}>{identity(item)}</li>)}</ol>
        {candidate.plan.length > 16 && <p>{s.omitted(candidate.plan.length - 16)}</p>}</details>
    </li>)}</ol>
    {!!result.exclusions.length && <details><summary>{s.exclusions} ({result.exclusions.length})</summary><ul>{result.exclusions.map(exclusion => <li key={exclusion.identity.revisionId}>
      {identity(exclusion.identity)}: {s.reasons[exclusion.reason]}
      <ul>{exclusion.diagnostics.map((issue, index) => <li key={index}>{t.skillPreflight.issues[issue.code]}{issue.packageId ? ` · ${issue.packageId}` : ''}{issue.relatedPackageId ? ` → ${issue.relatedPackageId}` : ''}</li>)}</ul>
      {exclusion.omittedDiagnostics > 0 && <p>{s.omitted(exclusion.omittedDiagnostics)}</p>}
    </li>)}</ul></details>}
  </div>;
}
