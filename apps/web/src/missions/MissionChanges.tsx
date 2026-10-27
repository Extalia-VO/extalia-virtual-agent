import type { Workspace } from '@extalia/core';
import type {
  AgentHostApi, HostMissionRun, HostMissionTask, IntegrationProposalView, WorktreeDiffView, WorktreeOrphanView, WorktreeStatusView, WorktreeView,
} from '@extalia/platform';
import { useEffect, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Language, Messages } from '../i18n';
import { useGateSuggestion } from '../setup/gateSuggestion';
import { Icon } from '../ui/Icon';

/**
 * ADR 0028: the Changes panel of a mission with write-capable workers. Each write task shows its own
 * worktree (branch, ahead/dirty, committed diff), lets the user propose an integration with a test
 * gate, shows every proposal's outcome (conflict paths, gate log), applies a ready proposal only
 * after a confirmation that shows and sends its exact diff digest, and removes a worktree only with
 * the fingerprint the user was shown. Hosts without the worktree methods do not show the panel.
 */

type WorktreeApi = Pick<Required<AgentHostApi>, 'listWorktrees' | 'worktreeStatus' | 'worktreeDiff' | 'worktreeOrphans' | 'removeWorktree' | 'proposeIntegration' | 'integrationProposals' | 'applyIntegration'>;
const METHODS = ['listWorktrees', 'worktreeStatus', 'worktreeDiff', 'worktreeOrphans', 'removeWorktree', 'proposeIntegration', 'integrationProposals', 'applyIntegration'] as const;
const UNSUPPORTED = 'This host does not support this action.';
const MAX_FILES_SHOWN = 50;
const LOG_EXCERPT = 2_000;

/** Whether `agents` offers every worktree method (Desktop and the Bridge do; older or other hosts may not). */
export function missionChangesSupported(agents: Partial<AgentHostApi>): agents is Partial<AgentHostApi> & WorktreeApi {
  return METHODS.every(method => typeof agents[method] === 'function');
}

/** A mission shows the panel when it has write-capable tasks. */
export const hasWriteTasks = (run: HostMissionRun): boolean => run.tasks.some(task => task.access === 'write');

export interface ChangeItem { task: HostMissionTask; worktree?: WorktreeView; status?: WorktreeStatusView; statusError?: string; diff?: WorktreeDiffView; proposals: IntegrationProposalView[] }

