import { EFFORTS, type Effort } from '@extalia/core';
import type {
  AgentHostApi, ContinuityNotes, ContinuityReadPage, ContinuitySnapshotSummary, ContinuityView,
  HandoverPreview, HandoverPreviewInput, HandoverReceipt, HandoverTarget, HandoverHarnessInventory, HandoverDestinationCreateReceipt, HostState, ObservedControlStatus, SessionSummary,
} from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ObservedAntigravityRecovery, type AntigravityRecoveryMessages } from '../observe/ObservedAntigravityRecovery';
import { ObservedCliResumeSetup, type CliResumeMessages } from '../observe/ObservedCliResumeSetup';
import { ObservedWorkspaceLinkDialog } from '../observe/ObservedWorkspaceLinkDialog';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { AgentAppLogo } from '../ui/OriginMark';
import { RuntimeIcon } from '../setup/RuntimeIcon';
import { Select } from '../ui/Select';
import './sessionHandoverDialog.css';

/** Supplied by the shared EN/ID catalog; user notes and source excerpts remain literal. */
export interface HandoverMessages {
  flow: {
    checkpoint: string; checkpointHint: string; latestHint: string; capturedAt: string; frozenHint: string;
    sourceActive: string; sourceIdle: string; sourceApproval: string; sourceUnknown: string; partial: string;
    ready: string; needsSetup: string; manualOnly: string; manualAction: string; openSettings: string; openDestination: string;
    workspaceRequired: string; associateWorkspace: string; enableWorkspace: string; enableWorkspaceHint: string;
    mergeTitle: string; mergeHint: string; mergeConfirm: string; reviewMerge: string; reviewedMerge: string; nextHandover: string;
    checkGatewayCreate: string; creationProfile: string;
  };
  harness?: HandoverHarnessMessages; title: string; description: string; close: string; loading: string; unavailable: string;
  canonical: string; source: string; destination: string; native: string; observed: string; manual: string;
  connection: string; model: string; effort: string; defaultValue: string; targetSession: string;
  cliResume?: string; route: string; refreshRoutes: string; noRoute: string; manualLabel: string; manualUnbound: string;
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
const observedSourceIdentity = (session: SessionSummary) => JSON.stringify([session.observation?.sourceId, session.observation?.nativeSessionId, session.observation?.projectPath]);
type Busy = 'load' | 'preview' | 'apply' | 'read' | 'reconcile' | undefined;
export interface HandoverDialogState {
  busy?: Busy; continuity?: ContinuityView; notes: ContinuityNotes; notesEdited: boolean;
  preview?: HandoverPreview; receipt?: HandoverReceipt; page?: ContinuityReadPage;
  error?: string; copied: boolean; sourceChanged?: boolean;
}

/** A UI ownership key, not a claim about hidden provider state or a substitute for host review validation. */
export function handoverDialogSourceKey(session: SessionSummary, checkpoint = false, scope = ''): string {
  return JSON.stringify([session.id, session.workspaceId, session.connectionId,
    ...(checkpoint ? [] : [session.lastActiveAt, session.running, session.context, session.model, session.effort]),
    session.options, session.runtime, session.projectLocation, session.observation?.sourceId,
    session.observation?.nativeSessionId, session.observation?.projectPath, session.observation?.watching, session.observation?.status, scope, checkpoint]);
}

/** Keeps old preview/read/clipboard acknowledgements from crossing a host, source or edit boundary. */
export class HandoverDialogController {
  value: HandoverDialogState = { notes: emptyNotes(), notesEdited: false, copied: false };
  private agents?: AgentHostApi;
  private sessionId = '';
  private workspaceId = '';
  private sourceIdentity = '';
  private key = '';
  private scope = '';
  private authorityScope = '';
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
  matches(agents: AgentHostApi, session: SessionSummary, checkpoint = false, scope = ''): boolean { return this.agents === agents && this.key === handoverDialogSourceKey(session, checkpoint, scope); }
  bind(agents: AgentHostApi, session: SessionSummary, checkpoint = false, scope = '', authorityScope = scope): void {
    const key = handoverDialogSourceKey(session, checkpoint, scope);
    if (this.agents === agents && key === this.key) return;
    const sourceIdentity = observedSourceIdentity(session);
    const sameOwner = this.agents === agents && this.sessionId === session.id && this.workspaceId === session.workspaceId && this.sourceIdentity === sourceIdentity && this.authorityScope === authorityScope;
    const sameDraft = sameOwner && this.scope === scope;
    const previous = this.value;
    // Once admitted, an apply receipt still belongs to this same source identity even if activity advances.
    if (sameOwner && this.applying) { this.key = key; this.scope = scope; return; }
    this.generation++; this.editing++; this.reading++; this.loading++;
    this.agents = agents; this.sessionId = session.id; this.workspaceId = session.workspaceId; this.sourceIdentity = sourceIdentity; this.scope = scope; this.authorityScope = authorityScope; this.key = key; this.applying = false;
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
  async review(target: HandoverTarget, options: Pick<HandoverPreviewInput, 'capture' | 'mergeTargetChain'> = {}): Promise<void> {
    const host = this.agents;
    if (!host?.previewHandover || this.value.busy || this.applying || this.value.receipt?.state === 'unknown') return;
    const generation = this.generation, editing = ++this.editing;
    const current = () => generation === this.generation && editing === this.editing;
    this.publish({ busy: 'preview', preview: undefined, receipt: undefined, copied: false, error: undefined });
    try {
      const preview = await host.previewHandover(this.sessionId, { target, notes: { ...this.value.notes }, ...options });
      if (current() && preview.sourceSessionId === this.sessionId) this.publish({ preview });
    } catch (failure) { if (current()) this.publish({ error: errorMessage(failure) }); }
    finally { if (current()) this.publish({ busy: undefined }); }
  }
  async apply(confirmed: boolean, operationId: string): Promise<void> {
    const host = this.agents, preview = this.value.preview;
    if (!host?.applyHandover || !preview || preview.targetChain?.requiresConsent || !confirmed || this.value.busy || this.applying || this.value.receipt) return;
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
export function handoverRouteOptions(status: ObservedControlStatus | undefined, sessionId: string, cliResumeLabel?: string): HandoverRouteOption[] {
  if (!status || status.sessionId !== sessionId || status.state !== 'ready') return [];
  const priority = (route: ObservedControlStatus['routes'][number]) => ['codex-native', 'hermes-native', 'antigravity-native'].includes(route.route) ? 0 : route.route === 'official-cli-resume' ? 1 : 2;
  return [...status.routes].sort((a, b) => priority(a) - priority(b)).flatMap(route => route.state === 'ready' ? route.capabilities.filter(capability => capability.available && capability.capabilityId)
    .map(capability => ({ value: capability.capabilityId!, label: route.route === 'official-cli-resume' && cliResumeLabel ? cliResumeLabel : `${route.route} · ${capability.action}`,
      target: { kind: 'observed' as const, sessionId, capabilityId: capability.capabilityId! } })) : []);
}

export interface HandoverHarnessMessages {
  title: string; description: string; conversation: string; newConversation: string; noConversation: string;
  needsSetup: string; unavailableConversation: string; advanced: string; reviewDetails: string; nativeHint: string;
  pendingCreation: string; inspectPending: string; inspectingPending: string; pendingNativeId: string; refresh: string; create: string; creating: string; created: string; creationUnknown: string;
  reasons: Record<'no-connection' | 'setup-required' | 'adapter-unavailable' | 'runtime-unavailable', string>;
  names: Record<string, string>;
}
export interface HandoverHarnessCard {
  id: string; label: string; sessionIds: string[]; createConnectionId?: string; canCreate?: boolean; unavailableReason?: string;
  existing?: 'ready' | 'setup-required' | 'unsupported';
  createNeedsSetup?: boolean; creationProfile?: string;
}
const harnessId = (sourceId: string) => sourceId === 'claude-code' ? 'claude' : sourceId === 'gemini-cli' ? 'gemini' : sourceId === 'open-code' ? 'opencode' : sourceId;
/** Conservative compatibility catalog: observed ownership never implies a send/create capability. */
export function handoverHarnessCards(state: HostState, source: SessionSummary, names: Record<string, string>): HandoverHarnessCard[] {
  const workspace = state.workspaces.find(workspace => workspace.id === source.workspaceId);
  const connection = workspace && (state.connections.find(item => item.id === workspace.providerProfileId && item.credentialStatus !== 'missing')
    ?? state.connections.find(item => item.credentialStatus !== 'missing'));
  const cards: HandoverHarnessCard[] = [{ id: 'extalia', label: names.extalia ?? 'Extalia', sessionIds: [], ...(connection ? { createConnectionId: connection.id, canCreate: true } : {}) }];
  for (const session of state.sessions) {
    if (session.control !== 'observed' || !session.observation?.sourceId) continue;
    const id = harnessId(session.observation.sourceId);
    let card = cards.find(item => item.id === id);
    if (!card) { card = { id, label: names[id] ?? session.observation.sourceId, sessionIds: [], existing: 'setup-required' }; cards.push(card); }
    if (Boolean(source.workspaceId) && session.workspaceId === source.workspaceId && session.id !== source.id) card.sessionIds.push(session.id);
  }
  return cards;
}

export interface HandoverHarnessState {
  inventory?: HandoverHarnessInventory; busy?: 'load' | 'create'; receipt?: HandoverDestinationCreateReceipt;
  createdSession?: SessionSummary; error?: string;
}
/** A validated creation receipt can extend the passive inventory before its next refresh. */
export function handoverDestinationSessions(state: HostState, source: SessionSummary, harnessState: HandoverHarnessState): SessionSummary[] {
  const { inventory, receipt } = harnessState;
  if (inventory && inventory.sourceSessionId !== source.id) return [];
  const ids = inventory ? new Set(inventory.harnesses.flatMap(item => item.sessionIds)) : undefined;
  const candidate = harnessState.createdSession;
  const created = candidate && (state.sessions.find(item => item.id === candidate.id) ?? candidate);
  const harness = inventory?.harnesses.find(item => item.id === receipt?.harnessId);
  const accepted = created && receipt?.state === 'created' && receipt.sessionId === created.id
    && created.id !== source.id && created.workspaceId === source.workspaceId && created.control === 'observed'
    && harness?.sourceIds.includes(created.observation?.sourceId ?? '');
  const known = accepted && !state.sessions.some(item => item.id === created.id) ? [...state.sessions, created] : state.sessions;
  if (accepted) ids?.add(created.id);
  return known.filter(item => item.control === 'observed' && item.id !== source.id
    && (ids ? ids.has(item.id) : Boolean(source.workspaceId) && item.workspaceId === source.workspaceId));
}
/** Inventory is passive; creation is one explicit operation and is never automatically repeated. */
export class HandoverHarnessController {
  value: HandoverHarnessState = {};
  private agents?: AgentHostApi;
  private source?: SessionSummary;
  private key = '';
  private authorityScope = '';
  private generation = 0;
  private creating = false;
  private readonly listeners = new Set<() => void>();
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.value;
  private publish(next: Partial<HandoverHarnessState>) { this.value = { ...this.value, ...next }; for (const listener of this.listeners) listener(); }
  matches(agents: AgentHostApi, source: SessionSummary, checkpoint = false, scope = '') { return this.agents === agents && this.key === handoverDialogSourceKey(source, checkpoint, scope); }
  bind(agents: AgentHostApi, source: SessionSummary, checkpoint = false, scope = '', authorityScope = scope) {
    if (this.matches(agents, source, checkpoint, scope)) return;
    const same = this.agents === agents && this.source?.id === source.id && this.source.workspaceId === source.workspaceId
      && observedSourceIdentity(this.source) === observedSourceIdentity(source) && this.authorityScope === authorityScope;
    this.generation++; this.agents = agents; this.source = source; this.authorityScope = authorityScope; this.key = handoverDialogSourceKey(source, checkpoint, scope);
    this.value = { ...(same ? { receipt: this.value.receipt, createdSession: this.value.createdSession } : {}), ...(this.creating ? { busy: 'create' as const } : {}) }; this.publish({});
  }
  invalidate() { this.generation++; this.agents = undefined; this.key = ''; }
  async load() {
    const agents = this.agents, source = this.source, generation = this.generation;
    if (!agents?.handoverHarnesses || !source || this.value.busy || this.creating) return;
    this.publish({ busy: 'load', error: undefined });
    try {
      const inventory = await agents.handoverHarnesses(source.id);
      if (generation !== this.generation) return;
      if (inventory.sourceSessionId !== source.id) throw new Error('HANDOVER_HARNESS_WRONG_SOURCE');
      this.publish({ inventory });
    } catch (failure) { if (generation === this.generation) this.publish({ error: errorMessage(failure) }); }
    finally { if (generation === this.generation) this.publish({ busy: undefined }); }
  }
  async create(harnessId: string): Promise<void> {
    const inventory = this.value.inventory;
    if (!inventory || inventory.pendingCreation?.harnessId === harnessId || this.value.receipt?.state === 'unknown'
      || this.value.receipt?.state === 'created' && this.value.receipt.harnessId === harnessId) return;
    if (!['ready', 'setup-required'].includes(inventory.harnesses.find(item => item.id === harnessId)?.create ?? '')) return;
    await this.performCreation(harnessId, crypto.randomUUID());
  }
  /** Explicit inspection reuses the persisted operation; it never requests a fresh destination. */
  async inspectPending(): Promise<void> {
    const pending = this.value.inventory?.pendingCreation;
    if (!pending) return;
    await this.performCreation(pending.harnessId, pending.operationId);
  }
  private async performCreation(harnessId: string, operationId: string): Promise<void> {
    const agents = this.agents, source = this.source, inventory = this.value.inventory, generation = this.generation;
    if (!agents?.createHandoverDestination || !source || !inventory || harnessId === 'extalia' || this.creating || this.value.busy) return;
    const harness = inventory.harnesses.find(item => item.id === harnessId);
    if (!harness) return;
    this.creating = true; this.publish({ busy: 'create', receipt: undefined, createdSession: undefined, error: undefined });
    let receipt: HandoverDestinationCreateReceipt | undefined;
    try {
      receipt = await agents.createHandoverDestination(source.id, { harnessId, revision: inventory.revision, operationId });
      if (generation !== this.generation) return;
      if (receipt.operationId !== operationId || receipt.harnessId !== harnessId) { receipt = undefined; throw new Error('HANDOVER_HARNESS_WRONG_SOURCE'); }
      if (receipt.state !== 'created') { this.publish({ receipt }); return; }
      // A successful creation is never repeated if the following state refresh fails.
      this.publish({ receipt });
      const state = await agents.getState();
      if (generation !== this.generation) return;
      const createdSession = state.sessions.find(item => item.id === receipt!.sessionId && item.id !== source.id && item.workspaceId === source.workspaceId
        && item.control === 'observed' && harness.sourceIds.includes(item.observation?.sourceId ?? ''));
      if (!createdSession) throw new Error('HANDOVER_HARNESS_WRONG_SOURCE');
      this.publish({ createdSession });
    } catch (failure) {
      if (generation === this.generation) this.publish({ error: errorMessage(failure), receipt: receipt?.state === 'created' ? receipt : { operationId, harnessId, state: 'unknown', retryable: false } });
    } finally {
      this.creating = false;
      if (generation === this.generation) this.publish({ busy: undefined });
      else if (this.agents) { this.publish({ busy: undefined }); void this.load(); }
    }
  }
}

export function handoverHarnessInventoryCards(inventory: HandoverHarnessInventory, state: HostState, source: SessionSummary, t: HandoverHarnessMessages): HandoverHarnessCard[] {
  if (inventory.sourceSessionId !== source.id) return [];
  const workspace = state.workspaces.find(workspace => workspace.id === source.workspaceId);
  const connection = workspace && (state.connections.find(item => item.id === workspace.providerProfileId && item.credentialStatus !== 'missing')
    ?? state.connections.find(item => item.credentialStatus !== 'missing'));
  return inventory.harnesses.filter(item => item.evidence.length > 0).map(item => ({ id: item.id, label: t.names[item.id] ?? item.id,
    existing: item.existing, ...(item.create === 'setup-required' ? { createNeedsSetup: true } : {}), ...(item.creationProfile ? { creationProfile: item.creationProfile } : {}),
    sessionIds: item.sessionIds.filter(id => state.sessions.some(session => session.id === id && session.id !== source.id && session.control === 'observed' && item.sourceIds.includes(session.observation?.sourceId ?? ''))),
    canCreate: ['ready', 'setup-required'].includes(item.create) && (item.id !== 'extalia' || Boolean(connection)) && inventory.pendingCreation?.harnessId !== item.id, ...(item.id === 'extalia' && item.create === 'ready' && connection ? { createConnectionId: connection.id } : {}),
    ...(item.reason ? { unavailableReason: t.reasons[item.reason] } : {}) }));
}

export interface SessionHandoverDialogProps {
  agents: AgentHostApi; state: HostState; session: SessionSummary; t: HandoverMessages;
  initialKind?: HandoverTarget['kind']; cliResumeMessages?: CliResumeMessages; antigravityMessages?: AntigravityRecoveryMessages;
  workspaceLinkMessages?: Messages['observedWorkspaceLink']; onState?(state: HostState): void; onOpenSettings?(): void;
  destinationSetup?(session: SessionSummary, onChanged: () => void): ReactNode;
  onOpenDestination?(sessionId: string): void;
  onClose(): void; onApplied(receipt: HandoverReceipt): void;
}

export function SessionHandoverDialog(props: SessionHandoverDialogProps) {
  const { agents, state, session, t, onClose, onApplied, cliResumeMessages, antigravityMessages } = props;
  const [checkpoint, setCheckpoint] = useState(true);
  const [associationOpen, setAssociationOpen] = useState(false);
  const workspace = state.workspaces.find(item => item.id === session.workspaceId);
  const authorityScope = JSON.stringify([state.profile?.id, state.dataDirectory, state.host?.instanceId]);
  const scope = JSON.stringify([authorityScope, workspace?.projectLocation, workspace?.additionalProjectLocations, workspace?.crossWorkspaceAccess, workspace?.mode]);
  const [controller] = useState(() => new HandoverDialogController(() => undefined, onApplied));
  const ownerState = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const key = handoverDialogSourceKey(session, checkpoint, scope);
  const current = controller.matches(agents, session, checkpoint, scope);
  const dialogState: HandoverDialogState = current ? ownerState : { notes: emptyNotes(), notesEdited: false, copied: false };
  useLayoutEffect(() => { controller.setApplied(onApplied); }, [controller, onApplied]);
  useLayoutEffect(() => {
    if (!controller.matches(agents, session, checkpoint, scope)) { controller.bind(agents, session, checkpoint, scope, authorityScope); void controller.load(); }
  }, [agents, session, controller, checkpoint, scope, authorityScope]);
  useEffect(() => () => controller.invalidate(), [controller]);
  const [harnessOwner] = useState(() => new HandoverHarnessController());
  const harnessOwnerState = useSyncExternalStore(harnessOwner.subscribe, harnessOwner.getSnapshot, harnessOwner.getSnapshot);
  const harnessState = harnessOwner.matches(agents, session, checkpoint, scope) ? harnessOwnerState : {};
  useLayoutEffect(() => { if (!harnessOwner.matches(agents, session, checkpoint, scope)) { harnessOwner.bind(agents, session, checkpoint, scope, authorityScope); void harnessOwner.load(); } }, [agents, session, harnessOwner, checkpoint, scope, authorityScope]);
  useEffect(() => () => harnessOwner.invalidate(), [harnessOwner]);

  const [kind, setKind] = useState<HandoverTarget['kind']>(props.initialKind ?? (session.control === 'observed' ? 'observed' : 'manual'));
  const [connectionId, setConnectionId] = useState(session.connectionId || state.workspaces.find(workspace => workspace.id === session.workspaceId)?.providerProfileId || state.connections[0]?.id || '');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<Effort | ''>('');
  const [observedId, setObservedId] = useState('');
  const [harnessSelection, setHarnessSelection] = useState(props.initialKind === 'native' ? 'extalia' : '');
  const [routeId, setRouteId] = useState('');
  const [manualLabel, setManualLabel] = useState('');
  const [routeState, setRouteState] = useState<{ agents: AgentHostApi; key: string; sessionId: string; refresh: number; status?: ObservedControlStatus; busy: boolean; error?: string }>();
  const [confirmedReview, setConfirmedReview] = useState('');
  const [mergeReview, setMergeReview] = useState('');
  const [nativeConsent, setNativeConsent] = useState('');
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
  const invalidate = () => { controller.editTarget(); setConfirmedReview(''); setMergeReview(''); };
  const options = handoverRouteOptions(routeCurrent ? routeState?.status : undefined, observedId, t.cliResume);
  const selectedRouteId = routeId || options[0]?.value || '';
  const selectedRoute = options.find(option => option.value === selectedRouteId);
  const connection = state.connections.find(item => item.id === connectionId);
  const nativeConsentKey = JSON.stringify([scope, session.id, workspace?.id, connectionId]);
  const nativeNeedsEnablement = workspace?.mode === 'observe';
  const nativeEnabled = nativeConsent === nativeConsentKey;
  const destinationSessions = handoverDestinationSessions(state, session, harnessState);
  const knownSessions = [...state.sessions, ...destinationSessions.filter(item => !state.sessions.some(known => known.id === item.id))];
  const destination = destinationSessions.find(item => item.id === observedId);
  const harnesses = t.harness ? harnessState.inventory ? handoverHarnessInventoryCards(harnessState.inventory, { ...state, sessions: knownSessions }, session, t.harness) : handoverHarnessCards(state, session, t.harness.names) : undefined;
  const createdCard = harnesses?.find(item => item.id === harnessState.receipt?.harnessId);
  if (createdCard && harnessState.createdSession && destinationSessions.some(item => item.id === harnessState.createdSession?.id)
    && !createdCard.sessionIds.includes(harnessState.createdSession.id)) createdCard.sessionIds.push(harnessState.createdSession.id);
  const chosenHarness = harnesses?.find(item => item.id === harnessSelection);
  const harnessSessions = chosenHarness ? destinationSessions.filter(item => chosenHarness.sessionIds.includes(item.id)) : [];
  const selectHarness = (id: string) => {
    const card = harnesses?.find(item => item.id === id); if (!card) return;
    invalidate(); setHarnessSelection(id); setRouteId('');
    if (id === 'extalia') {
      setKind('native');
      if (card.createConnectionId && card.createConnectionId !== connectionId) { setConnectionId(card.createConnectionId); setModel(''); setEffort(''); }
      setObservedId('');
    }
    else { setKind('observed'); setObservedId(card.sessionIds.length === 1 ? card.sessionIds[0]! : ''); }
  };
  const selectCreatedDestination = (expectedHarness?: string) => {
    const created = harnessOwner.value.createdSession, receipt = harnessOwner.value.receipt;
    if (!created || !receipt || expectedHarness && receipt.harnessId !== expectedHarness || !harnessOwner.matches(agents, session, checkpoint, scope)) return;
    controller.editTarget(); setConfirmedReview(''); setHarnessSelection(receipt.harnessId); setKind('observed'); setObservedId(created.id); setRouteId(''); setRouteRefresh(value => value + 1);
  };
  const cliResumeSetup = kind === 'observed' && cliResumeMessages && destination && ['codex', 'gemini-cli', 'claude-code'].includes(destination.observation?.sourceId ?? '')
    ? (compact: boolean, onExpand: () => void) => <ObservedCliResumeSetup compact={compact} onExpand={onExpand} agents={agents} sessionId={destination.id} sourceKey={handoverDialogSourceKey(destination)} t={cliResumeMessages}
      disabled={Boolean(dialogState.busy || dialogState.receipt?.state === 'unknown')} onChanged={() => { invalidate(); setRouteId(''); setRouteRefresh(value => value + 1); }} /> : undefined;
  const nativeRecovery = antigravityMessages && destination?.observation?.sourceId === 'antigravity' ? <ObservedAntigravityRecovery agents={agents} session={destination} t={antigravityMessages} disabled={Boolean(dialogState.busy)} onChanged={() => { invalidate(); setRouteId(''); setRouteRefresh(value => value + 1); }} /> : undefined;
  const destinationSetup = kind === 'observed' && destination ? props.destinationSetup?.(destination, () => { invalidate(); setRouteId(''); setRouteRefresh(value => value + 1); }) : undefined;
  const target: HandoverTarget | undefined = kind === 'native' ? connection ? { kind, connectionId, ...(model.trim() ? { model: model.trim() } : {}), ...(effort ? { effort } : {}),
    ...(nativeNeedsEnablement && nativeEnabled ? { enableManagedWorkspace: true as const } : {}) } : undefined
    : kind === 'observed' ? destinationSessions.some(item => item.id === observedId) ? selectedRoute?.target : undefined
      : manualLabel.trim() && (!observedId || destinationSessions.some(item => item.id === observedId)) ? { kind, label: manualLabel.trim(), ...(observedId ? { sessionId: observedId } : {}) } : undefined;
  const previewOptions: Pick<HandoverPreviewInput, 'capture'> = checkpoint ? { capture: 'checkpoint' } : {};
  const mergeConfirmed = Boolean(dialogState.preview && mergeReview === dialogState.preview.reviewId);
  const reviewMerge = () => {
    const proposal = dialogState.preview?.targetChain;
    if (target && proposal?.requiresConsent && mergeConfirmed) {
      setConfirmedReview(''); setMergeReview('');
      void controller.review(target, { ...previewOptions, mergeTargetChain: { canonicalId: proposal.canonicalId, revision: proposal.revision } });
    }
  };
  const canAssociate = session.control === 'observed' && Boolean(props.workspaceLinkMessages && props.onState && agents.observedWorkspaceLink && agents.setObservedWorkspaceLink);
  return <><SessionHandoverDialogView t={t} state={dialogState} session={session} supported={Boolean(agents.sessionContinuity && agents.previewHandover && agents.applyHandover)}
    checkpoint={checkpoint} onCheckpoint={value => { invalidate(); setCheckpoint(value); }}
    sourceWorkspace={workspace?.name} onAssociate={canAssociate ? () => setAssociationOpen(true) : undefined} onOpenSettings={props.onOpenSettings}
    nativeNeedsEnablement={nativeNeedsEnablement} nativeEnabled={nativeEnabled} nativeAssociated={Boolean(workspace)}
    onNativeEnable={value => { invalidate(); setNativeConsent(value ? nativeConsentKey : ''); }}
    mergeConfirmed={mergeConfirmed} onMergeConfirm={value => setMergeReview(value ? dialogState.preview?.reviewId ?? '' : '')} onReviewMerge={reviewMerge}
    onManualFallback={() => { invalidate(); setKind('manual'); setManualLabel(chosenHarness?.label ?? ''); }}
    onOpenDestination={props.onOpenDestination && dialogState.receipt?.targetSessionId ? () => props.onOpenDestination!(dialogState.receipt!.targetSessionId!) : undefined}
    kind={kind} onKind={next => { invalidate(); setRouteId(''); setKind(next); setHarnessSelection(next === 'native' ? 'extalia' : ''); }}
    harnesses={harnesses} harnessState={harnessState} onCreateConversation={() => { invalidate(); void harnessOwner.create(harnessSelection).then(() => selectCreatedDestination(harnessSelection)); }} onInspectPending={() => { invalidate(); void harnessOwner.inspectPending().then(() => selectCreatedDestination(harnessOwner.value.inventory?.pendingCreation?.harnessId)); }} onRefreshHarnesses={() => { void harnessOwner.load(); }} harnessId={harnessSelection} onHarness={selectHarness} harnessSessions={harnessSessions.map(item => ({ value: item.id, label: item.title || item.id }))}
    connectionId={connectionId} connections={state.connections.map(item => ({ value: item.id, label: item.name, description: item.model }))}
    onConnection={next => { invalidate(); setConnectionId(next); setModel(''); setEffort(''); }} model={model} onModel={next => { invalidate(); setModel(next); }}
    effort={effort} onEffort={next => { invalidate(); setEffort(next); }} defaultModel={connection?.model}
    observedId={observedId} observedSessions={destinationSessions.map(item => ({ value: item.id, label: item.title || item.id, description: item.observation?.sourceId }))}
    onObserved={next => { invalidate(); setObservedId(next); setRouteId(''); }}
    routeId={selectedRouteId} routes={options} onRoute={next => { invalidate(); setRouteId(next); }} routeBusy={routeBusy} routeError={routeError}
    onRefreshRoutes={() => { invalidate(); setRouteId(''); setRouteRefresh(value => value + 1); }}
    cliResumeSetup={cliResumeSetup} nativeRecovery={nativeRecovery} destinationSetup={destinationSetup} manualLabel={manualLabel} onManualLabel={next => { invalidate(); setManualLabel(next); }}
    onNote={(field, value) => { setConfirmedReview(''); controller.editNotes(field, value); }} confirmed={confirmed} onConfirm={value => setConfirmedReview(value ? dialogState.preview?.reviewId ?? '' : '')}
    canReview={Boolean(target) && !routeBusy && !harnessState.busy && harnessState.receipt?.state !== 'unknown' && (!harnessSelection || Boolean(chosenHarness))
      && (kind !== 'native' || Boolean(workspace && connection?.credentialStatus !== 'missing') && (!nativeNeedsEnablement || nativeEnabled))}
    onReview={() => { if (target) void controller.review(target, previewOptions); }}
    onApply={() => { if (confirmed) void controller.apply(true, crypto.randomUUID()); }}
    onEdit={() => { invalidate(); }} onCopy={() => { void controller.copy(text => navigator.clipboard.writeText(text), t.copyFailed); }}
    onRead={(id, more) => { void controller.read(id, more); }} onClose={onClose}
    canReconcile={Boolean(agents.reconcileHandover)} recoveryConfirmed={recoveryConfirmed}
    onRecoveryConfirm={value => setRecoveryOperation(value ? dialogState.receipt?.operationId ?? '' : '')}
    onReconcile={outcome => { if (recoveryConfirmed) void controller.reconcile(true, outcome); }} />
    {associationOpen && canAssociate && <ObservedWorkspaceLinkDialog agents={agents} session={session} state={state} t={props.workspaceLinkMessages!}
      onClose={() => setAssociationOpen(false)} onState={next => { setAssociationOpen(false); invalidate(); props.onState!(next); }} />}
  </>;
}

interface Choice { value: string; label: string; description?: string }
export interface SessionHandoverDialogViewProps {
  t: HandoverMessages; state: HandoverDialogState; session: SessionSummary; supported: boolean;
  checkpoint?: boolean; onCheckpoint?(value: boolean): void; sourceWorkspace?: string; onAssociate?(): void; onOpenSettings?(): void;
  nativeNeedsEnablement?: boolean; nativeEnabled?: boolean; nativeAssociated?: boolean; onNativeEnable?(value: boolean): void;
  mergeConfirmed?: boolean; onMergeConfirm?(value: boolean): void; onReviewMerge?(): void;
  onManualFallback?(): void; onOpenDestination?(): void;
  harnessState?: HandoverHarnessState; onCreateConversation?(): void; onInspectPending?(): void; onRefreshHarnesses?(): void; harnesses?: HandoverHarnessCard[]; harnessId?: string; onHarness?(value: string): void; harnessSessions?: Choice[];
  kind: HandoverTarget['kind']; onKind(value: HandoverTarget['kind']): void;
  connectionId: string; connections: Choice[]; onConnection(value: string): void;
  model: string; defaultModel?: string; onModel(value: string): void; effort: Effort | ''; onEffort(value: Effort | ''): void;
  observedId: string; observedSessions: Choice[]; onObserved(value: string): void;
  routeId: string; routes: HandoverRouteOption[]; onRoute(value: string): void; routeBusy: boolean; routeError?: string; onRefreshRoutes(): void;
  nativeRecovery?: ReactNode; destinationSetup?: ReactNode; cliResumeSetup?: (compact: boolean, onExpand: () => void) => ReactNode; manualLabel: string; onManualLabel(value: string): void; onNote(key: keyof ContinuityNotes, text: string): void;
  confirmed: boolean; onConfirm(value: boolean): void; canReview: boolean; onReview(): void; onApply(): void; onEdit(): void; onCopy(): void;
  onRead(snapshotId: string, more?: boolean): void; onClose(): void;
  canReconcile?: boolean; recoveryConfirmed?: boolean; onRecoveryConfirm?(value: boolean): void; onReconcile?(outcome: 'accepted' | 'not-delivered'): void;
}

/** Presentation only: every coverage count, packet and delivery receipt comes from the host. */
export function SessionHandoverDialogView(p: SessionHandoverDialogViewProps) {
  const { t, state, session } = p;
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId(), radioName = useId();
  const [advanced, setAdvanced] = useState(false);
  const simple = Boolean(t.harness && p.harnesses);
  const chosenHarness = p.harnesses?.find(item => item.id === p.harnessId);
  const pendingCreation = p.harnessState?.inventory?.pendingCreation;
  const unresolvedCreation = pendingCreation && !(p.harnessState?.createdSession && p.harnessState.receipt?.state === 'created' && p.harnessState.receipt.operationId === pendingCreation.operationId);
  const applying = state.busy === 'apply' || state.busy === 'reconcile', busy = Boolean(state.busy);
  const locked = applying || state.receipt?.state === 'unknown' || p.harnessState?.busy === 'create' || p.harnessState?.receipt?.state === 'unknown';
  const canCopy = Boolean(state.receipt && ['manual-ready', 'queued', 'submitted', 'native-ready', 'inspected'].includes(state.receipt.state));
  useEffect(() => {
    const element = dialog.current, focus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (element && !element.open) element.showModal();
    return () => { element?.close(); focus?.focus(); };
  }, []);
  const continuity = state.continuity, preview = state.preview;
  const captured = preview?.checkpoint;
  const activity = captured?.activity ?? (session.pendingApprovalId ? 'approval' : session.running ? 'active' : 'idle');
  const activityLabel = activity === 'active' ? t.flow.sourceActive : activity === 'approval' ? t.flow.sourceApproval : activity === 'idle' ? t.flow.sourceIdle : t.flow.sourceUnknown;
  const receiptPanel = state.receipt && <section className="handover-section" role="status"><h3>{t.delivery}: {t.statuses[state.receipt.state]}</h3>{simple && state.receipt.targetLabel && <p>{state.receipt.targetLabel}</p>}{(!simple || advanced) && <><p className="small">{t.canonical}: <code>{state.receipt.canonicalId}</code></p>{state.receipt.targetSessionId && <p className="small">{t.targetSession}: <code>{state.receipt.targetSessionId}</code></p>}<p className="small">{t.digest}: <code>{state.receipt.packetDigest}</code></p></>}{state.receipt.problem && <p>{state.receipt.problem}</p>}
        {state.receipt.resolution && <p className="note small">{t.userInspected} · {state.receipt.resolution.outcome === 'accepted' ? t.recoveryAccepted : t.recoveryNotDelivered} · <time dateTime={state.receipt.resolution.at}>{state.receipt.resolution.at}</time></p>}
        <p className="muted small">{t.receiptLimit}</p>{canCopy && p.onOpenDestination && <button type="button" className="button" onClick={p.onOpenDestination}>{t.flow.openDestination}</button>}</section>;
  const recoveryPanel = state.receipt?.state === 'unknown' && <section className="handover-section handover-recovery"><h3>{t.recoveryTitle}</h3><p className="small">{t.recoveryDescription}</p>
        {p.canReconcile ? <><label className="handover-confirm"><input type="checkbox" checked={Boolean(p.recoveryConfirmed)} disabled={busy} onChange={event => p.onRecoveryConfirm?.(event.target.checked)} />{t.recoveryConfirm}</label>
          <div className="row-actions"><button type="button" className="button small" disabled={busy || !p.recoveryConfirmed} onClick={() => p.onReconcile?.('accepted')}>{state.busy === 'reconcile' ? t.recovering : t.recoveryAccepted}</button><button type="button" className="button small" disabled={busy || !p.recoveryConfirmed} onClick={() => p.onReconcile?.('not-delivered')}>{t.recoveryNotDelivered}</button></div></> : <p className="note small">{t.unavailable}</p>}
      </section>;
  return <dialog ref={dialog} className={`session-handover-dialog${simple && !advanced ? ' handover-simple-dialog' : ''}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!applying) p.onClose(); }}>
    <header className="session-handover-header"><h2 id={titleId}>{t.title}</h2><button type="button" className="icon-button" disabled={applying} aria-label={t.close} onClick={p.onClose}><Icon name="close" /></button></header>
    <p className="muted small">{simple ? t.harness!.description : t.description}</p>
    <p className="small"><strong>{t.source}:</strong> {session.title || session.id} {(!simple || advanced) && <code>{session.id}</code>}</p>
    {!p.supported ? <p role="status">{t.unavailable}</p> : <>
      {state.busy === 'load' && <p role="status">{t.loading}</p>}
      <section className="handover-section handover-source-state">
        <p className="small"><strong>{activityLabel}</strong>{p.sourceWorkspace && <> · {p.sourceWorkspace}</>}</p>
        {p.onCheckpoint && <label className="handover-confirm"><input type="checkbox" checked={Boolean(p.checkpoint)} disabled={locked || busy} onChange={event => p.onCheckpoint?.(event.target.checked)} />{t.flow.checkpoint}</label>}
        {p.onCheckpoint && <p className="muted small">{p.checkpoint ? t.flow.checkpointHint : t.flow.latestHint}</p>}
        {captured && <><p className="small">{t.flow.capturedAt}: <time dateTime={captured.capturedAt}>{captured.capturedAt}</time></p><p className="muted small">{t.flow.frozenHint}</p></>}
        {(activity === 'active' || activity === 'approval' || preview?.coverage.some(snapshot => snapshot.coverage.mode !== 'full')) && <p className="note small">{t.flow.partial}</p>}
        {p.onAssociate && <button type="button" className="button small" disabled={locked || busy} onClick={p.onAssociate}><Icon name="folder" />{t.flow.associateWorkspace}</button>}
      </section>
      {simple && <section className="handover-simple-destination">
        {unresolvedCreation && <div className="note small" role="status"><p>{t.harness!.pendingCreation}</p><button type="button" className="button small" disabled={busy || Boolean(p.harnessState?.busy)} onClick={p.onInspectPending}>{p.harnessState?.busy === 'create' ? t.harness!.inspectingPending : t.harness!.inspectPending}</button></div>}
        <fieldset className="preset-picker handover-harness-picker"><legend>{t.harness!.title}</legend>
          <div className="preset-grid handover-harness-grid">{p.harnesses!.map(card => <label key={card.id} className="preset-card provider-card handover-harness-card">
            <input type="radio" name={radioName} aria-label={card.label} aria-describedby={`${radioName}-${card.id}-hint`} value={card.id} checked={p.harnessId === card.id && p.kind !== 'manual'} disabled={locked} onChange={() => p.onHarness?.(card.id)} />
            <span className="provider-card-head" aria-hidden="true"><span className="preset-brand">{card.id === 'extalia' ? <RuntimeIcon runtime="extalia-native" size={24} /> : <AgentAppLogo app={card.id} size={24} />}</span>{p.harnessId === card.id && <Icon name="check" />}</span>
            <span className="preset-name">{card.label}</span>
            <span id={`${radioName}-${card.id}-hint`} className="preset-hint">{card.id === 'extalia' && p.nativeNeedsEnablement ? t.flow.needsSetup
              : card.existing === 'ready' && card.sessionIds.length > 0 || card.canCreate && !card.createNeedsSetup ? t.flow.ready
                : card.createNeedsSetup || card.existing !== 'unsupported' ? t.flow.needsSetup : t.flow.manualOnly}</span>
          </label>)}</div>
        </fieldset>
        {chosenHarness && p.kind !== 'manual' && <div className="handover-conversation-choice">
          {!p.observedId && chosenHarness.creationProfile && <p className="small">{t.flow.creationProfile}: <code>{chosenHarness.creationProfile}</code></p>}
          {chosenHarness.id === 'extalia' ? <p className="small">{chosenHarness.createConnectionId ? t.harness!.newConversation : chosenHarness.unavailableReason || t.harness!.noConversation}</p>
            : (p.harnessSessions?.length ?? 0) > 0 || chosenHarness.canCreate ? <Select label={t.harness!.conversation} placeholder={t.unknown} value={p.observedId || '__create'} options={[...(chosenHarness.canCreate ? [{ value: '__create', label: t.harness!.newConversation }] : []), ...(p.harnessSessions ?? [])]} onChange={value => p.onObserved(value === '__create' ? '' : value)} disabled={locked} />
              : <p className="note small" role="status">{chosenHarness.unavailableReason || t.harness!.noConversation}</p>}
          {chosenHarness.id !== 'extalia' && chosenHarness.canCreate && !p.observedId && <button type="button" className="button" disabled={locked || Boolean(p.harnessState?.busy) || p.harnessState?.receipt?.state === 'created' && p.harnessState.receipt.harnessId === chosenHarness.id} onClick={p.onCreateConversation}>{p.harnessState?.busy === 'create' ? t.harness!.creating : chosenHarness.createNeedsSetup ? t.flow.checkGatewayCreate : t.harness!.create}</button>}
          {p.harnessState?.receipt?.state === 'unknown' && <p className="form-error" role="alert">{t.harness!.creationUnknown}</p>}
          {p.harnessState?.receipt?.state === 'created' && p.harnessState.receipt.harnessId === chosenHarness.id && <p className="muted small" role="status">{t.harness!.created}</p>}
          {p.harnessState?.receipt?.problem && p.harnessState.receipt.harnessId === chosenHarness.id && <p className="form-error" role="alert">{p.harnessState.receipt.problem}</p>}
          {p.kind === 'observed' && p.observedId && (p.routeBusy ? (state.busy !== 'load' && <p className="muted small" role="status">{t.loading}</p>) : !p.routes.length && <p className="note small">{t.harness!.needsSetup}</p>)}
          {chosenHarness.id === 'extalia' && chosenHarness.createConnectionId && <p className="muted small">{t.harness!.nativeHint}</p>}
        </div>}
        <div className="row-actions handover-destination-actions">
          {p.onManualFallback && <button type="button" className={`button small${p.kind === 'manual' ? ' primary' : ''}`} disabled={locked} aria-pressed={p.kind === 'manual'} onClick={p.onManualFallback}>{t.flow.manualAction}</button>}
          {p.onRefreshHarnesses && <button type="button" className="button small" disabled={locked || Boolean(p.harnessState?.busy)} onClick={p.onRefreshHarnesses}>{t.harness!.refresh}</button>}
        </div>
        {p.harnessState?.error && p.harnessState.error !== state.error && (!p.harnessState.receipt || p.harnessState.receipt.harnessId === p.harnessId) && <p className="form-error" role="alert">{p.harnessState.error === 'HANDOVER_HARNESS_WRONG_SOURCE' ? t.sourceChanged : p.harnessState.error}</p>}
        <button type="button" className="button small handover-advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}><Icon name="settings" />{t.harness!.advanced}</button>
      </section>}
      {continuity && <>
        {(!simple || advanced) && <p className="small"><strong>{t.canonical}:</strong> <code>{continuity.canonicalId}</code></p>}
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
      {(!simple || advanced || p.kind === 'native' || p.kind === 'manual' || Boolean(p.observedId)) && <section className="handover-section"><h3>{t.destination}</h3>
        {simple && advanced && unresolvedCreation && pendingCreation.nativeSessionId && <p className="small">{t.harness!.pendingNativeId}: <code>{pendingCreation.nativeSessionId}</code></p>}
        {(!simple || advanced) && <Select label={t.destination} value={p.kind} options={(['native', 'observed', 'manual'] as const).map(value => ({ value, label: t[value] }))} onChange={p.onKind} disabled={locked} />}
        {p.kind === 'native' && <div className="handover-target-fields">
          <Select label={t.connection} placeholder={t.unknown} value={p.connectionId} options={p.connections} onChange={p.onConnection} disabled={locked} />
          {(!simple || advanced) && <><label>{t.model}<input type="text" value={p.model} placeholder={p.defaultModel || t.defaultValue} maxLength={200} disabled={locked} onChange={event => p.onModel(event.target.value)} /></label>
            <Select label={t.effort} value={p.effort} options={[{ value: '', label: t.defaultValue }, ...EFFORTS.map(value => ({ value, label: value }))]} onChange={p.onEffort} disabled={locked} /></>}
          {p.nativeAssociated === false && <p className="note small handover-wide">{t.flow.workspaceRequired}</p>}
          {p.nativeNeedsEnablement && <div className="handover-wide"><label className="handover-confirm"><input type="checkbox" checked={Boolean(p.nativeEnabled)} disabled={locked} onChange={event => p.onNativeEnable?.(event.target.checked)} />{t.flow.enableWorkspace}</label><p className="muted small">{t.flow.enableWorkspaceHint}</p></div>}
          {p.onOpenSettings && <button type="button" className="button small" disabled={locked} onClick={p.onOpenSettings}>{t.flow.openSettings}</button>}
        </div>}
        {p.kind === 'observed' && <div className="handover-target-fields">
          {(!simple || advanced) && <Select label={t.targetSession} placeholder={t.unknown} value={p.observedId} options={p.observedSessions} onChange={p.onObserved} disabled={locked} />}
          {(!simple || advanced || p.routes.length > 1) && <Select label={t.route} placeholder={t.unknown} value={p.routeId} options={p.routes} onChange={p.onRoute} disabled={locked || p.routeBusy || !p.routes.length} />}
          {!p.routeBusy && p.routes.length > 0 && <p className="small" role="status">{t.flow.ready}</p>}
          <button type="button" className="button small" disabled={locked || p.routeBusy} onClick={p.onRefreshRoutes}>{t.refreshRoutes}</button>
          {p.routeBusy ? (state.busy !== 'load' && <p role="status">{t.loading}</p>) : p.observedId && !p.routes.length && <p className="note small">{t.noRoute}</p>}
          {p.routeError && <p className="form-error" role="alert">{p.routeError}</p>}
          {(p.nativeRecovery || p.destinationSetup) && <fieldset className="handover-setup handover-wide" disabled={locked}>{p.nativeRecovery}{p.destinationSetup}</fieldset>}
        </div>}
        {p.kind === 'manual' && <div className="handover-target-fields"><label>{t.manualLabel}<input type="text" maxLength={120} value={p.manualLabel} disabled={locked} onChange={event => p.onManualLabel(event.target.value)} /></label><Select label={t.targetSession} placeholder={t.unknown} value={p.observedId} options={[{ value: '', label: t.manualUnbound }, ...p.observedSessions]} onChange={p.onObserved} disabled={locked} /><p className="muted small">{t.receiptLimit}</p></div>}
      </section>}
      {p.cliResumeSetup?.(simple && !advanced && p.routes.length > 0, () => setAdvanced(true))}
      <details className="handover-section"><summary>{t.notes}</summary>{continuity?.notesOrigin === 'source-excerpt' && <p className="muted small">{t.sourceExcerpt}</p>}
        <div className="handover-note-fields">{noteKeys.map(field => <label key={field}>{t.fields[field]}<textarea value={state.notes[field]} maxLength={4000} rows={field === 'goal' ? 2 : 3} disabled={locked} onChange={event => p.onNote(field, event.target.value)} /></label>)}</div>
      </details>
      {preview && <section className="handover-section handover-packet" aria-label={t.review}>
        <h3>{t.packet}</h3><p>{preview.targetLabel}</p><p className="small"><strong>{t.digest}:</strong> <code>{preview.packetDigest}</code></p>
        <p className="small">{t.expires}: <time dateTime={preview.expiresAt}>{preview.expiresAt}</time> · {t.omitted}: {preview.packetOmittedEntries}</p>
        {simple ? <details><summary>{t.harness!.reviewDetails}</summary><textarea aria-label={t.packet} readOnly value={preview.packet} rows={12} /></details> : <textarea aria-label={t.packet} readOnly value={preview.packet} rows={12} />}
        {preview.target.kind === 'native' && preview.target.enableManagedWorkspace && <p className="note small">{t.flow.enableWorkspaceHint}</p>}
        {preview.targetChain && <section className="handover-merge"><h3>{t.flow.mergeTitle}</h3><p className="small">{t.coverage}: {preview.targetChain.snapshots} · {t.chain}: {preview.targetChain.handovers}</p>
          {preview.targetChain.requiresConsent ? <><p className="small">{t.flow.mergeHint}</p><label className="handover-confirm"><input type="checkbox" checked={Boolean(p.mergeConfirmed)} disabled={busy} onChange={event => p.onMergeConfirm?.(event.target.checked)} />{t.flow.mergeConfirm}</label>
            <button type="button" className="button" disabled={busy || !p.mergeConfirmed} onClick={p.onReviewMerge}>{t.flow.reviewMerge}</button></> : <p className="note small">{t.flow.reviewedMerge}</p>}
        </section>}
        {!state.receipt && <p className="muted small">{t.copyAfterApply}</p>}
        <button type="button" className="button small" disabled={applying || !canCopy} onClick={p.onCopy}><Icon name="copy" />{state.copied ? t.copied : t.copy}</button>
        {!state.receipt && !preview.targetChain?.requiresConsent && <label className="handover-confirm"><input type="checkbox" checked={p.confirmed} disabled={applying} onChange={event => p.onConfirm(event.target.checked)} />{t.confirm}</label>}
      </section>}
      {state.receipt?.state !== 'unknown' && receiptPanel}
    </>}
    {state.sourceChanged && <p className="note small" role="status">{t.sourceChanged}</p>}
    {state.error && <p className="form-error" role="alert">{state.error}</p>}
    <footer className="row-actions"><button type="button" className="button" disabled={applying} onClick={p.onClose}>{t.cancel}</button>
      {p.supported && state.receipt && state.receipt.state !== 'unknown' && <button type="button" className="button" disabled={busy} onClick={p.onEdit}>{t.flow.nextHandover}</button>}
      {p.supported && (preview && !state.receipt ? <><button type="button" className="button" disabled={busy} onClick={p.onEdit}>{t.edit}</button><button type="button" className="button primary" disabled={busy || !p.confirmed || preview.targetChain?.requiresConsent} onClick={p.onApply}>{applying ? t.applying : t.apply}</button></>
        : !state.receipt && <button type="button" className="button primary" disabled={busy || !p.canReview || !continuity} onClick={p.onReview}>{state.busy === 'preview' ? t.reviewing : t.review}</button>)}
    </footer>
  </dialog>;
}
