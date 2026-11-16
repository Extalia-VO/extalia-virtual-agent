import {
  SKILL_MARKET_LIMITS, normalizeSkillMarketPreviewInput, normalizeSkillMarketQuery, skillMarketPinnedSourceUrl,
  type AgentHostApi, type MarketSkillEntry, type SkillActionResult, type SkillMarketPreview,
  type SkillMarketPreviewInput, type SkillMarketSearchResult,
} from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { revealSkillManagement } from './SkillManagementDisclosure';
import { skillHostKey } from './skillPreflightContext';
import './skillMarketplace.css';

export function skillMarketSupported(agents: AgentHostApi): boolean {
  return ['skillMarketSearch', 'previewMarketSkill', 'installMarketSkill', 'discardMarketSkillPreview']
    .every(method => typeof agents[method as keyof AgentHostApi] === 'function');
}
export interface SkillMarketplaceState {
  query: string;
  repository: string;
  skill: string;
  busy?: 'search' | 'preview' | 'import';
  result?: SkillMarketSearchResult;
  preview?: SkillMarketPreview;
  confirmed: boolean;
  imported?: Pick<SkillActionResult, 'revisionId' | 'packageId' | 'state' | 'stateReason' | 'created'>;
  error?: string;
  importUncertain: boolean;
}

