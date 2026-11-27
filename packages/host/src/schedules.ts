import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Effort } from '@extalia/core';
import {
  GENERAL_SCHEDULE_LIMITS,
  nextScheduleRunAt,
  normalizeSaveGeneralSchedule,
  previewScheduleNextRuns as computeSchedulePreview,
  type GeneralSchedule,
  type GeneralScheduleCatalog,
  type NextRunPreview,
  type PermissionMode,
  type SaveGeneralScheduleInput,
  type ScheduleAgentAssignment,
  type ScheduleDeliveryV1,
  type ScheduleReviewDecision,
  type ScheduleRunDetail,
  type ScheduleRunFilter,
  type ScheduleRunPage,
  type ScheduleRunV1,
  type ScheduleTrigger,
  type ScheduleVerificationState,
} from '@extalia/platform';
import { writeJsonAtomic } from './jsonStore.js';
import {
  buildAutomaticOccurrenceKey,
  buildManualOccurrenceKey,
  decodeScheduleRetryContext,
  LEGACY_SCHEDULE_JSON_SCHEMA,
  MAX_PROMPT_CREATIONS,
  readLegacyScheduleJsonFile,
  ScheduleStore,
  ScheduleStoreCorruptionError,
  ScheduleStoreDowngradeError,
  type LegacyMigrationResult,
  type PromptCreationReceipt,
  type RecordDeliveryInput,
  type RecoveryReceipt,
  type ScheduleRetryContext,
  type TurnBindingInput,
  type TurnSettlementDetails,
  type TurnSettlementMatch,
  type VerificationDetails,
} from './scheduleStore.js';

export type { LegacyMigrationResult, RecordDeliveryInput, ScheduleRetryContext, TurnBindingInput, TurnSettlementDetails, TurnSettlementMatch, VerificationDetails };
export { ScheduleStoreCorruptionError, ScheduleStoreDowngradeError };

const CLOCK_RECHECK_MS = 30_000;
const MISSED_GRACE_MS = 60_000;
const BUSY_RETRY_DELAYS_MS = [60_000, 120_000, 300_000, 600_000] as const;

export interface ScheduleExecutionTarget {
  sessionId: string;
  boundSessionId?: string;
  skippedBusy?: boolean;
}

export interface ScheduleDeferredDispatch {
  deferred: 'connection-unavailable';
  retryContext: ScheduleRetryContext;
}

export interface ScheduleDispatchReceipt {
  runtimeId?: string;
  turnId?: string;
  correlationId?: string;
  executionGeneration?: string;
}

export interface GeneralScheduleHostCallbacks {
  validateWorkspace(workspaceId: string): void;
  /** Only a trusted, side-effect-free host check can report that dispatch has not started. */
  prepareExecution?(schedule: GeneralSchedule, manual: boolean, retryContext?: ScheduleRetryContext): Promise<'ready' | 'connection-unavailable'>;
  resolveSession(schedule: GeneralSchedule, manual: boolean, retryContext?: ScheduleRetryContext): Promise<ScheduleExecutionTarget>;
  dispatchPrompt(
    sessionId: string,
    prompt: string,
    assignment: ScheduleAgentAssignment,
    retryContext?: ScheduleRetryContext,
  ): Promise<void | ScheduleDeferredDispatch | ScheduleDispatchReceipt>;
  onRunSettled?(run: ScheduleRunV1, schedule: GeneralSchedule | undefined): Promise<void> | void;
  onChange?(): void;
}

