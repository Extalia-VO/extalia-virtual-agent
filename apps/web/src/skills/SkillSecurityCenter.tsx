import type {
  AgentHostApi, FileSystemCapability, HostState, SkillImportSource, SkillRegistryReport, SkillReviewDecision, SkillRevisionDetails, SkillRevisionSummary, WorkspaceSkills,
} from '@extalia/platform';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { SkillPreflightPanel } from './SkillPreflightPanel';
import { SkillRoutingPanel } from './SkillRoutingPanel';
import { skillHostKey, skillPreflightContext } from './skillPreflightContext';
import {
  applySkillCenterAction, approvalFor, groupSkillPackages, revisionActions, shortDigest, skillCenterSupported, stateTone,
  type SkillCenterAction, type SkillPackageGroup, type SkillRevisionAction,
} from './skillCenterModel';

/**
 * Skill Security Center (W3): the Rust core's skill registry on the Skills page. Shown only when the host runs the
 * native core (`mode: 'registry'`); otherwise the page shows the W0 project-skill panels. The page displays the daemon's
 * decisions and sends the user's choices with the exact digests shown (ADR 0026 decision 7).
 */

type Workspace = HostState['workspaces'][number];
export type SkillConfirm = { kind: 'approve' | 'review' | 'revoke'; revisionId: string } | null;
export type SkillImporter = 'folder' | 'project' | null;
type Details = Record<string, SkillRevisionDetails | 'loading' | { error: string }>;

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
const when = (iso: string) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(); };
const day = (iso: string) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(); };
/** Workspace id → name, to name the project a W0 consent came from. */
type WorkspaceNames = Readonly<Record<string, string>>;

type CenterProps = { t: Messages; agents: AgentHostApi; picker?: FileSystemCapability; state: HostState; onChanged?: () => void };
export function SkillSecurityCenter(props: CenterProps) {
  // A replacement host must never inherit the old host's catalog or pending actions.
  return <SkillSecurityCenterHost key={skillHostKey(props.agents)} {...props} />;
}
function SkillSecurityCenterHost({ t, agents, picker, state, onChanged }: CenterProps) {
  const supported = skillCenterSupported(agents);
  const [report, setReport] = useState<SkillRegistryReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SkillConfirm>(null);
  const [importer, setImporter] = useState<SkillImporter>(null);
  const [details, setDetails] = useState<Details>({});

  const load = useCallback(() => {
    if (!supported) return () => undefined;
    let live = true;
    // An older host refuses the method: the section stays hidden instead of showing an error.
    agents.skillRegistry().then(next => { if (live) setReport(next); }, () => undefined);
    return () => { live = false; };
  }, [agents, supported]);
  useEffect(() => load(), [load]);

  if (!supported || !report || report.mode !== 'registry') return null;
  const s = t.skillCenter;
  const run = async (action: SkillCenterAction) => {
    setBusy(true); setError(null); setNotice(null);
    const outcome = await applySkillCenterAction(agents, action);
    if (outcome.report) setReport(outcome.report);
    setError(outcome.error ?? null);
    if (outcome.result) {
      setConfirm(null);
      setDetails({});
      const result = outcome.result;
      const name = result.packageId ?? outcome.report?.revisions.find(item => item.revisionId === result.revisionId)?.packageId ?? '';
      const label = result.state ? s.states[result.state] ?? result.state : '';
      if (action.kind === 'import') { setImporter(null); setNotice(result.created === false ? s.alreadyImported(name, label) : s.imported(name, label)); }
      else if (label) setNotice(s.done(name, label));
      onChanged?.();
    }
    setBusy(false);
  };
  const toggleDetails = (revisionId: string) => {
    if (details[revisionId]) { setDetails(({ [revisionId]: _closed, ...rest }) => rest); return; }
    setDetails(current => ({ ...current, [revisionId]: 'loading' }));
    agents.inspectSkill(revisionId).then(
      found => setDetails(current => (current[revisionId] ? { ...current, [revisionId]: found } : current)),
      failure => setDetails(current => (current[revisionId] ? { ...current, [revisionId]: { error: errorMessage(failure) } } : current)),
    );
  };
  const workspaceNames: WorkspaceNames = Object.fromEntries(state.workspaces.map(item => [item.id, item.name]));
  const importPanel = importer && (
    <SkillImportPanel key={importer} t={t} kind={importer} busy={busy} picker={picker} agents={agents}
      workspaces={state.workspaces.filter(item => item.projectLocation)}
      onImport={source => void run({ kind: 'import', source })} onCancel={() => setImporter(null)} />
  );
  return (<>
    <SkillSecurityCenterView t={t} report={report} busy={busy} error={error} notice={notice} confirm={confirm} importer={importer} details={details}
      importPanel={importPanel} workspaceNames={workspaceNames} onRetry={() => { setError(null); load(); }} onConfirm={setConfirm} onImporter={next => { setNotice(null); setImporter(next); }}
      onAction={action => void run(action)} onToggleDetails={toggleDetails} />
    <SkillPreflightPanel key={skillPreflightContext(agents, report)} agents={agents} report={report} t={t} />
    <SkillRoutingPanel agents={agents} report={report} workspaces={state.workspaces} t={t} />
  </>);
}

