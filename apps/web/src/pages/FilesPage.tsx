import type { AgentHostApi, FileContent, FileEntry, HostState } from '@extalia/platform';
import { Fragment, useState } from 'react';
import type { Messages } from '../i18n';
import { breadcrumbs, formatSize, initialWorkspace, lineNumbers, parentPath } from '../inspect/format';
import { useLoad, type Loaded } from '../inspect/useLoad';
import { WorkspaceBar } from '../inspect/WorkspaceBar';
import { Icon, type IconName } from '../ui/Icon';

const isFolder = (entry: FileEntry) => entry.kind === 'dir' || entry.target === 'dir';
const canOpen = (entry: FileEntry) => entry.credential || entry.kind !== 'symlink' || Boolean(entry.target);
const iconFor = (entry: FileEntry): IconName => (entry.credential ? 'key' : isFolder(entry) ? 'files' : entry.kind === 'symlink' && !entry.target ? 'external' : 'file');

function Viewer({ t, language, entry, content, onClose }: { t: Messages; language: string; entry: FileEntry; content: Loaded<FileContent>; onClose: () => void }) {
  const file = content.value;
  return (
    <article className="card history-viewer inspect-viewer" aria-labelledby="file-title">
      <button type="button" className="button small back-to-list" onClick={onClose}><Icon name="chevron" className="flip" />{t.inspect.backToList}</button>
      <header className="viewer-head">
        <h2 id="file-title" className="viewer-title"><code>{entry.path}</code></h2>
        {file && !entry.credential && (
          <span className="muted small">{formatSize(file.size, language)}{!file.binary && <> · {t.files.lines(file.lines)}</>}</span>
        )}
      </header>
      {entry.credential ? <p className="note"><Icon name="key" />{t.files.credential}</p>
        : content.error ? <p className="form-error" role="alert"><Icon name="alert" />{content.error}</p>
          : !file ? <p className="muted" role="status">{t.common.loading}</p>
            : file.binary ? <p className="note">{t.files.binary}</p>
              : !file.content ? <p className="muted">{t.files.emptyFile}</p>
                : (
                  <>
                    {file.truncated && <p className="note">{t.files.truncated}</p>}
                    <div className="code-view" tabIndex={0} role="region" aria-label={entry.path}>
                      <pre className="code-gutter" aria-hidden="true">{lineNumbers(file.lines)}</pre>
                      <pre className="code-text">{file.content}</pre>
                    </div>
                  </>
                )}
    </article>
  );
}

/** Read-only browser for a workspace's project folder. */
export function FilesPage({ t, language, agents, state, workspaceId }: {
  t: Messages;
  language: string;
  agents: AgentHostApi;
  state: HostState;
  /** The workspace selected in Chat, if any. */
  workspaceId?: string;
}) {
  const [workspace, setWorkspace] = useState(() => initialWorkspace(state, workspaceId));
  const [dir, setDir] = useState('.');
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [version, setVersion] = useState(0);
  const listing = useLoad(workspace ? `${workspace}\n${dir}` : null, version, () => agents.listFiles(workspace!, dir));
  const readable = selected && !selected.credential ? selected.path : null;
  const content = useLoad(workspace && readable ? `${workspace}\n${readable}` : null, version, () => agents.readFile(workspace!, readable!));
  const name = state.workspaces.find(item => item.id === workspace)?.name ?? '';

  const header = (
    <header className="page-header">
      <h1>{t.files.title}</h1>
      <p className="lead">{t.files.lead}</p>
    </header>
  );
  if (!workspace) return <div className="page">{header}<section className="card"><p className="muted">{t.inspect.noWorkspace}</p></section></div>;

  const open = (entry: FileEntry) => {
    if (isFolder(entry) && !entry.credential) setDir(entry.path);
    else setSelected(entry);
  };
  const entries = listing.value?.entries ?? [];

  return (
    <div className="page">
      {header}
      <WorkspaceBar t={t} state={state} workspaceId={workspace} loading={listing.loading || content.loading}
        onWorkspace={id => { setWorkspace(id); setDir('.'); setSelected(null); }} onRefresh={() => setVersion(value => value + 1)} />
      <div className={`history inspect ${selected ? 'has-selection' : ''}`}>
        <section className="card history-list inspect-list" aria-label={t.files.title}>
          <nav className="crumbs" aria-label={t.files.path}>
            <button type="button" className="crumb" aria-current={dir === '.' ? 'location' : undefined} onClick={() => setDir('.')}><Icon name="files" />{name}</button>
            {breadcrumbs(dir).map(crumb => (
              <Fragment key={crumb.path}>
                <span className="crumb-separator" aria-hidden="true">/</span>
                <button type="button" className="crumb" aria-current={crumb.path === dir ? 'location' : undefined} onClick={() => setDir(crumb.path)}>{crumb.name}</button>
              </Fragment>
            ))}
          </nav>
          {listing.error ? (
            <div className="empty-state">
              <p className="form-error" role="alert"><Icon name="alert" />{listing.error}</p>
              {dir !== '.' && <button type="button" className="button small" onClick={() => setDir('.')}>{t.files.openRoot}</button>}
            </div>
          ) : !listing.value ? <p className="muted" role="status">{t.common.loading}</p> : (
            <ul className="tree-list">
              {dir !== '.' && (
                <li>
                  <button type="button" className="tree-item" onClick={() => setDir(parentPath(dir))} aria-label={t.files.up}>
                    <Icon name="chevron" className="flip" /><span className="tree-name">..</span>
                  </button>
                </li>
              )}
              {entries.length === 0 && <li className="muted small tree-empty">{t.files.empty}</li>}
              {entries.map(entry => (
                <li key={entry.path}>
                  <button type="button" className={`tree-item ${entry.generated ? 'dim' : ''}`} aria-current={selected?.path === entry.path ? 'true' : undefined}
                    disabled={!canOpen(entry)} title={canOpen(entry) ? entry.path : t.files.linkOutside} onClick={() => open(entry)}>
                    <Icon name={iconFor(entry)} />
                    <span className="tree-name">{entry.name}</span>
                    {entry.credential && <span className="badge warn">{t.files.credentialBadge}</span>}
                    {entry.generated && <span className="badge">{t.files.generated}</span>}
                    {entry.kind === 'symlink' && <span className="badge">{t.files.link}</span>}
                    {entry.size !== undefined && <span className="tree-meta">{formatSize(entry.size, language)}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {listing.value?.truncated && <p className="muted small">{t.files.listTruncated(entries.length)}</p>}
        </section>
        {selected
          ? <Viewer t={t} language={language} entry={selected} content={content} onClose={() => setSelected(null)} />
          : <section className="card history-viewer placeholder"><p className="muted">{t.files.select}</p></section>}
      </div>
    </div>
  );
}
