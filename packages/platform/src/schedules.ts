import { EFFORTS, SESSION_PERMISSION_MODES, type Effort, type SessionPermissionMode } from '@extalia/core';

export type ScheduleDstPolicy = 'each-valid-instant';

export type ScheduleTrigger =
  | { kind: 'once'; runAt: string }
  | { kind: 'interval'; intervalMinutes: number }
  | { kind: 'cron'; cron: string; timeZone?: string; dstPolicy?: ScheduleDstPolicy };

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
export type GeneralScheduleOutcome = 'succeeded' | 'failed' | 'skipped-busy' | 'missed' | 'deferred-connection';

export interface GeneralScheduleRecovery {
  reason: 'busy' | 'connection-unavailable';
  dueAt: string;
  attempt: number;
}

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
  /** A known pre-admission condition is being retried; this is catalog-only state. */
  recovery?: GeneralScheduleRecovery;
  state: GeneralScheduleState;
  nextRunAt?: string;
  lastRunAt?: string;
  lastOutcome?: GeneralScheduleOutcome;
  lastError?: string;
  lastSessionId?: string;
  runCount: number;
  /** Historical dispatch count preserved from legacy v0.4.353 migration without relabeling as completed turns. */
  legacyDispatchCount?: number;
  /** Observed completed managed-turn count recorded in the durable schedule ledger. */
  completedRunCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface GeneralScheduleCatalog {
  revision: string;
  schedules: GeneralSchedule[];
  /** IANA timezone used by the executing host for cron; older hosts may omit it. */
  timeZone?: string;
  /** Automatic execution is halted until the host can safely persist its state again. */
  problem?: 'storage-unavailable';
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

export const SCHEDULE_RUN_STATES = [
  'pending',
  'admitting',
  'deferred',
  'dispatched',
  'running',
  'completed',
  'failed',
  'cancelled',
  'blocked',
  'unknown',
] as const;

export type ScheduleRunState = (typeof SCHEDULE_RUN_STATES)[number];

export const SCHEDULE_OCCURRENCE_KINDS = ['automatic', 'manual', 'catch-up'] as const;
export type ScheduleOccurrenceKind = (typeof SCHEDULE_OCCURRENCE_KINDS)[number];

export const SCHEDULE_VERIFICATION_STATES = ['not-checked', 'passed', 'failed'] as const;
export type ScheduleVerificationState = (typeof SCHEDULE_VERIFICATION_STATES)[number];

export const SCHEDULE_DELIVERY_STATES = ['pending', 'sending', 'sent', 'failed', 'unknown', 'cancelled'] as const;
export type ScheduleDeliveryState = (typeof SCHEDULE_DELIVERY_STATES)[number];

export const SCHEDULE_REVIEW_ACTIONS = ['acknowledge', 'mark-resolved', 'dismiss-for-new-run'] as const;
export type ScheduleReviewAction = (typeof SCHEDULE_REVIEW_ACTIONS)[number];

export interface ScheduleReviewDecision {
  action: ScheduleReviewAction;
  note?: string;
}

export interface ScheduleRunV1 {
  id: string;
  revision: number;
  scheduleId: string;
  scheduleRevision: number;
  occurrenceKey: string;
  occurrenceKind: ScheduleOccurrenceKind;
  scheduledFor: string;
  requestedAt?: string;
  workspaceId: string;
  runtimeId?: string;
  sessionId?: string;
  turnId?: string;
  correlationId?: string;
  executionGeneration?: string;
  state: ScheduleRunState;
  admittedAt?: string;
  settledAt?: string;
  verification: ScheduleVerificationState;
  verificationEvidenceRef?: string;
  terminalEvidenceRef?: string;
  statusReason?: string;
  attemptCount: number;
  reviewDecision?: ScheduleReviewAction;
  reviewedAt?: string;
  reviewNote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleDeliveryV1 {
  id: string;
  runId: string;
  destinationBindingId: string;
  destinationRevision: number;
  notificationKind: string;
  targetGuildId: string;
  targetChannelId: string;
  targetThreadId?: string;
  payloadDigest: string;
  state: ScheduleDeliveryState;
  attemptCount: number;
  discordMessageId?: string;
  lastErrorCode?: string;
  acknowledgedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRunFilter {
  workspaceId: string;
  scheduleId?: string;
  state?: ScheduleRunState;
  limit?: number;
  cursor?: string;
}

export interface ScheduleRunPage {
  runs: ScheduleRunV1[];
  nextCursor?: string;
  total: number;
}

export interface ScheduleRunDetail {
  run: ScheduleRunV1;
  deliveries: ScheduleDeliveryV1[];
  scheduleName?: string;
}

export type ScheduleDstTransitionNote = 'repeated-first' | 'repeated-second' | 'after-skipped-gap';

export interface NextRunPreviewEntry {
  utc: string;
  localTime: string;
  timeZone: string;
  dstNote?: ScheduleDstTransitionNote;
}

export interface NextRunPreview {
  timeZone: string;
  usedFallbackTimeZone: boolean;
  dstPolicy?: ScheduleDstPolicy;
  runs: NextRunPreviewEntry[];
  notes: string[];
}

export const GENERAL_SCHEDULE_LIMITS = {
  schedules: 64,
  storeBytes: 512 * 1024,
  nameLength: 120,
  promptLength: 32_000,
  cronLength: 120,
  timeZoneLength: 100,
  reviewNoteLength: 500,
  maxPreviewRuns: 50,
  maxRunPageLimit: 200,
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
  'listScheduleRuns',
  'scheduleRunDetail',
  'previewScheduleNextRuns',
  'reviewUnknownScheduleRun',
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
const IANA_TIMEZONE_PATTERN = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/;

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function getZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    if (zoneFormatters.size >= 64) {
      const oldest = zoneFormatters.keys().next().value;
      if (oldest !== undefined) zoneFormatters.delete(oldest);
    }
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Validate an IANA timezone identifier via `Intl.DateTimeFormat`. */
export function isValidIanaTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string') return false;
  if (!timeZone || timeZone.length > GENERAL_SCHEDULE_LIMITS.timeZoneLength || timeZone.trim() !== timeZone) return false;
  if (/\p{Cc}/u.test(timeZone) || !IANA_TIMEZONE_PATTERN.test(timeZone)) return false;
  try {
    getZoneFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function normalizeIanaTimeZone(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Enter a valid IANA time zone (for example "UTC" or "America/New_York").');
  const trimmed = raw.trim();
  if (!isValidIanaTimeZone(trimmed)) {
    throw new Error(`Invalid IANA time zone "${trimmed}".`);
  }
  return trimmed;
}

interface ZoneWallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dow: number;
  wallMs: number;
  /** Offset in ms such that `wholeUtcMs = wallMs + offsetMs` (matches `Date.getTimezoneOffset()` sign). */
  offsetMs: number;
}

function zoneWallParts(utcMs: number, timeZone: string): ZoneWallParts {
  const formatter = getZoneFormatter(timeZone);
  const wholeUtcMs = Math.floor(utcMs / 1000) * 1000;
  const parts = formatter.formatToParts(new Date(wholeUtcMs));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
    else if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
    else if (part.type === 'second') second = Number(part.value);
  }
  if (hour === 24) hour = 0;
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, second, dow, wallMs, offsetMs: wholeUtcMs - wallMs };
}

function sampleZoneOffsetMs(atMs: number, timeZone: string): Set<number> {
  const result = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    result.add(zoneWallParts(atMs + hours * 3_600_000, timeZone).offsetMs);
  }
  return result;
}

function formatUtcOffset(offsetMs: number): string {
  // offsetMs = utcMs - wallMs, so local = UTC - offsetMs
  const localAheadMinutes = Math.round(-offsetMs / 60_000);
  const sign = localAheadMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(localAheadMinutes);
  const hours = String(Math.floor(absMinutes / 60)).padStart(2, '0');
  const minutes = String(absMinutes % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${minutes}`;
}

function formatZoneLocalTime(utcMs: number, timeZone: string): string {
  const parts = zoneWallParts(utcMs, timeZone);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)} (${formatUtcOffset(parts.offsetMs)})`;
}

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

/** Compute the next wall-clock occurrence at or after `afterWallMs` for a 5-field cron expression. */
function nextCronWallTime(parsed: ParsedCron, afterWallMs: number): number | undefined {
  const cursor = new Date(Math.floor(afterWallMs / 60_000) * 60_000);
  const maxYear = cursor.getUTCFullYear() + 4;
  while (cursor.getUTCFullYear() <= maxYear) {
    const month = cursor.getUTCMonth() + 1;
    if (!parsed.months.has(month)) {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const dom = cursor.getUTCDate();
    if (!cronDayMatches(parsed, dom, cursor.getUTCDay())) {
      cursor.setUTCDate(dom + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const hour = cursor.getUTCHours();
    if (!parsed.hours.has(hour)) {
      cursor.setUTCHours(hour + 1, 0, 0, 0);
      continue;
    }
    const minute = cursor.getUTCMinutes();
    if (!parsed.minutes.has(minute)) {
      cursor.setUTCMinutes(minute + 1, 0, 0);
      continue;
    }
    return cursor.getTime();
  }
  return undefined;
}

function localMatchesCron(parsed: ParsedCron, date: Date, wall: Date): boolean {
  return date.getFullYear() === wall.getUTCFullYear()
    && date.getMonth() === wall.getUTCMonth()
    && date.getDate() === wall.getUTCDate()
    && parsed.months.has(date.getMonth() + 1)
    && cronDayMatches(parsed, date.getDate(), date.getDay())
    && date.getHours() === wall.getUTCHours()
    && date.getMinutes() === wall.getUTCMinutes()
    && date.getSeconds() === 0
    && date.getMilliseconds() === 0;
}

function zoneMatchesCron(parsed: ParsedCron, utcMs: number, wall: Date, timeZone: string): boolean {
  if (utcMs % 60_000 !== 0) return false;
  const parts = zoneWallParts(utcMs, timeZone);
  return parts.year === wall.getUTCFullYear()
    && parts.month === wall.getUTCMonth() + 1
    && parts.day === wall.getUTCDate()
    && parsed.months.has(parts.month)
    && cronDayMatches(parsed, parts.day, parts.dow)
    && parts.hour === wall.getUTCHours()
    && parts.minute === wall.getUTCMinutes()
    && parts.second === 0;
}

function nextCronRunAtInZone(parsed: ParsedCron, afterMs: number, timeZone: string): string | undefined {
  const minuteMs = 60_000;
  const nearbyOffsets = sampleZoneOffsetMs(afterMs, timeZone);
  const offsetValues = [...nearbyOffsets];
  const foldSpanMs = Math.max(...offsetValues) - Math.min(...offsetValues);
  const afterParts = zoneWallParts(afterMs, timeZone);
  let wallAfter = afterParts.wallMs - foldSpanMs;
  let earliest: number | undefined;

  for (let rejected = 0; rejected < 3_000; rejected++) {
    const wallMs = nextCronWallTime(parsed, wallAfter);
    if (wallMs === undefined) break;
    const wall = new Date(wallMs);
    const candidates = sampleZoneOffsetMs(wallMs, timeZone);
    const minimumOffset = Math.min(...candidates);
    if (earliest !== undefined && wallMs + minimumOffset > earliest) break;
    for (const offsetMs of candidates) {
      const candidateMs = wallMs + offsetMs;
      if (candidateMs <= afterMs) continue;
      if (!zoneMatchesCron(parsed, candidateMs, wall, timeZone)) continue;
      if (earliest === undefined || candidateMs < earliest) earliest = candidateMs;
    }
    wallAfter = wallMs + minuteMs;
  }
  return earliest !== undefined ? new Date(earliest).toISOString() : undefined;
}

/** Compute the next occurrence strictly after `afterMs` for a 5-field cron expression.
 * When `timeZone` is provided, computes deterministically in that IANA timezone using
 * the `each-valid-instant` DST policy; when omitted, preserves legacy host-local behavior.
 */
export function nextCronRunAt(expression: string, afterMs: number, timeZone?: string): string | undefined {
  if (!Number.isFinite(afterMs)) return undefined;
  const parsed = parseCronExpression(expression);
  if (timeZone !== undefined) {
    return nextCronRunAtInZone(parsed, afterMs, normalizeIanaTimeZone(timeZone));
  }
  const minuteMs = 60_000;
  const sampleOffsets = (atMs: number) => {
    const result = new Set<number>();
    for (let hours = -48; hours <= 48; hours += 6) {
      result.add(new Date(atMs + hours * 60 * 60_000).getTimezoneOffset());
    }
    return result;
  };
  const nearbyOffsets = sampleOffsets(afterMs);
  const offsetValues = [...nearbyOffsets];
  const foldSpanMs = (Math.max(...offsetValues) - Math.min(...offsetValues)) * minuteMs;
  // Search back by the observed fold span so a repeated wall-clock minute can still be
  // returned after its first UTC occurrence (for example, 01:30 a second time in autumn).
  let wallAfter = afterMs - new Date(afterMs).getTimezoneOffset() * minuteMs - foldSpanMs;
  let earliest: number | undefined;

  // A cron candidate in a spring gap is rejected and the next calendar occurrence is found
  // using cron field jumps. Continue through a fold until later wall times cannot map to an
  // earlier UTC instant. 3,000 rejected slots cover unusual whole-day changes.
  for (let rejected = 0; rejected < 3_000; rejected++) {
    const wallMs = nextCronWallTime(parsed, wallAfter);
    if (wallMs === undefined) break;
    const wall = new Date(wallMs);
    const candidates = sampleOffsets(wallMs);
    const minimumOffset = Math.min(...candidates);
    if (earliest !== undefined && wallMs + minimumOffset * minuteMs > earliest) break;
    for (const offset of candidates) {
      const candidateMs = wallMs + offset * minuteMs;
      if (candidateMs <= afterMs) continue;
      if (!localMatchesCron(parsed, new Date(candidateMs), wall)) continue;
      if (earliest === undefined || candidateMs < earliest) earliest = candidateMs;
    }
    wallAfter = wallMs + minuteMs;
  }
  return earliest !== undefined ? new Date(earliest).toISOString() : undefined;
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
  return nextCronRunAt(trigger.cron, afterMs, trigger.timeZone);
}

function matchingUtcInstantsForWallTime(wallMs: number, timeZone: string): number[] {
  const wall = new Date(wallMs);
  const offsets = sampleZoneOffsetMs(wallMs, timeZone);
  const matches: number[] = [];
  for (const offsetMs of offsets) {
    const candidateMs = wallMs + offsetMs;
    const parts = zoneWallParts(candidateMs, timeZone);
    if (parts.year === wall.getUTCFullYear()
      && parts.month === wall.getUTCMonth() + 1
      && parts.day === wall.getUTCDate()
      && parts.hour === wall.getUTCHours()
      && parts.minute === wall.getUTCMinutes()
      && parts.second === 0) {
      matches.push(candidateMs);
    }
  }
  return [...new Set(matches)].sort((a, b) => a - b);
}

function hasSkippedGapBetween(parsed: ParsedCron, cursorMs: number, nextUtcMs: number, timeZone: string): boolean {
  const nextWallMs = zoneWallParts(nextUtcMs, timeZone).wallMs;
  const cursorWallMs = zoneWallParts(cursorMs, timeZone).wallMs;
  let searchWallMs = Math.floor(cursorWallMs / 60_000) * 60_000 + 60_000;
  for (let steps = 0; steps < 64 && searchWallMs < nextWallMs; steps++) {
    const candidateWallMs = nextCronWallTime(parsed, searchWallMs);
    if (candidateWallMs === undefined || candidateWallMs >= nextWallMs) return false;
    if (matchingUtcInstantsForWallTime(candidateWallMs, timeZone).length === 0) return true;
    searchWallMs = candidateWallMs + 60_000;
  }
  return false;
}

/** Produce an authoritative Host preview of the next N occurrences, formatted in the effective IANA zone with DST transition notes. */
export function previewScheduleNextRuns(
  rawTrigger: ScheduleTrigger,
  count: number,
  fromMs = Date.now(),
  fallbackTimeZone?: string,
): NextRunPreview {
  if (!Number.isFinite(fromMs)) throw new Error('Provide a valid reference timestamp for schedule preview.');
  if (!Number.isSafeInteger(count) || count < 1 || count > GENERAL_SCHEDULE_LIMITS.maxPreviewRuns) {
    throw new Error(`Preview count must be an integer between 1 and ${GENERAL_SCHEDULE_LIMITS.maxPreviewRuns}.`);
  }
  const trigger = normalizeScheduleTrigger(rawTrigger);
  const resolvedHostTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const normalizedFallback = fallbackTimeZone !== undefined ? normalizeIanaTimeZone(fallbackTimeZone) : resolvedHostTz;
  const explicitCronTz = trigger.kind === 'cron' ? trigger.timeZone : undefined;
  const effectiveTimeZone = explicitCronTz ?? normalizedFallback;
  const usedFallbackTimeZone = trigger.kind === 'cron' ? explicitCronTz === undefined : true;
  const notes: string[] = [];
  const runs: NextRunPreviewEntry[] = [];

  if (trigger.kind === 'cron' && explicitCronTz === undefined) {
    notes.push(`No per-job timezone set; previewing with fallback host timezone (${effectiveTimeZone}).`);
  }

  if (trigger.kind === 'once') {
    const runAtMs = Date.parse(trigger.runAt);
    if (runAtMs <= fromMs) {
      notes.push('One-off trigger timestamp is in the past.');
    } else {
      runs.push({
        utc: new Date(runAtMs).toISOString(),
        localTime: formatZoneLocalTime(runAtMs, effectiveTimeZone),
        timeZone: effectiveTimeZone,
      });
    }
    return { timeZone: effectiveTimeZone, usedFallbackTimeZone, runs, notes };
  }

  if (trigger.kind === 'interval') {
    let cursorMs = fromMs;
    let lastRunMs: number | undefined = fromMs;
    for (let index = 0; index < count; index++) {
      const nextIso = nextScheduleRunAt(trigger, cursorMs, lastRunMs);
      if (!nextIso) break;
      const utcMs = Date.parse(nextIso);
      runs.push({
        utc: nextIso,
        localTime: formatZoneLocalTime(utcMs, effectiveTimeZone),
        timeZone: effectiveTimeZone,
      });
      cursorMs = utcMs;
      lastRunMs = utcMs;
    }
    return { timeZone: effectiveTimeZone, usedFallbackTimeZone, runs, notes };
  }

  const parsed = parseCronExpression(trigger.cron);
  const computeZone = explicitCronTz ?? (fallbackTimeZone !== undefined ? normalizedFallback : undefined);
  let cursorMs = fromMs;
  const notedFold = new Set<string>();
  let notedGap = false;

  for (let index = 0; index < count; index++) {
    const nextIso = nextCronRunAt(trigger.cron, cursorMs, computeZone);
    if (!nextIso) break;
    const utcMs = Date.parse(nextIso);
    const parts = zoneWallParts(utcMs, effectiveTimeZone);
    const matchingInstants = matchingUtcInstantsForWallTime(parts.wallMs, effectiveTimeZone);
    let dstNote: ScheduleDstTransitionNote | undefined;
    if (matchingInstants.length > 1) {
      if (utcMs === matchingInstants[0]) {
        dstNote = 'repeated-first';
      } else if (utcMs === matchingInstants[1]) {
        dstNote = 'repeated-second';
      }
      const foldKey = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
      if (!notedFold.has(foldKey)) {
        notedFold.add(foldKey);
        notes.push(`DST fall-back repeated wall time in ${effectiveTimeZone}; each valid UTC instant is scheduled (each-valid-instant).`);
      }
    } else if (hasSkippedGapBetween(parsed, cursorMs, utcMs, effectiveTimeZone)) {
      dstNote = 'after-skipped-gap';
      if (!notedGap) {
        notedGap = true;
        notes.push(`DST spring-forward skipped a nonexistent local wall time in ${effectiveTimeZone}; advanced to next valid occurrence.`);
      }
    }
    runs.push({
      utc: nextIso,
      localTime: formatZoneLocalTime(utcMs, effectiveTimeZone),
      timeZone: effectiveTimeZone,
      ...(dstNote ? { dstNote } : {}),
    });
    cursorMs = utcMs;
  }

  return {
    timeZone: effectiveTimeZone,
    usedFallbackTimeZone,
    dstPolicy: trigger.dstPolicy ?? 'each-valid-instant',
    runs,
    notes,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const isCleanId = (value: unknown, max = 160): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/\p{Cc}/u.test(value) && value.trim() === value;
const isCleanText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/\p{Cc}/u.test(value);

export function isScheduleRunState(value: unknown): value is ScheduleRunState {
  return typeof value === 'string' && (SCHEDULE_RUN_STATES as readonly string[]).includes(value);
}

export function isScheduleVerificationState(value: unknown): value is ScheduleVerificationState {
  return typeof value === 'string' && (SCHEDULE_VERIFICATION_STATES as readonly string[]).includes(value);
}

export function isScheduleDeliveryState(value: unknown): value is ScheduleDeliveryState {
  return typeof value === 'string' && (SCHEDULE_DELIVERY_STATES as readonly string[]).includes(value);
}

export function normalizeScheduleReviewDecision(raw: unknown): ScheduleReviewDecision {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['action', 'note'])) {
    throw new Error('Provide a valid schedule run review decision.');
  }
  if (typeof raw.action !== 'string' || !(SCHEDULE_REVIEW_ACTIONS as readonly string[]).includes(raw.action)) {
    throw new Error('Choose a valid review action (acknowledge, mark-resolved, or dismiss-for-new-run).');
  }
  let note: string | undefined;
  if (raw.note !== undefined && raw.note !== '') {
    if (!isCleanText(raw.note, GENERAL_SCHEDULE_LIMITS.reviewNoteLength)) {
      throw new Error(`Review note must be 1 to ${GENERAL_SCHEDULE_LIMITS.reviewNoteLength} characters.`);
    }
    note = raw.note.trim();
  }
  return { action: raw.action as ScheduleReviewAction, ...(note ? { note } : {}) };
}

export function normalizeScheduleRunFilter(raw: unknown): ScheduleRunFilter {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['workspaceId', 'scheduleId', 'state', 'limit', 'cursor'])) {
    throw new Error('Invalid schedule run filter.');
  }
  if (!isCleanId(raw.workspaceId)) throw new Error('Choose a workspace to list schedule runs.');
  if (raw.scheduleId !== undefined && !isCleanId(raw.scheduleId)) throw new Error('Invalid schedule id filter.');
  if (raw.state !== undefined && !isScheduleRunState(raw.state)) throw new Error('Invalid schedule run state filter.');
  let limit: number | undefined;
  if (raw.limit !== undefined) {
    if (!Number.isSafeInteger(raw.limit) || Number(raw.limit) < 1 || Number(raw.limit) > GENERAL_SCHEDULE_LIMITS.maxRunPageLimit) {
      throw new Error(`Run page limit must be between 1 and ${GENERAL_SCHEDULE_LIMITS.maxRunPageLimit}.`);
    }
    limit = Number(raw.limit);
  }
  if (raw.cursor !== undefined && (typeof raw.cursor !== 'string' || !raw.cursor.trim() || raw.cursor.length > 512 || /\p{Cc}/u.test(raw.cursor))) {
    throw new Error('Invalid schedule run pagination cursor.');
  }
  return {
    workspaceId: raw.workspaceId,
    ...(raw.scheduleId !== undefined ? { scheduleId: raw.scheduleId } : {}),
    ...(raw.state !== undefined ? { state: raw.state } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(raw.cursor !== undefined ? { cursor: raw.cursor } : {}),
  };
}

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
    if (!hasOnlyKeys(raw, ['kind', 'cron', 'timeZone', 'dstPolicy']) || typeof raw.cron !== 'string') throw new Error('Enter a 5-field cron expression.');
    const cron = raw.cron.trim().replace(/\s+/g, ' ');
    parseCronExpression(cron);
    const timeZone = raw.timeZone !== undefined ? normalizeIanaTimeZone(raw.timeZone) : undefined;
    if (raw.dstPolicy !== undefined && raw.dstPolicy !== 'each-valid-instant') {
      throw new Error('Unsupported cron DST policy. Only "each-valid-instant" is supported.');
    }
    const dstPolicy: ScheduleDstPolicy | undefined = raw.dstPolicy;
    return {
      kind: 'cron',
      cron,
      ...(timeZone !== undefined ? { timeZone } : {}),
      ...(dstPolicy !== undefined ? { dstPolicy } : {}),
    };
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
  const missedPolicy: ScheduleMissedPolicy = raw.missedPolicy === undefined ? 'run-once' : raw.missedPolicy === 'skip' || raw.missedPolicy === 'run-once' ? raw.missedPolicy : (() => { throw new Error('Invalid missed-run policy.'); })();
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
