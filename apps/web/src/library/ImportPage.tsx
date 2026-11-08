import type { ImportMode } from '@extalia/core';
import type { AgentHostApi, HostState, ImportPreviewResult } from '@extalia/platform';
import { useMemo, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Segmented } from '../ui/Segmented';
import { previewRows, type PreviewRow } from './library';
import { LibraryTranscript } from './LibraryTranscript';
import { NativeSessionPicker } from './NativeSessionPicker';
import { useNativeDiscovery } from './nativeDiscovery';

type Busy = 'preview' | 'commit' | 'portable' | null;

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
export function ImportPage({ t, language, agents, onState, onImported, onOpenObserve, onOpenAgentSettings }: {
  t: Messages;
  language: string;
  agents: AgentHostApi;
  onState: (next: HostState) => void;
  onImported: (message: string) => void;
  onOpenObserve?: () => void;
  onOpenAgentSettings?: () => void;
}) {
  const discovery = useNativeDiscovery(agents, 'import');
  const { scope, scan, selected, consent } = discovery;
  const [mode, setMode] = useState<ImportMode>('imported');
  const [operation, setOperation] = useState<{ scope: typeof scope; busy: Busy; error: string | null; portableError: string | null }>({ scope, busy: null, error: null, portableError: null });
  const [prepared, setPrepared] = useState<{ scope: typeof scope; scanId: string; preview: ImportPreviewResult }>();
  const preview = prepared?.scope === scope && prepared.scanId === scan?.scanId ? prepared.preview : null;
  const { busy, error, portableError } = operation.scope === scope ? operation : { busy: null, error: null, portableError: null };
  const rows = useMemo(() => preview ? previewRows(preview) : [], [preview]);

  async function run(kind: Busy, action: (lease: { isCurrent: () => boolean }) => Promise<void>) {
    const lease = scope.acquire();
    if (!lease) return;
    setOperation({ scope, busy: kind, error: null, portableError: null });
    try { await action(lease); }
    catch (failure) {
      if (lease.isCurrent()) setOperation({ scope, busy: null, error: kind === 'portable' ? null : errorMessage(failure), portableError: kind === 'portable' ? errorMessage(failure) : null });
    } finally {
      if (lease.isCurrent()) setOperation(current => ({ ...current, busy: null }));
      lease.release();
    }
  }

  const startPreview = () => run('preview', async lease => {
    if (!scan || !selected.size || !consent) return;
    const preview = await agents.previewImports(scan.scanId, [...selected], mode);
    if (lease.isCurrent()) setPrepared({ scope, scanId: scan.scanId, preview });
  });
  const commit = () => run('commit', async lease => {
    if (!scan || !preview || !consent || !selected.size || preview.plan.rejectionReason || !rows.length) return;
    const state = await agents.commitImports(scan.scanId, [...selected], mode);
    if (!lease.isCurrent()) return;
    onState(state);
    onImported(t.imports.done(preview.plan.addCount + preview.plan.updateCount));
  });

  async function importFile(file: File | undefined) {
    if (!file) return;
    await run('portable', async lease => {
      const text = await file.text();
      if (!lease.isCurrent()) return;
      const result = await agents.importPortable(text);
      if (!lease.isCurrent()) return;
      if (result.plan.rejectionReason) { setOperation({ scope, busy: null, error: null, portableError: result.plan.rejectionReason }); return; }
      onState(result.state);
      onImported(t.imports.done(result.plan.addCount + result.plan.updateCount));
    });
  }

  const diagnostics = preview?.diagnostics ?? scan?.diagnostics ?? [];

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t.imports.title}</h1>
        <p className="lead">{t.pageRoles.import}</p>
        <p className="note"><Icon name="shield" />{t.imports.readOnly}</p>
        <p className="muted small">{t.pageRoles.observeHint}</p>
        <div className="actions">
          {onOpenObserve && <button type="button" onClick={onOpenObserve}>{t.pageRoles.openObserve}</button>}
          {onOpenAgentSettings && <button type="button" onClick={onOpenAgentSettings}>{t.pageRoles.manageAgentApps}</button>}
        </div>
      </header>

      {!preview && <NativeSessionPicker t={t} language={language} discovery={discovery} purpose="import" busy={busy !== null}>
        <div className="form-stack tight">
          <Segmented legend={t.imports.mode} value={mode} options={[{ value: 'imported', label: t.imports.modes.imported }, { value: 'linked', label: t.imports.modes.linked }]} onChange={setMode} />
          <p className="muted small">{t.imports.modeHint[mode]}</p>
        </div>
        <div className="actions">
          <button type="button" className="primary" disabled={busy !== null || !selected.size || !consent} onClick={startPreview}>
            {busy === 'preview' ? t.imports.previewing : t.imports.preview}
          </button>
        </div>
      </NativeSessionPicker>}
      {!preview && error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}

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
            <button type="button" disabled={busy !== null} onClick={() => { setPrepared(undefined); setOperation({ scope, busy: null, error: null, portableError: null }); }}>{t.imports.back}</button>
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
          <input type="file" accept=".json,application/json" disabled={busy !== null || discovery.scanning} onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
        </label>
        {portableError && <p className="form-error" role="alert"><Icon name="alert" />{t.imports.portableRejected} {portableError}</p>}
      </section>
    </div>
  );
}
