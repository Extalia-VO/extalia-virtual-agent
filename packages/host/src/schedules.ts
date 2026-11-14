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
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface ScheduleExecutionTarget {
  sessionId: string;
  boundSessionId?: string;
  skippedBusy?: boolean;
}

export interface GeneralScheduleHostCallbacks {
  validateWorkspace(workspaceId: string): void;
  resolveSession(schedule: GeneralSchedule, manual: boolean): Promise<ScheduleExecutionTarget>;
  dispatchPrompt(sessionId: string, prompt: string, assignment: ScheduleAgentAssignment): Promise<void>;
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
  const lastOutcome = ['succeeded', 'failed', 'skipped-busy', 'missed'].includes(String(item.lastOutcome))
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
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private activeRuns = 0;
  private closed = false;

  constructor(private readonly options: GeneralScheduleManagerOptions) {
    this.file = path.join(options.directory, 'schedules.json');
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  get isBusy(): boolean {
    return this.activeRuns > 0;
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work, work);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async readFromDisk(): Promise<GeneralSchedule[]> {
    let handle;
    try { handle = await open(this.file, 'r'); }
    catch (error) { if (isNotFound(error)) return []; throw error; }
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
    return items;
  }

  private async writeToDisk(): Promise<void> {
    const payload = { schema: SCHEMA, schedules: this.schedules };
    if (Buffer.byteLength(`${JSON.stringify(payload, null, 2)}\n`) > GENERAL_SCHEDULE_LIMITS.storeBytes) {
      throw userError('Schedules exceed the 512 KiB storage limit.');
    }
    await writeJsonAtomic(this.file, payload, { mode: 0o600 });
  }

  private catalog(): GeneralScheduleCatalog {
    const sorted = [...this.schedules].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const revision = createHash('sha256')
      .update(JSON.stringify(sorted.map(item => [item.id, item.revision, item.state, item.nextRunAt, item.lastRunAt, item.runCount])))
      .digest('hex')
      .slice(0, 16);
    return {
      revision,
      schedules: sorted.map(item => structuredClone(item)),
    };
  }

  async initialize(): Promise<void> {
    await this.serialized(async () => {
      this.schedules = await this.readFromDisk();
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      let dirty = false;
      const catchUpIds: string[] = [];

      for (const index of this.schedules.keys()) {
        const current = this.schedules[index]!;
        let updated = current;
        if (updated.state === 'running') {
          const nextRunAt = updated.enabled ? nextScheduleRunAt(updated.trigger, nowMs, nowMs) : undefined;
          updated = {
            ...updated,
            revision: updated.revision + 1,
            state: updated.enabled && nextRunAt ? 'scheduled' : 'paused',
            ...(nextRunAt ? { nextRunAt } : {}),
            lastOutcome: 'failed',
            lastError: 'The host restarted while this scheduled run was in progress.',
            updatedAt: nowIso,
          };
          if (!nextRunAt) delete updated.nextRunAt;
          this.schedules[index] = updated;
          dirty = true;
        }
        if (updated.enabled && updated.state === 'scheduled' && updated.nextRunAt) {
          const dueMs = Date.parse(updated.nextRunAt);
          if (Number.isFinite(dueMs) && dueMs <= nowMs) {
            if (updated.missedPolicy === 'run-once') {
              catchUpIds.push(updated.id);
            } else {
              const nextRunAt = updated.trigger.kind === 'once' ? undefined : nextScheduleRunAt(updated.trigger, nowMs, nowMs);
              const completed = updated.trigger.kind === 'once';
              const nextItem: GeneralSchedule = {
                ...updated,
                revision: updated.revision + 1,
                enabled: completed ? false : updated.enabled,
                state: completed ? 'completed' : nextRunAt ? 'scheduled' : 'paused',
                ...(nextRunAt ? { nextRunAt } : {}),
                lastOutcome: 'missed',
                updatedAt: nowIso,
              };
              if (!nextRunAt) delete nextItem.nextRunAt;
              this.schedules[index] = nextItem;
              dirty = true;
            }
          }
        }
      }
      if (dirty) await this.writeToDisk();
      this.armTimer();
      for (const id of catchUpIds) {
        if (!this.closed) void this.triggerSchedule(id, false);
      }
    });
  }

  private armTimer(): void {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    if (this.closed) return;
    let earliestMs = Number.POSITIVE_INFINITY;
    for (const schedule of this.schedules) {
      if (!schedule.enabled || schedule.state !== 'scheduled' || !schedule.nextRunAt) continue;
      const ms = Date.parse(schedule.nextRunAt);
      if (Number.isFinite(ms) && ms < earliestMs) earliestMs = ms;
    }
    if (!Number.isFinite(earliestMs)) return;
    const delay = Math.max(0, Math.min(MAX_TIMEOUT_MS, earliestMs - this.now()));
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.onTimerTick();
    }, delay);
  }

  private async onTimerTick(): Promise<void> {
    if (this.closed) return;
    const dueIds = await this.serialized(async () => {
      const nowMs = this.now();
      return this.schedules
        .filter(item => item.enabled && item.state === 'scheduled' && item.nextRunAt && Date.parse(item.nextRunAt) <= nowMs)
        .map(item => item.id);
    });
    for (const id of dueIds) {
      if (this.closed) break;
      await this.triggerSchedule(id, false);
    }
    if (!this.closed) this.armTimer();
  }

  private async triggerSchedule(id: string, manual: boolean): Promise<void> {
    let snapshot: GeneralSchedule | undefined;
    await this.serialized(async () => {
      if (this.closed) return;
      const index = this.schedules.findIndex(item => item.id === id);
      if (index < 0) return;
      const current = this.schedules[index]!;
      if (current.state === 'running') {
        if (manual) throw userError('This schedule is already running.');
        return;
      }
      if (!manual && !current.enabled) return;
      const stamp = new Date(this.now()).toISOString();
      const running: GeneralSchedule = {
        ...current,
        revision: current.revision + 1,
        state: 'running',
        updatedAt: stamp,
      };
      delete running.lastError;
      this.schedules[index] = running;
      snapshot = structuredClone(running);
      this.activeRuns++;
      await this.writeToDisk();
      this.armTimer();
      this.options.callbacks.onChange?.();
    });

    if (!snapshot) return;

    let outcome: 'succeeded' | 'failed' | 'skipped-busy' = 'succeeded';
    let errorMessage: string | undefined;
    let sessionId: string | undefined;
    let boundSessionId = snapshot.boundSessionId;

    try {
      const resolved = await this.options.callbacks.resolveSession(snapshot, manual);
      sessionId = resolved.sessionId;
      if (resolved.boundSessionId !== undefined) boundSessionId = resolved.boundSessionId;
      if (resolved.skippedBusy) {
        outcome = 'skipped-busy';
      } else {
        await this.options.callbacks.dispatchPrompt(sessionId, snapshot.prompt, snapshot.assignment);
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
      const oneOffCompleted = current.trigger.kind === 'once' && outcome === 'succeeded' && !manual;
      const keepEnabled = oneOffCompleted ? false : current.enabled;
      const nextRunAt = keepEnabled
        ? nextScheduleRunAt(current.trigger, finishedMs, current.trigger.kind === 'once' ? undefined : finishedMs)
        : undefined;
      const nextState: GeneralSchedule['state'] = oneOffCompleted
        ? 'completed'
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
  }

  async list(): Promise<GeneralScheduleCatalog> {
    return this.serialized(async () => this.catalog());
  }

  async save(raw: SaveGeneralScheduleInput): Promise<GeneralScheduleCatalog> {
    let input: SaveGeneralScheduleInput;
    try { input = normalizeSaveGeneralSchedule(raw); }
    catch (error) { throw userError(error instanceof Error ? error.message : 'Invalid schedule.'); }
    return this.serialized(async () => {
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
        && (input.sessionTarget.mode === 'create-and-reuse' || input.sessionTarget.mode === 'derive-from-session')
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
      await this.writeToDisk();
      this.armTimer();
      this.options.callbacks.onChange?.();
      return this.catalog();
    });
  }

  async runNow(id: string, expectedRevision?: number): Promise<GeneralScheduleCatalog> {
    if (typeof id !== 'string' || !id.trim()) throw userError('Choose a schedule to run.');
    await this.serialized(async () => {
      const previous = this.schedules.find(item => item.id === id);
      if (!previous || (expectedRevision !== undefined && previous.revision !== expectedRevision)) {
        throw userError('This schedule changed. Refresh before running it.');
      }
      if (previous.state === 'running') throw userError('This schedule is already running.');
    });
    await this.triggerSchedule(id, true);
    return this.list();
  }

  async delete(id: string, expectedRevision?: number): Promise<GeneralScheduleCatalog> {
    if (typeof id !== 'string' || !id.trim()) throw userError('Choose a schedule to delete.');
    return this.serialized(async () => {
      const previous = this.schedules.find(item => item.id === id);
      if (!previous || (expectedRevision !== undefined && previous.revision !== expectedRevision)) {
        throw userError('This schedule changed. Refresh before deleting.');
      }
      if (previous.state === 'running') {
        throw userError('Wait for the running schedule occurrence to finish before deleting.');
      }
      this.schedules = this.schedules.filter(item => item.id !== id);
      await this.writeToDisk();
      this.armTimer();
      this.options.callbacks.onChange?.();
      return this.catalog();
    });
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    await this.serialized(async () => {
      const before = this.schedules.length;
      this.schedules = this.schedules.filter(item => item.workspaceId !== workspaceId);
      if (this.schedules.length !== before) {
        await this.writeToDisk();
        this.armTimer();
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
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
