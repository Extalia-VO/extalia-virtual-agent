import type { AgentHostApi, FileEntry, HostState } from '@extalia/platform';
import { Fragment, useState } from 'react';
import type { Messages } from '../i18n';
import { breadcrumbs, formatSize, initialWorkspace, parentPath } from '../inspect/format';
import { useLoad } from '../inspect/useLoad';
import { WorkspaceBar } from '../inspect/WorkspaceBar';
import { Icon, type IconName } from '../ui/Icon';
import { canNavigateFolder, isFileFolder, selectedFileEntry } from './fileBrowser';
import './files.css';

const iconFor = (entry: FileEntry): IconName => entry.credential ? 'key' : isFileFolder(entry) ? 'files' : entry.kind === 'symlink' ? 'external' : 'file';
const typeFor = (entry: FileEntry, t: Messages) => entry.kind === 'symlink' ? t.files.symbolicLink : isFileFolder(entry) ? t.files.folder : t.files.file;

function EntryBadges({ entry, t }: { entry: FileEntry; t: Messages }) {
  return <span className="files-badges">
    {entry.credential && <span className="badge warn">{t.files.credentialBadge}</span>}
    {entry.generated && <span className="badge">{t.files.generated}</span>}
    {entry.kind === 'symlink' && <span className="badge">{t.files.link}</span>}
  </span>;
}

export function FileDetails({ t, language, entry, onClose, onOpen }: {
  t: Messages; language: string; entry: FileEntry; onClose: () => void; onOpen: () => void;
}) {
  return (
    <aside className="files-details" aria-labelledby="files-details-title">
      <header className="files-details-head">
        <h2 id="files-details-title">{t.files.details}</h2>
        <button type="button" className="button small icon-only" aria-label={t.files.closeDetails} onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className={`files-details-symbol ${isFileFolder(entry) ? 'is-folder' : ''}`}><Icon name={iconFor(entry)} /></div>
      <h3 className="files-details-name">{entry.name}</h3>
      <EntryBadges t={t} entry={entry} />
      <dl className="files-properties">
        <div><dt>{t.files.name}</dt><dd>{entry.name}</dd></div>
        <div><dt>{t.files.type}</dt><dd>{typeFor(entry, t)}</dd></div>
        <div><dt>{t.files.size}</dt><dd>{entry.size !== undefined ? formatSize(entry.size, language) : t.files.unavailable}</dd></div>
        <div><dt>{t.files.location}</dt><dd><code>{entry.path}</code></dd></div>
      </dl>
      {entry.credential && <p className="files-detail-note"><Icon name="key" />{t.files.credential}</p>}
      {entry.kind === 'symlink' && !entry.target && <p className="files-detail-note"><Icon name="external" />{t.files.linkOutside}</p>}
      {entry.generated && <p className="files-detail-note">{t.files.generatedInfo}</p>}
      {canNavigateFolder(entry)
        ? <button type="button" className="button files-open-folder" onClick={onOpen}><Icon name="files" />{t.files.openFolder}<Icon name="chevron" /></button>
        : <p className="files-detail-note files-metadata-note">{t.files.metadataOnly}</p>}
    </aside>
  );
}

export function FileBrowserEntry({ entry, t, language, selected, onSelect, onOpen }: {
  entry: FileEntry; t: Messages; language: string; selected: boolean; onSelect: () => void; onOpen: () => void;
}) {
  const openFolder = () => { if (canNavigateFolder(entry)) onOpen(); };
  return <button type="button" className={`files-entry ${isFileFolder(entry) ? 'is-folder' : ''}`} aria-pressed={selected}
    title={entry.path} onClick={onSelect} onDoubleClick={openFolder}
    onKeyDown={event => { if (event.key === 'Enter' && canNavigateFolder(entry)) { event.preventDefault(); openFolder(); } }}>
    <span className="files-entry-identity"><span className="files-entry-symbol"><Icon name={iconFor(entry)} /></span><span className="files-entry-name">{entry.name}</span><EntryBadges t={t} entry={entry} /></span>
    <span className="files-entry-type">{typeFor(entry, t)}</span>
    <span className="files-entry-size">{entry.size !== undefined ? formatSize(entry.size, language) : '—'}</span>
  </button>;
}

