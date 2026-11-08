import type { Workspace } from '@extalia/core';
import type { HostState, SessionSummary } from '@extalia/platform';
import type { Messages } from '../i18n';
import { sessionRuntime, workspaceTargetChanged } from './sessionRuntime';

export function WorkspaceRuntimeNotice({ t, state, workspace, session, onNewSession }: {
  t: Messages; state: Pick<HostState, 'connections'>; workspace: Workspace; session?: SessionSummary; onNewSession?(): void;
}) {
  if (!workspaceTargetChanged(workspace, session)) return null;
  const label = (selected?: SessionSummary) => {
    const runtime = sessionRuntime(workspace, selected);
    const detail = runtime === 'hermes' ? selected?.runtime?.profile ?? workspace.runtimeProfileId ?? 'default'
      : state.connections.find(item => item.id === (selected ? selected.connectionId : workspace.providerProfileId))?.name;
    return `${t.workspace.runtimes[runtime]}${detail ? ` · ${detail}` : ''}`;
  };
  return <aside className="note workspace-runtime-notice" aria-label={t.chat.workspaceDefaultChanged}>
    <p>{t.chat.sessionKeepsRuntime(label(session), label())}</p>
    {onNewSession && <button type="button" className="button small" onClick={onNewSession}>{t.chat.startWithWorkspaceDefault}</button>}
  </aside>;
}
