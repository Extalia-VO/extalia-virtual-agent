import type { AgentHostApi, HostState, SkillConsentInput, WorkspaceSkills } from '@extalia/platform';
import { useEffect, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { useSkillRegistryMode } from './skillCenterModel';

/**
 * W0 project-skill consent: a workspace's `.extalia/skills/<skill>/SKILL.md` files reach the agent only after the
 * user allows them, bound to each file's SHA-256. The sections live on the Skills page, one per workspace; Settings
 * and Chat show a short "waiting for review" link that opens that page on the workspace.
 */

type Workspace = HostState['workspaces'][number];
type SkillsHost = Pick<AgentHostApi, 'workspaceSkills' | 'allowWorkspaceSkills' | 'revokeWorkspaceSkills'>;

export function projectSkillsSupported(agents: AgentHostApi): boolean {
  const host = agents as Partial<SkillsHost>;
  return typeof host.workspaceSkills === 'function' && typeof host.allowWorkspaceSkills === 'function' && typeof host.revokeWorkspaceSkills === 'function';
}

export function hasProjectSkills(report: WorkspaceSkills | null | undefined): report is WorkspaceSkills {
  return Boolean(report && (report.allowed.length || report.pending.length || report.warnings.length));
}

/** The first 12 hex characters; the full hash goes in the tooltip. */
export const shortHash = (sha256: string) => sha256.slice(0, 12);

export type ProjectSkillsAction = { kind: 'allow'; skills: SkillConsentInput[] } | { kind: 'revoke'; names?: string[] };

/**
 * Allow or revoke, returning the host's fresh report. On failure (for example a skill that changed after it was
 * listed) the host's message is returned with a reloaded report, so the user reviews the current version.
 */
export async function applyProjectSkillsAction(agents: SkillsHost, workspaceId: string, action: ProjectSkillsAction): Promise<{ report: WorkspaceSkills | null; error?: string }> {
  try {
    const report = action.kind === 'allow'
      ? await agents.allowWorkspaceSkills(workspaceId, action.skills.map(({ name, sha256 }) => ({ name, sha256 })))
      : await agents.revokeWorkspaceSkills(workspaceId, action.names);
    return { report };
  } catch (failure) {
    const report = await agents.workspaceSkills(workspaceId).catch(() => null);
    return { report, error: errorMessage(failure) };
  }
}

// Chat and Settings ask the Skills page to scroll to one workspace's section; consumed once by that section.
let revealRequest: string | null = null;
export function requestProjectSkillsReveal(workspaceId: string) { revealRequest = workspaceId; }
/** Consumes the request for this workspace (true once); exported for tests. */
export function takeProjectSkillsReveal(workspaceId: string): boolean {
  if (revealRequest !== workspaceId) return false;
  revealRequest = null;
  return true;
}

export const projectSkillsId = (workspaceId: string) => `project-skills-${workspaceId}`;

/**
 * Loads a workspace's report; `report` stays `null` when the host lacks the methods, the workspace has no folder, or
 * loading fails (`failed`), so an older host shows nothing instead of an error.
 */
export function useWorkspaceSkills(agents: AgentHostApi, workspace: Pick<Workspace, 'id' | 'projectLocation'>) {
  const supported = projectSkillsSupported(agents);
  // Keyed by workspace and folder, so a report never shows under another project.
  const key = `${workspace.id}\n${workspace.projectLocation ?? ''}`;
  const [loaded, setLoaded] = useState<{ key: string; report: WorkspaceSkills | null } | null>(null);
  useEffect(() => {
    if (!supported || !workspace.projectLocation) return;
    let live = true;
    agents.workspaceSkills(workspace.id).then(report => { if (live) setLoaded({ key, report }); }, () => { if (live) setLoaded({ key, report: null }); });
    return () => { live = false; };
  }, [agents, supported, key, workspace.id, workspace.projectLocation]);
  const current = loaded?.key === key ? loaded : null;
  const report = current?.report ?? null;
  const failed = Boolean(current && !current.report);
  const setReport = (next: WorkspaceSkills) => setLoaded({ key, report: next });
  return { supported, report, failed, setReport };
}

/** One workspace's project skills on the Skills page; workspaces without skills say so in one line. */
export function ProjectSkills({ t, agents, workspace, onChanged }: { t: Messages; agents: AgentHostApi; workspace: Workspace; onChanged?: () => void }) {
  const { supported, report, failed, setReport } = useWorkspaceSkills(agents, workspace);
  // W3: with the native core's skill registry, the Skill Security Center replaces W0 consent.
  const registry = useSkillRegistryMode(agents) === 'registry';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!report || !takeProjectSkillsReveal(workspace.id) || !hasProjectSkills(report)) return;
    const section = document.getElementById(projectSkillsId(workspace.id));
    section?.scrollIntoView({ block: 'center' });
    section?.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
  }, [report, workspace.id]);

  if (!supported || registry || !workspace.projectLocation || failed) return null;
  const s = t.projectSkills;
  if (!report || !hasProjectSkills(report)) {
    return (
      <section className="project-skills project-skills-empty" aria-label={workspace.name}>
        <h3><Icon name="folder" />{workspace.name}</h3>
        <p className="muted small">{report ? s.none : t.skillsPage.loading}</p>
      </section>
    );
  }
  const run = async (action: ProjectSkillsAction) => {
    setBusy(true);
    setError(null);
    const result = await applyProjectSkillsAction(agents, workspace.id, action);
    if (result.report) setReport(result.report);
    setError(result.error ?? null);
    setBusy(false);
    if (!result.error) onChanged?.();
  };
  return <ProjectSkillsView t={t} workspaceId={workspace.id} title={workspace.name} report={report} busy={busy} error={error}
    onAllow={skills => void run({ kind: 'allow', skills })} onRevoke={names => void run({ kind: 'revoke', names })} />;
}