/** Stateless so tests can render it and press its buttons. */
export function SkillSecurityCenterView({
  t, report, busy, error, notice, confirm, importer, details, importPanel, workspaceNames, onRetry, onConfirm, onImporter, onAction, onToggleDetails,
}: {
  t: Messages;
  report: SkillRegistryReport;
  busy: boolean;
  error: string | null;
  notice: string | null;
  confirm: SkillConfirm;
  importer: SkillImporter;
  details: Details;
  importPanel?: ReactNode;
  workspaceNames?: WorkspaceNames;
  onRetry: () => void;
  onConfirm: (next: SkillConfirm) => void;
  onImporter: (next: SkillImporter) => void;
  onAction: (action: SkillCenterAction) => void;
  onToggleDetails: (revisionId: string) => void;
}) {
  const s = t.skillCenter;
  const ready = report.status === 'ready';
  const groups = groupSkillPackages(report.revisions);
  return (
    <section className="card settings-section skill-center" aria-labelledby="skill-center-title">
      <div className="section-head">
        <div>
          <h2 id="skill-center-title"><Icon name="shield" />{s.title}</h2>
          <p className="muted small">{s.lead}</p>
        </div>
        {ready && (
          <div className="row-actions skill-center-imports">
            <button type="button" className="button small" disabled={busy} aria-pressed={importer === 'folder'} onClick={() => onImporter(importer === 'folder' ? null : 'folder')}>
              <Icon name="folder" />{s.importFolder}
            </button>
            <button type="button" className="button small" disabled={busy} aria-pressed={importer === 'project'} onClick={() => onImporter(importer === 'project' ? null : 'project')}>
              <Icon name="download" />{s.importProject}
            </button>
          </div>
        )}
      </div>

      {!ready && (
        <div className="note skill-center-banner error" role="alert">
          <Icon name="alert" />
          <span>{report.unavailableReason === 'not-served' ? s.notServed : s.unavailable(report.unavailableReason ?? 'unknown')}</span>
          <button type="button" className="button small" onClick={onRetry}><Icon name="refresh" />{s.retry}</button>
        </div>
      )}
      {ready && <SkillScannerBanner t={t} report={report} />}
      {ready && importer && importPanel}
      {notice && <p className="status ok skill-center-notice" role="status"><Icon name="check" />{notice}</p>}
      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}

      {ready && !groups.length && <p className="muted small">{s.empty}</p>}
      {ready && groups.length > 0 && (
        <div className="skill-center-group">
          <h3>{s.packages(groups.length)}</h3>
          <ul className="skill-packages">
            {groups.map(group => SkillPackageItem({ t, group, busy, report, confirm, details, workspaceNames, onConfirm, onAction, onToggleDetails }))}
          </ul>
          {report.truncated && <p className="muted small">{s.truncated}</p>}
        </div>
      )}
    </section>
  );
}

/**
 * The installed scanner as the daemon reports it (`skill.scanner`). Without a `ready` scanner every import stays
 * quarantined; a host that does not report the inspector gets the generic warning.
 */