/** Metadata-only browser. Selection never requests file contents. */
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
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [version, setVersion] = useState(0);
  const listing = useLoad(workspace ? `${workspace}\n${dir}` : null, version, () => agents.listFiles(workspace!, dir), agents);
  const entries = listing.value?.entries ?? [];
  const selected = selectedFileEntry(entries, selectedPath);
  const [previousListing, setPreviousListing] = useState(listing.value);
  // A removed item must stay deselected even if its path reappears on a later refresh.
  if (previousListing !== listing.value) {
    setPreviousListing(listing.value);
    if (selectedPath !== null && !selected) setSelectedPath(null);
  }
  const name = state.workspaces.find(item => item.id === workspace)?.name ?? '';

  const navigate = (path: string) => { setDir(path); setSelectedPath(null); };
  const openFolder = (entry: FileEntry) => { if (canNavigateFolder(entry)) navigate(entry.path); };
  const header = <header className="page-header"><h1>{t.files.title}</h1><p className="lead">{t.files.lead}</p></header>;
  if (!workspace) return <div className="page files-page">{header}<section className="card"><p className="muted">{t.inspect.noWorkspace}</p></section></div>;

  return (
    <div className="page files-page">
      {header}
      <WorkspaceBar t={t} state={state} workspaceId={workspace} loading={listing.loading}
        onWorkspace={id => { setWorkspace(id); navigate('.'); }} onRefresh={() => setVersion(value => value + 1)} />
      <div className={`files-browser ${selected ? 'has-selection' : ''}`}>
        <section className="files-main" aria-label={t.files.title} aria-busy={listing.loading}>
          <div className="files-toolbar">
            <button type="button" className="button small icon-only" disabled={dir === '.'} onClick={() => navigate(parentPath(dir))} aria-label={t.files.up}><Icon name="chevron" className="files-up-icon" /></button>
            <nav className="crumbs files-crumbs" aria-label={t.files.path}>
              <button type="button" className="crumb" aria-current={dir === '.' ? 'location' : undefined} onClick={() => navigate('.')}><Icon name="files" />{name}</button>
              {breadcrumbs(dir).map(crumb => <Fragment key={crumb.path}>
                <Icon name="chevron" className="files-crumb-separator" />
                <button type="button" className="crumb" aria-current={crumb.path === dir ? 'location' : undefined} onClick={() => navigate(crumb.path)}>{crumb.name}</button>
              </Fragment>)}
            </nav>
            <div className="files-view-switch">
              <button type="button" aria-label={t.files.listView} title={t.files.listView} aria-pressed={view === 'list'} onClick={() => setView('list')}><Icon name="menu" /></button>
              <button type="button" aria-label={t.files.gridView} title={t.files.gridView} aria-pressed={view === 'grid'} onClick={() => setView('grid')}><span className="files-grid-icon" aria-hidden="true"><i /><i /><i /><i /></span></button>
            </div>
          </div>
          <div className="files-list-summary"><span>{t.files.items(entries.length)}</span><span>{t.files.folderHint}</span></div>
          {listing.error ? <div className="empty-state">
            <p className="form-error" role="alert"><Icon name="alert" />{listing.error}</p>
            {dir !== '.' && <button type="button" className="button small" onClick={() => navigate('.')}>{t.files.openRoot}</button>}
          </div> : !listing.value ? <p className="files-loading muted" role="status">{t.common.loading}</p> : <>
            {entries.length === 0 ? <div className="empty-state files-empty"><Icon name="files" /><p>{t.files.empty}</p></div> : <>
              {view === 'list' && <div className="files-columns" aria-hidden="true"><span>{t.files.name}</span><span>{t.files.type}</span><span>{t.files.size}</span></div>}
              <ul className={`files-entries files-${view}`}>
                {entries.map(entry => <li key={entry.path}><FileBrowserEntry entry={entry} t={t} language={language} selected={selected?.path === entry.path}
                  onSelect={() => setSelectedPath(entry.path)} onOpen={() => openFolder(entry)} /></li>)}
              </ul>
            </>}
            {listing.value.truncated && <p className="files-truncated muted small">{t.files.listTruncated(entries.length)}</p>}
          </>}
        </section>
        {selected && <FileDetails t={t} language={language} entry={selected} onClose={() => setSelectedPath(null)} onOpen={() => openFolder(selected)} />}
      </div>
      {!selected && <p className="files-selection-hint muted small">{t.files.select}</p>}
    </div>
  );
}