/** UI request ownership only. Downloading, source resolution, caching, staging and scanning stay behind the host API. */
export class SkillMarketplaceController {
  value: SkillMarketplaceState = { query: '', repository: '', skill: '', confirmed: false, importUncertain: false };
  private active = true;
  private generation = 0;
  private searchRevision = 0;
  private selectionRevision = 0;
  private enteredImport?: string;
  private releases: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly agents: AgentHostApi, private changed: () => void, private readonly reveal: () => void) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = (): SkillMarketplaceState => this.value;
  setChanged(callback: () => void): void { this.changed = callback; }
  activate(): void { this.active = true; }
  dispose(): void {
    this.active = false; this.generation++; this.searchRevision++; this.selectionRevision++;
    this.releasePreview();
    this.value = { ...this.value, preview: undefined, confirmed: false, ...(this.enteredImport ? { importUncertain: true } : { busy: undefined }) };
  }
  private publish(next: Partial<SkillMarketplaceState>): void {
    this.value = { ...this.value, ...next };
    for (const listener of this.listeners) listener();
  }
  private discard(reviewId: string): void {
    // Best-effort release never claims that entered effects were cancelled or that cleanup was confirmed.
    this.releases = this.releases.then(async () => {
      try { await this.agents.discardMarketSkillPreview?.(reviewId); } catch { /* Host owns expiry and admitted import settlement. */ }
    });
  }
  private releasePreview(): void {
    if (this.value.preview && this.value.preview.reviewId !== this.enteredImport) this.discard(this.value.preview.reviewId);
  }
  private announce(): void {
    // A failed UI refresh does not turn an acknowledged registry import into an uncertain operation.
    try { this.changed(); } catch { /* The receipt remains available for explicit review. */ }
    try { this.reveal(); } catch { /* An unmounted disclosure grants no new action. */ }
  }
  private clearSelection(): void {
    this.selectionRevision++; this.releasePreview();
    this.publish({ preview: undefined, confirmed: false, imported: undefined, error: undefined, importUncertain: false });
  }
  editQuery(query: string): void {
    if (!this.active || this.enteredImport) return;
    this.searchRevision++; this.clearSelection(); this.publish({ query, result: undefined });
  }
  editSource(field: 'repository' | 'skill', value: string): void {
    if (!this.active || this.enteredImport) return;
    this.clearSelection(); this.publish({ [field]: value });
  }
  confirm(confirmed: boolean): void {
    if (this.active && this.value.preview && !this.enteredImport) this.publish({ confirmed });
  }
  async search(refresh = false): Promise<void> {
    if (!this.active || !this.agents.skillMarketSearch || this.value.busy || this.enteredImport) return;
    let query: string;
    try { query = normalizeSkillMarketQuery(refresh ? this.value.result?.query : this.value.query); }
    catch (failure) { this.publish({ error: errorMessage(failure) }); return; }
    this.clearSelection();
    const generation = this.generation, revision = ++this.searchRevision;
    this.publish({ query, busy: 'search', result: undefined, error: undefined });
    try {
      // Cleanup shares the host's exclusive marketplace lane. Its real settlement precedes new I/O.
      await this.releases;
      if (!this.active || generation !== this.generation || revision !== this.searchRevision) return;
      const result = await this.agents.skillMarketSearch(query, refresh);
      if (this.active && generation === this.generation && revision === this.searchRevision && result.query === query) this.publish({ result });
    } catch (failure) {
      if (this.active && generation === this.generation && revision === this.searchRevision) this.publish({ error: errorMessage(failure) });
    } finally { if (this.active && generation === this.generation) this.publish({ busy: undefined }); }
  }
  async preview(input?: SkillMarketPreviewInput): Promise<void> {
    if (!this.active || !this.agents.previewMarketSkill || this.value.busy || this.enteredImport) return;
    this.clearSelection();
    let source: SkillMarketPreviewInput;
    try { source = normalizeSkillMarketPreviewInput(input ?? { repository: this.value.repository, skill: this.value.skill }); }
    catch (failure) { this.publish({ error: errorMessage(failure) }); return; }
    const generation = this.generation, revision = this.selectionRevision;
    this.publish({ ...source, busy: 'preview', error: undefined });
    try {
      await this.releases;
      if (!this.active || generation !== this.generation || revision !== this.selectionRevision) return;
      const preview = await this.agents.previewMarketSkill(source);
      if (!this.active || generation !== this.generation || revision !== this.selectionRevision) { this.discard(preview.reviewId); return; }
      this.publish({ preview, confirmed: false });
    } catch (failure) {
      if (this.active && generation === this.generation && revision === this.selectionRevision) this.publish({ error: errorMessage(failure) });
    } finally { if (this.active && generation === this.generation) this.publish({ busy: undefined }); }
  }
  closePreview(): void { if (this.active && !this.enteredImport) this.clearSelection(); }
  async import(): Promise<void> {
    const preview = this.value.preview;
    if (!this.active || !this.agents.installMarketSkill || !preview || !this.value.confirmed || this.value.busy || this.enteredImport) return;
    const generation = this.generation;
    this.enteredImport = preview.reviewId;
    this.publish({ busy: 'import', error: undefined, imported: undefined, importUncertain: false });
    try {
      const imported = await this.agents.installMarketSkill(preview.reviewId);
      if (!this.active || generation !== this.generation) return;
      if (!imported.revisionId || !imported.packageId || !imported.state) throw new Error('The import did not return a candidate identity.');
      const { revisionId, packageId, state, stateReason, created } = imported;
      this.publish({ imported: { revisionId, packageId, state, stateReason, created }, preview: undefined, confirmed: false });
      this.announce();
    } catch (failure) {
      if (!this.active || generation !== this.generation) return;
      // An entered import may have persisted before a lost response. Never retry that review automatically.
      this.publish({ error: errorMessage(failure), importUncertain: true, preview: undefined, confirmed: false });
      this.announce();
    } finally {
      // The host owns the entered preview until its import/scanner promises settle; disposal never deletes it early.
      this.enteredImport = undefined;
      if (this.active) this.publish({ busy: undefined });
    }
  }
}

export function SkillMarketplace({ agents, t, onChanged }: { agents: AgentHostApi; t: Messages; onChanged?: (() => void) | undefined }) {
  return <SkillMarketplaceHost key={skillHostKey(agents)} agents={agents} t={t} onChanged={onChanged} />;
}
function SkillMarketplaceHost({ agents, t, onChanged }: { agents: AgentHostApi; t: Messages; onChanged?: (() => void) | undefined }) {
  const [controller] = useState(() => new SkillMarketplaceController(agents, onChanged ?? (() => undefined), () => revealSkillManagement('skill-center-title')));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { controller.setChanged(onChanged ?? (() => undefined)); }, [controller, onChanged]);
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  return <SkillMarketplaceView t={t} state={state} supported={skillMarketSupported(agents)}
    onQuery={value => controller.editQuery(value)} onSearch={refresh => { void controller.search(refresh); }}
    onSource={(field, value) => controller.editSource(field, value)} onPreview={input => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      void controller.preview(input);
    }}
    onConfirm={value => controller.confirm(value)} onImport={() => { void controller.import(); }} onDiscard={() => { controller.closePreview(); if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); }}
    onReviewLibrary={() => revealSkillManagement('skill-center-title')} />;
}

