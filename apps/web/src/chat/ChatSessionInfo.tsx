import { sourceLabel, type Workspace } from '@extalia/core';
import type { HostState, SessionSummary } from '@extalia/platform';
import type { Messages } from '../i18n';
import { sessionRuntime } from './sessionRuntime';
import type { ChangedFile } from './changedFiles';

/** Presentation of known session facts; no extra host requests or inferred activity. */
export function ChatSessionInfo({ t, state, workspace, session, status, files }: {
  t: Messages; state: HostState; workspace: Workspace; session?: SessionSummary;
  status: string; files: readonly ChangedFile[];
}) {
  const m = t.chat.sessionInfo;
  const observed = session?.control === 'observed';
  const runtime = sessionRuntime(workspace, session);
  const connection = !observed && runtime === 'extalia-native'
    ? state.connections.find(item => item.id === (session ? session.connectionId : workspace.providerProfileId)) : undefined;
  const model = observed ? session.model : session?.options?.model ?? connection?.model;
  const effort = observed ? session.effort : session?.options?.effort ?? connection?.effort;
  return <section className="chat-session-facts" aria-labelledby="chat-session-info-title">
    <h2 id="chat-session-info-title">{m.title}</h2>
    <dl>
      <div><dt>{m.status}</dt><dd>{status}</dd></div>
      <div><dt>{m.runtime}</dt><dd>{observed ? (session.observation?.sourceId ? sourceLabel(session.observation.sourceId) : t.characterPopover.roles.observed) : runtime === 'hermes' ? 'Hermes Agent' : 'Extalia Native'}</dd></div>
      {model && <div><dt>{m.model}</dt><dd>{model}</dd></div>}
      {effort && <div><dt>{m.effort}</dt><dd>{effort}</dd></div>}
      <div><dt>{t.chat.workspace}</dt><dd>{workspace.name}</dd></div>
      <div className="chat-session-folder"><dt>{m.folder}</dt><dd>{session?.observation?.projectPath ?? session?.projectLocation ?? workspace.projectLocation}</dd></div>
    </dl>
    <div className="chat-session-recent-files">
      <h3>{m.recentFiles}{files.length > 0 && <span className="badge">{files.length}</span>}</h3>
      {files.length ? <ul>{files.slice(0, 5).map(file => <li key={file.path}><span title={file.path}>{file.path}</span><small>{t.tool.change[file.change]}</small></li>)}</ul>
        : <p className="muted">{t.characterConsole.noFiles}</p>}
    </div>
  </section>;
}
