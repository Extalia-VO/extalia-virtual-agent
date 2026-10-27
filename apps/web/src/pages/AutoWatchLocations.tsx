import type { AgentHostApi, HostState, ImportLocation } from '@extalia/platform';
import { useEffect, useId, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { AgentAppLogo } from '../ui/OriginMark';
import { addIgnoredFolder, DEFAULT_IGNORED_FOLDERS, isDefaultIgnoredFolder, missesDefaults, readDefaultIgnoreFolders, readIgnoreFolders, removeIgnoredFolder } from './ignoredFolders';

/** Per-location opt-in for "watch new sessions automatically". */
export function AutoWatchLocations({ t, agents, onState }: { t: Messages; agents: AgentHostApi; onState: (state: HostState) => void }) {
  const [locations, setLocations] = useState<ImportLocation[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    agents.importLocations().then(list => { if (active) setLocations(list); }, failure => { if (active) { setLocations([]); setError(errorMessage(failure)); } });
    return () => { active = false; };
  }, [agents]);

  const toggle = async (location: ImportLocation, enabled: boolean) => {
    setBusy(location.id); setError(undefined);
    try {
      setLocations(await agents.setAutoWatch(location.id, enabled));
      onState(await agents.getState());
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(null); }
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
export function IgnoredFolders({ t, agents, onState }: { t: Messages; agents: AgentHostApi; onState: (state: HostState) => void }) {
  const o = t.observedOrigin;
  const [folders, setFolders] = useState<string[] | null | undefined>(null);
  const [defaults, setDefaults] = useState<readonly string[]>(DEFAULT_IGNORED_FOLDERS);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inputId = useId();
  const hintId = useId();

  useEffect(() => {
    let active = true;
    agents.hookIngest().then(status => { if (active) { setFolders(readIgnoreFolders(status)); setDefaults(readDefaultIgnoreFolders(status)); } },
      () => { if (active) setFolders(undefined); });
    return () => { active = false; };
  }, [agents]);

  // `null` restores the host's default list.
  const save = async (next: string[] | null) => {
    setBusy(true); setError(undefined);
    try {
      const status = await agents.setHookPrivacy({ ignoreFolders: next });
      setFolders(readIgnoreFolders(status) ?? next ?? [...defaults]);
      onState(await agents.getState());
      return true;
    } catch (failure) { setError(errorMessage(failure)); return false; }
    finally { setBusy(false); }
  };
  if (folders === undefined) return null;
  const add = async () => {
    if (!folders) return;
    const next = addIgnoredFolder(folders, draft);
    if (next.duplicate) { setError(o.ignoredDuplicate); return; }
    if (next.added && await save(next.list)) setDraft('');
  };
  return <section className="card settings-section ignored-folders" aria-labelledby={`${inputId}-title`}>
    <h2 id={`${inputId}-title`}>{o.ignoredTitle}</h2>
    <p className="muted small" id={hintId}>{o.ignoredLead}</p>
    {!folders ? <p className="muted" role="status">{t.common.loading}</p> : <>
      {!folders.length ? <p className="muted small">{o.ignoredEmpty}</p> : <ul className="ignored-folder-list">
        {folders.map(folder => <li key={folder} className="ignored-folder">
          <code className="entity-path" title={folder}>{folder}</code>
          {isDefaultIgnoredFolder(folder, defaults) && <span className="badge">{o.ignoredDefault}</span>}
          <button type="button" className="icon-button small" disabled={busy} aria-label={o.ignoredRemove(folder)} title={o.ignoredRemove(folder)}
            onClick={() => { void save(removeIgnoredFolder(folders, folder)); }}><Icon name="close" /></button>
        </li>)}
      </ul>}
      <form className="ignored-folder-add" onSubmit={event => { event.preventDefault(); void add(); }}>
        <label className="visually-hidden" htmlFor={inputId}>{o.ignoredLabel}</label>
        <input id={inputId} type="text" value={draft} placeholder={o.ignoredPlaceholder} aria-describedby={hintId} spellCheck={false} autoComplete="off"
          disabled={busy} onChange={event => { setDraft(event.target.value); setError(undefined); }} />
        <button type="submit" className="button" disabled={busy || !draft.trim()}><Icon name="plus" />{o.ignoredAdd}</button>
        {missesDefaults(folders, defaults) && <button type="button" className="button" disabled={busy} onClick={() => { void save(null); }}><Icon name="refresh" />{o.ignoredRestore}</button>}
      </form>
    </>}
    {error && <p role="alert" className="form-error">{error}</p>}
  </section>;
}