export function SkillScannerBanner({ t, report }: { t: Messages; report: SkillRegistryReport }) {
  const s = t.skillCenter;
  const inspector = report.inspector;
  if (report.scanner === 'pinned') {
    if (!inspector || inspector.status !== 'ready') return null;
    return (
      <div className="note skill-center-banner" role="status">
        <Icon name="shield" />
        <span><strong>{s.scannerReady(inspector.scannerId, inspector.version)}</strong> {inspector.pin ? s.scannerReadyDetail(inspector.pin, inspector.policyVersion) : null}</span>
      </div>
    );
  }
  const title = inspector?.status === 'unpinned' ? s.scannerUnpinned(inspector.scannerId)
    : inspector?.status === 'unavailable' && inspector.pinned ? s.scannerDown(inspector.scannerId)
      : s.scannerBanner;
  return (
    <div className="note skill-center-banner warn" role="status">
      <Icon name="shield" />
      <span><strong>{title}</strong> {s.scannerDetail}</span>
    </div>
  );
}

function SkillPackageItem({ t, group, busy, report, confirm, details, workspaceNames, onConfirm, onAction, onToggleDetails }: {
  t: Messages; group: SkillPackageGroup; busy: boolean; report: SkillRegistryReport; confirm: SkillConfirm; details: Details; workspaceNames?: WorkspaceNames;
  onConfirm: (next: SkillConfirm) => void; onAction: (action: SkillCenterAction) => void; onToggleDetails: (revisionId: string) => void;
}) {
  const s = t.skillCenter;
  return (
    <li key={group.packageId} className="skill-package">
      <div className="skill-package-head">
        <strong>{group.packageId}</strong>
        <span className="badge">{s.origins[group.origin] ?? group.origin}</span>
        <span className="muted small">{group.active ? s.activeVersion(s.version(group.active.version)) : s.noActive} · {s.revisions(group.revisions.length)}</span>
      </div>
      <ul className="skill-revisions">
        {group.revisions.map(revision => SkillRevisionRow({
          t, revision, busy, report, confirm, detail: details[revision.revisionId], workspaceNames, onConfirm, onAction, onToggleDetails,
        }))}
      </ul>
    </li>
  );
}