/** Translate only Extalia-owned warning sentences; arbitrary repository/user text stays literal. */
export function skillMarketWarning(warning: string, t: Messages): string {
  const text = t.skillMarket;
  const known: Record<string, string> = {
    'Marketplace entries and repository content are untrusted. No code was executed and nothing was activated.': text.warningUntrusted,
    'Files are copied without executable permission; installation still requires the existing quarantine and review gates.': text.warningPermissions,
    'No license notice was found for this package. Marketplace listing does not establish permission to use or redistribute it.': text.warningNoLicense,
    'License notices are included as source evidence, not a legal compatibility determination.': text.warningLicenseEvidence,
  };
  return Object.hasOwn(known, warning) ? known[warning]! : warning;
}

export interface SkillMarketplaceViewProps {
  t: Messages; state: SkillMarketplaceState; supported: boolean;
  onQuery(value: string): void; onSearch(refresh?: boolean): void;
  onSource(field: 'repository' | 'skill', value: string): void; onPreview(input?: SkillMarketPreviewInput): void;
  onConfirm(value: boolean): void; onImport(): void; onDiscard(): void; onReviewLibrary(): void;
}
export function SkillMarketplaceView(p: SkillMarketplaceViewProps) {
  const { t, state } = p, text = t.skillMarket, id = useId();
  const busy = Boolean(state.busy), importing = state.busy === 'import';
  const pinnedSource = state.preview ? skillMarketPinnedSourceUrl(state.preview) : undefined;
  const review = useRef<HTMLElement>(null);
  const reviewId = state.preview?.reviewId;
  useEffect(() => {
    const element = review.current;
    if (!reviewId || !element) return;
    // A selected result may be hundreds of rows above its prepared package. Make completion visible and keyboard reachable.
    element.scrollIntoView({ block: 'start' }); element.focus({ preventScroll: true });
  }, [reviewId]);
  return <section className="card settings-section skill-marketplace" aria-labelledby={`${id}-title`}>
    <header className="section-head"><div><h2 id={`${id}-title`}>{text.title}</h2><p className="muted small">{text.lead}</p></div></header>
    {!p.supported ? <p role="status">{text.unavailable}</p> : <>
      <p className="note small">{text.privacy}</p>
      <form className="skill-market-search" onSubmit={event => { event.preventDefault(); p.onSearch(); }}>
        <label htmlFor={`${id}-query`}>{text.query}</label><div className="skill-market-search-row">
          <input id={`${id}-query`} type="search" value={state.query} maxLength={SKILL_MARKET_LIMITS.query} disabled={importing} autoComplete="off" onChange={event => p.onQuery(event.target.value)} />
          <button type="submit" className="button" disabled={busy || !state.query.trim()}>{state.busy === 'search' ? text.searching : text.search}</button>
        </div>
      </form>
      <p className="muted small">{text.noNetwork}</p>
      {state.result && <MarketplaceResults key={`${state.result.query}:${state.result.fetchedAt ?? ''}`} result={state.result} t={t} busy={busy} onRefresh={() => p.onSearch(true)}
        onPreview={entry => p.onPreview({ repository: entry.source, skill: entry.id })} />}
      <details className="skill-market-direct"><summary>{text.direct}</summary>
        <form onSubmit={event => { event.preventDefault(); p.onPreview(); }}>
          <label htmlFor={`${id}-repository`}>{text.repository}</label><input id={`${id}-repository`} type="text" value={state.repository} maxLength={SKILL_MARKET_LIMITS.repository} disabled={importing} autoComplete="off" onChange={event => p.onSource('repository', event.target.value)} />
          <label htmlFor={`${id}-skill`}>{text.skill}</label><input id={`${id}-skill`} type="text" value={state.skill} maxLength={SKILL_MARKET_LIMITS.skill} disabled={importing} autoComplete="off" onChange={event => p.onSource('skill', event.target.value)} />
          <button type="submit" className="button small" disabled={busy || !state.repository.trim() || !state.skill.trim()}>{state.busy === 'preview' ? text.previewing : text.preview}</button>
        </form>
      </details>
      {state.busy === 'preview' && <p role="status">{text.previewing}</p>}
      {state.preview && <section ref={review} tabIndex={-1} className="skill-market-review" aria-labelledby={`${id}-review`}>
        <header className="section-head"><h3 id={`${id}-review`}>{text.review}</h3><button type="button" className="button small" disabled={importing} onClick={p.onDiscard}>{text.discard}</button></header>
        <dl className="skill-market-pins"><dt>{text.source}</dt><dd><code>{state.preview.repository}</code></dd><dt>{text.commit}</dt><dd><code>{state.preview.commit}</code></dd>
          <dt>{text.directory}</dt><dd><code>{state.preview.directory || text.root}</code></dd><dt>{text.digest}</dt><dd><code>{state.preview.treeSha256}</code></dd>
          <dt>{text.license}</dt><dd>{state.preview.license || text.unknownLicense}</dd><dt>{text.expires}</dt><dd><time dateTime={state.preview.expiresAt}>{state.preview.expiresAt}</time></dd></dl>
        <code className="skill-market-source-ref">{state.preview.sourceRef}</code>
        {pinnedSource && <a className="button small" href={pinnedSource} target="_blank" rel="noopener noreferrer">{text.viewSource}</a>}
        <MarketPackageDeclarations key={state.preview.reviewId} manifest={state.preview.manifest} t={t} />
        {state.preview.warnings.length > 0 && <div className="note small"><strong>{text.warnings}</strong><ul>{state.preview.warnings.map((warning, index) => <li key={index}>{skillMarketWarning(warning, t)}</li>)}</ul></div>}
        <details><summary>{text.files}: {state.preview.files.length} · {state.preview.totalBytes.toLocaleString()} {text.bytes}</summary><ul className="skill-market-files">{state.preview.files.map(file => <li key={file.path}><code>{file.path}</code><span>{file.size.toLocaleString()} {text.bytes}</span><code>{file.sha256}</code></li>)}</ul></details>
        <p className="muted small">{text.importLimit}</p>
        <label className="skill-market-confirm"><input type="checkbox" checked={state.confirmed} disabled={importing} onChange={event => p.onConfirm(event.target.checked)} />{text.confirm}</label>
        <button type="button" className="button primary" disabled={busy || !state.confirmed} onClick={p.onImport}>{importing ? text.importing : text.import}</button>
      </section>}
      {state.imported && <div className="skill-market-receipt" role="status"><strong>{text.imported}</strong><p><code>{state.imported.packageId}</code> · {state.imported.state ? t.skillCenter.states[state.imported.state] : ''}</p>
        {state.imported.created === false && <p className="small">{text.alreadyImported}</p>}{state.imported.stateReason && <p className="small" title={t.skillCenter.reasonCode(state.imported.stateReason)}>{t.skillCenter.reasons[state.imported.stateReason] ?? t.skillCenter.reasonCode(state.imported.stateReason)}</p>}<p className="small">{text.importLimit}</p><button type="button" className="button small" onClick={p.onReviewLibrary}>{text.reviewInLibrary}</button></div>}
      {state.importUncertain && <div className="note small" role="alert"><p>{text.importUncertain}</p><button type="button" className="button small" onClick={p.onReviewLibrary}>{text.reviewInLibrary}</button></div>}
      {state.error && <p className="form-error" role="alert">{state.error === 'Native skill market unavailable (invalid_manifest).' ? text.invalidManifest : state.error}</p>}
    </>}
  </section>;
}

