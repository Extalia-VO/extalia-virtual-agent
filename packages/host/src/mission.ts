/** Native mission plan construction, retained result metadata and v0 projection. */
import type { Connection } from '@extalia/core';
import { isHostMissionRecoveryMetadata, isHostMissionTaskUsage, isHostMissionUsage, normalizeHostMissionBudget, type HostMissionRequest, type HostMissionRun, type HostMissionTask, type HostMissionUsage } from '@extalia/platform';
import { isUtcTimestamp, parseOrchestration, type AgentEvent, type EventBody, type OrchestrationPlan, type TaskState } from '@extalia/protocol';
import { runNativeMission, type ModelProvider, type NativeMissionOptions, type NativeMissionResult } from '@extalia/runtime';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { isNotFound, writeJsonAtomic } from './jsonStore.js';
import { MissionCheckpointStore, validateMissionJournalEvent } from './missionCheckpoints.js';
import { checkSessionId, type SessionRecord } from './sessions.js';
import { createFileTools } from './tools/files.js';

const MAX_RECORDS = 16;
const METADATA_SCHEMA = 'extalia.native-missions.v1';
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const copy = <T>(value: T): T => structuredClone(value);
const problem = () => new Error('Native mission metadata is unavailable. Unresolved execution must be reconciled before continuing.');
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const states = new Set<TaskState>(['queued', 'blocked', 'assigned', 'running', 'waiting', 'awaiting_approval', 'verifying', 'completed', 'failed', 'cancelled', 'unknown']);
const unresolved = (run: HostMissionRun) => run.state === 'running' || run.state === 'recovering';
const stableJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => !item || typeof item !== 'object' || Array.isArray(item)
  ? item : Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));

function validRun(raw: unknown, session: SessionRecord): raw is HostMissionRun {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const run = raw as HostMissionRun;
  if (Object.keys(run).some(key => !['id', 'sessionId', 'workspaceId', 'title', 'state', 'createdAt', 'updatedAt', 'transient', 'tasks', 'budget', 'usage', 'budgetExhausted', 'authority', 'recovery'].includes(key))) return false;
  if (!isHostMissionRecoveryMetadata(run)) return false;
  if (run.budget !== undefined) {
    try { if (stableJson(normalizeHostMissionBudget(run.budget, run.budget?.maxConcurrency)) !== stableJson(run.budget)) return false; } catch { return false; }
  }
  if (run.budgetExhausted !== undefined && !['tokens', 'usage-unknown', 'duration'].includes(run.budgetExhausted)) return false;
  if (!uuid(run.id) || run.sessionId !== session.id || run.workspaceId !== session.workspaceId || typeof run.title !== 'string' || run.title.length > 200
    || !['running', 'completed', 'failed', 'cancelled', 'recovering'].includes(run.state) || run.transient !== false
    || !isUtcTimestamp(run.createdAt) || !isUtcTimestamp(run.updatedAt) || !Array.isArray(run.tasks) || !run.tasks.length || run.tasks.length > 16) return false;
  if (new Set(run.tasks.map(task => task.taskId)).size !== run.tasks.length || new Set(run.tasks.map(task => task.id)).size !== run.tasks.length) return false;
  const aliases = new Set(run.tasks.map(task => task.id));
  if (run.usage !== undefined && !isHostMissionUsage(run.usage, run.tasks.length)) return false;
  if (!run.tasks.every(task => task && typeof task === 'object' && Object.keys(task).every(key => ['id', 'taskId', 'agentId', 'title', 'dependsOn', 'connectionId', 'model', 'state', 'answer', 'verification', 'reason', 'evidenceIds', 'usage', 'access'].includes(key)) && uuid(task.taskId) && uuid(task.agentId)
    && (task.access === undefined || task.access === 'write')
    && (task.usage === undefined || isHostMissionTaskUsage(task.usage))
    && typeof task.id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(task.id) && typeof task.title === 'string' && task.title.length <= 200
    && (task.dependsOn === undefined || Array.isArray(task.dependsOn) && task.dependsOn.length <= 16
      && task.dependsOn.every(id => typeof id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(id) && id !== task.id && aliases.has(id))
      && new Set(task.dependsOn).size === task.dependsOn.length)
    && typeof task.connectionId === 'string' && task.connectionId.length > 0 && task.connectionId.length <= 200 && typeof task.model === 'string' && task.model.length <= 200
    && states.has(task.state) && (task.answer === undefined || typeof task.answer === 'string' && task.answer.length <= 16_000)
    && (task.verification === undefined || task.verification === 'unverified') && (task.reason === undefined || typeof task.reason === 'string' && task.reason.length <= 200)
    && Array.isArray(task.evidenceIds) && task.evidenceIds.length === 0)) return false;
  // Missing `dependsOn` is legacy unknown graph data; only validate cycles in the known edge set.
  const known = run.tasks.filter(task => task.dependsOn !== undefined);
  const remaining = new Set(known.map(task => task.id));
  while (remaining.size) {
    let progressed = false;
    for (const task of known) {
      if (!remaining.has(task.id) || task.dependsOn!.some(id => remaining.has(id))) continue;
      remaining.delete(task.id); progressed = true;
    }
    if (!progressed) return false;
  }
  return true;
}

