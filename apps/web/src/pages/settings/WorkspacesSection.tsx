import type { AgentHostApi, FileSystemCapability, HostState } from '@extalia/platform';
import { useState } from 'react';
import { errorMessage } from '../../host/remote';
import type { Messages } from '../../i18n';
import { draftFromWorkspace, emptyWorkspaceDraft, isValid, toWorkspaceInput, validateWorkspace, type WorkspaceDraft } from '../../setup/validation';
import { WorkspaceForm } from '../../setup/WorkspaceForm';
import { Icon } from '../../ui/Icon';

export function WorkspacesSection({ t, agents, picker, state, onState }: {
  t: Messages;
  agents: AgentHostApi;
  picker?: FileSystemCapability;
  state: HostState;
  onState: (next: HostState) => void;
}) {
  const [draft, setDraft] = useState<WorkspaceDraft | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

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
  const mode = (value: 'ask' | 'allow' | undefined) => t.workspace.modes[value ?? 'ask'];

  return (
    <section className="card settings-section" aria-labelledby="settings-workspaces">
      <div className="section-head">
        <div>
          <h2 id="settings-workspaces">{t.settings.workspaces}</h2>
          <p className="muted small">{t.settings.workspacesLead}</p>
        </div>
        {!draft && <button type="button" className="button" onClick={() => edit(emptyWorkspaceDraft(state.connections[0]?.id))}><Icon name="plus" />{t.settings.addWorkspace}</button>}
      </div>

      {draft ? (
        <form className="editor" aria-label={draft.id ? t.settings.editing(draft.name) : t.settings.addWorkspace} onSubmit={event => { event.preventDefault(); void save(); }}>
          <WorkspaceForm t={t} agents={agents} picker={picker} draft={draft} onChange={setDraft} connections={state.connections} showAllErrors={attempted} />
          {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>{busy ? t.common.saving : t.common.save}</button>
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
                    {connection ? t.settings.usesConnection(connection.name) : t.settings.missingConnection}
                    {' · '}{t.setup.permissionSummary(mode(workspace.permissions?.fileWrite), mode(workspace.permissions?.commands))}
                  </span>
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
                    <button type="button" className="button small" onClick={() => edit(draftFromWorkspace(workspace))}><Icon name="edit" />{t.common.edit}</button>
                    <button type="button" className="button small" aria-label={`${t.common.delete}: ${workspace.name}`} onClick={() => { setError(null); setConfirming(workspace.id); }}><Icon name="trash" /></button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!draft && error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
    </section>
  );
}
