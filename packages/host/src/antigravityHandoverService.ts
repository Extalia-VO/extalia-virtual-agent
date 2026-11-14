import { createHash, randomUUID } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isNotFound, writeJsonAtomic } from './jsonStore.js';
import { directLoopbackPost } from './observedInboxClient.js';

export interface AntigravityHandoverEndpoint { address: string; csrfToken: string; identity: string }
export interface AntigravityHandoverWorkspace { id: string; cwd: string; fingerprint: string }
interface Options {
  file: string;
  endpoint(): Promise<AntigravityHandoverEndpoint | undefined>;
  workspace(id: string): Promise<AntigravityHandoverWorkspace | undefined>;
  model?(workspaceId: string): Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
  changed?(): void;
}
interface PinnedEndpoint { origin: string; key: string; csrfToken: string }
interface Review { revision: string; expires: number; workspace: AntigravityHandoverWorkspace; endpoint: PinnedEndpoint; model: string }
interface Creation { operationId: string; nativeSessionId: string; workspace: AntigravityHandoverWorkspace; endpointKey: string; model: string; state: 'inflight' | 'created' | 'unknown'; registered?: boolean; observationId?: string }
interface Submission { operationId: string; nativeSessionId: string; workspaceId: string; workspace?: AntigravityHandoverWorkspace; digest: string; endpointKey: string; clientMessageId: string; state: 'inflight' | 'submitted' | 'unknown'; settled: boolean; baseline: number; reconciled?: boolean }
export interface AntigravityHandoverInspection {
  nativeSessionId: string; workspaceUris: string[]; status: string; revision: string; model?: string;
  /** Display identity reported by the native catalog; never substitutes for the selected native enum. */
  modelId?: string;
  deliveryState: 'ready' | 'running' | 'uncertain';
  problem?: string;
  metadata: Record<string, unknown>; trajectory: Record<string, unknown>; steps: number;
}
export interface AntigravityHandoverDescription {
  state: 'ready' | 'unavailable'; revision?: string; workspaceId?: string; cwd?: string; model?: string; problem?: string;
}
export interface AntigravityHandoverCreation {
  state: 'created' | 'unknown' | 'rejected'; nativeSessionId?: string; cwd?: string; problem?: string; retryable: false;
}
export interface AntigravityHandoverSubmission { state: 'submitted' | 'unknown' | 'rejected'; nativeSessionId: string; problem?: string; retryable: false }
export interface AntigravityPendingCreation { operationId: string; nativeSessionId: string; state: 'created' | 'unknown' }
export interface AntigravityHandoverReconciliation {
  state: 'reconciled' | 'rejected'; nativeSessionId: string; reconciledOperations: number; rebound: boolean; problem?: string;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const modelId = (value: unknown): value is string => typeof value === 'string' && /^MODEL_[A-Z0-9_]{1,180}$/.test(value) && !value.endsWith('_UNSPECIFIED');
const IDLE = 'CASCADE_RUN_STATUS_IDLE';
const uncertain = 'Delivery is uncertain. Inspect the original native conversation; do not repeat this operation.';
const capacityProblem = 'The native handover journal has reached its retention limit. Further operations are disabled until supported journal archival is available; do not delete the journal or retry with another operation ID.';
const readinessPrompt = 'Extalia native conversation readiness check. Reply exactly READY. Do not call tools, read or change files, delegate, or create notes. No transferred work context is included.';

/** Reviewed, workspace-attested native RPCs. Never retries a mutation or falls back to another daemon. */
export class AntigravityHandoverService {
  private readonly creations: Creation[] = [];
  private readonly submissions: Submission[] = [];
  private readonly reviews = new Map<string, Review>();
  private readonly bindings = new Map<string, { workspace: AntigravityHandoverWorkspace; revision: string }>();
  private readonly watchers = new Map<string, Promise<void>>();
  private readonly requests = new Set<AbortController>();
  private readonly modelCatalogs = new Map<string, { at: number; models: Map<string, string>; missing: Set<string> }>();
  private readonly shutdown = new AbortController();
  private readonly loading: Promise<void>;
  private lane: Promise<unknown> = Promise.resolve();
  private closed = false;
  private broken = false;
  private mutations = 0;
  constructor(private readonly options: Options) { this.loading = this.load(); }
  private async load() {
    let handle;
    try {
      handle = await open(this.options.file, 'r');
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid native handover state.');
      const value = JSON.parse(await handle.readFile('utf8')) as { version: number; creations: Creation[]; submissions: Submission[] };
      if (value.version !== 1 || !Array.isArray(value.creations) || !Array.isArray(value.submissions) || value.creations.length > 128 || value.submissions.length > 512) throw new Error('Invalid native handover state.');
      const operations = new Set<string>();
      for (const row of value.creations) {
        if (!id(row.operationId) || operations.has(row.operationId) || !uuid(row.nativeSessionId) || !id(row.workspace?.id) || !path.isAbsolute(row.workspace.cwd)
          || typeof row.workspace.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.endpointKey) || !modelId(row.model) || !['inflight', 'created', 'unknown'].includes(row.state)
          || row.registered !== undefined && typeof row.registered !== 'boolean' || row.registered && !id(row.observationId)) throw new Error('Invalid native creation.');
        operations.add(row.operationId); if (row.state === 'inflight') row.state = 'unknown'; this.creations.push(row);
      }
      for (const row of value.submissions) {
        if (!id(row.operationId) || operations.has(row.operationId) || !uuid(row.nativeSessionId) || !id(row.workspaceId) || !uuid(row.clientMessageId)
          || !/^[a-f0-9]{64}$/.test(row.digest) || !/^[a-f0-9]{64}$/.test(row.endpointKey) || !['inflight', 'submitted', 'unknown'].includes(row.state)
          || typeof row.settled !== 'boolean' || !Number.isSafeInteger(row.baseline) || row.baseline < 0 || row.reconciled !== undefined && typeof row.reconciled !== 'boolean'
          || row.workspace !== undefined && (row.workspace.id !== row.workspaceId || !path.isAbsolute(row.workspace.cwd) || typeof row.workspace.fingerprint !== 'string' || !row.workspace.fingerprint || row.workspace.fingerprint.length > 4096)) throw new Error('Invalid native submission.');
        operations.add(row.operationId); if (row.state === 'inflight' || row.state === 'submitted' && !row.settled) row.state = 'unknown'; this.submissions.push(row);
      }
    } catch (error) { if (!isNotFound(error)) this.broken = true; }
    finally { await handle?.close(); }
  }
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.lane.then(async () => { await this.loading; this.mutations++; try { return await work(); } finally { this.mutations--; } });
    this.lane = pending.catch(() => undefined); return pending;
  }
  private async save() {
    try { await writeJsonAtomic(this.options.file, { version: 1, creations: this.creations, submissions: this.submissions }); }
    catch { this.broken = true; throw new Error('Native handover state could not be saved.'); }
  }
  private changed() { try { this.options.changed?.(); } catch { /* Presentation cannot own native delivery. */ } }
  private async endpoint(): Promise<PinnedEndpoint> {
    const value = await this.options.endpoint();
    if (!value || !value.identity || value.identity.length > 512 || !value.csrfToken || value.csrfToken.length > 4096 || /[\0\r\n]/.test(value.csrfToken)) throw new Error('The native daemon is unavailable.');
    const url = new URL(`http://${value.address}`);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('A reviewed loopback daemon is required.');
    return { origin: url.origin, csrfToken: value.csrfToken, key: digest([url.origin, value.identity, digest(value.csrfToken)]) };
  }
  private async workspace(workspaceId: string): Promise<AntigravityHandoverWorkspace> {
    const value = await this.options.workspace(workspaceId);
    if (!value || !id(value.id) || value.id !== workspaceId || !path.isAbsolute(value.cwd) || !value.fingerprint || value.fingerprint.length > 4096) throw new Error('The selected workspace is unavailable.');
    const cwd = await realpath(value.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error('The selected project folder is unavailable.');
    return { ...value, cwd };
  }
  private async rpc(endpoint: PinnedEndpoint, method: string, body: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error('The host is closing.');
    const controller = new AbortController(); this.requests.add(controller);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const url = `${endpoint.origin}/exa.language_server_pb.LanguageServerService/${method}`;
      const headers = { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': endpoint.csrfToken };
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
      let joined: Uint8Array;
      if (this.options.fetch) {
        const response = await this.options.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal });
        if (!response.ok || !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw new Error('The native RPC was not acknowledged.');
        reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
        for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 2 * 1024 * 1024) throw new Error('Native response exceeds the bounded read.'); chunks.push(next.value); }
        joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      } else {
        // The production transport bypasses proxy settings and DNS before attaching the local CSRF credential.
        const response = await directLoopbackPost(url, headers, JSON.stringify(body), signal, 2 * 1024 * 1024);
        if (!response.ok || !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('The native RPC was not acknowledged.');
        joined = response.bodyBytes;
      }
      const value: unknown = JSON.parse(new TextDecoder().decode(joined));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native response.');
      return value as Record<string, unknown>;
    } finally { this.requests.delete(controller); try { await reader?.cancel(); } catch { /* Already settled. */ } }
  }
  private rememberModelCatalog(endpoint: PinnedEndpoint, catalog: Record<string, unknown>) {
    const models = new Map<string, string>();
    for (const raw of (Array.isArray(catalog.clientModelConfigs) ? catalog.clientModelConfigs : []).slice(0, 512)) {
      const row = object(raw), nativeModel = object(row.modelOrAlias).model, display = row.modelId;
      if (modelId(nativeModel) && typeof display === 'string' && display.trim() && display.length <= 200 && !/\p{Cc}/u.test(display)) models.set(nativeModel, display);
    }
    const missing = new Set([...(this.modelCatalogs.get(endpoint.key)?.missing ?? [])].filter(model => !models.has(model)));
    while (models.size + missing.size > 512) missing.delete(missing.values().next().value!);
    this.modelCatalogs.delete(endpoint.key); this.modelCatalogs.set(endpoint.key, { at: Date.now(), models, missing });
    while (this.modelCatalogs.size > 8) this.modelCatalogs.delete(this.modelCatalogs.keys().next().value!);
  }
  private async nativeModelId(endpoint: PinnedEndpoint, model: string): Promise<string | undefined> {
    const cached = this.modelCatalogs.get(endpoint.key);
    const age = cached ? Date.now() - cached.at : -1;
    if (cached && age >= 0 && age < 60_000 && (cached.models.has(model) || cached.missing.has(model) || cached.models.size >= 512)) return cached.models.get(model);
    try { this.rememberModelCatalog(endpoint, await this.rpc(endpoint, 'GetCascadeModelConfigData', {}, 1500)); }
    catch {
      // Optional display metadata must never make native identity or workspace inspection unavailable.
      this.rememberModelCatalog(endpoint, {});
    }
    const entry = this.modelCatalogs.get(endpoint.key)!;
    if (!entry.models.has(model)) { entry.missing.add(model); while (entry.models.size + entry.missing.size > 512) entry.missing.delete(entry.missing.values().next().value!); }
    return entry.models.get(model);
  }
  private async model(workspaceId: string, endpoint: PinnedEndpoint): Promise<string> {
    const catalog = await this.rpc(endpoint, 'GetCascadeModelConfigData', {});
    this.rememberModelCatalog(endpoint, catalog);
    const selected = this.options.model ? await this.options.model(workspaceId) : object(object(catalog.defaultOverrideModelConfig).modelOrAlias).model;
    const models = Array.isArray(catalog.clientModelConfigs) ? catalog.clientModelConfigs.map(object) : [];
    const available = models.find(item => object(item.modelOrAlias).model === selected && item.disabled !== true
      && (item.quotaInfo === undefined || typeof object(item.quotaInfo).remainingFraction === 'number' && (object(item.quotaInfo).remainingFraction as number) > 0));
    if (!modelId(selected) || !available) throw new Error('Choose an available native model before creating a conversation.');
    return selected;
  }
  private blockedWorkspace(workspace: AntigravityHandoverWorkspace): boolean {
    return this.creations.some(row => (row.workspace.id === workspace.id || row.workspace.cwd === workspace.cwd) && (row.state !== 'created' || !row.registered))
      || this.submissions.some(row => row.workspaceId === workspace.id && (row.state === 'inflight' || row.state === 'unknown' && !row.reconciled || row.state === 'submitted' && !row.settled));
  }
  async describe(workspaceId: string): Promise<AntigravityHandoverDescription> {
    await this.loading;
    try {
      if (this.closed || this.broken) throw new Error('Native handover is unavailable.');
      if (this.creations.length >= 128 || this.submissions.length >= 512) return { state: 'unavailable', problem: capacityProblem };
      const workspace = await this.workspace(workspaceId);
      if (this.blockedWorkspace(workspace)) throw new Error(uncertain);
      const endpoint = await this.endpoint(), model = await this.model(workspaceId, endpoint);
      const current = this.reviews.get(workspaceId), selection = digest([workspace, endpoint.key, model]);
      const revision = current && current.expires > Date.now() && digest([current.workspace, current.endpoint.key, current.model]) === selection ? current.revision : randomUUID();
      this.reviews.set(workspaceId, { revision, workspace, endpoint, model, expires: Date.now() + 5 * 60_000 });
      return { state: 'ready', revision, workspaceId, cwd: workspace.cwd, model };
    } catch { return { state: 'unavailable', problem: 'The selected native workspace, model or delivery state needs inspection.' }; }
  }
  async create(workspaceId: string, input: { revision: string; operationId: string }): Promise<AntigravityHandoverCreation> {
    return this.mutate(async () => {
      const existing = this.creations.find(row => row.operationId === input.operationId);
      if (existing) return existing.workspace.id === workspaceId ? this.creationReceipt(existing) : { state: 'rejected', retryable: false };
      const review = this.reviews.get(workspaceId);
      if (!id(input.operationId) || this.submissions.some(row => row.operationId === input.operationId) || this.closed || this.broken || !review || review.revision !== input.revision || review.expires < Date.now() || this.creations.length >= 128) return { state: 'rejected', retryable: false };
      let endpoint: PinnedEndpoint, workspace: AntigravityHandoverWorkspace;
      try {
        workspace = await this.workspace(workspaceId); endpoint = await this.endpoint();
        if (digest(workspace) !== digest(review.workspace) || endpoint.key !== review.endpoint.key || await this.model(workspaceId, endpoint) !== review.model
          || this.blockedWorkspace(workspace)) throw new Error('Changed review.');
      } catch { return { state: 'rejected', retryable: false }; }
      const creation: Creation = { operationId: input.operationId, nativeSessionId: randomUUID(), workspace, endpointKey: endpoint.key, model: review.model, state: 'inflight' };
      this.creations.push(creation);
      try {
        await this.save();
        if ((await this.endpoint()).key !== endpoint.key || digest(await this.workspace(workspaceId)) !== digest(workspace)) throw new Error('The source changed before native creation.');
        const uri = pathToFileURL(workspace.cwd).href;
        const result = await this.rpc(endpoint, 'StartCascade', { cascadeId: creation.nativeSessionId, workspaceUris: [uri], overrideWorkspaceUris: [uri],
          source: 'CORTEX_TRAJECTORY_SOURCE_AGENT_API', trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE', requestedModel: creation.model });
        if (result.cascadeId !== creation.nativeSessionId) throw new Error('Native identity mismatch.');
        const inspection = await this.inspectFor(creation.nativeSessionId, endpoint, workspace.id);
        if (inspection.workspaceUris.length !== 1 || inspection.workspaceUris[0] !== uri) throw new Error('Workspace attestation mismatch.');
        if ((await this.endpoint()).key !== endpoint.key || digest(await this.workspace(workspaceId)) !== digest(workspace)) throw new Error('Native creation needs fresh inspection.');
        creation.state = 'created'; await this.save(); this.bindings.set(creation.nativeSessionId, { workspace, revision: inspection.revision });
      } catch { creation.state = 'unknown'; try { await this.save(); } catch { /* Fail closed. */ } }
      this.changed(); return this.creationReceipt(creation);
    });
  }
  private creationReceipt(row: Creation): AntigravityHandoverCreation {
    return { state: row.state === 'created' ? 'created' : 'unknown', nativeSessionId: row.nativeSessionId, cwd: row.workspace.cwd, retryable: false,
      ...(row.state !== 'created' ? { problem: uncertain } : {}) };
  }
  /** Recover only this workspace's existing receipt before any new review or effect is considered. */
  async creationStatus(workspaceId: string, operationId: string): Promise<AntigravityHandoverCreation | undefined> {
    await this.loading;
    const row = this.creations.find(value => value.operationId === operationId && value.workspace.id === workspaceId);
    if (!row) return undefined;
    return this.broken ? { state: 'unknown', nativeSessionId: row.nativeSessionId, cwd: row.workspace.cwd, problem: uncertain, retryable: false } : this.creationReceipt(row);
  }
  async pendingCreation(workspaceId: string): Promise<AntigravityPendingCreation | undefined> {
    await this.loading;
    const row = [...this.creations].reverse().find(value => value.workspace.id === workspaceId && (value.state !== 'created' || !value.registered));
    return row ? { operationId: row.operationId, nativeSessionId: row.nativeSessionId, state: row.state === 'created' && !this.broken ? 'created' : 'unknown' } : undefined;
  }
  /** An explicit inspection can recover this exact preallocated ID; it never repeats StartCascade or a prompt. */
  inspectCreation(workspaceId: string, operationId: string): Promise<AntigravityHandoverCreation | undefined> {
    return this.mutate(async () => {
      const row = this.creations.find(value => value.workspace.id === workspaceId && value.operationId === operationId);
      if (!row) return undefined;
      if (row.state === 'created') return this.creationReceipt(row);
      if (this.closed || this.broken) return { ...this.creationReceipt(row), state: 'unknown' };
      try {
        const endpoint = await this.endpoint(), workspace = await this.workspace(workspaceId);
        if (endpoint.key !== row.endpointKey || digest(workspace) !== digest(row.workspace)) return this.creationReceipt(row);
        const inspection = await this.inspectAt(row.nativeSessionId, endpoint);
        if (inspection.workspaceUris.length !== 1 || inspection.workspaceUris[0] !== pathToFileURL(workspace.cwd).href
          || (await this.endpoint()).key !== endpoint.key || digest(await this.workspace(workspaceId)) !== digest(workspace)) return this.creationReceipt(row);
        row.state = 'created'; row.registered = false; await this.save(); this.changed();
      } catch { /* A missing or ambiguous native identity remains fenced. */ }
      return this.creationReceipt(row);
    });
  }
  /** Host-only acknowledgement after the exact native conversation is attached to a verified observation. */
  async markRegistered(operationId: string, observationId?: string): Promise<boolean> {
    return this.mutate(async () => {
      const row = this.creations.find(value => value.operationId === operationId);
      if (!row || row.state !== 'created' || !id(observationId) || this.closed || this.broken) return false;
      if (row.registered) return row.observationId === observationId;
      try {
        const endpoint = await this.endpoint(), workspace = await this.workspace(row.workspace.id);
        const inspection = await this.inspectAt(row.nativeSessionId, endpoint);
        if (endpoint.key !== row.endpointKey || digest(workspace) !== digest(row.workspace) || inspection.workspaceUris.length !== 1 || inspection.workspaceUris[0] !== pathToFileURL(workspace.cwd).href) return false;
        row.registered = true; row.observationId = observationId; await this.save(); this.changed(); return true;
      } catch { return false; }
    });
  }
  private async canonicalUris(value: unknown): Promise<string[]> {
    if (!Array.isArray(value) || value.length > 10 || value.some(uri => typeof uri !== 'string' || uri.length > 4096)) throw new Error('Invalid native workspace metadata.');
    const result: string[] = [];
    for (const uri of value as string[]) {
      const url = new URL(uri);
      if (url.protocol !== 'file:' || url.username || url.password || url.search || url.hash || url.hostname && url.hostname !== 'localhost') throw new Error('Only local native project folders are supported.');
      const cwd = await realpath(fileURLToPath(url)); if (!(await stat(cwd)).isDirectory()) throw new Error('Native project folder is unavailable.'); result.push(pathToFileURL(cwd).href);
    }
    return [...new Set(result)].sort();
  }
  private async inspectAt(nativeSessionId: string, endpoint: PinnedEndpoint): Promise<AntigravityHandoverInspection> {
    if (!uuid(nativeSessionId)) throw new Error('An exact native conversation is required.');
    const metadataResult = await this.rpc(endpoint, 'GetConversationMetadata', { conversationId: nativeSessionId });
    const result = await this.rpc(endpoint, 'GetCascadeTrajectory', { cascadeId: nativeSessionId });
    const metadata = object(metadataResult.metadata), trajectory = object(result.trajectory);
    if (trajectory.cascadeId !== nativeSessionId || typeof trajectory.trajectoryId !== 'string' || metadataResult.trajectoryId !== trajectory.trajectoryId || typeof result.status !== 'string') throw new Error('Native identity was not attested.');
    const workspaceUris = await this.canonicalUris(metadata.workspaceUris ?? []), trajectoryUris = await this.canonicalUris(object(trajectory.metadata).workspaceUris ?? []);
    if (digest(workspaceUris) !== digest(trajectoryUris)) throw new Error('Native workspace metadata changed during inspection.');
    const steps = result.numTotalSteps ?? 0;
    if (!Number.isSafeInteger(steps) || (steps as number) < 0) throw new Error('Invalid native progress metadata.');
    const creation = this.creations.find(row => row.nativeSessionId === nativeSessionId);
    const selected = object(object(object(metadata.staticConfig).cascadeConfig).plannerConfig).planModel;
    const model = modelId(selected) ? selected : creation?.model;
    const displayModel = model ? await this.nativeModelId(endpoint, model) : undefined;
    const changedEndpoint = creation && creation.endpointKey !== endpoint.key;
    const atCapacity = this.submissions.length >= 512;
    const unknown = atCapacity || creation && (creation.state !== 'created' || !creation.registered || changedEndpoint) || this.submissions.some(row => row.nativeSessionId === nativeSessionId && (row.state === 'unknown' && !row.reconciled || row.state === 'inflight'));
    const deliveryState = unknown ? 'uncertain' : this.watchers.has(nativeSessionId) || result.status !== IDLE ? 'running' : 'ready';
    return { nativeSessionId, workspaceUris, status: result.status, steps: steps as number, metadata, trajectory, deliveryState,
      ...(atCapacity ? { problem: capacityProblem } : changedEndpoint ? { problem: 'The native daemon changed. Explicitly inspect and re-attest this conversation before sending.' } : {}),
      revision: digest([endpoint.key, nativeSessionId, workspaceUris, model]), ...(model ? { model } : {}), ...(displayModel ? { modelId: displayModel } : {}) };
  }
  private async inspectFor(nativeSessionId: string, endpoint: PinnedEndpoint, workspaceId?: string): Promise<AntigravityHandoverInspection> {
    const inspection = await this.inspectAt(nativeSessionId, endpoint);
    const scope = workspaceId ?? this.creations.find(row => row.nativeSessionId === nativeSessionId)?.workspace.id;
    if (scope && this.options.model) {
      const model = await this.model(scope, endpoint);
      const { modelId: _reportedDisplay, ...native } = inspection;
      const display = await this.nativeModelId(endpoint, model);
      return { ...native, model, ...(display ? { modelId: display } : {}), revision: digest([inspection.revision, scope, model]) };
    }
    return inspection;
  }
  async inspect(nativeSessionId: string, workspaceId?: string): Promise<AntigravityHandoverInspection> {
    await this.loading; if (this.closed || this.broken) throw new Error('Native handover is unavailable.');
    return this.inspectFor(nativeSessionId, await this.endpoint(), workspaceId);
  }
  /** Explicit recovery uses native reads only. It releases fences, never retries a prompt or upgrades its historical receipt. */
  reconcile(nativeSessionId: string, workspaceId: string): Promise<AntigravityHandoverReconciliation> {
    return this.mutate(async () => {
      const refused = (): AntigravityHandoverReconciliation => ({ state: 'rejected', nativeSessionId, reconciledOperations: 0, rebound: false, problem: uncertain });
      if (!uuid(nativeSessionId) || !id(workspaceId) || this.closed || this.broken || this.watchers.has(nativeSessionId)) return refused();
      const creation = this.creations.find(row => row.nativeSessionId === nativeSessionId);
      const rows = this.submissions.filter(row => row.nativeSessionId === nativeSessionId);
      if (creation && (creation.state !== 'created' || !creation.registered || creation.workspace.id !== workspaceId)
        || rows.some(row => row.workspaceId !== workspaceId || row.state === 'inflight' || row.state === 'submitted' && !row.settled)) return refused();
      try {
        const endpoint = await this.endpoint(), workspace = await this.workspace(workspaceId);
        if (creation && digest(creation.workspace) !== digest(workspace)) return refused();
        const inspection = await this.inspectAt(nativeSessionId, endpoint);
        if (inspection.status !== IDLE || inspection.workspaceUris.length !== 1 || inspection.workspaceUris[0] !== pathToFileURL(workspace.cwd).href) return refused();
        const pending = rows.filter(row => row.state === 'unknown' && !row.reconciled);
        // Older external-session journals without original scope evidence remain fenced.
        if (pending.some(row => row.workspace ? digest(row.workspace) !== digest(workspace) : !creation)) return refused();
        if (pending.some(row => !this.hasSubmission(inspection, row))) return refused();
        if ((await this.endpoint()).key !== endpoint.key || digest(await this.workspace(workspaceId)) !== digest(workspace)) return refused();
        const rebound = Boolean(creation && creation.endpointKey !== endpoint.key);
        if (creation) creation.endpointKey = endpoint.key;
        for (const row of pending) { row.reconciled = true; row.settled = true; }
        if (rebound || pending.length) { await this.save(); this.changed(); }
        return { state: 'reconciled', nativeSessionId, reconciledOperations: pending.length, rebound };
      } catch { return refused(); }
    });
  }
  private hasSubmission(inspection: AntigravityHandoverInspection, row: Submission): boolean {
    const steps = Array.isArray(inspection.trajectory.steps) ? inspection.trajectory.steps.map(object) : [];
    return steps.length === inspection.steps && steps.slice(row.baseline).some(step => step.type === 'CORTEX_STEP_TYPE_USER_INPUT' && object(step.userInput).clientMessageId === row.clientMessageId);
  }
  /** Only a known, newly created conversation can receive this fixed registration bootstrap. */
  async bootstrapOnce(creationOperationId: string): Promise<AntigravityHandoverSubmission> {
    await this.loading;
    const creation = this.creations.find(row => row.operationId === creationOperationId);
    if (!creation || creation.state !== 'created') return { state: 'rejected', nativeSessionId: creation?.nativeSessionId ?? '', retryable: false };
    try {
      const inspection = await this.inspect(creation.nativeSessionId, creation.workspace.id);
      return this.send(creation.nativeSessionId, { text: readinessPrompt, operationId: `bootstrap-${digest([creation.operationId, creation.nativeSessionId]).slice(0, 48)}`, workspaceId: creation.workspace.id }, inspection.revision, creationOperationId);
    } catch { return { state: 'rejected', nativeSessionId: creation.nativeSessionId, retryable: false }; }
  }
  sendOnce(nativeSessionId: string, input: { text: string; operationId: string; workspaceId?: string }, expectedBinding?: string): Promise<AntigravityHandoverSubmission> {
    return this.send(nativeSessionId, input, expectedBinding);
  }
  private send(nativeSessionId: string, input: { text: string; operationId: string; workspaceId?: string }, expectedBinding?: string, bootstrapCreationOperationId?: string): Promise<AntigravityHandoverSubmission> {
    return this.mutate(async () => {
      const refusal = (): AntigravityHandoverSubmission => ({ state: 'rejected', nativeSessionId, retryable: false });
      if (!uuid(nativeSessionId) || !id(input.operationId) || typeof input.text !== 'string' || !input.text.trim() || input.text.includes('\0') || Buffer.byteLength(input.text) > 16 * 1024) return refusal();
      const textDigest = digest(input.text), previous = this.submissions.find(row => row.operationId === input.operationId);
      if (previous) return previous.nativeSessionId === nativeSessionId && previous.digest === textDigest ? { state: previous.state === 'submitted' ? 'submitted' : 'unknown', nativeSessionId, retryable: false } : refusal();
      const creation = this.creations.find(row => row.nativeSessionId === nativeSessionId);
      const workspaceId = input.workspaceId ?? creation?.workspace.id;
      if (creation && !creation.registered && !(bootstrapCreationOperationId === creation.operationId && input.text === readinessPrompt)
        || bootstrapCreationOperationId && (!creation || creation.registered || creation.operationId !== bootstrapCreationOperationId)) return refusal();
      if (!workspaceId || this.closed || this.broken || this.creations.some(row => row.operationId === input.operationId || row.nativeSessionId === nativeSessionId && row.state !== 'created')
        || this.submissions.some(row => row.nativeSessionId === nativeSessionId && (row.state === 'inflight' || row.state === 'unknown' && !row.reconciled || row.state === 'submitted' && !row.settled)) || this.submissions.length >= 512) return refusal();
      let endpoint: PinnedEndpoint, workspace: AntigravityHandoverWorkspace, inspection: AntigravityHandoverInspection, selectedModel: string;
      try {
        endpoint = await this.endpoint(); workspace = await this.workspace(workspaceId); inspection = await this.inspectFor(nativeSessionId, endpoint, workspaceId);
        const knownBinding = expectedBinding ?? this.bindings.get(nativeSessionId)?.revision;
        if (!knownBinding || inspection.revision !== knownBinding || inspection.status !== IDLE || inspection.workspaceUris.length !== 1 || inspection.workspaceUris[0] !== pathToFileURL(workspace.cwd).href
          || creation && (creation.endpointKey !== endpoint.key || digest(creation.workspace) !== digest(workspace))) throw new Error('The reviewed native binding changed.');
        selectedModel = inspection.model ?? await this.model(workspaceId, endpoint);
        if (!modelId(selectedModel)) throw new Error('A reviewed native model is required.');
        if ((await this.endpoint()).key !== endpoint.key || digest(await this.workspace(workspaceId)) !== digest(workspace)) throw new Error('The source changed before sending.');
      } catch { return refusal(); }
      const row: Submission = { operationId: input.operationId, nativeSessionId, workspaceId, workspace, digest: textDigest, endpointKey: endpoint.key, clientMessageId: randomUUID(), state: 'inflight', settled: false, baseline: inspection.steps };
      this.submissions.push(row);
      try {
        await this.save();
        if ((await this.endpoint()).key !== endpoint.key || digest(await this.workspace(workspaceId)) !== digest(workspace)) throw new Error('The source changed before native submission.');
        await this.rpc(endpoint, 'SendUserCascadeMessage', { cascadeId: nativeSessionId, items: [{ text: input.text }], clientMessageId: row.clientMessageId,
          cascadeConfig: { plannerConfig: { planModel: selectedModel } }, messageOrigin: 'AGENT_MESSAGE_ORIGIN_SDK_EXECUTABLE', deliveryStrategy: 'MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE' });
        row.state = 'submitted'; await this.save(); this.watch(row, endpoint);
      } catch { row.state = 'unknown'; try { await this.save(); } catch { /* Fail closed. */ } }
      this.changed(); return { state: row.state === 'submitted' ? 'submitted' : 'unknown', nativeSessionId, retryable: false, ...(row.state === 'unknown' ? { problem: uncertain } : {}) };
    });
  }
  private watch(row: Submission, endpoint: PinnedEndpoint) {
    const work = (async () => {
      const started = Date.now();
      try {
        for (;;) {
          await new Promise<void>(resolve => { const timer = setTimeout(done, 1000); const signal = this.shutdown.signal;
            function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
            signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done(); });
          if (this.closed || Date.now() - started > 10 * 60_000 || (await this.endpoint()).key !== endpoint.key) throw new Error('Native execution needs inspection.');
          const current = await this.inspectAt(row.nativeSessionId, endpoint);
          const admitted = this.hasSubmission(current, row);
          if (current.status === IDLE && admitted) { await this.mutate(async () => { row.settled = true; await this.save(); }); return; }
        }
      } catch { await this.mutate(async () => { row.state = 'unknown'; try { await this.save(); } catch { /* Fail closed. */ } }); }
      finally { this.watchers.delete(row.nativeSessionId); this.changed(); }
    })();
    this.watchers.set(row.nativeSessionId, work);
  }
  isBusy(): boolean { return this.mutations > 0 || this.watchers.size > 0; }
  async close(): Promise<void> {
    this.closed = true; this.shutdown.abort(); for (const request of this.requests) request.abort();
    await this.lane; await Promise.all(this.watchers.values()); await this.lane;
  }
}