/** Sum retained per-task usage; a task with an unreported call counts as unknown (ADR 0015). */
export function missionUsageFromTasks(tasks: readonly HostMissionTask[]): HostMissionUsage {
  let inputTokens: number | undefined, outputTokens: number | undefined, unknownTasks = 0;
  for (const task of tasks) {
    if (task.usage?.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + task.usage.inputTokens;
    if (task.usage?.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + task.usage.outputTokens;
    if (task.usage?.unknown) unknownTasks++;
  }
  return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), unknownTasks };
}

/** Work that may have started: the contract's assigned task states, as the Rust store's `TaskState::in_flight`. */
const IN_FLIGHT = new Set<TaskState>(['assigned', 'running', 'waiting', 'awaiting_approval', 'verifying']);

/**
 * Restart recovery: never replay (ADR 0013). Only work that may have been in flight
 * becomes unknown, and so does its usage — the interrupted call may have consumed
 * tokens. Terminal tasks keep their result; queued and blocked tasks never ran and
 * stay as they are, since a recovering run admits nothing new.
 */
function recoverRun(run: HostMissionRun): HostMissionRun {
  const at = new Date().toISOString();
  const uncertain = run.recovery?.source === 'execution-uncertain' || run.tasks.some(task => task.state === 'unknown' || ['execution-unknown', 'persistence-failed'].includes(task.reason ?? ''));
  const recovery = { source: uncertain ? 'execution-uncertain' as const : 'host-restart' as const, at };
  const tasks = run.tasks.map(task => {
    if (!IN_FLIGHT.has(task.state)) return task;
    const { answer: _answer, verification: _verification, ...rest } = task;
    return { ...rest, state: 'unknown' as const, reason: 'host-restarted', usage: { ...task.usage, unknown: true as const } };
  });
  return { ...run, recovery, state: 'recovering', updatedAt: at, tasks, ...(run.usage ? { usage: missionUsageFromTasks(tasks) } : {}) };
}

/** Checkpoint metadata only. The separate canonical session event log continues to contain v0 events. */
export class MissionRecords {
  private readonly records = new Map<string, HostMissionRun[]>();
  private readonly transient = new Set<string>();
  private readonly reservations = new Map<string, string[]>();
  private checkpoints: MissionCheckpointStore | undefined;
  private readonly volatileEvents = new Map<string, { event: AgentEvent; snapshotDigest: string; bytes: number }[]>();
  private readonly volatileEventOwners = new Map<string, string>();
  /** Encoded bytes per transient run journal, matching the SQLite store's sum(encoded_bytes). */
  private readonly volatileBytes = new Map<string, number>();
  /** Omitting checkpointFile retains the legacy sidecar harness used by format/retention tests. */
  constructor(private readonly directory: string, private readonly checkpointFile?: string) {}
  private file(sessionId: string): string { return path.join(this.directory, `${checkSessionId(sessionId)}.missions.json`); }

