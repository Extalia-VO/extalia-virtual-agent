import { EFFORTS, SESSION_PERMISSION_MODES, type Effort, type SessionPermissionMode } from '@extalia/core';

export type ScheduleTrigger =
  | { kind: 'once'; runAt: string }
  | { kind: 'interval'; intervalMinutes: number }
  | { kind: 'cron'; cron: string };

export type ScheduleSessionTarget =
  | { mode: 'create-and-reuse' }
  | { mode: 'existing'; sessionId: string }
  | { mode: 'derive-from-session'; sourceSessionId: string; reuseDerived?: boolean }
  | { mode: 'new-each-run' };

export interface ScheduleWorkerAssignment {
  name: string;
  role: string;
  task?: string;
  model?: string;
}

export interface ScheduleAgentAssignment {
  leadModel?: string;
  leadEffort?: Effort;
  permissionMode?: SessionPermissionMode;
  teamMode: 'workspace' | 'solo' | 'custom';
  workers?: ScheduleWorkerAssignment[];
}

export type ScheduleMissedPolicy = 'skip' | 'run-once';

export type GeneralScheduleState = 'scheduled' | 'paused' | 'running' | 'completed' | 'failed';
export type GeneralScheduleOutcome = 'succeeded' | 'failed' | 'skipped-busy' | 'missed';

export interface GeneralSchedule {
  id: string;
  revision: number;
  workspaceId: string;
  name: string;
  prompt: string;
  enabled: boolean;
  trigger: ScheduleTrigger;
  sessionTarget: ScheduleSessionTarget;
  /** Created on first execution and reused when mode is create-and-reuse or derive-from-session (with reuseDerived !== false). */
  boundSessionId?: string;
  assignment: ScheduleAgentAssignment;
  missedPolicy: ScheduleMissedPolicy;
  state: GeneralScheduleState;
  nextRunAt?: string;
  lastRunAt?: string;
  lastOutcome?: GeneralScheduleOutcome;
  lastError?: string;
  lastSessionId?: string;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GeneralScheduleCatalog {
  revision: string;
  schedules: GeneralSchedule[];
}

export interface SaveGeneralScheduleInput {
  id?: string;
  expectedRevision?: number;
  workspaceId: string;
  name: string;
  prompt: string;
  enabled?: boolean;
  trigger: ScheduleTrigger;
  sessionTarget: ScheduleSessionTarget;
  assignment?: ScheduleAgentAssignment;
  missedPolicy?: ScheduleMissedPolicy;
}

export const GENERAL_SCHEDULE_LIMITS = {
  schedules: 64,
  storeBytes: 512 * 1024,
  nameLength: 120,
  promptLength: 32_000,
  cronLength: 120,
  minIntervalMinutes: 1,
  maxIntervalMinutes: 10_080,
  maxWorkers: 12,
} as const;

export const GENERAL_SCHEDULE_HOST_METHODS = [
  'listSchedules',
  'saveSchedule',
  'setScheduleEnabled',
  'runScheduleNow',
  'deleteSchedule',
] as const;

export interface ParsedCron {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  domWildcard: boolean;
  dowWildcard: boolean;
}

const EFFORT_VALUES: readonly Effort[] = EFFORTS;
const PERMISSION_VALUES: readonly SessionPermissionMode[] = SESSION_PERMISSION_MODES;

function parseCronField(raw: string, min: number, max: number, label: string, sundaySeven = false): { values: Set<number>; wildcard: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`Invalid cron ${label} field.`);
  const wildcard = trimmed === '*';
  const values = new Set<number>();
  for (const part of trimmed.split(',')) {
    const token = part.trim();
    if (!token) throw new Error(`Invalid cron ${label} field.`);
    const [rangePart, stepPart, extra] = token.split('/');
    if (extra !== undefined || !rangePart) throw new Error(`Invalid cron ${label} token "${token}".`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isSafeInteger(step) || step < 1 || step > max) throw new Error(`Invalid cron ${label} step in "${token}".`);
    let start = min;
    let end = max;
    if (rangePart !== '*') {
      const bounds = rangePart.split('-');
      if (bounds.length === 1) {
        const single = Number(bounds[0]);
        if (!Number.isSafeInteger(single) || single < min || single > max) throw new Error(`Cron ${label} value "${bounds[0]}" must be between ${min} and ${max}.`);
        if (stepPart === undefined) {
          values.add(sundaySeven && single === 7 ? 0 : single);
          continue;
        }
        start = single;
      } else if (bounds.length === 2 && bounds[0] && bounds[1]) {
        start = Number(bounds[0]);
        end = Number(bounds[1]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < min || end > max || start > end) {
          throw new Error(`Invalid cron ${label} range "${rangePart}".`);
        }
      } else {
        throw new Error(`Invalid cron ${label} range "${rangePart}".`);
      }
    }
    for (let current = start; current <= end; current += step) {
      values.add(sundaySeven && current === 7 ? 0 : current);
    }
  }
  if (!values.size) throw new Error(`Cron ${label} field matched no values.`);
  return { values, wildcard };
}

