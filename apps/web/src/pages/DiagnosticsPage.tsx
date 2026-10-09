import { describeCapabilities, type HostState, type Platform, type UpdateStatus } from '@extalia/platform';
import { PROTOCOL_VERSION } from '@extalia/protocol';
import { useState } from 'react';
import type { Messages } from '../i18n';
import { supportsWebGL2 } from '../platform';
import { Icon } from '../ui/Icon';

const OS_LABEL = { macos: 'macOS', windows: 'Windows', linux: 'Linux', other: '—' } as const;

export function DiagnosticsPage({ t, platform, hostState, updateStatus, onOpenWorkspaces }: {
  t: Messages; platform: Platform; hostState: HostState | null; updateStatus?: UpdateStatus | null; onOpenWorkspaces?: () => void;
}) {
  const [folder, setFolder] = useState<string>('');
  const [picking, setPicking] = useState(false);
  const [webgl] = useState(supportsWebGL2);
  const filesystem = platform.capabilities.filesystem;
  const { info } = platform;

  async function pickFolder() {
    if (!filesystem || picking) return;
    setPicking(true);
    try {
      const selection = await filesystem.selectDirectory();
      if (!selection) setFolder(t.diagnostics.cancelled);
      else setFolder(`${t.diagnostics.picked(selection.name)} ${selection.path ?? t.diagnostics.pathHidden}`);
    } catch (error) {
      setFolder(error instanceof Error ? error.message : String(error));
    } finally { setPicking(false); }
  }

  const rows: [string, string][] = [
    [t.diagnostics.app, info.appVersion],
    [t.diagnostics.protocol, PROTOCOL_VERSION],
    [t.diagnostics.host, t.hosts[info.kind]],
    [t.diagnostics.os, `${info.os ? OS_LABEL[info.os] : t.diagnostics.unknown}${info.arch ? ` · ${info.arch}` : ''}`],
    ...(info.shellVersion ? [[t.diagnostics.shell, info.shellVersion] as [string, string]] : []),
    [t.diagnostics.renderer, webgl ? t.diagnostics.supported : t.diagnostics.unsupported],
    ...(hostState ? [
      [t.diagnostics.agentHost, `${t.hosts[hostState.host.kind]} · ${hostState.host.version}`],
      [t.diagnostics.dataDirectory, hostState.storage.dataDirectory],
      [t.diagnostics.secretStore, t.diagnostics.secretStores[hostState.storage.secretStore]],
      [t.diagnostics.projects, String(hostState.workspaces.length)],
      [t.diagnostics.sessions, String(hostState.sessions.length)],
    ] as [string, string][] : []),
  ];

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t.diagnostics.title}</h1>
        <p className="lead">{t.diagnostics.lead}</p>
      </header>
      <div className="grid two">
        <section className="card">
          <dl className="facts">
            {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
        </section>
        <section className="card">
          <h2>{t.diagnostics.capabilities}</h2>
          <ul className="capabilities">
            {describeCapabilities(platform).map(row => {
              const { id } = row;
              const status = id === 'updater' && updateStatus?.state === 'unsupported' ? 'unavailable' : row.status;
              return (
              <li key={id}>
                <span>{t.diagnostics.capability[id]}</span>
                <span className={`status ${status === 'available' || status === 'via-agent-host' ? 'ok' : status === 'requires-bridge' ? 'warn' : 'off'}`}>{t.diagnostics.status[status]}</span>
              </li>
            ); })}
          </ul>
          {platform.capabilities.agents && <p className="muted small">{t.diagnostics.hostToolsHint}</p>}
          {updateStatus?.state === 'unsupported' && updateStatus.detail && <p className="muted small">{updateStatus.detail}</p>}
        </section>
        <section className="card">
          <h2>{t.diagnostics.folderTitle}</h2>
          <p className="muted">{t.diagnostics.folderLead}</p>
          <p className="muted small">{t.diagnostics.workspacesHint}</p>
          <div className="actions">
            <button type="button" className="primary" disabled={!filesystem || picking} onClick={pickFolder}><Icon name="folder" />{t.diagnostics.pick}</button>
            {platform.capabilities.agents && onOpenWorkspaces && <button type="button" onClick={onOpenWorkspaces}>{t.diagnostics.manageWorkspaces}</button>}
            {folder && <span role="status">{folder}</span>}
          </div>
        </section>
      </div>
    </div>
  );
}