  async initialize(sessions: SessionRecord[]): Promise<void> {
    try {
      if (this.checkpointFile) this.checkpoints = await MissionCheckpointStore.open(this.checkpointFile);
      await this.loadSessions(sessions);
    } catch {
      this.close();
      throw problem();
    }
  }
  private async loadSessions(sessions: SessionRecord[]): Promise<void> {
    const knownSessions = new Set(sessions.map(session => session.id));
    for (const id of this.checkpoints?.sessionIds() ?? []) {
      // A lost/corrupt session file must not hide durable quarantine from the
      // connection guards. Normal deletion writes its tombstone first.
      if (!knownSessions.has(id) && this.checkpoints!.readSession(id)?.some(unresolved)) throw problem();
    }
    for (const session of sessions) {
      const file = this.file(session.id);
      let raw: unknown;
      let legacyDigest: string | undefined;
      const stored = this.checkpoints?.readSession(session.id);
      if (stored !== undefined) raw = { schema: METADATA_SCHEMA, runs: stored };
      else {
        try {
          if ((await stat(file)).size > MAX_METADATA_BYTES) throw problem();
          const text = await readFile(file, 'utf8');
          legacyDigest = createHash('sha256').update(text).digest('hex');
          raw = JSON.parse(text) as unknown;
        } catch (error) { if (isNotFound(error)) continue; throw problem(); }
      }
      if (Buffer.byteLength(`${JSON.stringify(raw, null, 2)}\n`, 'utf8') > MAX_METADATA_BYTES) throw problem();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['schema', 'runs'].includes(key))) throw problem();
      const envelope = raw as { schema?: unknown; runs?: unknown };
      const entries = envelope.runs;
      if (envelope.schema !== METADATA_SCHEMA || !Array.isArray(entries) || entries.length > MAX_RECORDS || !entries.every(run => validRun(run, session)) || new Set(entries.map(run => run.id)).size !== entries.length) throw problem();
      const recovered = entries.map(run => run.state !== 'running' ? run : recoverRun(run));
      // Commit the imported/recovered checkpoint before exposing it. Preserved
      // sidecars are never consulted again after this session's import marker.
      if (this.checkpoints) this.checkpoints.writeSession(session.id, recovered, legacyDigest ? { legacyDigest } : undefined);
      else if (entries.some(run => run.state === 'running')) await writeJsonAtomic(file, { schema: METADATA_SCHEMA, runs: recovered });
      this.records.set(session.id, recovered);
    }
  }
  reserve(sessionId: string, connectionIds: string[]): void {
    this.assertSessionClear(sessionId);
    this.assertConnectionsClear(connectionIds);
    this.reservations.set(sessionId, [...new Set(connectionIds)]);
  }
  isReserved(sessionId: string): boolean { return this.reservations.has(sessionId); }
  release(sessionId: string): void { this.reservations.delete(sessionId); }
  assertSessionClear(sessionId: string): void {
    if (this.reservations.has(sessionId) || (this.records.get(sessionId) ?? []).some(unresolved)) throw new Error('This session has active or unresolved native mission execution.');
  }
  assertConnectionsClear(connectionIds: readonly string[], exceptSession?: string): void {
    for (const [sessionId, ids] of this.reservations) if (sessionId !== exceptSession && ids.some(id => connectionIds.includes(id))) throw new Error('A selected connection has active native mission execution.');
    for (const runs of this.records.values()) for (const run of runs) if (unresolved(run) && run.tasks.some(task => connectionIds.includes(task.connectionId))) throw new Error('A selected connection has active or unresolved native mission execution.');
  }
  assertRemovable(sessionId: string): void { this.assertSessionClear(sessionId); }
  list(sessionId: string): HostMissionRun[] { return copy(this.records.get(sessionId) ?? []); }
  get(sessionId: string, missionId: string): HostMissionRun {
    const record = this.records.get(sessionId)?.find(run => run.id === missionId);
    if (!record) throw new Error('That native mission no longer exists.');
    return copy(record);
  }
  private candidateRecords(run: HostMissionRun): HostMissionRun[] {
    const existing = this.records.get(run.sessionId) ?? [];
    // Stable sorting keeps the current record ahead of histories with the same timestamp.
    const updated = [copy(run), ...existing.filter(item => item.id !== run.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    while (updated.length > MAX_RECORDS) this.pruneTerminal(updated, run.id);
    return updated;
  }
  private pruneTerminal(records: HostMissionRun[], currentId: string): void {
    let oldest = records.length - 1;
    while (oldest >= 0 && (records[oldest]!.id === currentId || unresolved(records[oldest]!))) oldest--;
    if (oldest < 0) throw problem();
    records.splice(oldest, 1);
  }
  private replaceMemory(sessionId: string, records: HostMissionRun[]): void {
    const retained = new Set(records.map(run => run.id));
    for (const old of this.records.get(sessionId) ?? []) if (!retained.has(old.id)) this.forgetVolatile(old.id);
    this.records.set(sessionId, records);
  }
  private forgetVolatile(missionId: string): void {
    for (const { event } of this.volatileEvents.get(missionId) ?? []) this.volatileEventOwners.delete(event.id);
    this.volatileEvents.delete(missionId); this.volatileBytes.delete(missionId);
  }
  updateMemory(run: HostMissionRun): void {
    this.replaceMemory(run.sessionId, this.retainedRecords(run));
    if (run.transient) this.transient.add(run.sessionId);
  }
  private retainedRecords(run: HostMissionRun): HostMissionRun[] {
    // Never commit a saved record that the strict startup decoder would reject.
    if (!run.transient && !validRun(run, { id: run.sessionId, workspaceId: run.workspaceId } as SessionRecord)) throw problem();
    const records = this.candidateRecords(run);
    const envelope = { schema: METADATA_SCHEMA, runs: records };
    // Match writeJsonAtomic exactly, including indentation, JSON escapes and its trailing newline.
    while (Buffer.byteLength(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8') > MAX_METADATA_BYTES) this.pruneTerminal(records, run.id);
    return records;
  }
  /** One synchronous acknowledgement boundary for the runtime; observer delivery follows commit. */
  commitEvent(run: HostMissionRun, raw: AgentEvent): number {
    const event = validateMissionJournalEvent(raw, run);
    const records = this.retainedRecords(run);
    if (!run.transient) {
      if (!this.checkpoints) throw problem();
      const acknowledged = this.checkpoints.writeSession(run.sessionId, records, { event });
      if (!acknowledged?.sequence) throw problem();
      // A duplicate acknowledged event must not rewind the live cache either.
      this.replaceMemory(run.sessionId, this.checkpoints.readSession(run.sessionId)!);
      return acknowledged.sequence;
    }
    const prior = this.volatileEvents.get(run.id) ?? [];
    const snapshotDigest = createHash('sha256').update(stableJson(run)).digest('hex');
    const duplicate = prior.find(item => item.event.id === event.id);
    if (duplicate) {
      const { sequence: _sequence, ...original } = duplicate.event;
      if (stableJson(original) !== stableJson(event) || duplicate.snapshotDigest !== snapshotDigest) throw problem();
      return duplicate.event.sequence!;
    }
    // Match SQLite's retained event-ID uniqueness across missions as well.
    if (this.volatileEventOwners.has(event.id)) throw problem();
    const first = prior[0]?.event;
    const lead = prior.find(item => item.event.body.type === 'mission.state')?.event.agentId;
    if (first && (first.workspaceId !== event.workspaceId || first.sessionId !== event.sessionId)
      || event.body.type === 'mission.state' && lead && lead !== event.agentId || prior.length >= 8192) throw problem();
    const acknowledged = { ...event, sequence: prior.length + 1 };
    const bytes = Buffer.byteLength(stableJson(acknowledged), 'utf8');
    if (bytes > 4096) throw problem();
    // Running totals keep each acknowledgement O(1) instead of re-encoding the session journal.
    const sessionBytes = records.reduce((sum, item) => sum + (this.volatileBytes.get(item.id) ?? 0), 0) + bytes;
    if (sessionBytes > MAX_METADATA_BYTES) throw problem();
    prior.push({ event: acknowledged, snapshotDigest, bytes });
    this.volatileEvents.set(run.id, prior);
    this.volatileEventOwners.set(event.id, run.id);
    this.volatileBytes.set(run.id, (this.volatileBytes.get(run.id) ?? 0) + bytes);
    this.replaceMemory(run.sessionId, records); this.transient.add(run.sessionId);
    return acknowledged.sequence;
  }
  async save(run: HostMissionRun): Promise<void> {
    const records = this.retainedRecords(run);
    const envelope = { schema: METADATA_SCHEMA, runs: records };
    // Compute retention before touching either the live cache or the atomic file.
    if (!run.transient) {
      if (this.checkpointFile && !this.checkpoints) throw problem();
      if (this.checkpoints) this.checkpoints.writeSession(run.sessionId, records);
      else await writeJsonAtomic(this.file(run.sessionId), envelope);
    }
    this.replaceMemory(run.sessionId, records);
    if (run.transient) this.transient.add(run.sessionId);
  }
  async remove(sessionId: string): Promise<void> {
    this.assertRemovable(sessionId);
    if (!this.transient.has(sessionId)) {
      if (this.checkpointFile && !this.checkpoints) throw problem();
      if (this.checkpoints) this.checkpoints.removeSession(sessionId);
      else await rm(this.file(sessionId), { force: true });
    }
    for (const run of this.records.get(sessionId) ?? []) this.forgetVolatile(run.id);
    this.records.delete(sessionId); this.transient.delete(sessionId);
  }
  close(): void { this.checkpoints?.close(); this.checkpoints = undefined; }
}

export interface PreparedMission { run: HostMissionRun; options: NativeMissionOptions; leadId: string }
export async function prepareMission(input: {
  request: HostMissionRequest; session: SessionRecord; transient: boolean; root: string;
  connections: ReadonlyMap<string, Connection>;
  providerFor(connection: Connection): Promise<ModelProvider>;
  /** Trusted composition provenance, never copied from a mission/model request. */
  localSettlementCoverage?: 'extalia-native-local-v1';
  /**
   * Tool root for a write-capable task (ADR 0028): the host creates the worker's own Git worktree and
   * returns the folder its file tools are bound to. Required when any task has `access: 'write'`.
   */
  worktreeFor?(task: { alias: string; missionId: string; taskId: string; agentId: string }): Promise<string>;
}): Promise<PreparedMission> {
  const { request, session } = input, missionId = randomUUID(), workspaceId = randomUUID(), leadId = randomUUID(), budgetId = randomUUID(), sessionId = randomUUID();
  const now = new Date().toISOString(), version = { schemaVersion: 1 as const };
  const profiles = new Map<string, { id: string; connection: Connection; model: string }>();
  const providerIds = new Map([...input.connections.keys()].map(id => [id, randomUUID()]));
  const tasks: HostMissionTask[] = request.tasks.map(task => ({ id: task.id, taskId: randomUUID(), agentId: randomUUID(), title: task.title, dependsOn: [...task.dependsOn], connectionId: task.connectionId, model: task.model, state: 'queued', evidenceIds: [], ...(task.access === 'write' ? { access: 'write' as const } : {}) }));
  for (const task of request.tasks) {
    const key = JSON.stringify([task.connectionId, task.model]);
    if (!profiles.has(key)) profiles.set(key, { id: randomUUID(), connection: input.connections.get(task.connectionId)!, model: task.model });
  }
  const capability = { ...version, observe: true, readMessages: true, readTools: true, pause: false, resume: false, control: true, delegate: false };
  const maxConcurrency = request.budget?.maxConcurrency ?? request.maxConcurrency ?? 3;
  // One normalized budget object is retained with the run (ADR 0015).
  const budget = { ...(request.budget ?? {}), maxConcurrency };
  const plan: OrchestrationPlan = {
    ...version,
    mission: { ...version, id: missionId, workspaceId, leadAgentId: leadId, budgetId, state: 'queued', createdAt: now, updatedAt: now, version: 1 },
    budget: { ...version, id: budgetId, workspaceId, maxTokens: budget.maxTokens ?? 0, spentTokens: 0, maxCostUsd: 0, spentCostUsd: 0, maxDurationMs: budget.maxDurationMs ?? 0, maxActiveAgents: maxConcurrency, maxDelegationDepth: 1 },
    registry: { ...version, workspaceId, agents: [
      { ...version, id: leadId, origin: 'native', workspaceId, role: 'mission-supervisor', engineId: 'extalia-native', capabilities: { ...capability, control: false, delegate: true } },
      ...tasks.map((task, index) => ({ ...version, id: task.agentId, origin: 'native' as const, workspaceId, supervisorId: leadId, role: request.tasks[index]!.access === 'write' ? 'write-worker' : 'read-only-worker', engineId: 'extalia-native', modelProfileId: profiles.get(JSON.stringify([task.connectionId, task.model]))!.id, capabilities: capability })),
    ] },
    providers: [...input.connections.values()].map(connection => ({ ...version, id: providerIds.get(connection.id)!, adapterId: connection.api, maxConcurrency })),
    models: [...profiles.values()].map(profile => ({ ...version, id: profile.id, providerId: providerIds.get(profile.connection.id)!, model: profile.model, toolCalling: true, streaming: true, vision: false })),
    graph: { ...version, missionId, tasks: tasks.map((task, index) => ({ ...version, id: task.taskId, missionId, assignedAgentId: task.agentId, state: 'queued', attempt: 0, dependsOn: request.tasks[index]!.dependsOn.map(alias => tasks.find(task => task.id === alias)!.taskId), requirements: [task.title], evidenceIds: [], ...(task.access === 'write' ? { access: 'write' as const } : {}) })) },
  };
  const bindings = await Promise.all([...profiles.values()].map(async profile => ({ modelProfileId: profile.id, providerId: providerIds.get(profile.connection.id)!, model: profile.model, provider: await input.providerFor({ ...profile.connection, model: profile.model }), ...(input.localSettlementCoverage ? { localSettlementCoverage: input.localSettlementCoverage } : {}) })));
  const tools = createFileTools(input.root).filter(tool => tool.access === 'read');
  // Write-capable tasks get every file tool, rooted in their own worktree; nothing is bound to the project folder.
  const writeTools = new Map<string, ReturnType<typeof createFileTools>>();
  for (const [index, task] of tasks.entries()) {
    if (request.tasks[index]!.access !== 'write') continue;
    if (!input.worktreeFor) throw new Error('Write-capable tasks need an isolated worktree.');
    const root = await input.worktreeFor({ alias: task.id, missionId, taskId: task.taskId, agentId: task.agentId });
    writeTools.set(task.taskId, createFileTools(root));
  }
  return {
    run: { id: missionId, sessionId: session.id, workspaceId: session.workspaceId, title: request.title, state: 'running', createdAt: now, updatedAt: now, transient: input.transient, tasks, budget, usage: { unknownTasks: 0 } },
    leadId,
    options: { plan, sessionId, bindings, maxConcurrency,
      budget: { ...(budget.maxTokens !== undefined ? { maxTokens: budget.maxTokens } : {}), ...(budget.maxTaskTokens !== undefined ? { maxTaskTokens: budget.maxTaskTokens } : {}), ...(budget.maxDurationMs !== undefined ? { maxDurationMs: budget.maxDurationMs } : {}) },
      tasks: tasks.map((task, index) => ({ taskId: task.taskId, instructions: request.tasks[index]!.instructions, timeoutMs: request.tasks[index]!.timeoutMs ?? 60_000, maxSteps: request.tasks[index]!.maxSteps ?? 8,
        ...(input.localSettlementCoverage ? { localSettlementCoverage: input.localSettlementCoverage } : {}),
        ...(writeTools.has(task.taskId) ? { tools: writeTools.get(task.taskId)!, writeCapable: true } : { tools }) })) },
  };
}

export interface MissionProjection { body: EventBody; agentId: string; taskId?: string }
/** The legacy projection makes no v1 journal/durability claim. Missing v0 states stay in metadata. */
export function projectMissionEvent(event: AgentEvent, leadId: string): MissionProjection[] {
  if (!parseOrchestration('agentEvent', event).ok) throw new Error('Invalid native mission event.');
  const agentId = event.agentId === leadId ? 'primary' : event.agentId!;
  const envelope = { agentId, ...(event.taskId ? { taskId: event.taskId } : {}) }, body = event.body;
  if (body.type === 'mission.state') return [];
  if (body.type === 'task.state') {
    if (body.state === 'completed') return [{ ...envelope, body: { type: 'task.completed', ok: true, summary: 'Completed with unverified model output.' } }];
    if (['failed', 'cancelled', 'blocked', 'unknown'].includes(body.state)) {
      const summary = body.state === 'unknown' ? 'Execution state is unknown; reconciliation is required.' : body.state === 'blocked' ? 'This task was not started because required work or capacity is unavailable.' : `Task ${body.state}.`;
      return [
        { ...envelope, body: { type: 'task.completed', ok: false, summary } },
        { ...envelope, body: body.state === 'unknown' || body.state === 'blocked' ? { type: 'agent.state', state: 'blocked', summary } : { type: 'agent.state', state: 'idle', phase: body.state === 'cancelled' ? 'interrupted' : 'error', summary } },
      ];
    }
    return [];
  }
  if (body.type === 'turn.completed' || body.type === 'turn.failed') return [];
  return [{ ...envelope, body }];
}

export function finishMission(run: HostMissionRun, result: NativeMissionResult): HostMissionRun {
  const results = new Map(result.tasks.map(task => [task.taskId, task]));
  return {
    ...run, state: result.state, updatedAt: result.persistenceFailed ? new Date().toISOString() : result.events.at(-1)?.observedAt ?? new Date().toISOString(),
    usage: result.usage, ...(result.budgetExhausted ? { budgetExhausted: result.budgetExhausted } : {}), tasks: run.tasks.map(task => {
      const outcome = results.get(task.taskId)!;
      return { ...task, state: outcome.state, ...(outcome.answer !== undefined ? { answer: outcome.answer } : {}), ...(outcome.verification ? { verification: outcome.verification } : {}), ...(outcome.reason ? { reason: outcome.reason } : {}), evidenceIds: [], ...(outcome.usage ? { usage: outcome.usage } : {}) };
    }),
  };
}
export { runNativeMission };