/** One revision: state chip, reason in plain language, permissions, short hashes and the actions its state offers. */
export function SkillRevisionRow({ t, revision, busy, report, confirm, detail, workspaceNames, onConfirm, onAction, onToggleDetails }: {
  t: Messages; revision: SkillRevisionSummary; busy: boolean; report: SkillRegistryReport; confirm: SkillConfirm;
  detail?: SkillRevisionDetails | 'loading' | { error: string }; workspaceNames?: WorkspaceNames;
  onConfirm: (next: SkillConfirm) => void; onAction: (action: SkillCenterAction) => void; onToggleDetails: (revisionId: string) => void;
}) {
  const s = t.skillCenter;
  const name = revision.packageId, version = s.version(revision.version);
  const reason = revision.stateReason;
  const open = confirm?.revisionId === revision.revisionId ? confirm.kind : null;
  const label = (action: string) => s.actionLabel(action, name, version);
  const actions = revisionActions(revision);
  const button = (action: SkillRevisionAction) => {
    const common = { type: 'button' as const, disabled: busy };
    if (action === 'review') return <button key={action} {...common} className="button small" aria-label={label(s.review)} aria-expanded={open === 'review'} onClick={() => onConfirm(open === 'review' ? null : { kind: 'review', revisionId: revision.revisionId })}>{s.review}</button>;
    if (action === 'approve') return <button key={action} {...common} className="button small primary" aria-label={label(s.approve)} aria-expanded={open === 'approve'} onClick={() => onConfirm(open === 'approve' ? null : { kind: 'approve', revisionId: revision.revisionId })}>{s.approve}</button>;
    if (action === 'activate') return <button key={action} {...common} className="button small primary" aria-label={label(s.activate)} onClick={() => onAction({ kind: 'activate', revisionId: revision.revisionId })}>{s.activate}</button>;
    if (action === 'deactivate') return <button key={action} {...common} className="button small" aria-label={label(s.deactivate)} onClick={() => onAction({ kind: 'deactivate', packageId: revision.packageId })}>{s.deactivate}</button>;
    if (action === 'rollback') return <button key={action} {...common} className="button small" aria-label={label(s.rollback)} onClick={() => onAction({ kind: 'rollback', packageId: revision.packageId, revisionId: revision.revisionId })}>{s.rollback}</button>;
    return <button key={action} {...common} className="button small" aria-label={label(s.revoke)} aria-expanded={open === 'revoke'} onClick={() => onConfirm(open === 'revoke' ? null : { kind: 'revoke', revisionId: revision.revisionId })}>{s.revoke}</button>;
  };
  return (
    <li key={revision.revisionId} className="skill-revision">
      <div className="skill-revision-main">
        <span className="skill-revision-head">
          <strong className="skill-revision-version">{version}</strong>
          <span className={`badge ${stateTone(revision.state)}`}>{s.states[revision.state] ?? revision.state}</span>
          {revision.active && revision.state !== 'active' && <span className="badge ok">{s.states.active}</span>}
          <span className="badge subtle">{s.risks[revision.riskClass] ?? revision.riskClass}</span>
        </span>
        {reason && <span className="small skill-revision-reason" title={s.reasonCode(reason)}>{s.reasons[reason] ?? s.reasonCode(reason)}</span>}
        <SkillPermissions t={t} revision={revision} />
        <span className="muted small skill-revision-meta">
          <code className="skill-hash" title={s.treeTitle(revision.treeSha256)}>{shortDigest(revision.treeSha256)}</code>
          {' · '}
          <code className="skill-hash" title={s.digestTitle(revision.permissionDigest)}>{shortDigest(revision.permissionDigest)}</code>
          {revision.manifestInferred && <>{' · '}{s.inferred}</>}
        </span>
      </div>
      <div className="row-actions skill-revision-actions">
        {actions.map(button)}
        <button type="button" className="button small" aria-expanded={Boolean(detail)} aria-label={label(detail ? s.hideDetails : s.details)} onClick={() => onToggleDetails(revision.revisionId)}>
          {detail ? s.hideDetails : s.details}
        </button>
      </div>
      {open === 'approve' && SkillApproveConfirm({ t, revision, ttlMs: report.approvalTtlMs, busy, onApprove: () => onAction({ kind: 'approve', input: approvalFor(revision) }), onCancel: () => onConfirm(null) })}
      {open === 'review' && <SkillReviewForm t={t} revision={revision} available={report.review} busy={busy}
        onReview={(decision, note) => onAction({ kind: 'review', input: { revisionId: revision.revisionId, treeSha256: revision.treeSha256, decision, ...(note ? { note } : {}) } })}
        onCancel={() => onConfirm(null)} />}
      {open === 'revoke' && (
        <div className="skill-confirm" role="group" aria-label={label(s.revoke)}>
          <p className="small">{s.confirmRevoke(name, version)}</p>
          <div className="row-actions">
            <button type="button" className="button small danger" disabled={busy} onClick={() => onAction({ kind: 'revoke', revisionId: revision.revisionId })}>{s.confirmRevokeAction}</button>
            <button type="button" className="button small" disabled={busy} onClick={() => onConfirm(null)}>{s.cancel}</button>
          </div>
        </div>
      )}
      {detail && <SkillDetails t={t} detail={detail} workspaceNames={workspaceNames} />}
    </li>
  );
}

function SkillPermissions({ t, revision }: { t: Messages; revision: SkillRevisionSummary }) {
  const s = t.skillCenter;
  if (!revision.permissions.length) return <span className="muted small">{s.noPermissions}</span>;
  return (
    <ul className="skill-permissions" aria-label={s.permissions} title={s.permissions}>
      {revision.permissions.map((permission, index) => (
        <li key={`${permission.capability}:${permission.scope}:${index}`} className="badge warn">
          {s.capabilities[permission.capability] ?? permission.capability}
          {permission.scope && permission.scope !== 'true' && permission.scope !== '*' ? <code>{permission.scope}</code> : null}
        </li>
      ))}
    </ul>
  );
}

