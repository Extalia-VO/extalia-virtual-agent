import type { AgentHostApi, ContinueSource, HostState } from '@extalia/platform';
import { useId, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';

const samePath = (a?: string, b?: string) => Boolean(a && b) && a!.replace(/[\\/]+$/, '') === b!.replace(/[\\/]+$/, '');

/**
 * Carry a conversation from another agent (or the library) into a new managed
 * session, for example when Codex or Claude Code ran out of quota.
 */
export function ContinueInExtalia({ t, agents, state, source, projectPath, onContinued, onOpenSettings }: {
  t: Messages;
  agents: AgentHostApi;
  state: HostState;
  source: ContinueSource;
  /** The conversation's project folder, used to suggest a workspace. */
  projectPath?: string;
  onContinued: (sessionId: string, workspaceId: string) => void;
  onOpenSettings: () => void;
}) {
  const id = useId();
  // Hermes Agent workspaces need no connection; the conversation reaches Hermes with the first prompt.
  const usable = state.workspaces.filter(workspace => workspace.runtimeId === 'hermes'
    || (workspace.providerProfileId && state.connections.some(connection => connection.id === workspace.providerProfileId)));
  const suggested = usable.find(workspace => samePath(workspace.projectLocation, projectPath)) ?? usable[0];
  const [open, setOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const chosen = usable.find(workspace => workspace.id === workspaceId) ?? suggested;

  const start = async () => {
    if (!chosen) return;
    setBusy(true); setError(undefined);
    try {
      const session = await agents.continueSession(source, chosen.id);
      onContinued(session.id, chosen.id);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };

  return (
    <div className="continue-panel">
      <button type="button" className="button" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen(!open)}>
        <Icon name="chat" />{t.handoff.continue}
      </button>
      {open && (
        <div className="card continue-body" id={`${id}-panel`}>
          <p className="muted small">{t.handoff.lead}</p>
          {!chosen ? (
            <>
              <p>{t.handoff.needsSetup}</p>
              <div className="actions"><button type="button" onClick={onOpenSettings}><Icon name="settings" />{t.handoff.openSettings}</button></div>
            </>
          ) : (
            <>
              <div className="field">
                <label htmlFor={`${id}-workspace`}>{t.handoff.workspace}</label>
                <select id={`${id}-workspace`} value={chosen.id} onChange={event => setWorkspaceId(event.target.value)}>
                  {usable.map(workspace => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}{samePath(workspace.projectLocation, projectPath) ? ` (${t.handoff.matches})` : ''}
                    </option>
                  ))}
                </select>
              </div>
              {error && <p role="alert" className="form-error"><Icon name="alert" />{error}</p>}
              <div className="actions">
                <button type="button" className="primary" disabled={busy} onClick={() => { void start(); }}>
                  <Icon name="start" />{busy ? t.handoff.starting : t.handoff.start}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
