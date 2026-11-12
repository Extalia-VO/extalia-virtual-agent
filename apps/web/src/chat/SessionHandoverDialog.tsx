import { EFFORTS, type Effort } from '@extalia/core';
import type {
  AgentHostApi, ContinuityNotes, ContinuityReadPage, ContinuitySnapshotSummary, ContinuityView,
  HandoverPreview, HandoverReceipt, HandoverTarget, HostState, ObservedControlStatus, SessionSummary,
} from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { errorMessage } from '../host/remote';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import './sessionHandoverDialog.css';

/** Supplied by the shared EN/ID catalog; user notes and source excerpts remain literal. */
export interface HandoverMessages {
  title: string; description: string; close: string; loading: string; unavailable: string;
  canonical: string; source: string; destination: string; native: string; observed: string; manual: string;
  connection: string; model: string; effort: string; defaultValue: string; targetSession: string;
  route: string; refreshRoutes: string; noRoute: string; manualLabel: string; manualUnbound: string;
  notes: string; sourceExcerpt: string; fields: Record<keyof ContinuityNotes, string>;
  coverage: string; coverageModes: Record<ContinuitySnapshotSummary['coverage']['mode'], string>;
  observedThrough: string; entries: string; omitted: string; limits: string; unknown: string;
  context: string; estimated: string; reported: string; compactions: string; contextLimit: string;
  chain: string; noHandovers: string; delivery: string; statuses: Record<HandoverReceipt['state'], string>;
  receiptLimit: string; transient: string; inspect: string; loadMore: string; evidence: string;
  review: string; reviewing: string; apply: string; applying: string; confirm: string;
  packet: string; digest: string; expires: string; copy: string; copied: string; copyFailed: string; copyAfterApply: string;
  cancel: string; edit: string; sourceChanged: string; recoveryTitle: string; recoveryDescription: string; recoveryConfirm: string;
  recoveryAccepted: string; recoveryNotDelivered: string; recovering: string; userInspected: string;
}

const emptyNotes = (): ContinuityNotes => ({ goal: '', decisions: '', completed: '', pending: '', verification: '', risks: '' });
const noteKeys = ['goal', 'decisions', 'completed', 'pending', 'verification', 'risks'] as const;
type Busy = 'load' | 'preview' | 'apply' | 'read' | 'reconcile' | undefined;
export interface HandoverDialogState {
  busy?: Busy; continuity?: ContinuityView; notes: ContinuityNotes; notesEdited: boolean;
  preview?: HandoverPreview; receipt?: HandoverReceipt; page?: ContinuityReadPage;
  error?: string; copied: boolean; sourceChanged?: boolean;
}

/** A UI ownership key, not a claim about hidden provider state or a substitute for host review validation. */
export function handoverDialogSourceKey(session: SessionSummary): string {
  return JSON.stringify([session.id, session.workspaceId, session.connectionId, session.lastActiveAt, session.running,
    session.model, session.effort, session.context, session.options, session.observation?.sourceId,
    session.observation?.nativeSessionId, session.observation?.projectPath, session.observation?.watching, session.observation?.status]);
}

