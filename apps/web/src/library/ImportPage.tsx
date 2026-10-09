import type { ImportMode } from '@extalia/core';
import type { AgentHostApi, HostState, ImportLocation, ImportPreviewResult, ImportScan } from '@extalia/platform';
import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Segmented } from '../ui/Segmented';
import { filterCandidates, previewRows, selectableIds, type PreviewRow } from './library';
import { LibraryTranscript } from './LibraryTranscript';

type Busy = 'scan' | 'preview' | 'commit' | 'portable' | 'observe' | null;

function PreviewEntry({ t, row }: { t: Messages; row: PreviewRow }) {
  const [open, setOpen] = useState(false);
  const action = row.result?.action ?? 'skip';
  const id = `preview-${row.candidateId}`;
  return (
    <li className="entity preview-entry">
      <span className={`badge ${action === 'add' ? 'ok' : action === 'update' ? 'running' : ''}`}>{t.imports.actions[action]}</span>
      <div className="entity-main">
        <strong>{row.session.title}</strong>
        <span className="muted small">
          {row.session.workspace?.projectLocation ?? row.session.workspace?.name ?? ''}
          {row.result?.reason ? ` · ${row.result.reason}` : ''}
          {row.result?.redactions ? ` · ${t.imports.redactions(row.result.redactions)}` : ''}
        </span>
      </div>
      <button type="button" className="disclosure flush" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <Icon name="chevron" />{open ? t.imports.hideMessages : t.imports.showMessages(row.session.messages.length)}
      </button>
      {open && <div className="preview-messages" id={id}><LibraryTranscript t={t} messages={row.session.messages} /></div>}
    </li>
  );
}

