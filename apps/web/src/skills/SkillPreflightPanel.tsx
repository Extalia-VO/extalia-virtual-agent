import { useEffect, useRef, useState } from 'react';
import { normalizeSkillPreflightReport, type AgentHostApi, type SkillPreflightReport, type SkillRegistryReport } from '@extalia/platform';
import type { Messages } from '../i18n';
import { shortDigest } from './skillCenterModel';

export function SkillPreflightPanel({ agents, report, t }: { agents: AgentHostApi; report: SkillRegistryReport; t: Messages }) {
  const [root, setRoot] = useState('');
  const [pins, setPins] = useState<Record<string, string>>({});
  const [result, setResult] = useState<SkillPreflightReport>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const invalidate = () => { generation.current++; setResult(undefined); setError(false); setBusy(false); };
  const available = report.preflight === true && typeof agents.preflightSkill === 'function';
  const run = async () => {
    if (!available || !root || busy) return;
    const request = { rootRevisionId: root, pins: { ...pins } };
    const current = ++generation.current;
    setResult(undefined); setError(false); setBusy(true);
    try {
      const found = normalizeSkillPreflightReport(await agents.preflightSkill!(request), request.rootRevisionId);
      if (current === generation.current) setResult(found);
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  return <SkillPreflightView t={t} report={report} available={available} root={root} pins={pins} result={result} error={error} busy={busy}
    onRoot={next => { invalidate(); setRoot(next); setPins({}); }}
    onPin={revisionId => {
      const revision = report.revisions.find(item => item.revisionId === revisionId);
      if (!revision || Object.keys(pins).length >= 128) return;
      invalidate(); setPins(current => ({ ...current, [revision.packageId]: revisionId }));
    }}
    onRemove={packageId => { invalidate(); setPins(({ [packageId]: _removed, ...rest }) => rest); }} onRun={() => void run()} />;
}

/** Pure presentation; none of its actions import, inspect, approve or activate a skill. */
export function SkillPreflightView({ t, report, available, root, pins, result, error, busy, onRoot, onPin, onRemove, onRun }: {
  t: Messages; report: SkillRegistryReport; available: boolean; root: string; pins: Record<string, string>;
  result?: SkillPreflightReport; error: boolean; busy: boolean;
  onRoot: (id: string) => void; onPin: (id: string) => void; onRemove: (id: string) => void; onRun: () => void;
}) {
  const s = t.skillPreflight;
  const chosen = report.revisions.find(item => item.revisionId === root);
  const label = (id: string) => {
    const revision = report.revisions.find(item => item.revisionId === id);
    return revision ? `${revision.packageId} · ${revision.version} · ${shortDigest(revision.treeSha256)}` : id;
  };
  const candidates = report.revisions.filter(item => item.packageId !== chosen?.packageId && !Object.hasOwn(pins, item.packageId));
  return <section className="card settings-section skill-preflight" aria-labelledby="skill-preflight-title">
    <h3 id="skill-preflight-title">{s.title}</h3>
    <p className="muted small">{s.lead}</p>
    {!available ? <p className="muted small">{s.unsupported}</p> : <>
      <p className="note small">{s.limits}</p>
      {report.truncated && <p className="muted small">{s.incompleteCatalog}</p>}
      <div className="skill-preflight-fields">
        <label>{s.root}<select value={root} onChange={event => onRoot(event.target.value)}>
          <option value="">{s.chooseRoot}</option>
          {report.revisions.map(item => <option key={item.revisionId} value={item.revisionId}>{label(item.revisionId)}</option>)}
        </select></label>
        <label>{s.pin}<select value="" disabled={!chosen || Object.keys(pins).length >= 128 || !candidates.length} onChange={event => onPin(event.target.value)}>
          <option value="">{s.choosePin}</option>
          {candidates.map(item => <option key={item.revisionId} value={item.revisionId}>{label(item.revisionId)}</option>)}
        </select></label>
      </div>
      {Object.keys(pins).length === 0 && <p className="muted small">{s.noPins}</p>}
      <ul className="skill-preflight-pins">{Object.entries(pins).map(([id, revision]) => <li key={id}>
        <span>{label(revision)}</span><button type="button" className="button small" aria-label={s.removePin(id)} onClick={() => onRemove(id)}>{s.remove}</button>
      </li>)}</ul>
      <button type="button" className="button small" disabled={!chosen || busy} onClick={onRun}>{busy ? s.checking : s.check}</button>
      {error && <p className="form-error" role="alert">{s.failed}</p>}
      {result && <div className="skill-preflight-result" role="status">
        <p><strong>{result.status === 'consistent' ? s.consistent : s.blocked}</strong> {s.noAuthority}</p>
        {result.status === 'blocked' && <ul>{result.issues.map((issue, index) => <li key={index}>
          {s.issues[issue.code]}{issue.packageId ? ` · ${issue.packageId}` : ''}{issue.relatedPackageId ? ` → ${issue.relatedPackageId}` : ''}
        </li>)}</ul>}
        {result.truncated && <p className="muted small">{s.truncated}</p>}
        {result.status === 'consistent' && <ol>{result.plan.map(item => <li key={item.revisionId}>
          {item.packageId} · {item.version} · <code title={item.treeSha256}>{shortDigest(item.treeSha256)}</code>
        </li>)}</ol>}
      </div>}
    </>}
  </section>;
}