function MarketPackageDeclarations({ manifest, t }: { manifest: SkillMarketPreview['manifest']; t: Messages }) {
  const id = useId(), text = t.skillMarket, center = t.skillCenter;
  if (!manifest) return <p className="muted small">{text.declarationsUnavailable}</p>;
  const { permissions, permissionsTotal, compatibility, compatibilityTotal } = manifest;
  return <section className="skill-market-declarations" aria-labelledby={id}>
    <h4 id={id}>{text.declarations}</h4>
    <dl className="skill-market-pins">
      <dt>{text.packageId}</dt><dd><code>{manifest.id}</code></dd>
      <dt>{text.packageVersion}</dt><dd><code>{manifest.version}</code></dd>
      <dt>{text.riskClass}</dt><dd>{center.risks[manifest.riskClass]}</dd>
    </dl>
    {manifest.inferred && <p className="muted small">{center.inferred}</p>}
    <div className="skill-market-declaration-groups">
      <details open={permissions.length <= 4}>
        <summary>{text.requestedPermissions} · {permissionsTotal}</summary>
        <p className="muted small">{text.permissionNote}</p>
        {permissionsTotal === 0 && <p className="small">{center.noPermissions}</p>}
        {permissions.length > 0 && <ul className="skill-market-declaration-rows">
          {permissions.map(({ capability, scope }) => <li key={JSON.stringify([capability, scope])}>
            <span>{center.capabilities[capability]}</span><code>{scope}</code>
          </li>)}
        </ul>}
        {permissionsTotal > permissions.length && <p className="small">{text.omittedRows(permissionsTotal - permissions.length)}</p>}
      </details>
      <details open={compatibility.length <= 4}>
        <summary>{text.runtimeRequirements} · {compatibilityTotal}</summary>
        <p className="muted small">{text.compatibilityUnchecked}</p>
        {compatibilityTotal === 0 && <p className="small">{text.noRuntimeRequirements}</p>}
        {compatibility.length > 0 && <ul className="skill-market-declaration-rows">
          {compatibility.map(({ id, range }) => <li key={id}><code>{id}</code><code>{range}</code></li>)}
        </ul>}
        {compatibilityTotal > compatibility.length && <p className="small">{text.omittedRows(compatibilityTotal - compatibility.length)}</p>}
      </details>
    </div>
  </section>;
}

