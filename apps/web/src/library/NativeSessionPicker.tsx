import { useId, type ReactNode } from 'react';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { filterCandidates } from './library';
import { nativeSelectableIds, type DiscoveryPurpose, type NativeDiscovery } from './nativeDiscovery';
import './nativeDiscovery.css';

/** Shared source metadata UI; the owning page decides whether to watch or preview history. */
export function NativeSessionPicker({ t, language, discovery, purpose, busy = false, children }: {
  t: Messages;
  language: string;
  discovery: NativeDiscovery;
  purpose: DiscoveryPurpose;
  busy?: boolean;
  children?: ReactNode;
}) {
  const id = useId();
  const { locations, locationsChosen, scan, selected, query, consent, scanning, error, update, choose } = discovery;
  const disabled = busy || scanning;
  const visible = scan ? filterCandidates(scan.sessions, query) : [];
  const visibleIds = nativeSelectableIds(visible, purpose);
  const allSelected = visibleIds.length > 0 && visibleIds.every(candidateId => selected.has(candidateId));
  const someSelected = visibleIds.some(candidateId => selected.has(candidateId));
  const format = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });

  return <section className="card settings-section" aria-labelledby={`${id}-title`}>
    <div className="section-head">
      <h2 id={`${id}-title`}>{scan ? t.imports.candidates(scan.sessions.length) : t.imports.locations}</h2>
      {scan && <input type="search" className="search" value={query} placeholder={t.imports.search} aria-label={t.imports.search}
        disabled={disabled} onChange={event => update({ query: event.target.value })} />}
    </div>
    {!scan ? <>
      {!locations ? <p className="muted" role="status">{t.common.loading}</p> : <ul className="entity-list">
        {locations.map(location => {
          const usable = location.available && location.supported;
          return <li key={location.id} className={`entity location ${usable ? '' : 'disabled'}`}>
            <label className="check-row">
              <input type="checkbox" checked={locationsChosen.has(location.id)} disabled={disabled || !usable} onChange={event => {
                const chosen = new Set(locationsChosen);
                if (event.target.checked) chosen.add(location.id); else chosen.delete(location.id);
                update({ locationsChosen: chosen });
              }} />
              <span className="entity-main">
                <strong>{location.label}{location.profile && location.profile !== 'default' ? ` · ${t.imports.profile(location.profile)}` : ''}</strong>
                {location.path && <code className="entity-path">{location.path}</code>}
                {location.note && <span className="muted small">{location.note}</span>}
              </span>
            </label>
            <span className={`badge ${!location.supported ? 'warn' : location.available ? 'ok' : ''}`}>
              {!location.supported ? t.imports.unsupported : location.available ? t.imports.found : t.imports.notFound}
            </span>
          </li>;
        })}
      </ul>}
      <div className="actions">
        <button type="button" className="primary" disabled={disabled || locationsChosen.size === 0} onClick={() => { void discovery.startScan(); }}>
          <Icon name={scanning ? 'refresh' : 'search'} className={scanning ? 'spin' : ''} />{scanning ? t.imports.scanning : t.imports.scan}
        </button>
        {locations && locationsChosen.size === 0 && <span className="muted small">{t.imports.noLocations}</span>}
      </div>
    </> : <>
      {scan.truncated && <p className="warning"><Icon name="alert" />{t.imports.truncated}</p>}
      <div className="list-toolbar">
        <label className="check-row">
          <input type="checkbox" checked={allSelected} disabled={disabled || !visibleIds.length}
            ref={element => { if (element) element.indeterminate = someSelected && !allSelected; }}
            onChange={event => choose(visibleIds, event.target.checked)} />
          <span>{t.imports.selectAll}</span>
        </label>
        <span className="muted small" role="status">{t.imports.selected(selected.size)}</span>
      </div>
      {!visible.length ? <p className="muted">{t.imports.noCandidates}</p> : <ul className="candidate-list">
        {visible.map(candidate => {
          const selectable = candidate.supported && (purpose !== 'observe' || !candidate.ignored);
          return <li key={candidate.id} className={[selectable ? '' : 'disabled', candidate.ignored ? 'ignored' : ''].filter(Boolean).join(' ') || undefined}>
            <label className="check-row">
              <input type="checkbox" checked={selected.has(candidate.id)} disabled={disabled || !selectable} onChange={event => choose([candidate.id], event.target.checked)} />
              <span className="candidate-main">
                <span className="candidate-title">{candidate.title}</span>
                <span className="muted small">{candidate.projectPath && <code>{candidate.projectPath}</code>}{candidate.note && <span> {candidate.note}</span>}</span>
              </span>
            </label>
            {candidate.ignored && <span className="badge muted" title={t.observedOrigin.ignoredHint}>{t.observedOrigin.ignoredBadge}</span>}
            <span className="badge">{candidate.sourceName}{candidate.profile && candidate.profile !== 'default' ? ` · ${candidate.profile}` : ''}</span>
            <time className="muted small" dateTime={candidate.updatedAt}>{format.format(new Date(candidate.updatedAt))}</time>
          </li>;
        })}
      </ul>}
      <label className="check-row">
        <input type="checkbox" checked={consent} disabled={disabled || !selected.size} onChange={event => update({ consent: event.target.checked })} />
        <span>{purpose === 'observe' ? t.observer.sourceConsent : t.imports.sourceConsent}</span>
      </label>
      <fieldset className="native-discovery-actions" disabled={disabled}>{children}</fieldset>
      <div className="actions"><button type="button" disabled={disabled} onClick={() => update({ scan: null, selected: new Set(), consent: false, error: null })}>{t.imports.back}</button></div>
    </>}
    {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
  </section>;
}