/** Keeps old preview/read/clipboard acknowledgements from crossing a host, source or edit boundary. */
export class HandoverDialogController {
  value: HandoverDialogState = { notes: emptyNotes(), notesEdited: false, copied: false };
  private agents?: AgentHostApi;
  private sessionId = '';
  private workspaceId = '';
  private key = '';
  private generation = 0;
  private editing = 0;
  private reading = 0;
  private loading = 0;
  private applying = false;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly changed: () => void, private applied: (receipt: HandoverReceipt) => void) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = (): HandoverDialogState => this.value;
  setApplied(callback: (receipt: HandoverReceipt) => void): void { this.applied = callback; }
  matches(agents: AgentHostApi, session: SessionSummary): boolean { return this.agents === agents && this.key === handoverDialogSourceKey(session); }
  bind(agents: AgentHostApi, session: SessionSummary): void {
    const key = handoverDialogSourceKey(session);
    if (this.agents === agents && key === this.key) return;
    const sameDraft = this.agents === agents && this.sessionId === session.id && this.workspaceId === session.workspaceId;
    const previous = this.value;
    // Once admitted, an apply receipt still belongs to this same source identity even if activity advances.
    if (sameDraft && this.applying) { this.key = key; return; }
    this.generation++; this.editing++; this.reading++; this.loading++;
    this.agents = agents; this.sessionId = session.id; this.workspaceId = session.workspaceId; this.key = key; this.applying = false;
    this.value = { notes: sameDraft ? previous.notes : emptyNotes(), notesEdited: sameDraft && previous.notesEdited, copied: false, sourceChanged: sameDraft && Boolean(previous.preview) };
    this.notify();
  }
  invalidate(): void { this.generation++; this.editing++; this.reading++; this.loading++; this.key = ''; this.applying = false; }
  private notify(): void { this.changed(); for (const listener of this.listeners) listener(); }
  private publish(next: Partial<HandoverDialogState>): void { this.value = { ...this.value, ...next }; this.notify(); }
  editTarget(): void {
    if (this.applying || this.value.receipt?.state === 'unknown') return;
    this.editing++;
    this.publish({ preview: undefined, receipt: undefined, copied: false, error: undefined, sourceChanged: false,
      ...(this.value.busy === 'preview' ? { busy: undefined } : {}) });
  }
  editNotes(key: keyof ContinuityNotes, text: string): void {
    if (this.applying || this.value.receipt?.state === 'unknown') return;
    this.editTarget(); this.publish({ notes: { ...this.value.notes, [key]: text }, notesEdited: true });
  }
  async load(): Promise<void> {
    const host = this.agents, generation = this.generation, loading = ++this.loading;
    if (!host?.sessionContinuity || this.applying) return;
    this.publish({ busy: 'load', error: undefined });
    try {
      const continuity = await host.sessionContinuity(this.sessionId);
      if (generation !== this.generation || loading !== this.loading) return;
      const currentReceipt = this.value.receipt;
      const receipt = currentReceipt ? continuity.handovers.find(item => item.operationId === currentReceipt.operationId) ?? currentReceipt
        : [...continuity.handovers].reverse().find(item => item.state === 'unknown');
      this.publish({ continuity, receipt, ...(!this.value.notesEdited ? { notes: { ...continuity.notes } } : {}) });
    } catch (failure) {
      if (generation === this.generation && loading === this.loading) this.publish({ error: errorMessage(failure) });
    } finally {
      if (generation === this.generation && loading === this.loading) this.publish({ busy: undefined });
    }
  }
  async review(target: HandoverTarget): Promise<void> {
    const host = this.agents;
    if (!host?.previewHandover || this.value.busy || this.applying || this.value.receipt?.state === 'unknown') return;
    const generation = this.generation, editing = ++this.editing;
    const current = () => generation === this.generation && editing === this.editing;
    this.publish({ busy: 'preview', preview: undefined, receipt: undefined, copied: false, error: undefined });
    try {
      const preview = await host.previewHandover(this.sessionId, { target, notes: { ...this.value.notes } });
      if (current() && preview.sourceSessionId === this.sessionId) this.publish({ preview });
    } catch (failure) { if (current()) this.publish({ error: errorMessage(failure) }); }
    finally { if (current()) this.publish({ busy: undefined }); }
  }
  async apply(confirmed: boolean, operationId: string): Promise<void> {
    const host = this.agents, preview = this.value.preview;
    if (!host?.applyHandover || !preview || !confirmed || this.value.busy || this.applying || this.value.receipt) return;
    const generation = this.generation, editing = this.editing;
    const current = () => generation === this.generation && editing === this.editing;
    this.applying = true; this.publish({ busy: 'apply', error: undefined });
    let refresh = false;
    try {
      const receipt = await host.applyHandover(this.sessionId, { reviewId: preview.reviewId, operationId });
      if (!current()) return;
      this.publish({ receipt }); refresh = true; this.applied(receipt);
    } catch (failure) {
      // An uncertain transport is never resubmitted by this dialog. The user must inspect current state and review again.
      if (current()) this.publish({ error: errorMessage(failure), preview: undefined });
    } finally { if (current()) { this.applying = false; this.publish({ busy: undefined }); } }
    if (current() && refresh) await this.load();
  }
  async reconcile(confirmed: boolean, outcome: 'accepted' | 'not-delivered'): Promise<void> {
    const host = this.agents, receipt = this.value.receipt;
    if (!host?.reconcileHandover || !confirmed || receipt?.state !== 'unknown' || this.value.busy || this.applying) return;
    const generation = this.generation, editing = this.editing;
    const current = () => generation === this.generation && editing === this.editing;
    this.applying = true; this.publish({ busy: 'reconcile', error: undefined });
    let resolved = false;
    try {
      const result = await host.reconcileHandover(this.sessionId, { operationId: receipt.operationId, packetDigest: receipt.packetDigest, outcome });
      if (!current()) return;
      this.publish({ receipt: result }); resolved = result.state !== 'unknown';
    } catch (failure) { if (current()) this.publish({ error: errorMessage(failure) }); }
    finally { if (current()) { this.applying = false; this.publish({ busy: undefined }); } }
    if (current() && resolved) await this.load();
  }
  async read(snapshotId: string, more = false): Promise<void> {
    const host = this.agents, previous = this.value.page;
    if (!host?.readContinuity || this.value.busy || this.applying) return;
    if (more && (previous?.snapshot.id !== snapshotId || previous.nextOffset === undefined)) return;
    const generation = this.generation, reading = ++this.reading;
    const current = () => generation === this.generation && reading === this.reading;
    this.publish({ busy: 'read', error: undefined, ...(more ? {} : { page: undefined }) });
    try {
      const page = await host.readContinuity(this.sessionId, { snapshotId, offset: more ? previous!.nextOffset : 0, limit: 30 });
      if (!current() || page.snapshot.id !== snapshotId) return;
      // Render one explicit source page at a time; never retain or silently trim an unbounded transcript.
      this.publish({ page });
    } catch (failure) { if (current()) this.publish({ error: errorMessage(failure) }); }
    finally { if (current()) this.publish({ busy: undefined }); }
  }
  async copy(write: (text: string) => Promise<void>, failureText: string): Promise<void> {
    const preview = this.value.preview, generation = this.generation, editing = this.editing;
    if (!preview || this.applying) return;
    try {
      await write(preview.packet);
      if (generation === this.generation && editing === this.editing) this.publish({ copied: true });
    } catch {
      if (generation === this.generation && editing === this.editing) this.publish({ copied: false, error: failureText });
    }
  }
}

