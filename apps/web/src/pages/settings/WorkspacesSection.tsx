import type { AgentHostApi, FileSystemCapability, HostState } from '@extalia/platform';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../host/remote';
import type { Messages } from '../../i18n';
import { availableHermes, useRuntimeStatus } from '../../setup/useRuntimes';
import { draftFromWorkspace, emptyWorkspaceDraft, isValid, toWorkspaceInput, validateWorkspace, type WorkspaceDraft } from '../../setup/validation';
import { permissionsLabel } from '../../setup/permissions';
import { WorkspaceForm } from '../../setup/WorkspaceForm';
import { Icon } from '../../ui/Icon';
import { TeamSetupDialog } from '../../office/TeamSetupDialog';
import { teamSupported, workspaceTeamSupported } from '../../office/team';
import { ProjectSkillsPendingLink } from '../../skills/ProjectSkills';

export function WorkspacesSection({ t, agents, picker, state, onState, editGateFor, onEditGateHandled, onReviewSkills, showGate = true }: {
  t: Messages;
  agents: AgentHostApi;
  picker?: FileSystemCapability;
  state: HostState;
  onState: (next: HostState) => void;
  /** ADR 0028: open this workspace's editor at its integration test gate (from a mission's Changes panel). */
  editGateFor?: string;
  onEditGateHandled?: () => void;
  /** Opens the Skills page on this workspace ("N project skills waiting — Review"). */
  onReviewSkills?: (workspaceId: string) => void;
  /** Settings exposes advanced merge checks; first-chat creation keeps them out of the initial form. */
  showGate?: boolean;
}) {
  const gateWorkspace = editGateFor ? state.workspaces.find(item => item.id === editGateFor) : undefined;
  const [draft, setDraft] = useState<WorkspaceDraft | null>(() => gateWorkspace ? draftFromWorkspace(gateWorkspace) : null);
  const [focusGateId] = useState(gateWorkspace?.id);
  // The request is used once; later visits to Settings open the list as usual.
  useEffect(() => { if (editGateFor) onEditGateHandled?.(); }, [editGateFor, onEditGateHandled]);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // v0.0.47: the workspace whose default team is being edited.
  const [teamFor, setTeamFor] = useState<string | null>(null);
  const teams = teamSupported(agents) && workspaceTeamSupported(agents);
  const teamWorkspace = teamFor ? state.workspaces.find(item => item.id === teamFor) : undefined;
  const leadNames = new Set(state.sessions.flatMap(session => (session.agentName ? [session.agentName] : [])));
  const { runtimes, ready: runtimesReady, refresh: refreshRuntimes } = useRuntimeStatus(agents);
  // Without a connection, a new workspace starts on Hermes Agent when it is installed.
  const newRuntime = !state.connections.length && availableHermes(runtimes) ? 'hermes' : 'extalia-native';

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await action(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }

  const save = () => run(async () => {
    if (!draft) return;
    setAttempted(true);
    if (!isValid(validateWorkspace(draft))) return;
    onState(await agents.saveWorkspace(toWorkspaceInput(draft)));
    setDraft(null);
  });

  const edit = (next: WorkspaceDraft) => { setAttempted(false); setError(null); setConfirming(null); setDraft(next); };

  return (
    <section className="card settings-section" aria-labelledby="settings-workspaces">
      <div className="section-head">
        <div>
          <h2 id="settings-workspaces">{t.settings.workspaces}</h2>
          <p className="muted small">{t.settings.workspacesLead}</p>
        </div>
        {!draft && <button type="button" className="button" onClick={() => edit(emptyWorkspaceDraft(state.connections[0]?.id, newRuntime))}><Icon name="plus" />{t.settings.addWorkspace}</button>}
      </div>

      {draft ? (
        <form className="editor" aria-label={draft.id ? t.settings.editing(draft.name) : t.settings.addWorkspace} onSubmit={event => { event.preventDefault(); void save(); }}>
          <WorkspaceForm t={t} agents={agents} picker={picker} draft={draft} onChange={setDraft} connections={state.connections} runtimes={runtimes}
            runtimesReady={runtimesReady} onRecheckRuntimes={refreshRuntimes} showAllErrors={attempted} showGate={showGate} focusGate={focusGateId !== undefined && draft.id === focusGateId} />
          {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
          <div className="actions">
            <button type="submit" className="primary" disabled={busy || !draft.folder}>{busy ? t.common.saving : t.common.save}</button>
            <button type="button" disabled={busy} onClick={() => setDraft(null)}>{t.common.cancel}</button>
          </div>
        </form>
      ) : state.workspaces.length === 0 ? <p className="muted">{t.settings.noWorkspaces}</p> : (
        <ul className="entity-list">
          {state.workspaces.map(workspace => {
            const connection = state.connections.find(item => item.id === workspace.providerProfileId);
            return (
              <li key={workspace.id} className="entity">
                <div className="entity-main">
                  <strong>{workspace.name}</strong>
                  <code className="entity-path">{workspace.projectLocation ?? '—'}</code>
                  <span className="muted small">
                    {workspace.runtimeId === 'hermes' ? t.workspace.usesHermes(workspace.runtimeProfileId ?? 'default')
                      : connection ? t.settings.usesConnection(connection.name) : t.settings.missingConnection}
                    {' · '}{permissionsLabel(t, workspace.runtimeId, workspace.permissions)}
                  </span>
                  {workspace.integrationGate && <span className="muted small workspace-gate-summary"><Icon name="shield" />{t.workspace.gate.heading}: <code>{workspace.integrationGate.command}</code></span>}
                  {teams && <span className="muted small workspace-team-summary" data-on={workspace.team?.enabled || undefined}>
                    <Icon name="users" />{workspace.team ? t.team.settingsTeam(workspace.team.members.length, workspace.team.enabled) : t.team.settingsNoTeam}
                  </span>}
                </div>
                {confirming === workspace.id ? (
                  <div className="confirm" role="alertdialog" aria-label={t.settings.deleteWorkspace}>
                    <p>{t.settings.deleteWorkspace}</p>
                    <div className="row-actions">
                      <button type="button" className="button small danger" autoFocus disabled={busy}
                        onClick={() => run(async () => { onState(await agents.deleteWorkspace(workspace.id)); setConfirming(null); })}>{t.common.delete}</button>
                      <button type="button" className="button small" onClick={() => setConfirming(null)}>{t.common.cancel}</button>
                    </div>
                  </div>
                ) : (
                  <div className="row-actions">
                    {teams && <button type="button" className="button small" aria-label={`${workspace.team ? t.team.settingsEdit : t.team.settingsSetUp}: ${workspace.name}`}
                      onClick={() => { setError(null); setTeamFor(workspace.id); }}><Icon name="users" />{workspace.team ? t.team.settingsEdit : t.team.settingsSetUp}</button>}
                    {teams && workspace.team && <button type="button" className="button small" aria-label={`${t.team.removeDefault}: ${workspace.name}`} title={t.team.removeDefault} disabled={busy}
                      onClick={() => run(async () => { onState(await agents.saveWorkspaceTeam(workspace.id, null)); })}><Icon name="close" /></button>}
                    <button type="button" className="button small" onClick={() => edit(draftFromWorkspace(workspace))}><Icon name="edit" />{t.common.edit}</button>
                    <button type="button" className="button small" aria-label={`${t.common.delete}: ${workspace.name}`} onClick={() => { setError(null); setConfirming(workspace.id); }}><Icon name="trash" /></button>
                  </div>
                )}
                {onReviewSkills && <ProjectSkillsPendingLink t={t} agents={agents} workspace={workspace} onReview={onReviewSkills} />}
              </li>
            );
          })}
        </ul>
      )}
      {!draft && error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
      {teamWorkspace && <TeamSetupDialog key={teamWorkspace.id} t={t} agents={agents} workspaceId={teamWorkspace.id} workspaceName={teamWorkspace.name} scope="workspace"
        pending={teamWorkspace.team} officeNames={leadNames} onState={onState} onSaved={() => undefined} onClose={() => setTeamFor(null)} />}
    </section>
  );
}