/** One entry per write task in task order, with its worktree and its proposals, newest first. */
export function missionChangeItems(run: HostMissionRun, worktrees: readonly WorktreeView[], proposals: readonly IntegrationProposalView[],
  statuses: Readonly<Record<string, WorktreeStatusView | string>> = {}, diffs: Readonly<Record<string, WorktreeDiffView>> = {}): ChangeItem[] {
  return run.tasks.filter(task => task.access === 'write').map(task => {
    const worktree = worktrees.find(item => item.owner.missionId === run.id && item.owner.taskId === task.taskId);
    if (!worktree) return { task, proposals: [] };
    const status = statuses[worktree.id], diff = diffs[worktree.id];
    return {
      task, worktree, ...(typeof status === 'string' ? { statusError: status } : status ? { status } : {}), ...(diff ? { diff } : {}),
      proposals: proposals.filter(item => item.worktreeId === worktree.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  });
}

/** Orphans of this mission, plus folders that belong to no mission. */
export const missionOrphans = (run: HostMissionRun, orphans: readonly WorktreeOrphanView[]): WorktreeOrphanView[] =>
  orphans.filter(item => item.owner ? item.owner.missionId === run.id : item.reason === 'unregistered');

export type ChangesConfirm =
  | { kind: 'apply'; proposalId: string; targetBranch: string; diffDigest: string }
  | { kind: 'remove'; worktreeId: string; fingerprint: string; unmerged: boolean };

/** Sends exactly the digest the confirmation showed; nothing else approves an integration. */
export function confirmChange(agents: WorktreeApi, confirm: ChangesConfirm): Promise<unknown> {
  return confirm.kind === 'apply'
    ? agents.applyIntegration(confirm.proposalId, { diffDigest: confirm.diffDigest })
    : agents.removeWorktree(confirm.worktreeId, { fingerprint: confirm.fingerprint });
}

/** The workspace fields the panel uses: its name and integration test gate (ADR 0028). */
export type ChangesWorkspace = Pick<Workspace, 'id' | 'name' | 'integrationGate'>;
type WorkspaceGate = Workspace['integrationGate'];

/**
 * The integration form of one worktree; the target defaults to the worktree's base branch and the
 * gate to the workspace setting (empty when none is configured; there is no built-in default).
 */
export interface ProposeForm { target: string; gate: string }
export const proposeForm = (worktree: WorktreeView, current?: ProposeForm, workspaceGate?: WorkspaceGate): ProposeForm =>
  current ?? { target: worktree.baseBranch ?? '', gate: workspaceGate?.command ?? '' };

/**
 * Where the gate of this form comes from. `workspace`: the field matches (or, left empty, falls back
 * to) the workspace setting; `custom`: a command for this proposal only; `none`: no gate anywhere,
 * so the proposal will be `gate_missing`.
 */
export type GateOrigin = 'workspace' | 'custom' | 'none';
export function gateOrigin(form: ProposeForm, workspaceGate?: WorkspaceGate): GateOrigin {
  const command = form.gate.trim();
  if (!command) return workspaceGate ? 'workspace' : 'none';
  return command === workspaceGate?.command ? 'workspace' : 'custom';
}

/** Only a custom command is sent; otherwise the host runs the workspace setting itself (with its timeout). */
export const proposeRequest = (form: ProposeForm, workspaceGate?: WorkspaceGate) => ({
  targetBranch: form.target.trim(), ...(gateOrigin(form, workspaceGate) === 'custom' ? { gate: { command: form.gate.trim() } } : {}),
});

const short = (value: string) => value.replace(/^sha256:/, '').slice(0, 12);
const statusTone: Record<string, string> = { ready: 'ok', applied: 'ok', conflict: 'error', gate_failed: 'error', gate_missing: 'warn', stale: 'warn', empty: 'off' };
const totals = (diff: Pick<WorktreeDiffView, 'files'>) => diff.files.reduce((sum, file) => ({ added: sum.added + (file.added ?? 0), deleted: sum.deleted + (file.deleted ?? 0) }), { added: 0, deleted: 0 });

export interface MissionChangesViewProps {
  t: Messages;
  language: Language;
  run: HostMissionRun;
  items: ChangeItem[] | null;
  orphans: WorktreeOrphanView[];
  forms: Readonly<Record<string, ProposeForm>>;
  busy: string | null;
  error: string | null;
  confirm: ChangesConfirm | null;
  onRefresh(): void;
  onForm(worktreeId: string, form: ProposeForm): void;
  onPropose(worktreeId: string): void;
  onAskApply(proposal: IntegrationProposalView): void;
  onAskRemove(worktreeId: string): void;
  onConfirm(): void;
  onCancelConfirm(): void;
  /** The mission's workspace; its integration test gate pre-fills the form. */
  workspace?: ChangesWorkspace | undefined;
  /** A gate suggested from the project's files, offered only while none is configured. */
  gateSuggestion?: string | undefined;
  onEditGate?: ((workspaceId: string) => void) | undefined;
}

/** Hook-free view (tests render it directly). */
export function MissionChangesView(props: MissionChangesViewProps) {
  const { t, run, items, orphans, busy, error, confirm } = props;
  const c = t.missions.changes;
  const headingId = `mission-changes-${run.id}`;
  const time = (iso: string) => new Date(iso).toLocaleString(props.language, { dateStyle: 'medium', timeStyle: 'short' });

  const confirmBox = (target: ChangesConfirm) => {
    const titleId = `${headingId}-confirm-title`, bodyId = `${headingId}-confirm-body`;
    const value = target.kind === 'apply' ? target.diffDigest : target.fingerprint;
    return (
      <div className="mission-confirm-box" role="alertdialog" aria-labelledby={titleId} aria-describedby={bodyId}>
        <p id={titleId} className="mission-confirm-text">{target.kind === 'apply' ? c.applyTitle : c.removeTitle}</p>
        <div id={bodyId}>
          <p className="small">{target.kind === 'apply' ? c.applyBody(target.targetBranch) : target.unmerged ? c.removeUnmerged : c.removeMerged}</p>
          {(target.kind === 'apply' || target.unmerged) && <code className="mission-digest" data-testid="confirm-digest">{value}</code>}
        </div>
        <div className="actions">
          <button type="button" className={target.kind === 'apply' ? 'primary' : 'danger'} disabled={busy !== null} onClick={props.onConfirm}>
            {busy === 'confirm' ? (target.kind === 'apply' ? c.applying : c.removing) : target.kind === 'apply' ? c.applyConfirm : target.unmerged ? c.discardConfirm : c.removeConfirm}
          </button>
          <button type="button" disabled={busy === 'confirm'} onClick={props.onCancelConfirm}>{t.common.cancel}</button>
        </div>
      </div>
    );
  };

  const proposalView = (proposal: IntegrationProposalView) => {
    const hint = c.hint[proposal.status];
    const sums = totals(proposal);
    return (
      <li key={proposal.id} className="mission-proposal" data-tone={statusTone[proposal.status] ?? 'off'} data-status={proposal.status}>
        <header className="mission-change-head">
          <span className="mission-state" data-tone={statusTone[proposal.status] ?? 'off'}>{c.status[proposal.status] ?? proposal.status}</span>
          <span className="muted small"><Icon name="git" /><code>{proposal.targetBranch}</code> · <time dateTime={proposal.createdAt}>{time(proposal.appliedAt ?? proposal.createdAt)}</time></span>
        </header>
        {hint && <p className="small mission-proposal-hint">{hint(proposal.targetBranch)}</p>}
        {proposal.files.length > 0 && <p className="muted small">{c.diff(proposal.files.length, sums.added, sums.deleted)}</p>}
        {proposal.status === 'conflict' && proposal.conflicts?.length && (
          <div className="mission-conflicts">
            <p className="small"><strong>{c.conflicts}</strong></p>
            <ul>{proposal.conflicts.map(file => <li key={file}><code>{file}</code></li>)}</ul>
          </div>
        )}
        {proposal.gate && (
          <div className="mission-gate">
            <p className="small"><Icon name={proposal.gate.ok ? 'check' : 'alert'} /><code>{c.gateResult(proposal.gate.command, proposal.gate.exitCode, (proposal.gate.durationMs / 1000).toFixed(1))}</code>
              {proposal.gateSource === 'workspace' && <span className="muted"> · {c.gateSourceWorkspace}</span>}</p>
            {!proposal.gate.ok && proposal.gate.log && (
              <details className="mission-gate-log" open>
                <summary>{c.log}</summary>
                <pre>{proposal.gate.log.length > LOG_EXCERPT ? `…${proposal.gate.log.slice(-LOG_EXCERPT)}` : proposal.gate.log}</pre>
              </details>
            )}
          </div>
        )}
        {proposal.diffDigest && proposal.status === 'ready' && (
          <p className="muted small mission-digest-line"><span>{c.digest}:</span> <code title={proposal.diffDigest}>{short(proposal.diffDigest)}</code></p>
        )}
        {proposal.status === 'ready' && proposal.diffDigest && (confirm?.kind === 'apply' && confirm.proposalId === proposal.id
          ? confirmBox(confirm)
          : <div className="actions"><button type="button" className="primary" disabled={busy !== null || confirm !== null} onClick={() => props.onAskApply(proposal)}><Icon name="check" />{c.apply}</button></div>)}
      </li>
    );
  };

  const itemView = (item: ChangeItem) => {
    const { task, worktree, status, diff } = item;
    if (!worktree) return <li key={task.taskId} className="mission-change"><header className="mission-change-head"><h4>{task.title}</h4></header><p className="muted small">{c.noWorktree}</p></li>;
    const workspaceGate = props.workspace?.integrationGate;
    const form = proposeForm(worktree, props.forms[worktree.id], workspaceGate);
    const origin = gateOrigin(form, workspaceGate);
    const sums = diff ? totals(diff) : undefined;
    const released = worktree.state === 'released';
    const fieldId = (name: string) => `${headingId}-${worktree.id}-${name}`;
    return (
      <li key={task.taskId} className="mission-change" data-worktree={worktree.id}>
        <header className="mission-change-head">
          <h4>{task.title}</h4>
          {worktree.integratedAs ? <span className="badge ok"><Icon name="check" />{c.integrated}</span> : !released && <span className="badge running"><span className="pulse" aria-hidden="true" />{c.running}</span>}
        </header>
        <p className="mission-task-meta">
          <span><Icon name="git" /><code>{worktree.branch}</code></span>
          <span className="muted">{c.base(short(worktree.baseCommit), worktree.baseBranch)}</span>
        </p>
        <p className="mission-change-status">
          {status ? <>
            <span className="badge">{c.ahead(status.ahead)}</span>
            {status.behind > 0 && <span className="badge warn">{c.behind(status.behind)}</span>}
            <span className={status.dirty ? 'badge warn' : 'badge'}>{status.dirty ? c.dirty(status.changedPaths) : c.clean}</span>
            {status.merged && status.ahead > 0 && <span className="badge ok">{c.merged}</span>}
          </> : item.statusError ? <span className="badge warn"><Icon name="alert" />{c.statusUnavailable}: {item.statusError}</span> : null}
        </p>
        {diff && (diff.files.length
          ? <details className="mission-diff">
            <summary>{c.files}: {c.diff(diff.files.length, sums!.added, sums!.deleted)}</summary>
            <ul>{diff.files.slice(0, MAX_FILES_SHOWN).map(file => (
              <li key={file.path}><code>{file.path}</code><span className="muted">{file.binary ? c.binary : `+${file.added ?? 0} −${file.deleted ?? 0}`}</span></li>
            ))}</ul>
            {diff.files.length > MAX_FILES_SHOWN && <p className="muted small">{c.moreFiles(diff.files.length - MAX_FILES_SHOWN)}</p>}
            {diff.truncated && <p className="muted small">{c.truncated}</p>}
          </details>
          : <p className="muted small">{c.noDiff}</p>)}
        {!worktree.integratedAs && (released
          ? <form className="mission-propose" onSubmit={event => { event.preventDefault(); props.onPropose(worktree.id); }}>
            <div className="mission-propose-fields">
              <div className="field">
                <label htmlFor={fieldId('target')}>{c.target}</label>
                <input id={fieldId('target')} type="text" maxLength={200} spellCheck={false} autoCapitalize="off" value={form.target} required
                  onChange={event => props.onForm(worktree.id, { ...form, target: event.target.value })} />
              </div>
              <div className="field">
                <label htmlFor={fieldId('gate')}>{c.gate}</label>
                <input id={fieldId('gate')} type="text" maxLength={4000} spellCheck={false} autoCapitalize="off" value={form.gate} aria-describedby={fieldId('gate-note')}
                  onChange={event => props.onForm(worktree.id, { ...form, gate: event.target.value })} />
              </div>
            </div>
            <p id={fieldId('gate-note')} className="muted small mission-gate-origin" data-origin={origin}>
              {props.workspace && <>{origin === 'workspace' ? c.gateFromWorkspace(props.workspace.name)
                : origin === 'custom' ? (workspaceGate ? c.gateCustom(props.workspace.name) : c.gateCustomNoSetting(props.workspace.name))
                  : c.gateNone(props.workspace.name)}{' '}</>}
              {c.gateNote}
            </p>
            {props.workspace && (props.onEditGate || (origin === 'none' && props.gateSuggestion)) && (
              <div className="actions mission-gate-actions">
                {origin === 'none' && props.gateSuggestion && (
                  <button type="button" className="button small" onClick={() => props.onForm(worktree.id, { ...form, gate: props.gateSuggestion! })}><Icon name="check" />{c.gateSuggestion(props.gateSuggestion)}</button>
                )}
                {props.onEditGate && (
                  <button type="button" className="button small" onClick={() => props.onEditGate!(props.workspace!.id)}><Icon name="settings" />{workspaceGate ? c.editGate : c.setGate}</button>
                )}
              </div>
            )}
            <div className="actions">
              <button type="submit" disabled={busy !== null || !form.target.trim()}>{busy === `propose:${worktree.id}` ? c.proposing : c.propose}</button>
            </div>
          </form>
          : <p className="muted small">{c.notReleased}</p>)}
        {item.proposals.length > 0 && (
          <section aria-label={c.proposals}>
            <h5 className="mission-change-subhead">{c.proposals}</h5>
            <ol className="mission-proposals">{item.proposals.map(proposalView)}</ol>
          </section>
        )}
        {released && (confirm?.kind === 'remove' && confirm.worktreeId === worktree.id
          ? confirmBox(confirm)
          : <div className="actions"><button type="button" className="button small" disabled={busy !== null || confirm !== null} onClick={() => props.onAskRemove(worktree.id)}><Icon name="trash" />{c.remove}</button></div>)}
      </li>
    );
  };

  return (
    <section className="mission-changes" aria-labelledby={headingId}>
      <header className="mission-graph-head">
        <h3 id={headingId}>{c.title}</h3>
        <button type="button" className="icon-button small" aria-label={c.refresh} title={c.refresh} disabled={busy !== null} onClick={props.onRefresh}><Icon name="refresh" className={busy === 'load' ? 'spin' : ''} /></button>
      </header>
      <p className="muted small">{c.lead}</p>
      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
      {items === null ? <p className="muted small" role="status">{c.loading}</p>
        : items.length ? <ol className="mission-change-list">{items.map(itemView)}</ol>
          : <p className="muted small">{c.none}</p>}
      {orphans.length > 0 && (
        <section className="mission-orphans" aria-label={c.orphans}>
          <h5 className="mission-change-subhead">{c.orphans}</h5>
          <p className="muted small">{c.orphansHint}</p>
          <ul>{orphans.map(orphan => (
            <li key={orphan.path}>
              <span className="badge warn"><Icon name="alert" />{c.orphanReasons[orphan.reason] ?? orphan.reason}</span>
              {orphan.branch ? <code>{orphan.branch}</code> : <code title={orphan.path}>{orphan.path.split(/[\\/]/).pop()}</code>}
              {orphan.unmerged && <span className="muted small">{c.unmerged}</span>}
              {orphan.id && orphan.reason === 'owner-ended' && (confirm?.kind === 'remove' && confirm.worktreeId === orphan.id
                ? confirmBox(confirm)
                : <button type="button" className="button small" disabled={busy !== null || confirm !== null} onClick={() => props.onAskRemove(orphan.id!)}><Icon name="trash" />{c.remove}</button>)}
            </li>
          ))}</ul>
        </section>
      )}
    </section>
  );
}

interface Loaded { worktrees: WorktreeView[]; proposals: IntegrationProposalView[]; orphans: WorktreeOrphanView[]; statuses: Record<string, WorktreeStatusView | string>; diffs: Record<string, WorktreeDiffView> }

/** The stateful panel. Renders nothing when the host turns out not to support worktrees. */
export function MissionChanges({ t, language, agents, run, workspace, onEditGate }: {
  t: Messages; language: Language; agents: WorktreeApi & Partial<Pick<AgentHostApi, 'listFiles' | 'readFile'>>; run: HostMissionRun;
  workspace?: ChangesWorkspace | undefined; onEditGate?: ((workspaceId: string) => void) | undefined;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forms, setForms] = useState<Record<string, ProposeForm>>({});
  const [confirm, setConfirm] = useState<ChangesConfirm | null>(null);
  // Only while no gate is configured: a suggestion button, never applied by itself.
  const gateSuggestion = useGateSuggestion(agents, workspace && !workspace.integrationGate ? workspace.id : undefined);

  useEffect(() => {
    let active = true;
    void (async () => {
      setBusy(current => current ?? 'load');
      try {
        const [worktrees, proposals, orphans] = await Promise.all([agents.listWorktrees(), agents.integrationProposals(), agents.worktreeOrphans()]);
        const own = worktrees.filter(item => item.owner.missionId === run.id);
        const statuses: Loaded['statuses'] = {}, diffs: Loaded['diffs'] = {};
        await Promise.all(own.map(async worktree => {
          try { statuses[worktree.id] = await agents.worktreeStatus(worktree.id); } catch (failure) { statuses[worktree.id] = errorMessage(failure); }
          try { diffs[worktree.id] = await agents.worktreeDiff(worktree.id); } catch { /* the status explains a missing folder */ }
        }));
        if (!active) return;
        setLoaded({ worktrees, proposals, orphans, statuses, diffs }); setError(null);
      } catch (failure) {
        if (!active) return;
        const message = errorMessage(failure);
        if (message === UNSUPPORTED) setUnsupported(true); else setError(message);
      } finally {
        if (active) setBusy(current => (current === 'load' ? null : current));
      }
    })();
    return () => { active = false; };
  }, [agents, run.id, run.state, version]);

  if (unsupported) return null;

  const act = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await work(); setConfirm(null); setVersion(value => value + 1); }
    catch (failure) { setError(errorMessage(failure)); setVersion(value => value + 1); }
    finally { setBusy(null); }
  };

  const items = loaded ? missionChangeItems(run, loaded.worktrees, loaded.proposals, loaded.statuses, loaded.diffs) : null;
  return (
    <MissionChangesView t={t} language={language} run={run} items={items} orphans={loaded ? missionOrphans(run, loaded.orphans) : []}
        forms={forms} busy={busy} error={error} confirm={confirm} workspace={workspace} gateSuggestion={gateSuggestion} onEditGate={onEditGate}
        onRefresh={() => setVersion(value => value + 1)}
        onForm={(id, form) => setForms(current => ({ ...current, [id]: form }))}
        onPropose={id => {
          const worktree = loaded?.worktrees.find(item => item.id === id);
          if (!worktree) return;
          const form = proposeForm(worktree, forms[id], workspace?.integrationGate);
          if (!form.target.trim()) { setError(t.missions.changes.targetRequired); return; }
          void act(`propose:${id}`, () => agents.proposeIntegration(id, proposeRequest(form, workspace?.integrationGate)));
        }}
        onAskApply={proposal => { if (proposal.diffDigest) setConfirm({ kind: 'apply', proposalId: proposal.id, targetBranch: proposal.targetBranch, diffDigest: proposal.diffDigest }); }}
        onAskRemove={id => void (async () => {
          // A fresh status: the fingerprint shown is the one sent, and any later change invalidates it.
          setBusy(`status:${id}`); setError(null);
          try {
            const status = await agents.worktreeStatus(id);
            setConfirm({ kind: 'remove', worktreeId: id, fingerprint: status.fingerprint, unmerged: status.dirty || !status.merged });
          } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(null); }
        })()}
        onConfirm={() => { if (confirm) void act('confirm', () => confirmChange(agents, confirm)); }}
        onCancelConfirm={() => setConfirm(null)} />
  );
}