export interface HandoverRouteOption { value: string; label: string; target: Extract<HandoverTarget, { kind: 'observed' }> }
/** Only capabilities freshly reported for the selected existing conversation are selectable. */
export function handoverRouteOptions(status: ObservedControlStatus | undefined, sessionId: string): HandoverRouteOption[] {
  if (!status || status.sessionId !== sessionId || status.state !== 'ready') return [];
  return status.routes.flatMap(route => route.state === 'ready' ? route.capabilities.filter(capability => capability.available && capability.capabilityId)
    .map(capability => ({ value: capability.capabilityId!, label: `${route.route} · ${capability.action}`,
      target: { kind: 'observed' as const, sessionId, capabilityId: capability.capabilityId! } })) : []);
}

export interface SessionHandoverDialogProps {
  agents: AgentHostApi; state: HostState; session: SessionSummary; t: HandoverMessages;
  initialKind?: HandoverTarget['kind'];
  onClose(): void; onApplied(receipt: HandoverReceipt): void;
}

export function SessionHandoverDialog(props: SessionHandoverDialogProps) {
  const { agents, state, session, t, onClose, onApplied } = props;
  const [controller] = useState(() => new HandoverDialogController(() => undefined, onApplied));
  const ownerState = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const key = handoverDialogSourceKey(session);
  const current = controller.matches(agents, session);
  const dialogState: HandoverDialogState = current ? ownerState : { notes: emptyNotes(), notesEdited: false, copied: false };
  useLayoutEffect(() => { controller.setApplied(onApplied); }, [controller, onApplied]);
  useLayoutEffect(() => {
    if (!controller.matches(agents, session)) { controller.bind(agents, session); void controller.load(); }
  }, [agents, session, controller]);
  useEffect(() => () => controller.invalidate(), [controller]);
  const [kind, setKind] = useState<HandoverTarget['kind']>(props.initialKind ?? 'manual');
  const [connectionId, setConnectionId] = useState(session.connectionId || state.workspaces.find(workspace => workspace.id === session.workspaceId)?.providerProfileId || state.connections[0]?.id || '');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<Effort | ''>('');
  const [observedId, setObservedId] = useState('');
  const [routeId, setRouteId] = useState('');
  const [manualLabel, setManualLabel] = useState('');
  const [routeState, setRouteState] = useState<{ agents: AgentHostApi; key: string; sessionId: string; refresh: number; status?: ObservedControlStatus; busy: boolean; error?: string }>();
  const [confirmedReview, setConfirmedReview] = useState('');
  const [recoveryOperation, setRecoveryOperation] = useState('');
  const recoveryConfirmed = Boolean(dialogState.receipt?.state === 'unknown' && recoveryOperation === dialogState.receipt.operationId);
  const confirmed = Boolean(dialogState.preview && confirmedReview === dialogState.preview.reviewId);
  const [routeRefresh, setRouteRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    if (kind !== 'observed' || !observedId || !agents.observedControlStatus) return;
    const scope = { agents, key, sessionId: observedId, refresh: routeRefresh };
    void Promise.resolve().then(async () => {
      if (!live) return;
      setRouteState({ ...scope, busy: true });
      try {
        const status = await agents.observedControlStatus!(observedId);
        if (live) setRouteState({ ...scope, status, busy: false });
      } catch (failure) { if (live) setRouteState({ ...scope, error: errorMessage(failure), busy: false }); }
    });
    return () => { live = false; };
  }, [agents, key, kind, observedId, routeRefresh]);
  const routeCurrent = routeState?.agents === agents && routeState.key === key && routeState.sessionId === observedId && routeState.refresh === routeRefresh;
  const routeBusy = kind === 'observed' && Boolean(observedId) && (!routeCurrent || Boolean(routeState?.busy));
  const routeError = routeCurrent ? routeState?.error : undefined;
  const invalidate = () => { controller.editTarget(); setConfirmedReview(''); };
  const options = handoverRouteOptions(routeCurrent ? routeState?.status : undefined, observedId);
  const selectedRouteId = routeId || options[0]?.value || '';
  const selectedRoute = options.find(option => option.value === selectedRouteId);
  const connection = state.connections.find(item => item.id === connectionId);
  const destinationSessions = state.sessions.filter(item => item.control === 'observed' && item.workspaceId === session.workspaceId && item.id !== session.id);
  const target: HandoverTarget | undefined = kind === 'native' ? connection ? { kind, connectionId, ...(model.trim() ? { model: model.trim() } : {}), ...(effort ? { effort } : {}) } : undefined
    : kind === 'observed' ? destinationSessions.some(item => item.id === observedId) ? selectedRoute?.target : undefined
      : manualLabel.trim() && (!observedId || destinationSessions.some(item => item.id === observedId)) ? { kind, label: manualLabel.trim(), ...(observedId ? { sessionId: observedId } : {}) } : undefined;
  return <SessionHandoverDialogView t={t} state={dialogState} session={session} supported={Boolean(agents.sessionContinuity && agents.previewHandover && agents.applyHandover)}
    kind={kind} onKind={next => { invalidate(); setRouteId(''); setKind(next); }}
    connectionId={connectionId} connections={state.connections.map(item => ({ value: item.id, label: item.name, description: item.model }))}
    onConnection={next => { invalidate(); setConnectionId(next); setModel(''); setEffort(''); }} model={model} onModel={next => { invalidate(); setModel(next); }}
    effort={effort} onEffort={next => { invalidate(); setEffort(next); }} defaultModel={connection?.model}
    observedId={observedId} observedSessions={destinationSessions.map(item => ({ value: item.id, label: item.title || item.id, description: item.observation?.sourceId }))}
    onObserved={next => { invalidate(); setObservedId(next); setRouteId(''); }}
    routeId={selectedRouteId} routes={options} onRoute={next => { invalidate(); setRouteId(next); }} routeBusy={routeBusy} routeError={routeError}
    onRefreshRoutes={() => { invalidate(); setRouteId(''); setRouteRefresh(value => value + 1); }}
    manualLabel={manualLabel} onManualLabel={next => { invalidate(); setManualLabel(next); }}
    onNote={(field, value) => { setConfirmedReview(''); controller.editNotes(field, value); }} confirmed={confirmed} onConfirm={value => setConfirmedReview(value ? dialogState.preview?.reviewId ?? '' : '')}
    canReview={Boolean(target) && !routeBusy} onReview={() => { if (target) void controller.review(target); }}
    onApply={() => { if (confirmed) void controller.apply(true, crypto.randomUUID()); }}
    onEdit={() => { invalidate(); }} onCopy={() => { void controller.copy(text => navigator.clipboard.writeText(text), t.copyFailed); }}
    onRead={(id, more) => { void controller.read(id, more); }} onClose={onClose}
    canReconcile={Boolean(agents.reconcileHandover)} recoveryConfirmed={recoveryConfirmed}
    onRecoveryConfirm={value => setRecoveryOperation(value ? dialogState.receipt?.operationId ?? '' : '')}
    onReconcile={outcome => { if (recoveryConfirmed) void controller.reconcile(true, outcome); }} />;
}