/** The exact digests being approved and the expiry; pressing approve sends nothing else. */
export function SkillApproveConfirm({ t, revision, ttlMs, busy, onApprove, onCancel }: {
  t: Messages; revision: SkillRevisionSummary; ttlMs: number; busy: boolean; onApprove: () => void; onCancel: () => void;
}) {
  const s = t.skillCenter;
  const version = s.version(revision.version);
  return (
    <div className="skill-confirm" role="group" aria-label={s.approveTitle(revision.packageId, version)}>
      <strong className="small">{s.approveTitle(revision.packageId, version)}</strong>
      <p className="small muted">{s.approveLead}</p>
      <dl className="skill-digests">
        <dt>{s.approveTree}</dt><dd><code>{revision.treeSha256}</code></dd>
        <dt>{s.approveDigest}</dt><dd><code>{revision.permissionDigest}</code></dd>
      </dl>
      <SkillPermissions t={t} revision={revision} />
      <p className="small"><Icon name="alert" />{s.approveExpiry(minutes(ttlMs))}</p>
      <div className="row-actions">
        <button type="button" className="button small primary" disabled={busy} onClick={onApprove}><Icon name="check" />{s.confirmApprove}</button>
        <button type="button" className="button small" disabled={busy} onClick={onCancel}>{s.cancel}</button>
      </div>
    </div>
  );
}

function SkillReviewForm({ t, revision, available, busy, onReview, onCancel }: {
  t: Messages; revision: SkillRevisionSummary; available: boolean; busy: boolean; onReview: (decision: SkillReviewDecision, note: string) => void; onCancel: () => void;
}) {
  const s = t.skillCenter;
  const [note, setNote] = useState('');
  const id = `skill-review-${revision.revisionId}`;
  return (
    <div className="skill-confirm" role="group" aria-label={s.actionLabel(s.review, revision.packageId, s.version(revision.version))}>
      <p className="small muted">{available ? s.reviewLead : s.reviewUnavailable}</p>
      <label className="field" htmlFor={id}>
        <span>{s.reviewNote}</span>
        <textarea id={id} rows={2} maxLength={2000} value={note} disabled={!available || busy} onChange={event => setNote(event.target.value)} />
      </label>
      <div className="row-actions">
        <button type="button" className="button small primary" disabled={!available || busy} onClick={() => onReview('accept', note.trim() ? note : '')}>{s.accept}</button>
        <button type="button" className="button small danger" disabled={!available || busy} onClick={() => onReview('reject', note.trim() ? note : '')}>{s.reject}</button>
        <button type="button" className="button small" disabled={busy} onClick={onCancel}>{s.cancel}</button>
      </div>
    </div>
  );
}