/** Stateless so tests can render it and press its buttons. Hidden when the project has no skills. */
export function ProjectSkillsView({ t, workspaceId, title, report, busy, error, onAllow, onRevoke }: {
  t: Messages;
  workspaceId: string;
  /** The heading: the workspace name on the Skills page; "Project skills" otherwise. */
  title?: string;
  report: WorkspaceSkills | null;
  busy: boolean;
  error: string | null;
  onAllow: (skills: SkillConsentInput[]) => void;
  /** Without names: every skill of the workspace. */
  onRevoke: (names?: string[]) => void;
}) {
  if (!hasProjectSkills(report)) return null;
  const s = t.projectSkills;
  const id = projectSkillsId(workspaceId);
  const hash = (sha256: string) => <code className="project-skill-hash" title={s.hashTitle(sha256)}>{shortHash(sha256)}</code>;
  return (
    <section className="project-skills" id={id} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} tabIndex={-1}><Icon name={title ? 'folder' : 'book'} />{title ?? s.title}</h3>
      {!title && <p className="muted small">{s.lead}</p>}

      {report.pending.length > 0 && (
        <div className="project-skills-group">
          <div className="project-skills-subhead">
            <h4>{s.pending(report.pending.length)}</h4>
            {report.pending.length > 1 && <button type="button" className="button small" disabled={busy}
              onClick={() => onAllow(report.pending.map(({ name, sha256 }) => ({ name, sha256 })))}><Icon name="check" />{s.allowAll}</button>}
          </div>
          <ul className="project-skills-list">
            {report.pending.map(skill => (
              <li key={skill.name} className="project-skill">
                <div className="project-skill-main">
                  <span className="project-skill-name">
                    <strong>{skill.name}</strong>
                    <span className={`badge ${skill.reason === 'changed' ? 'warn' : ''}`}>{s.reasons[skill.reason]}</span>
                  </span>
                  <span className="small">{skill.description}</span>
                  <span className="muted small project-skill-meta">
                    <code title={s.sourceTitle}>{s.sourcePath(skill.name)}</code>{' · '}{hash(skill.sha256)}
                  </span>
                </div>
                <button type="button" className="button small primary" disabled={busy} aria-label={s.allowLabel(skill.name)}
                  onClick={() => onAllow([{ name: skill.name, sha256: skill.sha256 }])}>{s.allow}</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.allowed.length > 0 && (
        <div className="project-skills-group">
          <div className="project-skills-subhead">
            <h4>{s.allowed(report.allowed.length)}</h4>
            <button type="button" className="button small" disabled={busy} onClick={() => onRevoke()}>{s.revokeAll}</button>
          </div>
          <ul className="project-skills-list">
            {report.allowed.map(skill => (
              <li key={skill.name} className="project-skill">
                <div className="project-skill-main">
                  <span className="project-skill-name"><strong>{skill.name}</strong>{hash(skill.sha256)}</span>
                </div>
                <button type="button" className="button small" disabled={busy} aria-label={s.revokeLabel(skill.name)}
                  onClick={() => onRevoke([skill.name])}>{s.revoke}</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.warnings.length > 0 && (
        <div className="project-skills-group">
          <h4>{s.warnings}</h4>
          <ul className="project-skills-warnings">
            {report.warnings.map((warning, index) => <li key={index} className="warning small"><Icon name="alert" />{warning}</li>)}
          </ul>
        </div>
      )}
      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
    </section>
  );
}

/** Non-blocking Chat notice while the active workspace has skills waiting for review; opens the Skills page on it. */
export function ProjectSkillsNotice({ t, agents, workspace, onReview }: { t: Messages; agents: AgentHostApi; workspace: Workspace; onReview: (workspaceId: string) => void }) {
  const { report } = useWorkspaceSkills(agents, workspace);
  const registry = useSkillRegistryMode(agents) === 'registry';
  const [hidden, setHidden] = useState<string | null>(null);
  const count = report?.pending.length ?? 0;
  if (!count || hidden === workspace.id || registry) return null;
  return <ProjectSkillsNoticeView t={t} workspaceId={workspace.id} count={count} onReview={onReview} onClose={() => setHidden(workspace.id)} />;
}

/** Stateless so tests can render it and press its buttons. */
export function ProjectSkillsNoticeView({ t, workspaceId, count, onReview, onClose }: {
  t: Messages; workspaceId: string; count: number; onReview: (workspaceId: string) => void; onClose: () => void;
}) {
  const s = t.projectSkills;
  return (
    <div className="note project-skills-notice" role="status">
      <Icon name="shield" />
      <span>{s.chatNotice(count)}</span>
      <span className="row-actions">
        <button type="button" className="button small" onClick={() => { requestProjectSkillsReveal(workspaceId); onReview(workspaceId); }}>{s.review}</button>
        <button type="button" className="button small" aria-label={t.common.close} title={t.common.close} onClick={onClose}><Icon name="close" /></button>
      </span>
    </div>
  );
}

/** Settings → Workspaces: "N project skills waiting — Review" under a workspace; nothing when none wait. */
export function ProjectSkillsPendingLink({ t, agents, workspace, onReview }: { t: Messages; agents: AgentHostApi; workspace: Workspace; onReview: (workspaceId: string) => void }) {
  const { report } = useWorkspaceSkills(agents, workspace);
  const registry = useSkillRegistryMode(agents) === 'registry';
  const count = report?.pending.length ?? 0;
  if (!count || registry) return null;
  return <ProjectSkillsPendingLinkView t={t} workspaceId={workspace.id} workspaceName={workspace.name} count={count} onReview={onReview} />;
}

/** Stateless so tests can render it and press its button. */
export function ProjectSkillsPendingLinkView({ t, workspaceId, workspaceName, count, onReview }: {
  t: Messages; workspaceId: string; workspaceName: string; count: number; onReview: (workspaceId: string) => void;
}) {
  const s = t.projectSkills;
  return (
    <p className="small project-skills-pending">
      <Icon name="shield" />
      <span>{s.waiting(count)}</span>
      <button type="button" className="link-button strong" aria-label={s.reviewLabel(workspaceName)}
        onClick={() => { requestProjectSkillsReveal(workspaceId); onReview(workspaceId); }}>{s.reviewShort}</button>
    </p>
  );
}
