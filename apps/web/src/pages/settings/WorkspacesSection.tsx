import type { AgentHostApi, FileSystemCapability, HostState } from '@extalia/platform';
import { workspaceCrossAccess, type OperatingProfile } from '@extalia/core';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../host/remote';
import type { Messages } from '../../i18n';
import { availableHermes, useRuntimeStatus } from '../../setup/useRuntimes';
import { draftFromWorkspace, emptyWorkspaceDraft, isValid, toWorkspaceInput, validateWorkspace, type WorkspaceDraft } from '../../setup/validation';
import { permissionsLabel } from '../../setup/permissions';
import { WorkspaceForm } from '../../setup/WorkspaceForm';
import { Icon } from '../../ui/Icon';
import { DeleteConfirmation } from '../../ui/DeleteConfirmation';
import { TeamSetupDialog } from '../../office/TeamSetupDialog';
import { teamSupported, workspaceTeamSupported } from '../../office/team';
import { ProjectSkillsPendingLink } from '../../skills/ProjectSkills';
import { WorkspaceProfilePicker } from '../../operatingProfiles/WorkspaceProfilePicker';
import { workspaceProfileInput } from '../../operatingProfiles/profileDraft';

type Props = {
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
  /** Profile CRUD may leave structurally shared workspace arrays unchanged. */
  profileCatalogRevision?: number;
};
export function WorkspacesSection(props: Props) {
  const [scope, setScope] = useState({ agents: props.agents, profile: props.state.profile.id, key: 0 });
  const changed = scope.agents !== props.agents || scope.profile !== props.state.profile.id;
  const key = scope.key + (changed ? 1 : 0);
  if (changed) setScope({ agents: props.agents, profile: props.state.profile.id, key });
  return <WorkspaceEditor key={key} {...props} />;
}
function WorkspaceEditor({ t, agents, picker, state, onState, editGateFor, onEditGateHandled, onReviewSkills, showGate = true, profileCatalogRevision = 0 }: Props) {
  const owner = useRef({ active: true, busy: false });
  useEffect(() => { const operation = owner.current; operation.active = true; return () => { operation.active = false; }; }, []);
  const gateWorkspace = editGateFor ? state.workspaces.find(item => item.id === editGateFor) : undefined;
  const [draft, setDraft] = useState<WorkspaceDraft | null>(() => gateWorkspace ? draftFromWorkspace(gateWorkspace) : null);
  const [focusGateId] = useState(gateWorkspace?.id);
  // The request is used once; later visits to Settings open the list as usual.
  useEffect(() => { if (editGateFor) onEditGateHandled?.(); }, [editGateFor, onEditGateHandled]);
  const [attempted, setAttempted] = useState(false);
  const [connectionEdited, setConnectionEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const validationPending = useRef(false);
  const [validating, setValidating] = useState(false);
  const [validationChanged] = useState(() => (pending: boolean) => {
    if (!owner.current.active) return;
    validationPending.current = pending; setValidating(pending);
  });
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // v0.0.47: the workspace whose default team is being edited.
  const [teamFor, setTeamFor] = useState<string | null>(null);
  const [profileCatalog, setProfileCatalog] = useState<{ agents: AgentHostApi; profiles: OperatingProfile[] }>();
  useEffect(() => {
    let live = true;
    if (state.workflow !== 'observe' && typeof agents.listOperatingProfiles === 'function') agents.listOperatingProfiles().then(
      profiles => { if (live) setProfileCatalog({ agents, profiles }); }, () => { if (live) setProfileCatalog(undefined); });
    return () => { live = false; };
  }, [agents, state.workspaces, state.workflow, profileCatalogRevision]);
  const teams = teamSupported(agents) && workspaceTeamSupported(agents);
  const teamWorkspace = teamFor ? state.workspaces.find(item => item.id === teamFor) : undefined;
  const deletingWorkspace = confirming ? state.workspaces.find(item => item.id === confirming) : undefined;
  const leadNames = new Set(state.sessions.flatMap(session => (session.agentName ? [session.agentName] : [])));
  const { runtimes, ready: runtimesReady, refresh: refreshRuntimes } = useRuntimeStatus(agents);
  // Without a connection, a new workspace starts on Hermes Agent when it is installed.
  const newRuntime = !state.connections.length && availableHermes(runtimes) ? 'hermes' : 'extalia-native';

  async function run(action: (active: () => boolean) => Promise<void>) {
    const operation = owner.current;
    if (!operation.active || operation.busy || validationPending.current) return;
    operation.busy = true; setBusy(true); setError(null);
    try { await action(() => operation.active); }
    catch (failure) { if (operation.active) setError(errorMessage(failure)); }
    finally { operation.busy = false; if (operation.active) setBusy(false); }
  }

  const save = () => run(async active => {
    if (!draft) return;
    setAttempted(true);
    if (!isValid(validateWorkspace(draft))) return;
    const next = await agents.saveWorkspace(workspaceProfileInput(toWorkspaceInput(draft), state.workspaces.find(item => item.id === draft.id), connectionEdited));
    if (!active()) return;
    onState(next); setDraft(null);
  });

  const edit = (next: WorkspaceDraft) => { if (owner.current.busy || !owner.current.active) return; setAttempted(false); setConnectionEdited(false); setError(null); setConfirming(null); setDraft(next); };
  const changeDraft = (next: WorkspaceDraft) => { if (owner.current.busy || !owner.current.active) return; if (next.connectionId !== draft?.connectionId) setConnectionEdited(true); setDraft(next); };

  return (
    <section className="card settings-section" aria-labelledby="settings-workspaces">
      <div className="section-head">
        <div>
          <h2 id="settings-workspaces">{t.settings.workspaces}</h2>
          <p className="muted small">{t.settings.workspacesLead}</p>
        </div>
        {!draft && <button type="button" className="button" disabled={busy} onClick={() => edit({ ...emptyWorkspaceDraft(state.workflow === 'observe' ? '' : state.connections[0]?.id, newRuntime), ...(state.workflow === 'observe' ? { mode: 'observe', runtimeId: 'extalia-native' } : {}) })}><Icon name="plus" />{t.settings.addWorkspace}</button>}
      </div>

      {draft ? (
        <form className="editor" aria-label={draft.id ? t.settings.editing(draft.name) : t.settings.addWorkspace} onSubmit={event => { event.preventDefault(); void save(); }}>
          <fieldset disabled={busy} className="workspace-editor-fields"><WorkspaceForm t={t} agents={agents} picker={picker} draft={draft} onChange={changeDraft} onValidationBusyChange={validationChanged} connections={state.connections} runtimes={runtimes}
            runtimesReady={runtimesReady} onRecheckRuntimes={refreshRuntimes} showAllErrors={attempted} showGate={showGate} focusGate={focusGateId !== undefined && draft.id === focusGateId} /></fieldset>
          {!connectionEdited && state.workspaces.some(item => item.id === draft.id && item.operatingProfileId && item.providerProfileId !== draft.connectionId) && <p role="status" className="muted small">{t.operatingProfiles.latestDefaults}</p>}
          {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
          <div className="actions">
            <button type="submit" className="primary" disabled={busy || validating || !draft.folder}>{busy ? t.common.saving : t.common.save}</button>
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
                  {workspace.runtimeId !== 'hermes' && workspace.additionalProjectLocations?.map(path => <code className="entity-path" key={path}>{path}</code>)}
                  <span className="muted small">
                    {workspace.mode === 'observe' ? t.workspace.observe
                      : workspace.runtimeId === 'hermes' ? t.workspace.usesHermes(workspace.runtimeProfileId ?? 'default')
                      : connection ? t.settings.usesConnection(connection.name) : t.settings.missingConnection}
                    {workspace.mode === 'observe' && <> · {connection ? `${t.workspace.curator}: ${connection.name}` : t.workspace.noCurator}</>}
                    {workspace.mode !== 'observe' && <> · {permissionsLabel(t, workspace.runtimeId, workspace.permissions)}
                      {workspace.runtimeId !== 'hermes' && <> · {t.workspace.crossAccess.heading}: {t.workspace.crossAccess.modes[workspaceCrossAccess(workspace)]}</>}</>}
                  </span>
                  {workspace.mode !== 'observe' && workspace.integrationGate && <span className="muted small workspace-gate-summary"><Icon name="shield" />{t.workspace.gate.heading}: <code>{workspace.integrationGate.command}</code></span>}
                  {teams && workspace.mode !== 'observe' && state.workflow !== 'observe' && <span className="muted small workspace-team-summary" data-on={workspace.team?.enabled || undefined}>
                    <Icon name="users" />{workspace.team ? t.team.settingsTeam(workspace.team.members.length, workspace.team.enabled) : t.team.settingsNoTeam}
                  </span>}
                  {state.workflow !== 'observe' && profileCatalog?.agents === agents && <WorkspaceProfilePicker key={workspace.id} t={t} agents={agents} workspace={workspace} profiles={profileCatalog.profiles} onState={onState} />}
                </div>
                <div className="row-actions">
                  {teams && workspace.mode !== 'observe' && state.workflow !== 'observe' && <button type="button" className="button small" aria-label={`${workspace.team ? t.team.settingsEdit : t.team.settingsSetUp}: ${workspace.name}`}
                    disabled={busy} onClick={() => { setError(null); setTeamFor(workspace.id); }}><Icon name="users" />{workspace.team ? t.team.settingsEdit : t.team.settingsSetUp}</button>}
                  {teams && workspace.mode !== 'observe' && state.workflow !== 'observe' && workspace.team && <button type="button" className="button small" aria-label={`${t.team.removeDefault}: ${workspace.name}`} title={t.team.removeDefault} disabled={busy}
                    onClick={() => run(async active => { const next = await agents.saveWorkspaceTeam(workspace.id, null); if (active()) onState(next); })}><Icon name="close" /></button>}
                  <button type="button" className="button small" disabled={busy} onClick={() => edit(draftFromWorkspace(workspace))}><Icon name="edit" />{t.common.edit}</button>
                  <button type="button" className="button small" aria-label={`${t.common.delete}: ${workspace.name}`} disabled={busy} onClick={() => { setError(null); setConfirming(workspace.id); }}><Icon name="trash" /></button>
                </div>
                {onReviewSkills && workspace.mode !== 'observe' && state.workflow !== 'observe' && <ProjectSkillsPendingLink t={t} agents={agents} workspace={workspace} onReview={onReviewSkills} />}
              </li>
            );
          })}
        </ul>
      )}
      {deletingWorkspace && <DeleteConfirmation t={t} title={t.deletion.workspaceTitle} target={deletingWorkspace.name}
        description={t.settings.deleteWorkspace} busy={busy} error={error}
        onConfirm={() => { void run(async active => { const next = await agents.deleteWorkspace(deletingWorkspace.id); if (active()) { onState(next); setConfirming(null); } }); }}
        onCancel={() => { if (!owner.current.busy) { setConfirming(null); setError(null); } }} />}
      {!draft && !deletingWorkspace && error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
      {teamWorkspace && <TeamSetupDialog key={teamWorkspace.id} t={t} agents={agents} workspaceId={teamWorkspace.id} workspaceName={teamWorkspace.name} scope="workspace"
        pending={teamWorkspace.team} officeNames={leadNames} onState={onState} onSaved={() => undefined} onClose={() => setTeamFor(null)} />}
    </section>
  );
}