export function SkillDetails({ t, detail, workspaceNames }: { t: Messages; detail: SkillRevisionDetails | 'loading' | { error: string }; workspaceNames?: WorkspaceNames }) {
  const s = t.skillCenter;
  if (detail === 'loading') return <p className="muted small">{s.loadingDetails}</p>;
  if ('error' in detail) return <p className="form-error small" role="alert"><Icon name="alert" />{detail.error}</p>;
  return (
    <div className="skill-details">
      {detail.consent.map((consent, index) => (
        // W0 consent is review input only: shown with the project it came from, never as an approval.
        <p key={`${consent.workspaceId ?? ''}:${consent.sha256}:${index}`} className="small note" title={s.consentTitle}>
          {s.consentInput(consent.workspaceId ? workspaceNames?.[consent.workspaceId] ?? consent.workspaceId : undefined, consent.allowedAt ? day(consent.allowedAt) : undefined)}
        </p>
      ))}
      <div>
        <h4>{s.files}</h4>
        <ul className="skill-detail-list">
          {detail.files.map(file => (
            <li key={file.path} className="small"><code>{file.path}</code> <span className="muted">{file.size} B</span> <code className="skill-hash muted" title={`SHA-256 ${file.sha256}`}>{shortDigest(file.sha256)}</code></li>
          ))}
        </ul>
      </div>
      {detail.inspections.length > 0 && (
        <div>
          <h4>{s.inspections}</h4>
          <ul className="skill-detail-list">
            {detail.inspections.map(inspection => (
              <li key={inspection.inspectionId} className="small">{s.inspectionLine(inspection.scannerId, s.reasons[inspection.outcome] ?? inspection.outcome)} <span className="muted">{when(inspection.finishedAt)}</span></li>
            ))}
          </ul>
        </div>
      )}
      {detail.approvals.length > 0 && (
        <div>
          <h4>{s.approvals}</h4>
          <ul className="skill-detail-list">
            {detail.approvals.map(approval => <li key={approval.approvalId} className="small">{s.approvalLine(approval.approver, approval.status, when(approval.expiresAt))}</li>)}
          </ul>
        </div>
      )}
      <div>
        <h4>{s.history}</h4>
        <ol className="skill-detail-list">
          {detail.history.map(event => (
            <li key={event.seq} className="small">
              {event.fromState ? `${s.states[event.fromState] ?? event.fromState} → ` : ''}{s.states[event.toState] ?? event.toState}
              {event.reason ? <span className="muted"> · {s.reasons[event.reason] ?? event.reason}</span> : null}
              <span className="muted"> · {when(event.at)}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** Import from a folder (typed, or chosen with the Desktop picker) or from a workspace's `.extalia/skills`. */
function SkillImportPanel({ t, kind, busy, picker, agents, workspaces, onImport, onCancel }: {
  t: Messages; kind: 'folder' | 'project'; busy: boolean; picker?: FileSystemCapability; agents: AgentHostApi; workspaces: Workspace[];
  onImport: (source: SkillImportSource) => void; onCancel: () => void;
}) {
  const s = t.skillCenter;
  const [folder, setFolder] = useState('');
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '');
  const [skills, setSkills] = useState<{ workspaceId: string; report: WorkspaceSkills | null } | null>(null);
  const [name, setName] = useState('');
  useEffect(() => {
    if (kind !== 'project' || !workspaceId || typeof agents.workspaceSkills !== 'function') return;
    let live = true;
    agents.workspaceSkills(workspaceId).then(report => { if (live) setSkills({ workspaceId, report }); }, () => { if (live) setSkills({ workspaceId, report: null }); });
    return () => { live = false; };
  }, [agents, kind, workspaceId]);
  const names = skills?.workspaceId === workspaceId && skills.report ? [...skills.report.allowed, ...skills.report.pending].map(skill => skill.name).sort() : [];
  const chosen = names.includes(name) ? name : names[0] ?? '';
  const choose = async () => {
    const selection = await picker?.selectDirectory().catch(() => null);
    if (selection?.path) setFolder(selection.path);
  };
  return (
    <form className="skill-import" onSubmit={event => {
      event.preventDefault();
      if (kind === 'folder' && folder.trim()) onImport({ kind: 'folder', path: folder.trim() });
      if (kind === 'project' && workspaceId && chosen) onImport({ kind: 'workspace', workspaceId, name: chosen });
    }}>
      <p className="small muted">{s.importLead}</p>
      {kind === 'folder' ? (
        <label className="field">
          <span>{s.folderLabel}</span>
          <span className="skill-import-row">
            <input type="text" value={folder} placeholder={s.folderPlaceholder} spellCheck={false} autoComplete="off" onChange={event => setFolder(event.target.value)} />
            {picker && <button type="button" className="button small" disabled={busy} onClick={() => void choose()}><Icon name="folder" />{s.browse}</button>}
          </span>
        </label>
      ) : !workspaces.length ? <p className="small muted">{s.noProjects}</p> : (
        <div className="skill-import-row">
          <label className="field">
            <span>{s.workspaceLabel}</span>
            <select value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}>
              {workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>{s.projectSkillLabel}</span>
            <select value={chosen} disabled={!names.length} onChange={event => setName(event.target.value)}>
              {names.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
        </div>
      )}
      {kind === 'project' && skills?.workspaceId === workspaceId && !names.length && <p className="small muted">{s.noProjectSkills}</p>}
      <div className="row-actions">
        <button type="submit" className="button small primary" disabled={busy || (kind === 'folder' ? !folder.trim() : !chosen)}><Icon name="download" />{s.importAction}</button>
        <button type="button" className="button small" disabled={busy} onClick={onCancel}>{s.cancel}</button>
      </div>
    </form>
  );
}
