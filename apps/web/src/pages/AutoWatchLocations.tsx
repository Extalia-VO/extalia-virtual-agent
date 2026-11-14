import type { AgentHostApi, FileSystemCapability, HostState, ImportLocation } from '@extalia/platform';
import { useEffect, useId, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { CopyButton } from '../ui/CopyButton';
import { HostFolderPicker } from '../ui/HostFolderPicker';
import { AgentAppLogo } from '../ui/OriginMark';
import { addIgnoredFolder, DEFAULT_IGNORED_FOLDERS, isDefaultIgnoredFolder, missesDefaults, readDefaultIgnoreFolders, readIgnoreFolders, removeIgnoredFolder } from './ignoredFolders';

type WatchProps = { t: Messages; agents: AgentHostApi; onState: (state: HostState) => void };
type IgnoreProps = WatchProps & { picker?: FileSystemCapability | undefined };

/** Per-location opt-in for "watch new sessions automatically". */
export function AutoWatchLocations(props: WatchProps) {
  const [source, setSource] = useState({ agents: props.agents, key: 0 });
  const changed = source.agents !== props.agents;
  const key = source.key + (changed ? 1 : 0);
  if (changed) setSource({ agents: props.agents, key });
  return <AutoWatchLocationsForm key={key} {...props} />;
}

function AutoWatchLocationsForm({ t, agents, onState }: WatchProps) {
  const owner = useRef({ active: true, busy: false });
  const [locations, setLocations] = useState<ImportLocation[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    agents.importLocations().then(list => { if (active) setLocations(list); }, failure => { if (active) { setLocations([]); setError(errorMessage(failure)); } });
    const scope = owner.current;
    scope.active = true;
    return () => { active = false; scope.active = false; };
  }, [agents]);

  const toggle = async (location: ImportLocation, enabled: boolean) => {
    if (!owner.current.active || owner.current.busy || !location.available || !location.supported || Boolean(location.autoWatch) === enabled) return;
    owner.current.busy = true; setBusy(location.id); setError(undefined);
    try {
      const next = await agents.setAutoWatch(location.id, enabled);
      if (!owner.current.active) return;
      setLocations(next);
      const state = await agents.getState();
      if (owner.current.active) onState(state);
    } catch (failure) { if (owner.current.active) setError(errorMessage(failure)); }
    finally { owner.current.busy = false; if (owner.current.active) setBusy(null); }
  };
  const usable = (locations ?? []).filter(location => location.available && location.supported);
  return <section className="card settings-section" aria-labelledby="observer-auto">
    <h2 id="observer-auto">{t.observer.autoTitle}</h2>
    <p className="muted small">{t.observer.autoLead}</p>
    {!locations ? <p className="muted" role="status">{t.common.loading}</p> : !usable.length ? <p className="muted small">{t.observer.autoNone}</p> : (
      <ul className="entity-list">
        {usable.map(location => (
          <li key={location.id} className="entity location">
            <label className="check-row">
              <input type="checkbox" checked={Boolean(location.autoWatch)} disabled={busy !== null} onChange={event => { void toggle(location, event.target.checked); }} />
              <span className="connect-app-mark connect-app-mark-small" data-app={location.sourceId} aria-hidden="true">
                <AgentAppLogo app={location.sourceId} size={16} />
              </span>
              <span className="entity-main">
                <strong>{location.label}{location.profile && location.profile !== 'default' ? ` · ${location.profile}` : ''}</strong>
                {location.path && <code className="entity-path">{location.path}</code>}
              </span>
            </label>
            {location.autoWatch && <span className="badge ok">{t.observer.autoBadge}</span>}
          </li>
        ))}
      </ul>
    )}
    {error && <p role="alert" className="form-error">{error}</p>}
  </section>;
}

/**
 * v0.0.37: folders whose sessions are never shown in the Office (default `~/.claude-mem`), wired to the host's
 * `setHookPrivacy({ ignoreFolders })`. Hidden on hosts that do not report an ignore list.
 */
