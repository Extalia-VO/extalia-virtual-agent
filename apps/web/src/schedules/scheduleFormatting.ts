import {
  isValidIanaTimeZone,
  type ScheduleDeliveryState,
  type ScheduleRunState,
  type ScheduleTrigger,
  type ScheduleVerificationState,
} from '@extalia/platform';
import type { Messages } from '../i18n';

export const COMMON_SCHEDULE_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Jakarta',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
] as const;

export const CUSTOM_TIMEZONE_OPTION = '__custom__';
export const HOST_FALLBACK_TIMEZONE_OPTION = '__host_fallback__';

export interface TimeZoneOption {
  value: string;
  label: string;
}

export function buildTimeZoneSelectOptions(
  hostZone: string | undefined,
  text: Pick<Messages['schedules'], 'timeZonePresetHost' | 'timeZonePresetHostFallback' | 'timeZonePresetCustom'>,
  allowHostFallback: boolean,
): TimeZoneOption[] {
  const seen = new Set<string>();
  const options: TimeZoneOption[] = [];
  if (allowHostFallback) {
    options.push({
      value: HOST_FALLBACK_TIMEZONE_OPTION,
      label: hostZone ? text.timeZonePresetHost(hostZone) : text.timeZonePresetHostFallback,
    });
  }
  if (hostZone && isValidIanaTimeZone(hostZone)) {
    seen.add(hostZone);
    options.push({ value: hostZone, label: text.timeZonePresetHost(hostZone) });
  }
  for (const zone of COMMON_SCHEDULE_TIMEZONES) {
    if (seen.has(zone)) continue;
    seen.add(zone);
    options.push({ value: zone, label: zone });
  }
  options.push({ value: CUSTOM_TIMEZONE_OPTION, label: text.timeZonePresetCustom });
  return options;
}

export function formatTimestampInZone(iso?: string, timeZone?: string): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '—';
  const date = new Date(iso);
  if (timeZone && isValidIanaTimeZone(timeZone)) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
    } catch {
      return date.toLocaleString();
    }
  }
  return date.toLocaleString();
}

export function scheduleTriggerZoneBadge(
  trigger: ScheduleTrigger,
  hostZone: string | undefined,
  text: Pick<Messages['schedules'], 'timeZoneBadge' | 'timeZoneHostFallbackBadge'>,
): string | undefined {
  if (trigger.kind !== 'cron') return undefined;
  return trigger.timeZone ? text.timeZoneBadge(trigger.timeZone) : text.timeZoneHostFallbackBadge(hostZone);
}

export type BadgeTone = 'ok' | 'warn' | 'error' | 'running' | 'info' | 'subtle';

export function runStateBadgeTone(state: ScheduleRunState): BadgeTone {
  switch (state) {
    case 'completed':
      return 'info';
    case 'running':
    case 'admitting':
      return 'running';
    case 'failed':
    case 'blocked':
      return 'error';
    case 'unknown':
    case 'deferred':
      return 'warn';
    case 'dispatched':
    case 'pending':
    case 'cancelled':
    default:
      return 'subtle';
  }
}

export function verificationBadgeTone(verification: ScheduleVerificationState): BadgeTone {
  switch (verification) {
    case 'passed':
      return 'ok';
    case 'failed':
      return 'error';
    case 'not-checked':
    default:
      return 'subtle';
  }
}

export function deliveryBadgeTone(state: ScheduleDeliveryState): BadgeTone {
  switch (state) {
    case 'sent':
      return 'ok';
    case 'sending':
      return 'running';
    case 'failed':
      return 'error';
    case 'unknown':
      return 'warn';
    case 'pending':
    case 'cancelled':
    default:
      return 'subtle';
  }
}