/** Import from native agent histories (scan → choose → preview → import) or from an Extalia export. */
export function ImportPage({ t, language, agents, onState, onImported, onObserved }: {
  t: Messages;
  language: string;
  agents: AgentHostApi;
  onState: (next: HostState) => void;
  onImported: (message: string) => void;
  onObserved: () => void;
}) {
  const [locations, setLocations] = useState<ImportLocation[] | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [scan, setScan] = useState<ImportScan | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<ImportMode>('imported');
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [portableError, setPortableError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    agents.importLocations().then(
      list => {
        if (!active) return;
        setLocations(list);
        setChosen(new Set(list.filter(item => item.available && item.supported).map(item => item.id)));
      },
      failure => { if (active) { setLocations([]); setError(errorMessage(failure)); } },
    );
    return () => { active = false; };
  }, [agents]);

  const visible = useMemo(() => scan ? filterCandidates(scan.sessions, query) : [], [scan, query]);
  const visibleIds = selectableIds(visible);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selected.has(id));
  const someVisibleSelected = visibleIds.some(id => selected.has(id));
  const rows = useMemo(() => preview ? previewRows(preview) : [], [preview]);
  const format = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });

  async function run(kind: Busy, action: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try { await action(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(null); }
  }

  const startScan = () => run('scan', async () => {
    const result = await agents.scanImports([...chosen]);
    setScan(result);
    setQuery('');
    setPreview(null);
    setSelected(new Set(selectableIds(result.sessions)));
  });
  const startPreview = () => run('preview', async () => { if (scan) setPreview(await agents.previewImports(scan.scanId, [...selected], mode)); });
  const commit = () => run('commit', async () => {
    if (!scan || !preview) return;
    onState(await agents.commitImports(scan.scanId, [...selected], mode));
    onImported(t.imports.done(preview.plan.addCount + preview.plan.updateCount));
  });

  async function importFile(file: File | undefined) {
    if (!file) return;
    setPortableError(null);
    setBusy('portable');
    try {
      const result = await agents.importPortable(await file.text());
      if (result.plan.rejectionReason) { setPortableError(result.plan.rejectionReason); return; }
      onState(result.state);
      onImported(t.imports.done(result.plan.addCount + result.plan.updateCount));
    } catch (failure) {
      setPortableError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }

  const toggle = (set: ReadonlySet<string>, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id); else next.delete(id);
    return next;
  };
  const diagnostics = preview?.diagnostics ?? scan?.diagnostics ?? [];

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t.imports.title}</h1>
        <p className="lead">{t.imports.lead}</p>
        <p className="note"><Icon name="shield" />{t.imports.readOnly}</p>
      </header>

      {!scan && (
        <section className="card settings-section" aria-labelledby="import-locations">
          <h2 id="import-locations">{t.imports.locations}</h2>
          {!locations ? <p className="muted" role="status">{t.common.loading}</p> : (
            <ul className="entity-list">
              {locations.map(location => {
                const usable = location.available && location.supported;
                return (
                  <li key={location.id} className={`entity location ${usable ? '' : 'disabled'}`}>
                    <label className="check-row">
                      <input type="checkbox" checked={chosen.has(location.id)} disabled={!usable}
                        onChange={event => setChosen(toggle(chosen, location.id, event.target.checked))} />
                      <span className="entity-main">
                        <strong>{location.label}{location.profile && location.profile !== 'default' ? ` · ${t.imports.profile(location.profile)}` : ''}</strong>
                        {location.path && <code className="entity-path">{location.path}</code>}
                        {location.note && <span className="muted small">{location.note}</span>}
                      </span>
                    </label>
                    <span className={`badge ${!location.supported ? 'warn' : location.available ? 'ok' : ''}`}>
                      {!location.supported ? t.imports.unsupported : location.available ? t.imports.found : t.imports.notFound}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
          <div className="actions">
            <button type="button" className="primary" disabled={busy !== null || chosen.size === 0} onClick={startScan}>
              <Icon name={busy === 'scan' ? 'refresh' : 'search'} className={busy === 'scan' ? 'spin' : ''} />{busy === 'scan' ? t.imports.scanning : t.imports.scan}
            </button>
            {locations && chosen.size === 0 && <span className="muted small">{t.imports.noLocations}</span>}
          </div>
        </section>
      )}

      {scan && !preview && (
        <section className="card settings-section" aria-labelledby="import-candidates">
          <div className="section-head">
            <h2 id="import-candidates">{t.imports.candidates(scan.sessions.length)}</h2>
            <input type="search" className="search" value={query} placeholder={t.imports.search} aria-label={t.imports.search} onChange={event => setQuery(event.target.value)} />
          </div>
          {scan.truncated && <p className="warning"><Icon name="alert" />{t.imports.truncated}</p>}
          <div className="list-toolbar">
            <label className="check-row">
              <input type="checkbox" checked={allVisibleSelected} disabled={!visibleIds.length}
                ref={element => { if (element) element.indeterminate = someVisibleSelected && !allVisibleSelected; }}
                onChange={event => setSelected(current => {
                  const next = new Set(current);
                  for (const id of visibleIds) { if (event.target.checked) next.add(id); else next.delete(id); }
                  return next;
                })} />
              <span>{t.imports.selectAll}</span>
            </label>
            <span className="muted small" role="status">{t.imports.selected(selected.size)}</span>
          </div>
          {visible.length === 0 ? <p className="muted">{t.imports.noCandidates}</p> : (
            <ul className="candidate-list">
              {visible.map(candidate => (
                <li key={candidate.id} className={candidate.supported ? '' : 'disabled'}>
                  <label className="check-row">
                    <input type="checkbox" checked={selected.has(candidate.id)} disabled={!candidate.supported}
                      onChange={event => setSelected(toggle(selected, candidate.id, event.target.checked))} />
                    <span className="candidate-main">
                      <span className="candidate-title">{candidate.title}</span>
                      <span className="muted small">
                        {candidate.projectPath && <code>{candidate.projectPath}</code>}
                        {candidate.note && <span> {candidate.note}</span>}
                      </span>
                    </span>
                  </label>
                  <span className="badge">{candidate.sourceName}{candidate.profile && candidate.profile !== 'default' ? ` · ${candidate.profile}` : ''}</span>
                  <time className="muted small" dateTime={candidate.updatedAt}>{format.format(new Date(candidate.updatedAt))}</time>
                </li>
              ))}
            </ul>
          )}
          <div className="form-stack tight">
            <Segmented legend={t.imports.mode} value={mode} options={[{ value: 'imported', label: t.imports.modes.imported }, { value: 'linked', label: t.imports.modes.linked }]} onChange={setMode} />
            <p className="muted small">{t.imports.modeHint[mode]}</p>
          </div>
          {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
          <div className="actions">
            <button type="button" disabled={busy !== null} onClick={() => { setScan(null); setError(null); }}>{t.imports.back}</button>
            <button type="button" className="primary" disabled={busy !== null || selected.size === 0} onClick={startPreview}>
              {busy === 'preview' ? t.imports.previewing : t.imports.preview}
            </button>
          </div>
        </section>
      )}

      {scan && preview && (
        <section className="card settings-section" aria-labelledby="import-preview">
          <div className="section-head">
            <h2 id="import-preview">{t.imports.preview}</h2>
            <span className="muted" role="status">{t.imports.plan(preview.plan.addCount, preview.plan.updateCount, preview.plan.skipCount)}</span>
          </div>
          {preview.plan.rejectionReason && <p className="form-error"><Icon name="alert" />{preview.plan.rejectionReason}</p>}
          <ul className="entity-list">{rows.map(row => <PreviewEntry key={row.candidateId} t={t} row={row} />)}</ul>
          {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
          <div className="actions">
            <button type="button" disabled={busy !== null} onClick={() => { setPreview(null); setError(null); }}>{t.imports.back}</button>
            <button type="button" disabled={busy !== null || !rows.length || selected.size > 10} onClick={() => run('observe', async () => {
              onState(await agents.observeImports(scan.scanId, [...selected])); onObserved();
            })}>{t.observer.watch}</button>
            <button type="button" className="primary" disabled={busy !== null || Boolean(preview.plan.rejectionReason) || preview.plan.addCount + preview.plan.updateCount === 0} onClick={commit}>
              <Icon name="download" />{busy === 'commit' ? t.imports.committing : t.imports.commit(preview.plan.addCount + preview.plan.updateCount)}
            </button>
          </div>
        </section>
      )}

      {diagnostics.length > 0 && (
        <section className="card settings-section" aria-labelledby="import-diagnostics">
          <h2 id="import-diagnostics">{t.imports.diagnostics}</h2>
          <ul className="diagnostics">{diagnostics.map((item, index) => <li key={index} className="muted small">{item.message}</li>)}</ul>
        </section>
      )}

      <section className="card settings-section" aria-labelledby="import-portable">
        <h2 id="import-portable">{t.imports.portableTitle}</h2>
        <p className="muted small">{t.imports.portableLead}</p>
        <label className="field">
          <span>{t.imports.portableFile}</span>
          <input type="file" accept=".json,application/json" disabled={busy !== null} onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
        </label>
        {portableError && <p className="form-error" role="alert"><Icon name="alert" />{t.imports.portableRejected} {portableError}</p>}
      </section>
    </div>
  );
}