export interface GeneralScheduleManagerOptions {
  directory: string;
  /** Directory for the canonical SQLite ledger (`schedules.sqlite`). Defaults to `directory`. */
  stateDirectory?: string;
  /** Explicit file path override for the SQLite schedule ledger. */
  sqlitePath?: string;
  /** Mirror catalog JSON to `directory/schedules.json` for transitional legacy compatibility. Defaults to `false` when `stateDirectory` or `sqlitePath` is provided, otherwise `true`. */
  mirrorLegacyJson?: boolean;
  callbacks: GeneralScheduleHostCallbacks;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface ScheduleMigrationDiagnostics {
  migrated: boolean;
  migratedAt?: string;
  backupPath?: string;
  migratedHostTimeZone?: string;
  currentHostTimeZone: string;
  hostTimeZoneChanged: boolean;
}

const userError = (message: string) => Object.assign(new Error(message), { name: 'UserError' });

function decodeDispatchReceipt(raw: unknown): { kind: 'deferred'; retryContext: ScheduleRetryContext } | { kind: 'dispatched'; receipt: ScheduleDispatchReceipt } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('The schedule dispatch returned an invalid receipt.');
  }
  const value = raw as Record<string, unknown>;
  if ('deferred' in value) {
    if (Object.keys(value).some(key => key !== 'deferred' && key !== 'retryContext') || value.deferred !== 'connection-unavailable') {
      throw new Error('The schedule dispatch returned an invalid receipt.');
    }
    return { kind: 'deferred', retryContext: decodeScheduleRetryContext(value.retryContext) };
  }
  const allowedKeys = ['runtimeId', 'turnId', 'correlationId', 'executionGeneration'];
  const keys = Object.keys(value);
  if (!keys.length || keys.some(key => !allowedKeys.includes(key))) {
    throw new Error('The schedule dispatch returned an invalid receipt.');
  }
  const receipt: ScheduleDispatchReceipt = {};
  for (const key of keys) {
    const field = value[key];
    if (field !== undefined) {
      if (typeof field !== 'string' || !field.trim() || field.length > 200 || /\p{Cc}/u.test(field)) {
        throw new Error('The schedule dispatch returned an invalid receipt.');
      }
      receipt[key as keyof ScheduleDispatchReceipt] = field;
    }
  }
  return { kind: 'dispatched', receipt };
}

export class GeneralScheduleManager {
  private readonly file: string;
  readonly sqlitePath: string;
  private readonly mirrorLegacyJson: boolean;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private store?: ScheduleStore;
  private schedules: GeneralSchedule[] = [];
  /** Private, bounded receipts; neither host invocation keys nor this ledger enter the public catalog. */
  private promptCreations = new Map<string, PromptCreationReceipt>();
  private recoveries = new Map<string, RecoveryReceipt>();
  private triggerGenerations = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private timerGeneration = 0;
  private activeRuns = 0;
  private closed = false;
  private storageUnavailable = false;
  private readonly executions = new Set<Promise<void>>();