interface Choice { value: string; label: string; description?: string }
export interface SessionHandoverDialogViewProps {
  t: HandoverMessages; state: HandoverDialogState; session: SessionSummary; supported: boolean;
  kind: HandoverTarget['kind']; onKind(value: HandoverTarget['kind']): void;
  connectionId: string; connections: Choice[]; onConnection(value: string): void;
  model: string; defaultModel?: string; onModel(value: string): void; effort: Effort | ''; onEffort(value: Effort | ''): void;
  observedId: string; observedSessions: Choice[]; onObserved(value: string): void;
  routeId: string; routes: HandoverRouteOption[]; onRoute(value: string): void; routeBusy: boolean; routeError?: string; onRefreshRoutes(): void;
  manualLabel: string; onManualLabel(value: string): void; onNote(key: keyof ContinuityNotes, text: string): void;
  confirmed: boolean; onConfirm(value: boolean): void; canReview: boolean; onReview(): void; onApply(): void; onEdit(): void; onCopy(): void;
  onRead(snapshotId: string, more?: boolean): void; onClose(): void;
  canReconcile?: boolean; recoveryConfirmed?: boolean; onRecoveryConfirm?(value: boolean): void; onReconcile?(outcome: 'accepted' | 'not-delivered'): void;
}

/** Presentation only: every coverage count, packet and delivery receipt comes from the host. */
export function SessionHandoverDialogView(p: SessionHandoverDialogViewProps) {
  const { t, state, session } = p;
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  const applying = state.busy === 'apply' || state.busy === 'reconcile', busy = Boolean(state.busy);
  const locked = applying || state.receipt?.state === 'unknown';
  const canCopy = Boolean(state.receipt && ['manual-ready', 'queued', 'submitted', 'native-ready', 'inspected'].includes(state.receipt.state));
  useEffect(() => {
    const element = dialog.current, focus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (element && !element.open) element.showModal();
    return () => { element?.close(); focus?.focus(); };
  }, []);
  const continuity = state.continuity, preview = state.preview;
  const receiptPanel = state.receipt && <section className="handover-section" role="status"><h3>{t.delivery}: {t.statuses[state.receipt.state]}</h3><p className="small">{t.canonical}: <code>{state.receipt.canonicalId}</code></p>{state.receipt.targetSessionId && <p className="small">{t.targetSession}: <code>{state.receipt.targetSessionId}</code></p>}{state.receipt.problem && <p>{state.receipt.problem}</p>}
        <p className="small">{t.digest}: <code>{state.receipt.packetDigest}</code></p>
        {state.receipt.resolution && <p className="note small">{t.userInspected} · {state.receipt.resolution.outcome === 'accepted' ? t.recoveryAccepted : t.recoveryNotDelivered} · <time dateTime={state.receipt.resolution.at}>{state.receipt.resolution.at}</time></p>}
        <p className="muted small">{t.receiptLimit}</p></section>;
  const recoveryPanel = state.receipt?.state === 'unknown' && <section className="handover-section handover-recovery"><h3>{t.recoveryTitle}</h3><p className="small">{t.recoveryDescription}</p>
        {p.canReconcile ? <><label className="handover-confirm"><input type="checkbox" checked={Boolean(p.recoveryConfirmed)} disabled={busy} onChange={event => p.onRecoveryConfirm?.(event.target.checked)} />{t.recoveryConfirm}</label>
          <div className="row-actions"><button type="button" className="button small" disabled={busy || !p.recoveryConfirmed} onClick={() => p.onReconcile?.('accepted')}>{state.busy === 'reconcile' ? t.recovering : t.recoveryAccepted}</button><button type="button" className="button small" disabled={busy || !p.recoveryConfirmed} onClick={() => p.onReconcile?.('not-delivered')}>{t.recoveryNotDelivered}</button></div></> : <p className="note small">{t.unavailable}</p>}
      </section>;
  return <dialog ref={dialog} className="session-handover-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!applying) p.onClose(); }}>
    <header className="session-handover-header"><h2 id={titleId}>{t.title}</h2><button type="button" className="icon-button" disabled={applying} aria-label={t.close} onClick={p.onClose}><Icon name="close" /></button></header>
    <p className="muted small">{t.description}</p>
    <p className="small"><strong>{t.source}:</strong> {session.title || session.id} <code>{session.id}</code></p>
    {!p.supported ? <p role="status">{t.unavailable}</p> : <>
      {state.busy === 'load' && <p role="status">{t.loading}</p>}
      {continuity && <>
        <p className="small"><strong>{t.canonical}:</strong> <code>{continuity.canonicalId}</code></p>
        {!continuity.persistent && <p className="note small">{t.transient}</p>}
        <details className="handover-section"><summary>{t.coverage} ({continuity.snapshots.length})</summary><p className="muted small">{t.contextLimit}</p>
          <ul className="handover-coverage">{continuity.snapshots.map(snapshot => <li key={snapshot.id}>
            <strong>{snapshot.title || snapshot.sessionId}</strong><code>{snapshot.sourceId} · {snapshot.nativeSessionId || snapshot.sessionId}</code>
            {snapshot.model && <p>{t.model}: <code>{snapshot.model}</code>{snapshot.effort && <> · {t.effort}: <code>{snapshot.effort}</code></>}</p>}
            {snapshot.connectionId && <p>{t.connection}: <code>{snapshot.connectionId}</code></p>}
            <p>{t.coverageModes[snapshot.coverage.mode]} · {t.entries}: {snapshot.coverage.observedEntries} · {t.omitted}: {snapshot.coverage.omittedEntries}</p>
            <p>{t.observedThrough}: <code>{snapshot.coverage.observedThrough || t.unknown}</code></p>
            {snapshot.context ? <p>{t.context}: {snapshot.context.usedTokens.toLocaleString()} / {snapshot.context.windowTokens?.toLocaleString() ?? t.unknown} · {snapshot.context.estimated ? t.estimated : t.reported} · {t.compactions}: {snapshot.context.compactions}</p> : <p>{t.context}: {t.unknown}</p>}
            {snapshot.coverage.limits.length > 0 && <div><strong>{t.limits}</strong><ul>{snapshot.coverage.limits.map((limit, i) => <li key={i}>{limit}</li>)}</ul></div>}
            <button type="button" className="button small" disabled={busy} onClick={() => p.onRead(snapshot.id)}>{t.inspect}</button>
          </li>)}</ul>
        </details>
        <details className="handover-section"><summary>{t.chain} ({continuity.handovers.length})</summary>
          {continuity.handovers.length === 0 ? <p className="muted small">{t.noHandovers}</p> : <ol className="handover-chain">{continuity.handovers.map(receipt => <li key={receipt.operationId}>
            <time dateTime={receipt.at}>{receipt.at}</time><span>{receipt.sourceSessionId} → {receipt.targetLabel || receipt.targetSessionId || (receipt.target.kind === 'manual' ? receipt.target.label : receipt.target.kind)}</span>{receipt.targetLabel && receipt.targetSessionId && <code>{receipt.targetSessionId}</code>}<strong>{t.statuses[receipt.state]}</strong>{receipt.resolution && <span>{t.userInspected}</span>}
          </li>)}</ol>}<p className="muted small">{t.receiptLimit}</p>
        </details>
      </>}
      {state.receipt?.state === 'unknown' && <>{receiptPanel}{recoveryPanel}</>}
      {state.page && <section className="handover-section"><h3>{t.evidence}: {state.page.snapshot.title}</h3>
        <p className="muted small">{t.entries}: {state.page.entries.length ? state.page.offset + 1 : state.page.offset}–{state.page.offset + state.page.entries.length} / {state.page.total}</p><ol className="handover-evidence">{state.page.entries.map(entry => <li key={entry.id}><strong>{entry.kind}</strong><pre>{entry.text}</pre></li>)}</ol>
        {state.page.nextOffset !== undefined && <button type="button" className="button small" disabled={busy} onClick={() => p.onRead(state.page!.snapshot.id, true)}>{t.loadMore}</button>}
      </section>}
      <section className="handover-section"><h3>{t.destination}</h3>
        <Select label={t.destination} value={p.kind} options={(['native', 'observed', 'manual'] as const).map(value => ({ value, label: t[value] }))} onChange={p.onKind} disabled={locked} />
        {p.kind === 'native' && <div className="handover-target-fields">
          <Select label={t.connection} placeholder={t.unknown} value={p.connectionId} options={p.connections} onChange={p.onConnection} disabled={locked} />
          <label>{t.model}<input type="text" value={p.model} placeholder={p.defaultModel || t.defaultValue} maxLength={200} disabled={locked} onChange={event => p.onModel(event.target.value)} /></label>
          <Select label={t.effort} value={p.effort} options={[{ value: '', label: t.defaultValue }, ...EFFORTS.map(value => ({ value, label: value }))]} onChange={p.onEffort} disabled={locked} />
        </div>}
        {p.kind === 'observed' && <div className="handover-target-fields">
          <Select label={t.targetSession} placeholder={t.unknown} value={p.observedId} options={p.observedSessions} onChange={p.onObserved} disabled={locked} />
          <Select label={t.route} placeholder={t.unknown} value={p.routeId} options={p.routes} onChange={p.onRoute} disabled={locked || p.routeBusy || !p.routes.length} />
          <button type="button" className="button small" disabled={locked || p.routeBusy} onClick={p.onRefreshRoutes}>{t.refreshRoutes}</button>
          {p.routeBusy ? <p role="status">{t.loading}</p> : p.observedId && !p.routes.length && <p className="note small">{t.noRoute}</p>}
          {p.routeError && <p className="form-error" role="alert">{p.routeError}</p>}
        </div>}
        {p.kind === 'manual' && <div className="handover-target-fields"><label>{t.manualLabel}<input type="text" maxLength={120} value={p.manualLabel} disabled={locked} onChange={event => p.onManualLabel(event.target.value)} /></label><Select label={t.targetSession} placeholder={t.unknown} value={p.observedId} options={[{ value: '', label: t.manualUnbound }, ...p.observedSessions]} onChange={p.onObserved} disabled={locked} /><p className="muted small">{t.receiptLimit}</p></div>}
      </section>
      <section className="handover-section"><h3>{t.notes}</h3>{continuity?.notesOrigin === 'source-excerpt' && <p className="muted small">{t.sourceExcerpt}</p>}
        <div className="handover-note-fields">{noteKeys.map(field => <label key={field}>{t.fields[field]}<textarea value={state.notes[field]} maxLength={4000} rows={field === 'goal' ? 2 : 3} disabled={locked} onChange={event => p.onNote(field, event.target.value)} /></label>)}</div>
      </section>
      {preview && <section className="handover-section handover-packet" aria-label={t.review}>
        <h3>{t.packet}</h3><p>{preview.targetLabel}</p><p className="small"><strong>{t.digest}:</strong> <code>{preview.packetDigest}</code></p>
        <p className="small">{t.expires}: <time dateTime={preview.expiresAt}>{preview.expiresAt}</time> · {t.omitted}: {preview.packetOmittedEntries}</p>
        <textarea aria-label={t.packet} readOnly value={preview.packet} rows={12} />
        {!state.receipt && <p className="muted small">{t.copyAfterApply}</p>}
        <button type="button" className="button small" disabled={applying || !canCopy} onClick={p.onCopy}><Icon name="copy" />{state.copied ? t.copied : t.copy}</button>
        {!state.receipt && <label className="handover-confirm"><input type="checkbox" checked={p.confirmed} disabled={applying} onChange={event => p.onConfirm(event.target.checked)} />{t.confirm}</label>}
      </section>}
      {state.receipt?.state !== 'unknown' && receiptPanel}
    </>}
    {state.sourceChanged && <p className="note small" role="status">{t.sourceChanged}</p>}
    {state.error && <p className="form-error" role="alert">{state.error}</p>}
    <footer className="row-actions"><button type="button" className="button" disabled={applying} onClick={p.onClose}>{t.cancel}</button>
      {p.supported && state.receipt && state.receipt.state !== 'unknown' && <button type="button" className="button" disabled={busy} onClick={p.onEdit}>{t.edit}</button>}
      {p.supported && (preview && !state.receipt ? <><button type="button" className="button" disabled={busy} onClick={p.onEdit}>{t.edit}</button><button type="button" className="button primary" disabled={busy || !p.confirmed} onClick={p.onApply}>{applying ? t.applying : t.apply}</button></>
        : !state.receipt && <button type="button" className="button primary" disabled={busy || !p.canReview || !continuity} onClick={p.onReview}>{state.busy === 'preview' ? t.reviewing : t.review}</button>)}
    </footer>
  </dialog>;
}