/** Parse and validate a standard 5-field cron expression (`minute hour dayOfMonth month dayOfWeek`). */
export function parseCronExpression(expression: string): ParsedCron {
  if (typeof expression !== 'string') throw new Error('Enter a 5-field cron expression.');
  const trimmed = expression.trim();
  if (!trimmed || trimmed.length > GENERAL_SCHEDULE_LIMITS.cronLength || /\p{Cc}/u.test(trimmed)) {
    throw new Error('Enter a valid 5-field cron expression (for example "0 9 * * 1-5").');
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('Cron expressions must have 5 fields: minute hour day-of-month month day-of-week.');
  }
  const minutes = parseCronField(fields[0]!, 0, 59, 'minute');
  const hours = parseCronField(fields[1]!, 0, 23, 'hour');
  const dom = parseCronField(fields[2]!, 1, 31, 'day-of-month');
  const months = parseCronField(fields[3]!, 1, 12, 'month');
  const dow = parseCronField(fields[4]!, 0, 7, 'day-of-week', true);
  return {
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: dom.values,
    months: months.values,
    daysOfWeek: dow.values,
    domWildcard: dom.wildcard,
    dowWildcard: dow.wildcard,
  };
}

function cronDayMatches(parsed: ParsedCron, dom: number, dow: number): boolean {
  const domMatch = parsed.daysOfMonth.has(dom);
  const dowMatch = parsed.daysOfWeek.has(dow);
  if (parsed.domWildcard && parsed.dowWildcard) return true;
  if (parsed.domWildcard) return dowMatch;
  if (parsed.dowWildcard) return domMatch;
  return domMatch || dowMatch;
}