  constructor(private readonly options: GeneralScheduleManagerOptions) {
    this.file = path.join(options.directory, 'schedules.json');
    this.sqlitePath = options.sqlitePath ?? path.join(options.stateDirectory ?? options.directory, 'schedules.sqlite');
    this.mirrorLegacyJson = options.mirrorLegacyJson ?? (options.stateDirectory === undefined && options.sqlitePath === undefined);
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  get isBusy(): boolean {
    return this.activeRuns > 0 || this.executions.size > 0;
  }

  private assertWritable(): void {
    if (this.closed) throw userError('The schedule host is closed.');
    if (this.storageUnavailable || !this.store) {
      throw userError('Schedule storage is unavailable. Inspect the saved schedule state before restarting.');
    }
  }

  private assertStoreOpen(): ScheduleStore {
    if (this.storageUnavailable || !this.store) {
      throw userError('Schedule storage is unavailable. Inspect the saved schedule state before restarting.');
    }
    return this.store;
  }

  private cancelTimer(): void {
    this.timerGeneration++;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
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

  private serializeLegacyMirror(): { payload: Record<string, unknown>; sha256: string; bytes: number } {
    const publicRecoveries = [...this.recoveries.values()].map(item => ({
      scheduleId: item.scheduleId,
      reason: item.reason,
      dueAt: item.dueAt,
      retryAt: item.retryAt,
      attempt: item.attempt,
      ...(item.retryContext ? { retryContext: item.retryContext } : {}),
    }));
    const payload = {
      schema: LEGACY_SCHEDULE_JSON_SCHEMA,
      schedules: this.schedules,
      ...(this.promptCreations.size ? { promptCreations: [...this.promptCreations.values()] } : {}),
      ...(publicRecoveries.length ? { recoveries: publicRecoveries } : {}),
    };
    const encoded = `${JSON.stringify(payload, null, 2)}\n`;
    const bytes = Buffer.byteLength(encoded);
    const digest = createHash('sha256').update(encoded).digest('hex');
    return { payload, sha256: digest, bytes };
  }

  private async writeToDisk(): Promise<void> {
    const store = this.assertStoreOpen();
    let mirrorSha256: string | undefined;
    try {
      if (this.mirrorLegacyJson) {
        const mirror = this.serializeLegacyMirror();
        if (mirror.bytes > GENERAL_SCHEDULE_LIMITS.storeBytes) {
          throw userError('Schedules exceed the 512 KiB storage limit.');
        }
        await writeJsonAtomic(this.file, mirror.payload, { mode: 0o600 });
        mirrorSha256 = mirror.sha256;
      }
      store.replaceCatalogState({
        schedules: this.schedules,
        promptCreations: [...this.promptCreations.values()],
        recoveries: [...this.recoveries.values()],
        triggerGenerations: this.triggerGenerations,
        ...(mirrorSha256 !== undefined ? { lastJsonMirrorSha256: mirrorSha256 } : {}),
      });
    } catch (error) {
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
      const dueMs = Date.parse(plannedDue);
      const intervalMs = schedule.trigger.intervalMinutes * 60_000;
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
    const updated: GeneralSchedule = {
      ...current,
      revision: current.revision + 1,
      enabled: !completed && current.enabled,
      state: completed ? 'completed' : nextRunAt ? 'scheduled' : 'paused',
      lastOutcome: 'missed',
      updatedAt: new Date(nowMs).toISOString(),
    };
    if (nextRunAt) updated.nextRunAt = nextRunAt;
    else delete updated.nextRunAt;
    this.recoveries.delete(current.id);
    this.schedules[index] = updated;
  }

  async initialize(): Promise<void> {
    let hasDue = false;
    await this.serialized(async () => {
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      let store: ScheduleStore;
      try {
        store = await ScheduleStore.open(this.sqlitePath);
      } catch (error) {
        this.storageUnavailable = true;
        this.cancelTimer();
        throw error;
      }
      this.store = store;

      try {
        // One-time idempotent migration from legacy config/schedules.json with immutable backup.
        await store.migrateLegacyJson(this.file, nowIso);

        // In legacy-mirror compatibility mode, detect external offline edits to schedules.json.
        if (this.mirrorLegacyJson) {
          const external = await readLegacyScheduleJsonFile(this.file);
          const lastMirrorSha = store.getMeta('last_json_mirror_sha256');
          if (external && external.sha256 !== lastMirrorSha) {
            const currentState = store.readCatalogState();
            const currentById = new Map(currentState.schedules.map(item => [item.id, item]));
            const nextGenerations = new Map(currentState.triggerGenerations);
            const externalRecoveryById = new Map(external.recoveries.map(item => [item.scheduleId, item]));
            for (const extJob of external.schedules) {
              const prev = currentById.get(extJob.id);
              const existingGen = nextGenerations.get(extJob.id) ?? 1;
              const hasActiveRecovery = externalRecoveryById.has(extJob.id);
              if (prev && prev.nextRunAt !== extJob.nextRunAt && !hasActiveRecovery) {
                nextGenerations.set(extJob.id, existingGen + 1);
              } else {
                nextGenerations.set(extJob.id, existingGen);
              }
            }
            const existingRecoveryById = new Map(currentState.recoveries.map(item => [item.scheduleId, item]));
            const mergedRecoveries = external.recoveries.map(rec => {
              const prior = existingRecoveryById.get(rec.scheduleId);
              return prior?.runId && prior.dueAt === rec.dueAt ? { ...rec, runId: prior.runId } : rec;
            });
            store.replaceCatalogState({
              schedules: external.schedules,
              promptCreations: external.promptCreations,
              recoveries: mergedRecoveries,
              triggerGenerations: nextGenerations,
              lastJsonMirrorSha256: external.sha256,
            });
          }
        }
      } catch (error) {
        this.storageUnavailable = true;
        this.cancelTimer();
        throw error;
      }

      const loaded = store.readCatalogState();
      this.schedules = loaded.schedules;
      this.promptCreations = new Map(loaded.promptCreations.map(receipt => [receipt.scheduleId, receipt]));
      this.recoveries = new Map(loaded.recoveries.map(receipt => [receipt.scheduleId, receipt]));
      this.triggerGenerations = new Map(loaded.triggerGenerations);

      // Quarantine any interrupted SQLite runs (`admitting`, `dispatched`, `running`) as `unknown`.
      store.recoverInterruptedRuns(nowIso);

      let dirty = false;
      for (const index of this.schedules.keys()) {
        const current = this.schedules[index]!;
        if (current.state === 'running') {
          // Dispatch may already have been accepted: never replay this uncertain occurrence.
          const plannedDue = this.recoveries.get(current.id)?.dueAt ?? current.nextRunAt;
          const generation = this.triggerGenerations.get(current.id) ?? 1;
          store.recordInterruptedLegacyRun({
            scheduleId: current.id,
            scheduleRevision: current.revision,
            occurrenceKey: buildAutomaticOccurrenceKey(current.id, plannedDue ?? nowIso, generation),
            scheduledFor: plannedDue ?? nowIso,
            workspaceId: current.workspaceId,
            ...(current.lastSessionId ? { sessionId: current.lastSessionId } : {}),
            statusReason: 'The host restarted while this scheduled run was in progress.',
            nowIso,
          });
          const nextRunAt = current.enabled ? this.nextOccurrence(current, nowMs, plannedDue) : undefined;
          const oneOff = current.trigger.kind === 'once';
          const updated: GeneralSchedule = {
            ...current,
            revision: current.revision + 1,
            enabled: oneOff ? false : current.enabled,
            state: oneOff ? 'failed' : nextRunAt ? 'scheduled' : 'paused',
            lastOutcome: 'failed',
            lastError: 'The host restarted while this scheduled run was in progress.',
            updatedAt: nowIso,
          };
          if (nextRunAt) updated.nextRunAt = nextRunAt;
          else delete updated.nextRunAt;
          this.recoveries.delete(current.id);
          this.schedules[index] = updated;
          dirty = true;
        }
        const updated = this.schedules[index]!;
        if (updated.enabled && updated.state === 'scheduled' && updated.nextRunAt && Date.parse(updated.nextRunAt) <= nowMs) {
          if (updated.missedPolicy === 'skip' && nowMs - Date.parse(updated.nextRunAt) > MISSED_GRACE_MS) {
            this.skipMissed(index, nowMs);
            dirty = true;
          } else {
            hasDue = true;
          }
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

  private triggerSchedule(id: string, manual: boolean, expectedRevision?: number, operatorRequestId?: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.own(this.executeSchedule(id, manual, expectedRevision, operatorRequestId));
  }

  private async executeSchedule(id: string, manual: boolean, expectedRevision?: number, operatorRequestId?: string): Promise<void> {
    let snapshot: GeneralSchedule | undefined;
    let plannedDue: string | undefined;
    let busyAttempt = 0;
    let connectionAttempt = 0;
    let manualEarlyDeadline: string | undefined;
    let priorRecovery: RecoveryReceipt | undefined;
    let retryContext: ScheduleRetryContext | undefined;
    let activeRun: ScheduleRunV1 | undefined;

    await this.serialized(async () => {
      if (this.closed) return;
      this.assertWritable();
      const store = this.assertStoreOpen();
      const index = this.schedules.findIndex(item => item.id === id);
      if (index < 0) {
        if (manual) throw userError('This schedule changed. Refresh before running it.');
        return;
      }
      const current = this.schedules[index]!;
      if (manual && expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw userError('This schedule changed. Refresh before running it.');
      }
      if (current.state === 'running') {
        if (manual) throw userError('This schedule is already running.');
        return;
      }
      const nowMs = this.now();
      if (!manual && (!current.enabled || current.state !== 'scheduled' || !current.nextRunAt || Date.parse(current.nextRunAt) > nowMs)) return;
      if (!manual && current.missedPolicy === 'skip' && nowMs - Date.parse(current.nextRunAt!) > MISSED_GRACE_MS) {
        this.skipMissed(index, nowMs);
        await this.writeToDisk();
        this.armTimer();
        this.options.callbacks.onChange?.();
        return;
      }
      const pending = this.recoveries.get(id);
      priorRecovery = pending ? structuredClone(pending) : undefined;
      retryContext = pending?.retryContext ? { ...pending.retryContext } : undefined;
      plannedDue = pending?.dueAt ?? current.nextRunAt;
      busyAttempt = pending?.reason === 'busy' ? pending.attempt : 0;
      connectionAttempt = pending?.reason === 'connection-unavailable' ? pending.attempt : 0;
      if (manual && !pending && current.nextRunAt && Date.parse(current.nextRunAt) > nowMs) manualEarlyDeadline = current.nextRunAt;

      const stamp = new Date(nowMs).toISOString();
      const triggerGeneration = this.triggerGenerations.get(id) ?? 1;
      const occurrenceKind = manual
        ? 'manual'
        : !pending && plannedDue && nowMs - Date.parse(plannedDue) > MISSED_GRACE_MS
          ? 'catch-up'
          : 'automatic';
      const occurrenceKey = manual
        ? buildManualOccurrenceKey(id, operatorRequestId ?? randomUUID())
        : buildAutomaticOccurrenceKey(id, plannedDue ?? stamp, triggerGeneration);

      const running: GeneralSchedule = {
        ...current,
        revision: current.revision + 1,
        state: 'running',
        updatedAt: stamp,
      };
      delete running.lastError;
      this.schedules[index] = running;
      this.activeRuns++;
      try {
        await this.writeToDisk();
        const admission = store.admitOccurrence({
          scheduleId: running.id,
          scheduleRevision: running.revision,
          occurrenceKey,
          occurrenceKind,
          scheduledFor: plannedDue ?? stamp,
          ...(manual ? { requestedAt: stamp } : {}),
          workspaceId: running.workspaceId,
          nowIso: stamp,
          safeNoWorkProof: !manual && Boolean(pending),
        });
        if (!admission.admitted) {
          this.activeRuns--;
          this.schedules[index] = current;
          await this.writeToDisk();
          if (manual) throw userError('This scheduled occurrence was already admitted.');
          return;
        }
        activeRun = admission.run;
      } catch (error) {
        this.activeRuns--;
        this.schedules[index] = current;
        throw error;
      }
      snapshot = structuredClone(running);
      this.armTimer();
      this.options.callbacks.onChange?.();
    });

    if (!snapshot || !activeRun) return;

    let outcome: 'succeeded' | 'failed' | 'skipped-busy' | 'deferred-connection' = 'succeeded';
    let errorMessage: string | undefined;
    let sessionId: string | undefined;
    let boundSessionId = snapshot.boundSessionId;
    let dispatchReceipt: ScheduleDispatchReceipt | undefined;

    try {
      const readiness = this.options.callbacks.prepareExecution
        ? retryContext
          ? await this.options.callbacks.prepareExecution(snapshot, manual, { ...retryContext })
          : await this.options.callbacks.prepareExecution(snapshot, manual)
        : 'ready';
      this.assertWritable();
      if (readiness === 'connection-unavailable') {
        outcome = 'deferred-connection';
      } else {
        if (readiness !== 'ready') throw new Error('The schedule connection check returned an invalid result.');
        const resolved = retryContext
          ? await this.options.callbacks.resolveSession(snapshot, manual, { ...retryContext })
          : await this.options.callbacks.resolveSession(snapshot, manual);
        if (retryContext && resolved.sessionId !== retryContext.sessionId) {
          throw new Error('The scheduled retry destination changed. Review the retained session before retrying.');
        }
        sessionId = resolved.sessionId;
        if (resolved.boundSessionId !== undefined) boundSessionId = resolved.boundSessionId;
        if (resolved.skippedBusy) {
          outcome = 'skipped-busy';
        } else {
          this.assertWritable();
          const receipt = retryContext
            ? await this.options.callbacks.dispatchPrompt(sessionId, snapshot.prompt, snapshot.assignment, { ...retryContext })
            : await this.options.callbacks.dispatchPrompt(sessionId, snapshot.prompt, snapshot.assignment);
          if (receipt !== undefined) {
            const parsed = decodeDispatchReceipt(receipt);
            if (parsed.kind === 'deferred') {
              if (parsed.retryContext.sessionId !== sessionId) {
                throw new Error('The deferred receipt does not match its scheduled destination.');
              }
              retryContext = parsed.retryContext;
              outcome = 'deferred-connection';
            } else {
              dispatchReceipt = parsed.receipt;
            }
          }
        }
      }
    } catch (error) {
      outcome = 'failed';
      errorMessage = error instanceof Error ? error.message.slice(0, 500) : 'Scheduled run failed.';
    }

    let terminalRun: ScheduleRunV1 | undefined;
    let terminalSchedule: GeneralSchedule | undefined;

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
        this.recoveries.set(id, {
          ...priorRecovery!,
          reason,
          attempt: priorRecovery!.reason === reason ? priorRecovery!.attempt : 1,
          ...(retryContext ? { retryContext: { ...retryContext } } : {}),
        });
      } else if ((recoverBusy || recoverConnection) && plannedDue && nextRunAt) {
        this.recoveries.set(id, {
          scheduleId: id,
          reason: connectionUnavailable ? 'connection-unavailable' : 'busy',
          dueAt: plannedDue,
          retryAt: nextRunAt,
          attempt: Math.min(retryAttempt + 1, BUSY_RETRY_DELAYS_MS.length),
          ...(retryContext ? { retryContext: { ...retryContext } } : {}),
          runId: activeRun!.id,
        });
      } else {
        this.recoveries.delete(id);
      }
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

      const store = this.assertStoreOpen();
      try {
        if (outcome === 'succeeded') {
          store.markRunDispatched(activeRun!.id, activeRun!.revision, {
            ...(sessionId ? { sessionId } : {}),
            ...(dispatchReceipt?.runtimeId ? { runtimeId: dispatchReceipt.runtimeId } : {}),
            ...(dispatchReceipt?.turnId ? { turnId: dispatchReceipt.turnId } : {}),
            ...(dispatchReceipt?.correlationId ? { correlationId: dispatchReceipt.correlationId } : {}),
            ...(dispatchReceipt?.executionGeneration ? { executionGeneration: dispatchReceipt.executionGeneration } : {}),
            nowIso: finishedIso,
          });
        } else if (outcome === 'deferred-connection' || outcome === 'skipped-busy') {
          if (recoverBusy || recoverConnection) {
            store.markRunDeferred(activeRun!.id, activeRun!.revision, {
              statusReason: outcome,
              ...(sessionId ? { sessionId } : {}),
              nowIso: finishedIso,
            });
          } else {
            terminalRun = store.markRunBlocked(activeRun!.id, activeRun!.revision, {
              statusReason: outcome,
              ...(sessionId ? { sessionId } : {}),
              nowIso: finishedIso,
            });
            terminalSchedule = structuredClone(updated);
          }
        } else {
          terminalRun = store.markRunFailed(activeRun!.id, activeRun!.revision, {
            statusReason: errorMessage ?? 'Scheduled run failed.',
            ...(sessionId ? { sessionId } : {}),
            nowIso: finishedIso,
          });
          terminalSchedule = structuredClone(updated);
        }
      } catch (error) {
        this.storageUnavailable = true;
        this.cancelTimer();
        throw error;
      }

      this.armTimer();
      this.options.callbacks.onChange?.();
    });
    if (terminalRun && this.options.callbacks.onRunSettled) {
      try {
        await this.options.callbacks.onRunSettled(terminalRun, terminalSchedule);
      } catch {
        // Delivery/fanout failures never alter the settled run state (GW-AT-091).
      }
    }
    if (manual && outcome === 'failed' && errorMessage) {
      throw userError(errorMessage);
    }
    if (manual && outcome === 'skipped-busy') throw userError('This session is still working. Wait for it or stop it first.');
    if (manual && outcome === 'deferred-connection') throw userError('The configured connection is unavailable. No scheduled prompt was sent.');
  }

  async list(): Promise<GeneralScheduleCatalog> {
    return this.serialized(async () => this.catalog());
  }

  async listScheduleRuns(filter: ScheduleRunFilter): Promise<ScheduleRunPage> {
    return this.serialized(async () => {
      const store = this.assertStoreOpen();
      return store.listRuns(filter);
    });
  }

  async scheduleRunDetail(runId: string): Promise<ScheduleRunDetail | undefined> {
    return this.serialized(async () => {
      const store = this.assertStoreOpen();
      return store.getRunDetail(runId);
    });
  }

  async reviewUnknownScheduleRun(runId: string, expectedRevision: number, decision: ScheduleReviewDecision): Promise<ScheduleRunDetail> {
    return this.serialized(async () => {
      this.assertWritable();
      const store = this.assertStoreOpen();
      const detail = store.reviewUnknownRun(runId, expectedRevision, decision, new Date(this.now()).toISOString());
      this.options.callbacks.onChange?.();
      return detail;
    });
  }

  previewScheduleNextRuns(trigger: ScheduleTrigger, count: number, fromMs?: number): NextRunPreview {
    const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    return computeSchedulePreview(trigger, count, fromMs ?? this.now(), hostTimeZone);
  }

  async recordTurnStarted(runId: string, binding: TurnBindingInput): Promise<ScheduleRunV1> {
    return this.serialized(async () => {
      this.assertWritable();
      const store = this.assertStoreOpen();
      const run = store.recordTurnBound(runId, {
        ...binding,
        nowIso: binding.nowIso ?? new Date(this.now()).toISOString(),
      });
      this.options.callbacks.onChange?.();
      return run;
    });
  }

  async recordTurnSettled(
    match: TurnSettlementMatch,
    outcome: 'completed' | 'failed' | 'cancelled',
    details: TurnSettlementDetails = {},
  ): Promise<ScheduleRunV1> {
    const { run, schedule } = await this.serialized(async () => {
      this.assertWritable();
      const store = this.assertStoreOpen();
      const settled = store.recordTurnSettled(match, outcome, {
        ...details,
        nowIso: details.nowIso ?? new Date(this.now()).toISOString(),
      });
      let matchedSchedule: GeneralSchedule | undefined;
      const index = this.schedules.findIndex(item => item.id === settled.scheduleId);
      if (index >= 0) {
        const current = this.schedules[index]!;
        if (outcome === 'completed') {
          this.schedules[index] = {
            ...current,
            completedRunCount: (current.completedRunCount ?? 0) + 1,
          };
        }
        matchedSchedule = structuredClone(this.schedules[index]!);
      }
      this.options.callbacks.onChange?.();
      return { run: settled, schedule: matchedSchedule };
    });
    if (this.options.callbacks.onRunSettled) {
      try {
        await this.options.callbacks.onRunSettled(run, schedule);
      } catch {
        // Delivery/fanout failures never alter the settled run state (GW-AT-091).
      }
    }
    return run;
  }

  async recordDelivery(input: RecordDeliveryInput): Promise<ScheduleDeliveryV1> {
    return this.serialized(async () => {
      this.assertWritable();
      const store = this.assertStoreOpen();
      const delivery = store.recordDelivery({
        ...input,
        nowIso: input.nowIso ?? new Date(this.now()).toISOString(),
      });
      this.options.callbacks.onChange?.();
      return delivery;
    });
  }

  async recordVerification(
    runId: string,
    verification: ScheduleVerificationState,
    details: VerificationDetails = {},
  ): Promise<ScheduleRunV1> {
    return this.serialized(async () => {
      this.assertWritable();
      const store = this.assertStoreOpen();
      const run = store.recordVerification(runId, verification, {
        ...details,
        nowIso: details.nowIso ?? new Date(this.now()).toISOString(),
      });
      this.options.callbacks.onChange?.();
      return run;
    });
  }

  async migrationDiagnostics(): Promise<ScheduleMigrationDiagnostics> {
    return this.serialized(async () => {
      const store = this.assertStoreOpen();
      const migrated = store.getMeta('legacy_migration_v1') === '1';
      const migratedAt = store.getMeta('legacy_migration_at');
      const backupPath = store.getMeta('legacy_migration_backup');
      const migratedHostTimeZone = store.getMeta('legacy_migration_host_timezone');
      const currentHostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      return {
        migrated,
        ...(migratedAt ? { migratedAt } : {}),
        ...(backupPath ? { backupPath } : {}),
        ...(migratedHostTimeZone ? { migratedHostTimeZone } : {}),
        currentHostTimeZone,
        hostTimeZoneChanged: Boolean(migratedHostTimeZone && migratedHostTimeZone !== currentHostTimeZone),
      };
    });
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
    const fingerprint = createHash('sha256').update(JSON.stringify({
      workspaceId: input.workspaceId,
      name: input.name,
      prompt: input.prompt,
      enabled: input.enabled ?? true,
      trigger: input.trigger,
      sessionTarget,
      assignment: input.assignment ?? { teamMode: 'workspace' },
      missedPolicy: input.missedPolicy ?? 'skip',
    })).digest('hex');
    return this.serialized(async () => {
      this.assertWritable();
      assertCurrent?.();
      this.options.callbacks.validateWorkspace(input.workspaceId);
      const receipt = this.promptCreations.get(id);
      const existing = this.schedules.find(item => item.id === id);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint || receipt.invalidated || !existing) {
          throw userError('This prompt scheduling invocation changed or its job was edited or removed. Inspect the original schedule.');
        }
        return structuredClone(existing);
      }
      if (existing) throw userError('This prompt scheduling identity is already reserved. Inspect the saved schedule.');
      if (this.promptCreations.size >= MAX_PROMPT_CREATIONS) {
        throw userError('Prompt scheduling receipt limit reached (1024). Existing receipts were preserved; use Schedules to create jobs manually.');
      }
      if (this.schedules.length >= GENERAL_SCHEDULE_LIMITS.schedules) {
        throw userError(`Keep at most ${GENERAL_SCHEDULE_LIMITS.schedules} schedules.`);
      }
      const nowMs = this.now();
      const stamp = new Date(nowMs).toISOString();
      const enabled = input.enabled ?? true;
      if (enabled && input.trigger.kind === 'once' && Date.parse(input.trigger.runAt) <= nowMs) {
        throw userError('Choose a future date and time for a one-off schedule.');
      }
      const nextRunAt = enabled ? nextScheduleRunAt(input.trigger, nowMs) : undefined;
      const record: GeneralSchedule = {
        id,
        revision: 1,
        workspaceId: input.workspaceId,
        name: input.name,
        prompt: input.prompt,
        enabled,
        trigger: input.trigger,
        sessionTarget: input.sessionTarget,
        assignment: input.assignment ?? { teamMode: 'workspace' },
        missedPolicy: input.missedPolicy ?? 'skip',
        state: enabled && nextRunAt ? 'scheduled' : 'paused',
        ...(nextRunAt ? { nextRunAt } : {}),
        runCount: 0,
        createdAt: stamp,
        updatedAt: stamp,
      };
      this.schedules.push(record);
      this.promptCreations.set(id, { scheduleId: id, fingerprint, invalidated: false });
      this.triggerGenerations.set(id, 1);
      try {
        await this.writeToDisk();
      } catch (error) {
        this.schedules = this.schedules.filter(item => item.id !== id);
        this.promptCreations.delete(id);
        this.triggerGenerations.delete(id);
        throw error;
      }
      this.armTimer();
      this.options.callbacks.onChange?.();
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
        ...(previous?.legacyDispatchCount !== undefined ? { legacyDispatchCount: previous.legacyDispatchCount } : {}),
        ...(previous?.completedRunCount !== undefined ? { completedRunCount: previous.completedRunCount } : {}),
        createdAt: previous?.createdAt ?? nowIso,
        updatedAt: nowIso,
      };
      if (previous) {
        this.schedules[existingIndex] = record;
        const triggerChanged = JSON.stringify(previous.trigger) !== JSON.stringify(input.trigger);
        if (triggerChanged) {
          this.triggerGenerations.set(record.id, (this.triggerGenerations.get(record.id) ?? 1) + 1);
        }
        this.invalidatePromptCreation(previous.id);
        this.recoveries.delete(previous.id);
      } else {
        this.schedules.push(record);
        this.triggerGenerations.set(record.id, 1);
      }
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
      this.invalidatePromptCreation(id);
      this.recoveries.delete(id);
      await this.writeToDisk();
      this.armTimer();
      this.options.callbacks.onChange?.();
      return this.catalog();
    });
  }

  async runNow(id: string, expectedRevision?: number, operatorRequestId?: string): Promise<GeneralScheduleCatalog> {
    if (typeof id !== 'string' || !id.trim()) throw userError('Choose a schedule to run.');
    await this.serialized(async () => {
      this.assertWritable();
      const previous = this.schedules.find(item => item.id === id);
      if (!previous || (expectedRevision !== undefined && previous.revision !== expectedRevision)) {
        throw userError('This schedule changed. Refresh before running it.');
      }
      if (previous.state === 'running') throw userError('This schedule is already running.');
    });
    await this.triggerSchedule(id, true, expectedRevision, operatorRequestId);
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
      this.invalidatePromptCreation(id);
      this.recoveries.delete(id);
      this.triggerGenerations.delete(id);
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
      for (const item of this.schedules) {
        if (item.workspaceId === workspaceId) {
          this.invalidatePromptCreation(item.id);
          this.recoveries.delete(item.id);
          this.triggerGenerations.delete(item.id);
        }
      }
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
    this.store?.close();
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
