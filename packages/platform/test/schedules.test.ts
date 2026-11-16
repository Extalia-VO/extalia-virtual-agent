import { describe, expect, it } from 'vitest';
import {
  AGENT_HOST_METHODS,
  GENERAL_SCHEDULE_HOST_METHODS,
  isAgentHostMethod,
  nextCronRunAt,
  nextScheduleRunAt,
  normalizeSaveGeneralSchedule,
  parseCronExpression,
} from '../src/index.js';

describe('general schedules contract and cron parser', () => {
  it('registers all general schedule methods on AGENT_HOST_METHODS', () => {
    for (const method of GENERAL_SCHEDULE_HOST_METHODS) {
      expect(isAgentHostMethod(method)).toBe(true);
      expect(AGENT_HOST_METHODS.filter(item => item === method)).toHaveLength(1);
    }
  });

  it('parses standard 5-field cron expressions and rejects malformed syntax', () => {
    const parsed = parseCronExpression('*/15 9-17 * 1,6 1-5');
    expect([...parsed.minutes]).toEqual([0, 15, 30, 45]);
    expect([...parsed.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...parsed.months]).toEqual([1, 6]);
    expect([...parsed.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.domWildcard).toBe(true);
    expect(parsed.dowWildcard).toBe(false);

    // Sunday as 7 maps to 0
    expect([...parseCronExpression('0 0 * * 7').daysOfWeek]).toEqual([0]);

    expect(() => parseCronExpression('0 9 * *')).toThrow(/5 fields/);
    expect(() => parseCronExpression('60 9 * * *')).toThrow(/minute/);
    expect(() => parseCronExpression('0 24 * * *')).toThrow(/hour/);
    expect(() => parseCronExpression('0 9 0 * *')).toThrow(/day-of-month/);
    expect(() => parseCronExpression('0 9 * 13 *')).toThrow(/month/);
    expect(() => parseCronExpression('0 9 * * 8')).toThrow(/day-of-week/);
  });

  it('calculates deterministic next cron occurrences and interval slots', () => {
    const base = new Date(2026, 10, 14, 8, 12, 30).getTime(); // Local 08:12:30
    const nextDailyNine = nextCronRunAt('0 9 * * *', base);
    expect(nextDailyNine).toBeDefined();
    const nextDate = new Date(nextDailyNine!);
    expect(nextDate.getHours()).toBe(9);
    expect(nextDate.getMinutes()).toBe(0);

    const nextInterval = nextScheduleRunAt({ kind: 'interval', intervalMinutes: 30 }, base, base);
    expect(Date.parse(nextInterval!)).toBe(base + 30 * 60_000);

    const onceIso = new Date(base + 3_600_000).toISOString();
    expect(nextScheduleRunAt({ kind: 'once', runAt: onceIso }, base)).toBe(onceIso);
    expect(nextScheduleRunAt({ kind: 'once', runAt: onceIso }, base, base)).toBeUndefined();
  });

  it('normalizes schedule creation payloads with session modes and assigned workers', () => {
    const valid = normalizeSaveGeneralSchedule({
      workspaceId: 'ws-1',
      name: '  Morning Triage  ',
      prompt: '  Check open issues and run tests. ',
      enabled: true,
      trigger: { kind: 'cron', cron: '0   9 * * 1-5' },
      sessionTarget: { mode: 'derive-from-session', sourceSessionId: 's_123', reuseDerived: true },
      assignment: {
        leadModel: 'gpt-5',
        leadEffort: 'high',
        permissionMode: 'accept-edits',
        teamMode: 'custom',
        workers: [{ name: 'Nadine', role: 'QA Verifier', task: 'Verify unit tests', model: 'gpt-5-mini' }],
      },
      missedPolicy: 'run-once',
    });
    expect(valid).toEqual({
      workspaceId: 'ws-1',
      name: 'Morning Triage',
      prompt: 'Check open issues and run tests.',
      enabled: true,
      trigger: { kind: 'cron', cron: '0 9 * * 1-5' },
      sessionTarget: { mode: 'derive-from-session', sourceSessionId: 's_123', reuseDerived: true },
      assignment: {
        leadModel: 'gpt-5',
        leadEffort: 'high',
        permissionMode: 'accept-edits',
        teamMode: 'custom',
        workers: [{ name: 'Nadine', role: 'QA Verifier', task: 'Verify unit tests', model: 'gpt-5-mini' }],
      },
      missedPolicy: 'run-once',
    });
  });
});
