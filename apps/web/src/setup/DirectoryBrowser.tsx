import type { AgentHostApi, DirectoryListing } from '@extalia/platform';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';

/** Browse folders on the host; browser directory handles cannot reveal host paths. */
export function DirectoryBrowser({ t, agents, startPath, onSelect, onClose }: {
  t: Messages; agents: AgentHostApi; startPath?: string;
  onSelect(path: string): void; onClose(): void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const sequence = useRef(0);
  const [listing, setListing] = useState<DirectoryListing>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async (target?: string) => {
    const request = ++sequence.current;
    setLoading(true); setFailed(false);
    try {
      const next = await agents.browseDirectories(target);
      if (sequence.current === request) setListing(next);
    } catch {
      if (sequence.current === request) setFailed(true);
    } finally {
      if (sequence.current === request) setLoading(false);
    }
  }, [agents]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) return load(startPath); });
    return () => {
      active = false;
      sequence.current++; // eslint-disable-line react-hooks/exhaustive-deps -- invalidate request IDs; this ref never holds a DOM node
    };
  }, [load, startPath]);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);
  if (typeof document === 'undefined') return null;
  return createPortal(<dialog ref={dialog} className="folder-browser" aria-labelledby={`${id}-title`}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="folder-browser-body">
      <div className="section-head"><h2 id={`${id}-title`}>{t.workspace.browser.title}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t.common.close}><Icon name="close" /></button></div>
      <p className="muted small">{t.workspace.browser.lead}</p>
      <div className="row-actions">
        <button type="button" className="button small" disabled={loading} onClick={() => { void load(); }}><Icon name="folder" />{t.workspace.browser.home}</button>
        <button type="button" className="button small" disabled={loading || !listing?.parentPath} onClick={() => { void load(listing?.parentPath); }}>{t.workspace.browser.up}</button>
        {listing && <select aria-label={t.workspace.browser.roots} value="" disabled={loading} onChange={event => { void load(event.target.value); }}>
          <option value="" disabled>{t.workspace.browser.roots}</option>
          {listing.roots.map(root => <option key={root.path} value={root.path}>{root.name}</option>)}
        </select>}
      </div>
      <code className="folder-browser-path">{listing?.path}</code>
      <div className="folder-browser-list" aria-busy={loading}>
        {loading ? <p role="status">{t.workspace.browser.loading}</p> : failed ? <p role="alert" className="field-error">{t.workspace.browser.error}</p>
          : listing?.entries.length ? <ul>{listing.entries.map(entry => <li key={entry.path}>
            <button type="button" onClick={() => { void load(entry.path); }} title={entry.path}><Icon name="folder" /><span>{entry.name}</span><Icon name="chevron" /></button>
          </li>)}</ul> : <p className="muted">{t.workspace.browser.empty}</p>}
      </div>
      {listing?.truncated && <p role="status" className="muted small">{t.workspace.browser.truncated}</p>}
      <div className="actions"><button type="button" onClick={onClose}>{t.common.cancel}</button>
        <button type="button" className="primary" disabled={loading || failed || !listing?.parentPath} onClick={() => { if (listing) onSelect(listing.path); }}>{t.workspace.browser.select}</button></div>
    </div>
  </dialog>, document.body);
}