export function IgnoredFolders(props: IgnoreProps) {
  const [source, setSource] = useState({ agents: props.agents, picker: props.picker, key: 0 });
  const changed = source.agents !== props.agents || source.picker !== props.picker;
  const key = source.key + (changed ? 1 : 0);
  if (changed) setSource({ agents: props.agents, picker: props.picker, key });
  return <IgnoredFoldersForm key={key} {...props} />;
}

function IgnoredFoldersForm({ t, agents, picker, onState }: IgnoreProps) {
  const owner = useRef({ active: true, busy: false });
  const o = t.observedOrigin;
  const [folders, setFolders] = useState<string[] | null | undefined>(null);
  const [defaults, setDefaults] = useState<readonly string[]>(DEFAULT_IGNORED_FOLDERS);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inputId = useId();
  const hintId = useId();

  useEffect(() => {
    let active = true;
    agents.hookIngest().then(status => { if (active) { setFolders(readIgnoreFolders(status)); setDefaults(readDefaultIgnoreFolders(status)); } },
      () => { if (active) setFolders(undefined); });
    const scope = owner.current;
    scope.active = true;
    return () => { active = false; scope.active = false; };
  }, [agents]);

  // `null` restores the host's default list.
  const save = async (next: string[] | null) => {
    if (!owner.current.active || owner.current.busy) return false;
    owner.current.busy = true; setBusy(true); setError(undefined);
    try {
      const status = await agents.setHookPrivacy({ ignoreFolders: next });
      if (!owner.current.active) return false;
      setFolders(readIgnoreFolders(status) ?? next ?? [...defaults]);
      const state = await agents.getState();
      if (!owner.current.active) return false;
      onState(state);
      return true;
    } catch (failure) { if (owner.current.active) setError(errorMessage(failure)); return false; }
    finally { owner.current.busy = false; if (owner.current.active) setBusy(false); }
  };
  if (folders === undefined) return null;
  const add = async (path: string) => {
    if (!owner.current.active || owner.current.busy || !folders) return;
    const next = addIgnoredFolder(folders, path);
    if (next.duplicate) { setError(o.ignoredDuplicate); return; }
    if (next.added) await save(next.list);
  };
  return <section className="card settings-section ignored-folders" aria-labelledby={`${inputId}-title`}>
    <h2 id={`${inputId}-title`}>{o.ignoredTitle}</h2>
    <p className="muted small" id={hintId}>{o.ignoredLead}</p>
    {!folders ? <p className="muted" role="status">{t.common.loading}</p> : <>
      {!folders.length ? <p className="muted small">{o.ignoredEmpty}</p> : <ul className="ignored-folder-list">
        {folders.map(folder => <li key={folder} className="ignored-folder">
          <code className="entity-path" title={folder}>{folder}</code>
          <CopyButton text={folder} label={folder} />
          {isDefaultIgnoredFolder(folder, defaults) && <span className="badge">{o.ignoredDefault}</span>}
          <button type="button" className="icon-button small" disabled={busy || picking} aria-label={o.ignoredRemove(folder)} title={o.ignoredRemove(folder)}
            onClick={() => { void save(removeIgnoredFolder(folders, folder)); }}><Icon name="close" /></button>
        </li>)}
      </ul>}
      <div className="ignored-folder-add" aria-describedby={hintId}>
        <HostFolderPicker t={t} agents={agents} picker={picker} disabled={busy} label={o.ignoredAdd} title={o.ignoredLabel}
          onSelect={add} onBusyChange={setPicking} />
        {missesDefaults(folders, defaults) && <button type="button" className="button" disabled={busy || picking} onClick={() => { void save(null); }}><Icon name="refresh" />{o.ignoredRestore}</button>}
      </div>
    </>}
    {error && <p role="alert" className="form-error">{error}</p>}
  </section>;
}
