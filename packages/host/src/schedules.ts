import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { Effort } from '@extalia/core';
import {
  GENERAL_SCHEDULE_LIMITS,
  nextScheduleRunAt,
  normalizeSaveGeneralSchedule,
  normalizeScheduleAgentAssignment,
  normalizeScheduleSessionTarget,
  normalizeScheduleTrigger,
  type GeneralSchedule,
  type GeneralScheduleCatalog,
  type PermissionMode,
  type SaveGeneralScheduleInput,
  type ScheduleAgentAssignment,
} from '@extalia/platform';
import { isNotFound, writeJsonAtomic } from './jsonStore.js';

const SCHEMA = 'extalia.schedules.v1';
const CLOCK_RECHECK_MS = 30_000;
const MISSED_GRACE_MS = 60_000;
const BUSY_RETRY_DELAYS_MS = [60_000, 120_000, 300_000, 600_000] as const;
const MAX_PROMPT_CREATIONS = 1024;
interface PromptCreationReceipt { scheduleId: string; fingerprint: string; invalidated: boolean }
interface RecoveryReceipt { scheduleId: string; reason: 'busy' | 'connection-unavailable'; dueAt: string; retryAt: string; attempt: number; retryContext?: ScheduleRetryContext }
interface StoredSchedules { schedules: GeneralSchedule[]; promptCreations: PromptCreationReceipt[]; recoveries: RecoveryReceipt[] }

export interface ScheduleExecutionTarget {
  sessionId: string;
  boundSessionId?: string;
  skippedBusy?: boolean;
}

/** Opaque proof owned by the host: one unstarted Native destination and its saved history. */
export interface ScheduleRetryContext {
  sessionId: string;
  historySha256: string;
}

export interface ScheduleDeferredDispatch {
  deferred: 'connection-unavailable';
  retryContext: ScheduleRetryContext;
}

function decodeRetryContext(raw: unknown): ScheduleRetryContext {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid schedule retry context.');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'sessionId' && key !== 'historySha256')
    || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 160
    || value.sessionId.trim() !== value.sessionId || /\p{Cc}/u.test(value.sessionId)
    || typeof value.historySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.historySha256))
    throw new Error('Invalid schedule retry context.');
  return { sessionId: value.sessionId, historySha256: value.historySha256 };
}

export interface GeneralScheduleHostCallbacks {
  validateWorkspace(workspaceId: string): void;
  /** Only a trusted, side-effect-free host check can report that dispatch has not started. */
  prepareExecution?(schedule: GeneralSchedule, manual: boolean, retryContext?: ScheduleRetryContext): Promise<'ready' | 'connection-unavailable'>;
  resolveSession(schedule: GeneralSchedule, manual: boolean, retryContext?: ScheduleRetryContext): Promise<ScheduleExecutionTarget>;
  dispatchPrompt(sessionId: string, prompt: string, assignment: ScheduleAgentAssignment, retryContext?: ScheduleRetryContext): Promise<void | ScheduleDeferredDispatch>;
  onChange?(): void;
}

export interface GeneralScheduleManagerOptions {
  directory: string;
  callbacks: GeneralScheduleHostCallbacks;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

const userError = (message: string) => Object.assign(new Error(message), { name: 'UserError' });

function decodeStoredSchedule(raw: unknown): GeneralSchedule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid schedule entry.');
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || !item.id || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1) {
    throw new Error('Invalid schedule identity.');
  }
  const normalized = normalizeSaveGeneralSchedule({
    id: item.id,
    expectedRevision: Number(item.revision),
    workspaceId: item.workspaceId,
    name: item.name,
    prompt: item.prompt,
    enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
    trigger: normalizeScheduleTrigger(item.trigger),
    sessionTarget: normalizeScheduleSessionTarget(item.sessionTarget),
    assignment: normalizeScheduleAgentAssignment(item.assignment),
    missedPolicy: item.missedPolicy === 'run-once' ? 'run-once' : 'skip',
  });
  const state = ['scheduled', 'paused', 'running', 'completed', 'failed'].includes(String(item.state))
    ? (item.state as GeneralSchedule['state'])
    : normalized.enabled ? 'scheduled' : 'paused';
  const lastOutcome = ['succeeded', 'failed', 'skipped-busy', 'deferred-connection', 'missed'].includes(String(item.lastOutcome))
    ? (item.lastOutcome as NonNullable<GeneralSchedule['lastOutcome']>)
    : undefined;
  return {
    id: item.id,
    revision: Number(item.revision),
    workspaceId: normalized.workspaceId,
    name: normalized.name,
    prompt: normalized.prompt,
    enabled: normalized.enabled ?? true,
    trigger: normalized.trigger,
    sessionTarget: normalized.sessionTarget,
    ...(typeof item.boundSessionId === 'string' && item.boundSessionId ? { boundSessionId: item.boundSessionId } : {}),
    assignment: normalized.assignment ?? { teamMode: 'workspace' },
    missedPolicy: normalized.missedPolicy ?? 'skip',
    state,
    ...(typeof item.nextRunAt === 'string' && Number.isFinite(Date.parse(item.nextRunAt)) ? { nextRunAt: item.nextRunAt } : {}),
    ...(typeof item.lastRunAt === 'string' && Number.isFinite(Date.parse(item.lastRunAt)) ? { lastRunAt: item.lastRunAt } : {}),
    ...(lastOutcome ? { lastOutcome } : {}),
    ...(typeof item.lastError === 'string' && item.lastError ? { lastError: item.lastError.slice(0, 500) } : {}),
    ...(typeof item.lastSessionId === 'string' && item.lastSessionId ? { lastSessionId: item.lastSessionId } : {}),
    runCount: Number.isSafeInteger(item.runCount) && Number(item.runCount) >= 0 ? Number(item.runCount) : 0,
    createdAt: typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt : new Date(0).toISOString(),
    updatedAt: typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt)) ? item.updatedAt : new Date(0).toISOString(),
  };
}