function MarketplaceResults({ result, t, busy, onRefresh, onPreview }: { result: SkillMarketSearchResult; t: Messages; busy: boolean; onRefresh(): void; onPreview(entry: MarketSkillEntry): void }) {
  const [visible, setVisible] = useState(12), text = t.skillMarket;
  return <section className="skill-market-results" aria-label={text.results}>
    <header className="section-head"><h3>{text.results}: {result.query} ({Math.min(visible, result.entries.length)}/{result.entries.length})</h3><button type="button" className="button small" disabled={busy} onClick={onRefresh}>{text.refresh}</button></header>
    <p className="small" role="status">{result.cached && <span>{text.cached} · </span>}{result.stale && <span>{text.stale} · </span>}{result.fetchedAt && <span>{text.fetched}: <time dateTime={result.fetchedAt}>{result.fetchedAt}</time></span>}</p>
    {result.problem && <p className="note small" title={result.problem}>{result.cached || result.entries.length ? text.refreshFailed : text.searchUnavailable}</p>}
    {!result.entries.length && !result.problem && <p>{text.empty}</p>}
    <ul className="skill-market-entries">{result.entries.slice(0, visible).map(entry => <li key={`${entry.source}:${entry.id}`}>
      <div><strong>{entry.name}</strong><code>{entry.source} · {entry.id}</code><p className="muted small">{text.installs}: {entry.installs.toLocaleString()}</p><code className="skill-market-catalog-url">{entry.url}</code></div>
      <button type="button" className="button small" disabled={busy} aria-label={`${text.preview}: ${entry.name}`} onClick={() => onPreview(entry)}>{text.preview}</button>
    </li>)}</ul>
    {visible < result.entries.length && <button type="button" className="button small" onClick={() => setVisible(value => Math.min(value + 12, result.entries.length))}>{text.showMore}</button>}
  </section>;
}