/** Compute the next local occurrence strictly after `afterMs` for a 5-field cron expression. */
export function nextCronRunAt(expression: string, afterMs: number): string | undefined {
  if (!Number.isFinite(afterMs)) return undefined;
  const parsed = parseCronExpression(expression);
  const startMinuteMs = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  const cursor = new Date(startMinuteMs);
  const maxYear = cursor.getFullYear() + 4;

  while (cursor.getFullYear() <= maxYear) {
    const month = cursor.getMonth() + 1;
    if (!parsed.months.has(month)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    const dom = cursor.getDate();
    const dow = cursor.getDay();
    if (!cronDayMatches(parsed, dom, dow)) {
      cursor.setDate(dom + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    const hour = cursor.getHours();
    if (!parsed.hours.has(hour)) {
      cursor.setHours(hour + 1, 0, 0, 0);
      continue;
    }
    const minute = cursor.getMinutes();
    if (!parsed.minutes.has(minute)) {
      cursor.setMinutes(minute + 1, 0, 0);
      continue;
    }
    return cursor.toISOString();
  }
  return undefined;
}

/** Compute the next firing ISO timestamp for any schedule trigger. */
export function nextScheduleRunAt(trigger: ScheduleTrigger, afterMs: number, lastRunAtMs?: number): string | undefined {
  if (!Number.isFinite(afterMs)) return undefined;
  if (trigger.kind === 'once') {
    if (lastRunAtMs !== undefined) return undefined;
    const ms = Date.parse(trigger.runAt);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  }
  if (trigger.kind === 'interval') {
    const intervalMs = trigger.intervalMinutes * 60_000;
    const base = lastRunAtMs !== undefined && Number.isFinite(lastRunAtMs) ? lastRunAtMs : afterMs;
    const next = base + intervalMs;
    if (next > afterMs) return new Date(next).toISOString();
    const elapsed = afterMs - base;
    const steps = Math.floor(elapsed / intervalMs) + 1;
    return new Date(base + steps * intervalMs).toISOString();
  }
  return nextCronRunAt(trigger.cron, afterMs);
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const isCleanId = (value: unknown, max = 160): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/\p{Cc}/u.test(value) && value.trim() === value;
const isCleanText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/\p{Cc}/u.test(value);

export function normalizeScheduleTrigger(raw: unknown): ScheduleTrigger {
  if (!isRecord(raw)) throw new Error('Choose a schedule trigger.');
  if (raw.kind === 'once') {
    if (!hasOnlyKeys(raw, ['kind', 'runAt']) || typeof raw.runAt !== 'string') throw new Error('Choose a valid date and time for a one-off schedule.');
    const ms = Date.parse(raw.runAt);
    if (!Number.isFinite(ms)) throw new Error('Choose a valid date and time for a one-off schedule.');
    return { kind: 'once', runAt: new Date(ms).toISOString() };
  }
  if (raw.kind === 'interval') {
    if (!hasOnlyKeys(raw, ['kind', 'intervalMinutes']) || !Number.isSafeInteger(raw.intervalMinutes)) {
      throw new Error('Enter a valid interval in minutes.');
    }
    const minutes = Number(raw.intervalMinutes);
    if (minutes < GENERAL_SCHEDULE_LIMITS.minIntervalMinutes || minutes > GENERAL_SCHEDULE_LIMITS.maxIntervalMinutes) {
      throw new Error(`Interval must be between ${GENERAL_SCHEDULE_LIMITS.minIntervalMinutes} and ${GENERAL_SCHEDULE_LIMITS.maxIntervalMinutes} minutes.`);
    }
    return { kind: 'interval', intervalMinutes: minutes };
  }
  if (raw.kind === 'cron') {
    if (!hasOnlyKeys(raw, ['kind', 'cron']) || typeof raw.cron !== 'string') throw new Error('Enter a 5-field cron expression.');
    const cron = raw.cron.trim().replace(/\s+/g, ' ');
    parseCronExpression(cron);
    return { kind: 'cron', cron };
  }
  throw new Error('Unknown schedule trigger kind.');
}

export function normalizeScheduleSessionTarget(raw: unknown): ScheduleSessionTarget {
  if (!isRecord(raw) || typeof raw.mode !== 'string') throw new Error('Choose how this schedule targets a session.');
  if (raw.mode === 'create-and-reuse') {
    if (!hasOnlyKeys(raw, ['mode'])) throw new Error('Invalid session target fields.');
    return { mode: 'create-and-reuse' };
  }
  if (raw.mode === 'new-each-run') {
    if (!hasOnlyKeys(raw, ['mode'])) throw new Error('Invalid session target fields.');
    return { mode: 'new-each-run' };
  }
  if (raw.mode === 'existing') {
    if (!hasOnlyKeys(raw, ['mode', 'sessionId']) || !isCleanId(raw.sessionId)) throw new Error('Choose an existing session for this schedule.');
    return { mode: 'existing', sessionId: raw.sessionId };
  }
  if (raw.mode === 'derive-from-session') {
    if (!hasOnlyKeys(raw, ['mode', 'sourceSessionId', 'reuseDerived']) || !isCleanId(raw.sourceSessionId)
      || (raw.reuseDerived !== undefined && typeof raw.reuseDerived !== 'boolean')) {
      throw new Error('Choose a source session to derive from.');
    }
    return {
      mode: 'derive-from-session',
      sourceSessionId: raw.sourceSessionId,
      ...(raw.reuseDerived !== undefined ? { reuseDerived: raw.reuseDerived } : {}),
    };
  }
  throw new Error('Unknown schedule session target mode.');
}

export function normalizeScheduleAgentAssignment(raw: unknown): ScheduleAgentAssignment {
  if (raw === undefined) return { teamMode: 'workspace' };
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['leadModel', 'leadEffort', 'permissionMode', 'teamMode', 'workers'])) {
    throw new Error('Invalid agent assignment for schedule.');
  }
  const teamMode = raw.teamMode ?? 'workspace';
  if (teamMode !== 'workspace' && teamMode !== 'solo' && teamMode !== 'custom') {
    throw new Error('Choose a valid team assignment mode.');
  }
  const leadModel = raw.leadModel !== undefined && raw.leadModel !== '' ? (isCleanText(raw.leadModel, 160) ? raw.leadModel.trim() : (() => { throw new Error('Invalid lead model.'); })()) : undefined;
  const leadEffort = raw.leadEffort !== undefined ? (EFFORT_VALUES.includes(raw.leadEffort as Effort) ? (raw.leadEffort as Effort) : (() => { throw new Error('Invalid reasoning effort.'); })()) : undefined;
  const permissionMode = raw.permissionMode !== undefined ? (PERMISSION_VALUES.includes(raw.permissionMode as SessionPermissionMode) ? (raw.permissionMode as SessionPermissionMode) : (() => { throw new Error('Invalid permission mode.'); })()) : undefined;

  let workers: ScheduleWorkerAssignment[] | undefined;
  if (raw.workers !== undefined) {
    if (!Array.isArray(raw.workers) || raw.workers.length > GENERAL_SCHEDULE_LIMITS.maxWorkers) {
      throw new Error(`Assign at most ${GENERAL_SCHEDULE_LIMITS.maxWorkers} workers to a schedule.`);
    }
    workers = raw.workers.map(item => {
      if (!isRecord(item) || !hasOnlyKeys(item, ['name', 'role', 'task', 'model'])) throw new Error('Invalid worker assignment.');
      if (!isCleanText(item.name, 60) || !isCleanText(item.role, 80)) throw new Error('Each assigned worker needs a name and role.');
      const task = item.task !== undefined && item.task !== '' ? (isCleanText(item.task, 240) ? item.task.trim() : (() => { throw new Error('Invalid worker task.'); })()) : undefined;
      const model = item.model !== undefined && item.model !== '' ? (isCleanText(item.model, 160) ? item.model.trim() : (() => { throw new Error('Invalid worker model.'); })()) : undefined;
      return {
        name: item.name.trim(),
        role: item.role.trim(),
        ...(task ? { task } : {}),
        ...(model ? { model } : {}),
      };
    });
  }

  return {
    ...(leadModel ? { leadModel } : {}),
    ...(leadEffort ? { leadEffort } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    teamMode,
    ...(teamMode === 'custom' && workers?.length ? { workers } : {}),
  };
}

export function normalizeSaveGeneralSchedule(raw: unknown): SaveGeneralScheduleInput {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['id', 'expectedRevision', 'workspaceId', 'name', 'prompt', 'enabled', 'trigger', 'sessionTarget', 'assignment', 'missedPolicy'])) {
    throw new Error('Invalid schedule payload.');
  }
  if (raw.id !== undefined && !isCleanId(raw.id)) throw new Error('Invalid schedule id.');
  if (raw.id !== undefined && (!Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 1)) {
    throw new Error('Refresh this schedule before saving changes.');
  }
  if (raw.id === undefined && raw.expectedRevision !== undefined) {
    throw new Error('New schedules do not have an existing revision.');
  }
  if (!isCleanId(raw.workspaceId)) throw new Error('Choose a workspace for this schedule.');
  if (!isCleanText(raw.name, GENERAL_SCHEDULE_LIMITS.nameLength)) {
    throw new Error(`Enter a schedule name of 1 to ${GENERAL_SCHEDULE_LIMITS.nameLength} characters.`);
  }
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > GENERAL_SCHEDULE_LIMITS.promptLength) {
    throw new Error(`Enter a prompt of 1 to ${GENERAL_SCHEDULE_LIMITS.promptLength} characters.`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('Invalid schedule enabled flag.');
  const missedPolicy: ScheduleMissedPolicy = raw.missedPolicy === undefined ? 'skip' : raw.missedPolicy === 'skip' || raw.missedPolicy === 'run-once' ? raw.missedPolicy : (() => { throw new Error('Invalid missed-run policy.'); })();
  return {
    ...(raw.id !== undefined ? { id: raw.id, expectedRevision: Number(raw.expectedRevision) } : {}),
    workspaceId: raw.workspaceId,
    name: raw.name.trim(),
    prompt: raw.prompt.trim(),
    ...(raw.enabled !== undefined ? { enabled: raw.enabled } : {}),
    trigger: normalizeScheduleTrigger(raw.trigger),
    sessionTarget: normalizeScheduleSessionTarget(raw.sessionTarget),
    assignment: normalizeScheduleAgentAssignment(raw.assignment),
    missedPolicy,
  };
}