export class GeneralScheduleManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private schedules: GeneralSchedule[] = [];
  /** Private, bounded receipts; neither host invocation keys nor this ledger enter the public catalog. */
  private promptCreations = new Map<string, PromptCreationReceipt>();
  private recoveries = new Map<string, RecoveryReceipt>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private timerGeneration = 0;
  private activeRuns = 0;
  private closed = false;
  private storageUnavailable = false;
  private readonly executions = new Set<Promise<void>>();

  constructor(private readonly options: GeneralScheduleManagerOptions) {
    this.file = path.join(options.directory, 'schedules.json');
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  get isBusy(): boolean {
    return this.activeRuns > 0 || this.executions.size > 0;
  }

  private assertWritable(): void {
    if (this.closed) throw userError('The schedule host is closed.');
    if (this.storageUnavailable) throw userError('Schedule storage is unavailable. Inspect the saved schedule state before restarting.');
  }

  private cancelTimer(): void {
    this.timerGeneration++;
    if (this.timer) { this.clearTimer(this.timer); this.timer = undefined; }
  }

  /** Keep callback work owned through its final persistence acknowledgement. */
  private own(task: Promise<void>): Promise<void> {
    this.executions.add(task);
    const settled = () => {
      this.executions.delete(task);
      try { this.options.callbacks.onChange?.(); } catch { /* Notification cannot reopen settled work. */ }
    };
    void task.then(settled, settled);
    return task;
  }

  private observeBackground(task: Promise<void>): void {
    // Storage failures latch in writeToDisk; background rejection must still be
    // observed instead of escaping a timer or startup catch-up callback.
    void task.catch(() => undefined);
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work, work);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async readFromDisk(): Promise<StoredSchedules> {
    let handle;
    try { handle = await open(this.file, 'r'); }
    catch (error) { if (isNotFound(error)) return { schedules: [], promptCreations: [], recoveries: [] }; throw error; }
    let raw: unknown;
    try {
      const buffer = Buffer.alloc(GENERAL_SCHEDULE_LIMITS.storeBytes + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > GENERAL_SCHEDULE_LIMITS.storeBytes) throw new Error('Schedule store exceeds its size limit.');
      raw = JSON.parse(buffer.toString('utf8', 0, total));
    } finally {
      await handle.close();
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid schedule store.');
    const value = raw as Record<string, unknown>;
    if (value.schema !== SCHEMA || !Array.isArray(value.schedules) || value.schedules.length > GENERAL_SCHEDULE_LIMITS.schedules) {
      throw new Error('Invalid schedule store schema.');
    }
    const items = value.schedules.map(decodeStoredSchedule);
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Duplicate schedule ids.');
    const rawReceipts = value.promptCreations ?? [];
    if (!Array.isArray(rawReceipts) || rawReceipts.length > MAX_PROMPT_CREATIONS) throw new Error('Invalid prompt schedule receipt ledger.');
    const promptCreations = rawReceipts.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid prompt schedule receipt.');
      const receipt = raw as Record<string, unknown>;
      if (typeof receipt.scheduleId !== 'string' || !/^sch_[a-f0-9]{64}$/.test(receipt.scheduleId)
        || typeof receipt.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)
        || typeof receipt.invalidated !== 'boolean') throw new Error('Invalid prompt schedule receipt.');
      if (!receipt.invalidated && !items.some(item => item.id === receipt.scheduleId)) throw new Error('A prompt schedule receipt is missing its job.');
      return { scheduleId: receipt.scheduleId, fingerprint: receipt.fingerprint, invalidated: receipt.invalidated };
    });
    if (new Set(promptCreations.map(receipt => receipt.scheduleId)).size !== promptCreations.length) throw new Error('Duplicate prompt schedule receipts.');
    const rawRecoveries = value.recoveries ?? [];
    if (!Array.isArray(rawRecoveries) || rawRecoveries.length > GENERAL_SCHEDULE_LIMITS.schedules) throw new Error('Invalid schedule recovery ledger.');
    const recoveries = rawRecoveries.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid schedule recovery receipt.');
      const item = raw as Record<string, unknown>;
      const job = items.find(job => job.id === item.scheduleId);
      const reason = item.reason === undefined ? 'busy' : item.reason;
      if (!job || !job.enabled || (reason !== 'busy' && reason !== 'connection-unavailable') || job.trigger.kind === 'once' && reason === 'busy' || job.missedPolicy !== 'run-once'
        || !['scheduled', 'running'].includes(job.state) || typeof item.dueAt !== 'string' || !Number.isFinite(Date.parse(item.dueAt))
        || typeof item.retryAt !== 'string' || !Number.isFinite(Date.parse(item.retryAt)) || job.nextRunAt !== item.retryAt
        || !Number.isSafeInteger(item.attempt) || Number(item.attempt) < 1 || Number(item.attempt) > BUSY_RETRY_DELAYS_MS.length)
        throw new Error('Invalid schedule recovery receipt.');
      const retryContext = item.retryContext === undefined ? undefined : decodeRetryContext(item.retryContext);
      return { scheduleId: job.id, reason: reason as 'busy' | 'connection-unavailable', dueAt: item.dueAt, retryAt: item.retryAt, attempt: Number(item.attempt),
        ...(retryContext ? { retryContext } : {}) };
    });
    if (new Set(recoveries.map(item => item.scheduleId)).size !== recoveries.length) throw new Error('Duplicate schedule recoveries.');
    return { schedules: items, promptCreations, recoveries };
  }

  private async writeToDisk(): Promise<void> {
    const payload = { schema: SCHEMA, schedules: this.schedules,
      ...(this.promptCreations.size ? { promptCreations: [...this.promptCreations.values()] } : {}),
      ...(this.recoveries.size ? { recoveries: [...this.recoveries.values()] } : {}) };
    try {
      if (Buffer.byteLength(`${JSON.stringify(payload, null, 2)}\n`) > GENERAL_SCHEDULE_LIMITS.storeBytes) {
        throw userError('Schedules exceed the 512 KiB storage limit.');
      }
      await writeJsonAtomic(this.file, payload, { mode: 0o600 });
    }
    catch (error) {
      this.storageUnavailable = true;
      this.cancelTimer();
      throw error;
    }
  }

  private catalog(): GeneralScheduleCatalog {
    const sorted = [...this.schedules].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const revision = createHash('sha256')
      .update(JSON.stringify([timeZone, this.storageUnavailable, sorted.map(item => [item.id, item.revision, item.state, item.nextRunAt, item.lastRunAt, item.runCount, this.recoveries.get(item.id)])]))
      .digest('hex')
      .slice(0, 16);
    return {
      revision,
      schedules: sorted.map(item => {
        const pending = this.recoveries.get(item.id);
        return { ...structuredClone(item), ...(pending ? { recovery: { reason: pending.reason, dueAt: pending.dueAt, attempt: pending.attempt } } : {}) };
      }),
      ...(timeZone ? { timeZone } : {}),
      ...(this.storageUnavailable ? { problem: 'storage-unavailable' as const } : {}),
    };
  }

  /** Keep interval slots anchored to their planned occurrence, never to completion latency. */
  private nextOccurrence(schedule: GeneralSchedule, afterMs: number, plannedDue?: string): string | undefined {
    if (schedule.trigger.kind === 'interval' && plannedDue && Number.isFinite(Date.parse(plannedDue))) {
      const dueMs = Date.parse(plannedDue), intervalMs = schedule.trigger.intervalMinutes * 60_000;
      const slots = Math.max(1, Math.floor((afterMs - dueMs) / intervalMs) + 1);
      return new Date(dueMs + slots * intervalMs).toISOString();
    }
    const referenceMs = plannedDue && Number.isFinite(Date.parse(plannedDue)) ? Math.max(afterMs, Date.parse(plannedDue)) : afterMs;
    return nextScheduleRunAt(schedule.trigger, referenceMs, referenceMs);
  }

  private skipMissed(index: number, nowMs: number): void {
    const current = this.schedules[index]!;
    const nextRunAt = this.nextOccurrence(current, nowMs, current.nextRunAt);
    const completed = current.trigger.kind === 'once';
    const updated: GeneralSchedule = { ...current, revision: current.revision + 1, enabled: !completed && current.enabled,
      state: completed ? 'completed' : nextRunAt ? 'scheduled' : 'paused', lastOutcome: 'missed', updatedAt: new Date(nowMs).toISOString() };
    if (nextRunAt) updated.nextRunAt = nextRunAt; else delete updated.nextRunAt;
    this.recoveries.delete(current.id); this.schedules[index] = updated;
  }

  async initialize(): Promise<void> {
    let hasDue = false;
    await this.serialized(async () => {
      const stored = await this.readFromDisk();
      this.schedules = stored.schedules;
      this.promptCreations = new Map(stored.promptCreations.map(receipt => [receipt.scheduleId, receipt]));
      this.recoveries = new Map(stored.recoveries.map(receipt => [receipt.scheduleId, receipt]));
      const nowMs = this.now();
      let dirty = false;
      for (const index of this.schedules.keys()) {
        const current = this.schedules[index]!;
        if (current.state === 'running') {
          // Dispatch may already have been accepted: never replay this uncertain occurrence.
          const plannedDue = this.recoveries.get(current.id)?.dueAt ?? current.nextRunAt;
          const nextRunAt = current.enabled ? this.nextOccurrence(current, nowMs, plannedDue) : undefined;
          const oneOff = current.trigger.kind === 'once';
          const updated: GeneralSchedule = { ...current, revision: current.revision + 1,
            enabled: oneOff ? false : current.enabled, state: oneOff ? 'failed' : nextRunAt ? 'scheduled' : 'paused',
            lastOutcome: 'failed', lastError: 'The host restarted while this scheduled run was in progress.', updatedAt: new Date(nowMs).toISOString() };
          if (nextRunAt) updated.nextRunAt = nextRunAt; else delete updated.nextRunAt;
          this.recoveries.delete(current.id); this.schedules[index] = updated; dirty = true;
        }
        const updated = this.schedules[index]!;
        if (updated.enabled && updated.state === 'scheduled' && updated.nextRunAt && Date.parse(updated.nextRunAt) <= nowMs) {
          if (updated.missedPolicy === 'skip' && nowMs - Date.parse(updated.nextRunAt) > MISSED_GRACE_MS) {
            this.skipMissed(index, nowMs); dirty = true;
          } else hasDue = true;
        }
      }
      if (dirty) await this.writeToDisk();
    });
    // Exactly one owner processes startup catch-up; do not also arm a zero-delay timer.
    if (hasDue && !this.closed && !this.storageUnavailable) this.observeBackground(this.own(this.onTimerTick()));
    else this.armTimer();
  }

  private armTimer(): void {
    this.cancelTimer();
    if (this.closed || this.storageUnavailable) return;
    let earliestMs = Number.POSITIVE_INFINITY;
    for (const schedule of this.schedules) {
      if (!schedule.enabled || schedule.state !== 'scheduled' || !schedule.nextRunAt) continue;
      const ms = Date.parse(schedule.nextRunAt);
      if (Number.isFinite(ms) && ms < earliestMs) earliestMs = ms;
    }
    if (!Number.isFinite(earliestMs)) return;
    const delay = Math.max(0, Math.min(CLOCK_RECHECK_MS, earliestMs - this.now()));
    const generation = this.timerGeneration;
    this.timer = this.setTimer(() => {
      if (generation !== this.timerGeneration) return;
      this.timer = undefined;
      this.observeBackground(this.own(this.onTimerTick()));
    }, delay);
  }

  private async onTimerTick(): Promise<void> {
    if (this.closed || this.storageUnavailable) return;
    const dueIds = await this.serialized(async () => {
      const nowMs = this.now();
      return this.schedules
        .filter(item => item.enabled && item.state === 'scheduled' && item.nextRunAt && Date.parse(item.nextRunAt) <= nowMs)
        .map(item => item.id);
    });
    for (const id of dueIds) {
      if (this.closed || this.storageUnavailable) break;
      await this.triggerSchedule(id, false);
    }
    if (!this.closed) this.armTimer();
  }

  private triggerSchedule(id: string, manual: boolean, expectedRevision?: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.own(this.executeSchedule(id, manual, expectedRevision));
  }

  private async executeSchedule(id: string, manual: boolean, expectedRevision?: number): Promise<void> {
    let snapshot: GeneralSchedule | undefined;
    let plannedDue: string | undefined;
    let busyAttempt = 0;
    let connectionAttempt = 0;
    let manualEarlyDeadline: string | undefined;
    let priorRecovery: RecoveryReceipt | undefined;
    let retryContext: ScheduleRetryContext | undefined;
    await this.serialized(async () => {
      if (this.closed) return;
      this.assertWritable();
      const index = this.schedules.findIndex(item => item.id === id);
      if (index < 0) {
        if (manual) throw userError('This schedule changed. Refresh before running it.');
        return;
      }
      const current = this.schedules[index]!;
      if (manual && expectedRevision !== undefined && current.revision !== expectedRevision)
        throw userError('This schedule changed. Refresh before running it.');
      if (current.state === 'running') {
        if (manual) throw userError('This schedule is already running.');
        return;
      }
      if (!manual && (!current.enabled || current.state !== 'scheduled' || !current.nextRunAt || Date.parse(current.nextRunAt) > this.now())) return;
      if (!manual && current.missedPolicy === 'skip' && this.now() - Date.parse(current.nextRunAt!) > MISSED_GRACE_MS) {
        this.skipMissed(index, this.now()); await this.writeToDisk(); this.armTimer(); this.options.callbacks.onChange?.(); return;
      }
      const pending = this.recoveries.get(id);
      priorRecovery = pending ? structuredClone(pending) : undefined;
      retryContext = pending?.retryContext ? { ...pending.retryContext } : undefined;
      plannedDue = pending?.dueAt ?? current.nextRunAt;
      busyAttempt = pending?.reason === 'busy' ? pending.attempt : 0;
      connectionAttempt = pending?.reason === 'connection-unavailable' ? pending.attempt : 0;
      if (manual && !pending && current.nextRunAt && Date.parse(current.nextRunAt) > this.now()) manualEarlyDeadline = current.nextRunAt;
      const stamp = new Date(this.now()).toISOString();
      const running: GeneralSchedule = {
        ...current,
        revision: current.revision + 1,
        state: 'running',
        updatedAt: stamp,
      };
      delete running.lastError;
      this.schedules[index] = running;
      this.activeRuns++;
      try { await this.writeToDisk(); }
      catch (error) {
        this.activeRuns--;
        this.schedules[index] = current;
        throw error;
      }
      snapshot = structuredClone(running);
      this.armTimer();
      this.options.callbacks.onChange?.();
    });

    if (!snapshot) return;

    let outcome: 'succeeded' | 'failed' | 'skipped-busy' | 'deferred-connection' = 'succeeded';
    let errorMessage: string | undefined;
    let sessionId: string | undefined;
    let boundSessionId = snapshot.boundSessionId;

    try {
      const readiness = this.options.callbacks.prepareExecution
        ? retryContext ? await this.options.callbacks.prepareExecution(snapshot, manual, { ...retryContext }) : await this.options.callbacks.prepareExecution(snapshot, manual)
        : 'ready';
      this.assertWritable();
      if (readiness === 'connection-unavailable') {
        outcome = 'deferred-connection';
      } else {
        if (readiness !== 'ready') throw new Error('The schedule connection check returned an invalid result.');
        const resolved = retryContext
          ? await this.options.callbacks.resolveSession(snapshot, manual, { ...retryContext })
          : await this.options.callbacks.resolveSession(snapshot, manual);
        if (retryContext && resolved.sessionId !== retryContext.sessionId) throw new Error('The scheduled retry destination changed. Review the retained session before retrying.');
        sessionId = resolved.sessionId;
        if (resolved.boundSessionId !== undefined) boundSessionId = resolved.boundSessionId;
        if (resolved.skippedBusy) outcome = 'skipped-busy';
        else {
          this.assertWritable();
          const receipt = retryContext
            ? await this.options.callbacks.dispatchPrompt(sessionId, snapshot.prompt, snapshot.assignment, { ...retryContext })
            : await this.options.callbacks.dispatchPrompt(sessionId, snapshot.prompt, snapshot.assignment);
          if (receipt !== undefined) {
            if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
              || Object.keys(receipt).some(key => key !== 'deferred' && key !== 'retryContext')
              || receipt.deferred !== 'connection-unavailable') throw new Error('The schedule dispatch returned an invalid receipt.');
            const nextContext = decodeRetryContext(receipt.retryContext);
            if (nextContext.sessionId !== sessionId) throw new Error('The deferred receipt does not match its scheduled destination.');
            retryContext = nextContext;
            outcome = 'deferred-connection';
          }
        }
      }
    } catch (error) {
      outcome = 'failed';
      errorMessage = error instanceof Error ? error.message.slice(0, 500) : 'Scheduled run failed.';
    }

    await this.serialized(async () => {
      this.activeRuns = Math.max(0, this.activeRuns - 1);
      const index = this.schedules.findIndex(item => item.id === id);
      if (index < 0) {
        this.options.callbacks.onChange?.();
        return;
      }
      const current = this.schedules[index]!;
      const finishedMs = this.now();
      const finishedIso = new Date(finishedMs).toISOString();
      const connectionUnavailable = outcome === 'deferred-connection';
      const preservePending = manual && priorRecovery && (outcome === 'skipped-busy' && current.trigger.kind !== 'once' || connectionUnavailable);
      const recoverConnection = !manual && current.enabled && current.missedPolicy === 'run-once' && connectionUnavailable;
      // Only proven pre-dispatch unavailability retains a one-off. Unknown effects
      // and ordinary busy one-offs keep their explicit consumed semantics.
      const oneOffFinished = current.trigger.kind === 'once' && !recoverConnection && !preservePending;
      const keepEnabled = oneOffFinished ? false : current.enabled;
      const recoverBusy = !manual && current.trigger.kind !== 'once' && keepEnabled && current.missedPolicy === 'run-once'
        && outcome === 'skipped-busy' && busyAttempt < BUSY_RETRY_DELAYS_MS.length;
      const retryAttempt = recoverConnection ? connectionAttempt : busyAttempt;
      const retryBaseMs = plannedDue && Number.isFinite(Date.parse(plannedDue)) ? Math.max(finishedMs, Date.parse(plannedDue)) : finishedMs;
      const beforePendingDeadline = manualEarlyDeadline && Date.parse(manualEarlyDeadline) > finishedMs;
      const nextRunAt = preservePending
        ? priorRecovery!.retryAt
        : recoverBusy || recoverConnection
          ? new Date(retryBaseMs + BUSY_RETRY_DELAYS_MS[Math.min(retryAttempt, BUSY_RETRY_DELAYS_MS.length - 1)]!).toISOString()
          : keepEnabled
            ? beforePendingDeadline ? current.nextRunAt : this.nextOccurrence(current, finishedMs, plannedDue)
            : undefined;
      if (preservePending) {
        const reason = connectionUnavailable ? 'connection-unavailable' : 'busy';
        this.recoveries.set(id, { ...priorRecovery!, reason, attempt: priorRecovery!.reason === reason ? priorRecovery!.attempt : 1,
          ...(retryContext ? { retryContext: { ...retryContext } } : {}) });
      }
      else if ((recoverBusy || recoverConnection) && plannedDue && nextRunAt) this.recoveries.set(id, {
        scheduleId: id, reason: connectionUnavailable ? 'connection-unavailable' : 'busy', dueAt: plannedDue,
        retryAt: nextRunAt, attempt: Math.min(retryAttempt + 1, BUSY_RETRY_DELAYS_MS.length),
        ...(retryContext ? { retryContext: { ...retryContext } } : {}),
      });
      else this.recoveries.delete(id);
      const nextState: GeneralSchedule['state'] = oneOffFinished
        ? outcome === 'failed' || connectionUnavailable ? 'failed' : outcome === 'skipped-busy' ? 'paused' : 'completed'
        : !keepEnabled
          ? 'paused'
          : outcome === 'failed' && !nextRunAt
            ? 'failed'
            : nextRunAt
              ? 'scheduled'
              : 'paused';
      const updated: GeneralSchedule = {
        ...current,
        revision: current.revision + 1,
        enabled: keepEnabled,
        state: nextState,
        ...(boundSessionId ? { boundSessionId } : {}),
        ...(nextRunAt ? { nextRunAt } : {}),
        lastRunAt: finishedIso,
        lastOutcome: outcome,
        ...(errorMessage ? { lastError: errorMessage } : {}),
        ...(sessionId ? { lastSessionId: sessionId } : {}),
        runCount: outcome === 'succeeded' ? current.runCount + 1 : current.runCount,
        updatedAt: finishedIso,
      };
      if (!nextRunAt) delete updated.nextRunAt;
      if (!errorMessage) delete updated.lastError;
      this.schedules[index] = updated;
      await this.writeToDisk();
      this.armTimer();
      this.options.callbacks.onChange?.();
    });
    if (manual && outcome === 'failed' && errorMessage) {
      throw userError(errorMessage);
    }
    if (manual && outcome === 'skipped-busy') throw userError('This session is still working. Wait for it or stop it first.');
    if (manual && outcome === 'deferred-connection') throw userError('The configured connection is unavailable. No scheduled prompt was sent.');
  }

  async list(): Promise<GeneralScheduleCatalog> {
    return this.serialized(async () => this.catalog());
  }

  /** Host-only creation identity; retries inspect the original durable job and never update it. */
  async createFromPrompt(raw: SaveGeneralScheduleInput, invocationKey: string, assertCurrent?: () => void): Promise<GeneralSchedule> {
    let input: SaveGeneralScheduleInput;
    try { input = normalizeSaveGeneralSchedule(raw); }
    catch (error) { throw userError(error instanceof Error ? error.message : 'Invalid schedule.'); }
    if (input.id !== undefined || input.expectedRevision !== undefined) throw userError('Prompt scheduling creates a new job; edit existing schedules in Schedules.');
    if (typeof invocationKey !== 'string' || !invocationKey.trim() || invocationKey.length > 4096 || /\p{Cc}/u.test(invocationKey)) throw userError('Invalid prompt scheduling invocation.');
    const id = `sch_${createHash('sha256').update('extalia.schedule.prompt.v1\0').update(invocationKey).digest('hex')}`;
    const sessionTarget = input.sessionTarget.mode === 'derive-from-session'
      ? { ...input.sessionTarget, reuseDerived: input.sessionTarget.reuseDerived !== false } : input.sessionTarget;
    const fingerprint = createHash('sha256').update(JSON.stringify({ workspaceId: input.workspaceId, name: input.name, prompt: input.prompt,
      enabled: input.enabled ?? true, trigger: input.trigger, sessionTarget, assignment: input.assignment ?? { teamMode: 'workspace' }, missedPolicy: input.missedPolicy ?? 'skip' })).digest('hex');
    return this.serialized(async () => {
      this.assertWritable(); assertCurrent?.();
      this.options.callbacks.validateWorkspace(input.workspaceId);
      const receipt = this.promptCreations.get(id), existing = this.schedules.find(item => item.id === id);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint || receipt.invalidated || !existing) throw userError('This prompt scheduling invocation changed or its job was edited or removed. Inspect the original schedule.');
        return structuredClone(existing);
      }
      if (existing) throw userError('This prompt scheduling identity is already reserved. Inspect the saved schedule.');
      if (this.promptCreations.size >= MAX_PROMPT_CREATIONS) throw userError('Prompt scheduling receipt limit reached (1024). Existing receipts were preserved; use Schedules to create jobs manually.');
      if (this.schedules.length >= GENERAL_SCHEDULE_LIMITS.schedules) throw userError(`Keep at most ${GENERAL_SCHEDULE_LIMITS.schedules} schedules.`);
      const nowMs = this.now(), stamp = new Date(nowMs).toISOString(), enabled = input.enabled ?? true;
      if (enabled && input.trigger.kind === 'once' && Date.parse(input.trigger.runAt) <= nowMs) throw userError('Choose a future date and time for a one-off schedule.');
      const nextRunAt = enabled ? nextScheduleRunAt(input.trigger, nowMs) : undefined;
      const record: GeneralSchedule = { id, revision: 1, workspaceId: input.workspaceId, name: input.name, prompt: input.prompt,
        enabled, trigger: input.trigger, sessionTarget: input.sessionTarget, assignment: input.assignment ?? { teamMode: 'workspace' },
        missedPolicy: input.missedPolicy ?? 'skip', state: enabled && nextRunAt ? 'scheduled' : 'paused', ...(nextRunAt ? { nextRunAt } : {}),
        runCount: 0, createdAt: stamp, updatedAt: stamp };
      this.schedules.push(record);
      this.promptCreations.set(id, { scheduleId: id, fingerprint, invalidated: false });
      try { await this.writeToDisk(); }
      catch (error) {
        this.schedules = this.schedules.filter(item => item.id !== id);
        this.promptCreations.delete(id);
        throw error;
      }
      this.armTimer(); this.options.callbacks.onChange?.();
      return structuredClone(record);
    });
  }

  private invalidatePromptCreation(id: string): void {
    const receipt = this.promptCreations.get(id);
    if (receipt) this.promptCreations.set(id, { ...receipt, invalidated: true });
  }

  async save(raw: SaveGeneralScheduleInput): Promise<GeneralScheduleCatalog> {
    let input: SaveGeneralScheduleInput;
    try { input = normalizeSaveGeneralSchedule(raw); }
    catch (error) { throw userError(error instanceof Error ? error.message : 'Invalid schedule.'); }
    return this.serialized(async () => {
      this.assertWritable();
      this.options.callbacks.validateWorkspace(input.workspaceId);
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      const existingIndex = input.id ? this.schedules.findIndex(item => item.id === input.id) : -1;
      const previous = existingIndex >= 0 ? this.schedules[existingIndex] : undefined;
      if (input.id && (!previous || previous.revision !== input.expectedRevision)) {
        throw userError('This schedule changed. Refresh before saving.');
      }
      if (previous?.state === 'running') {
        throw userError('Wait for the running schedule occurrence to finish before editing.');
      }
      if (!previous && this.schedules.length >= GENERAL_SCHEDULE_LIMITS.schedules) {
        throw userError(`Keep at most ${GENERAL_SCHEDULE_LIMITS.schedules} schedules.`);
      }
      const enabled = input.enabled ?? previous?.enabled ?? true;
      if (enabled && input.trigger.kind === 'once' && Date.parse(input.trigger.runAt) <= nowMs) {
        throw userError('Choose a future date and time for a one-off schedule.');
      }
      const nextRunAt = enabled ? nextScheduleRunAt(input.trigger, nowMs) : undefined;
      const keepBoundSession = previous
        && previous.workspaceId === input.workspaceId
        && previous.sessionTarget.mode === input.sessionTarget.mode
        && (input.sessionTarget.mode === 'create-and-reuse' || input.sessionTarget.mode === 'derive-from-session'
          && previous.sessionTarget.mode === 'derive-from-session'
          && previous.sessionTarget.sourceSessionId === input.sessionTarget.sourceSessionId
          && previous.sessionTarget.reuseDerived !== false && input.sessionTarget.reuseDerived !== false)
        ? previous.boundSessionId
        : undefined;
      const record: GeneralSchedule = {
        id: previous?.id ?? `sch_${randomUUID()}`,
        revision: (previous?.revision ?? 0) + 1,
        workspaceId: input.workspaceId,
        name: input.name,
        prompt: input.prompt,
        enabled,
        trigger: input.trigger,
        sessionTarget: input.sessionTarget,
        ...(keepBoundSession ? { boundSessionId: keepBoundSession } : {}),
        assignment: input.assignment ?? { teamMode: 'workspace' },
        missedPolicy: input.missedPolicy ?? 'skip',
        state: enabled && nextRunAt ? 'scheduled' : 'paused',
        ...(nextRunAt ? { nextRunAt } : {}),
        ...(previous?.lastRunAt ? { lastRunAt: previous.lastRunAt } : {}),
        ...(previous?.lastOutcome ? { lastOutcome: previous.lastOutcome } : {}),
        ...(previous?.lastSessionId ? { lastSessionId: previous.lastSessionId } : {}),
        runCount: previous?.runCount ?? 0,
        createdAt: previous?.createdAt ?? nowIso,
        updatedAt: nowIso,
      };
      if (previous) this.schedules[existingIndex] = record;
      else this.schedules.push(record);
      if (previous) { this.invalidatePromptCreation(previous.id); this.recoveries.delete(previous.id); }
      await this.writeToDisk();
      this.armTimer();
      this.options.callbacks.onChange?.();
      return this.catalog();
    });
  }

  async setEnabled(id: string, enabled: boolean, expectedRevision?: number): Promise<GeneralScheduleCatalog> {
    if (typeof id !== 'string' || !id.trim() || typeof enabled !== 'boolean') {
      throw userError('Choose a schedule to pause or resume.');
    }
    return this.serialized(async () => {
      this.assertWritable();
      const index = this.schedules.findIndex(item => item.id === id);
      const previous = index >= 0 ? this.schedules[index] : undefined;
      if (!previous || (expectedRevision !== undefined && previous.revision !== expectedRevision)) {
        throw userError('This schedule changed. Refresh before updating.');
      }
      if (previous.state === 'running') {
        throw userError('Wait for the running schedule occurrence to finish first.');
      }
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      if (enabled && previous.trigger.kind === 'once' && Date.parse(previous.trigger.runAt) <= nowMs) {
        throw userError('Edit this one-off schedule with a future date and time before enabling it.');
      }
      const nextRunAt = enabled ? nextScheduleRunAt(previous.trigger, nowMs) : undefined;
      const updated: GeneralSchedule = {
        ...previous,
        revision: previous.revision + 1,
        enabled,
        state: enabled && nextRunAt ? 'scheduled' : 'paused',
        ...(nextRunAt ? { nextRunAt } : {}),
        updatedAt: nowIso,
      };
      if (!nextRunAt) delete updated.nextRunAt;
      this.schedules[index] = updated;
      this.invalidatePromptCreation(id); this.recoveries.delete(id);
      await this.writeToDisk();
      this.armTimer();
      this.options.callbacks.onChange?.();
      return this.catalog();
    });
  }

  async runNow(id: string, expectedRevision?: number): Promise<GeneralScheduleCatalog> {
    if (typeof id !== 'string' || !id.trim()) throw userError('Choose a schedule to run.');
    await this.serialized(async () => {
      this.assertWritable();
      const previous = this.schedules.find(item => item.id === id);
      if (!previous || (expectedRevision !== undefined && previous.revision !== expectedRevision)) {
        throw userError('This schedule changed. Refresh before running it.');
      }
      if (previous.state === 'running') throw userError('This schedule is already running.');
    });
    await this.triggerSchedule(id, true, expectedRevision);
    return this.list();
  }

  async delete(id: string, expectedRevision?: number): Promise<GeneralScheduleCatalog> {
    if (typeof id !== 'string' || !id.trim()) throw userError('Choose a schedule to delete.');
    return this.serialized(async () => {
      this.assertWritable();
      const previous = this.schedules.find(item => item.id === id);
      if (!previous || (expectedRevision !== undefined && previous.revision !== expectedRevision)) {
        throw userError('This schedule changed. Refresh before deleting.');
      }
      if (previous.state === 'running') {
        throw userError('Wait for the running schedule occurrence to finish before deleting.');
      }
      this.schedules = this.schedules.filter(item => item.id !== id);
      this.invalidatePromptCreation(id); this.recoveries.delete(id);
      await this.writeToDisk();
      this.armTimer();
      this.options.callbacks.onChange?.();
      return this.catalog();
    });
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    await this.serialized(async () => {
      this.assertWritable();
      const before = this.schedules.length;
      for (const item of this.schedules) if (item.workspaceId === workspaceId) { this.invalidatePromptCreation(item.id); this.recoveries.delete(item.id); }
      this.schedules = this.schedules.filter(item => item.workspaceId !== workspaceId);
      if (this.schedules.length !== before) {
        await this.writeToDisk();
        this.armTimer();
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelTimer();
    while (this.executions.size) await Promise.allSettled([...this.executions]);
    await this.chain;
  }
}

export function buildScheduledSessionOptions(assignment: ScheduleAgentAssignment): {
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
} {
  return {
    ...(assignment.leadModel ? { model: assignment.leadModel } : {}),
    ...(assignment.leadEffort ? { effort: assignment.leadEffort } : {}),
    ...(assignment.permissionMode ? { permissionMode: assignment.permissionMode } : {}),
  };
}
