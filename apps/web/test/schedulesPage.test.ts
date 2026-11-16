import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentHostApi, HostState } from '@extalia/platform';
import { MESSAGES } from '../src/i18n';
import { SchedulesPage, previewTriggerNextRun, scheduleRecoveryStatus, scheduleSessionChoices, scheduleSessionTarget, scheduleTriggerPreset, scheduleRecurrenceTrigger } from '../src/schedules/SchedulesPage';

const sampleState: HostState = {
  host: { kind: 'bridge', version: '0.4.320' },
  dataDirectory: '/Users/example/.extalia-vo',
  storage: { dataDirectory: '/Users/example/.extalia-vo', secretStore: 'memory' },
  profile: { id: 'default', name: 'Example' },
  setupComplete: true,
  workflow: 'managed',
  library: [],
  connections: [{
    id: 'conn-1',
    name: 'OpenAI',
    preset: 'openai',
    api: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
    credential: { kind: 'stored', ref: 'cred-1' },
    credentialStatus: 'ok',
    model: 'gpt-5',
    orchestration: { enabled: true, maxDelegations: 3, tiers: { complex: 'gpt-5', standard: 'gpt-5', quick: 'gpt-5-mini' } },
    features: { memory: 'extalia', skills: 'extalia' },
    inputTokenLimit: 120_000,
    createdAt: '2026-11-14T09:00:00.000Z',
    updatedAt: '2026-11-14T09:00:00.000Z',
  }],
  workspaces: [{
    id: 'ws-1',
    profileId: 'default',
    name: 'Core Project',
    mode: 'managed',
    projectLocation: '/Users/example/project',
    providerProfileId: 'conn-1',
    permissions: { fileWrite: 'ask', commands: 'ask' },
    createdAt: '2026-11-14T09:00:00.000Z',
    updatedAt: '2026-11-14T09:00:00.000Z',
  }],
  sessions: [{
    id: 's_1',
    workspaceId: 'ws-1',
    connectionId: 'conn-1',
    title: 'Initial Session',
    control: 'managed',
    running: false,
    createdAt: '2026-11-14T09:00:00.000Z',
    lastActiveAt: '2026-11-14T09:05:00.000Z',
    agentName: 'Example agent',
    agentGender: 'female',
  }],
};

const mockAgents: AgentHostApi = {
  listSchedules: vi.fn(async () => ({ revision: 'rev-1', schedules: [] })),
  saveSchedule: vi.fn(async () => ({ revision: 'rev-2', schedules: [] })),
  setScheduleEnabled: vi.fn(async () => ({ revision: 'rev-2', schedules: [] })),
  runScheduleNow: vi.fn(async () => ({ revision: 'rev-2', schedules: [] })),
  deleteSchedule: vi.fn(async () => ({ revision: 'rev-2', schedules: [] })),
  modelChoices: vi.fn(async () => ({
    runtime: 'extalia-native' as const,
    defaultModel: 'gpt-5',
    models: ['gpt-5', 'gpt-5-mini'],
    efforts: ['low', 'medium', 'high'] as const,
    permissionModes: ['workspace', 'ask', 'accept-edits', 'plan'] as const,
  })),
  subscribe: () => () => undefined,
} as unknown as AgentHostApi;

describe('SchedulesPage', () => {
  it('opens on suggestions and existing schedules without exposing the editor or cron fields', () => {
    for (const lang of ['en', 'id'] as const) {
      const t = MESSAGES[lang];
      const html = renderToStaticMarkup(createElement(SchedulesPage, {
        t,
        agents: mockAgents,
        state: sampleState,
        workspaceId: 'ws-1',
        onSelectWorkspace: vi.fn(),
        onOpenSession: vi.fn(),
        onOpenSettings: vi.fn(),
        onState: vi.fn(),
      }));
      expect(html).toContain(t.schedules.title);
      expect(html).toContain(t.schedules.newSchedule);
      expect(html).toContain(t.schedules.suggested);
      expect(html).toContain(t.schedules.yourSchedules);
      expect(html).toContain(t.schedules.templates.projectReview.name);
      expect(html).toContain(t.schedules.templates.sessionFollowup.name);
      expect(html).toContain(sampleState.workspaces[0]!.name);
      expect(html).not.toContain('data-testid="schedule-editor"');
      expect(html).not.toContain(t.schedules.cronLabel);
      expect(html).not.toContain(t.schedules.templates.knowledgeReview.name);
      expect(html).toContain(t.schedules.runtimeHint);
      expect(html).toContain(t.schedules.suggestionsHint);
      expect(html).toContain(t.schedules.loadingSchedules);
      expect(html).not.toContain(t.schedules.empty);
    }
  });

  it('computes a valid next-run preview for cron and interval triggers', () => {
    const base = Date.parse('2026-11-14T08:00:00.000Z');
    expect(previewTriggerNextRun({ kind: 'cron', cron: '0 9 * * 1-5' }, base)).toBeDefined();
    expect(previewTriggerNextRun({ kind: 'cron', cron: 'not-a-cron' }, base)).toBeUndefined();
    expect(previewTriggerNextRun({ kind: 'interval', intervalMinutes: 15 }, base)).toBe('2026-11-14T08:15:00.000Z');
  });
});


describe('schedule picker ownership and human recurrence', () => {
  it('lists only managed sessions in the selected project, retaining supported managed runtime identities', () => {
    const original = sampleState.sessions[0]!;
    const state: HostState = { ...sampleState, sessions: [original,
      { ...original, id: 'observed', control: 'observed' },
      { ...original, id: 'foreign', workspaceId: 'other-project' },
      { ...original, id: 'managed-hermes', runtime: { id: 'hermes', profile: 'fixture' } },
    ] };
    expect(scheduleSessionChoices(state, 'ws-1').map(session => session.id)).toEqual(['s_1', 'managed-hermes']);
    expect(scheduleSessionChoices(state, 'missing')).toEqual([]);
    expect(scheduleSessionTarget('derive-from-session', '', 'managed-hermes', true, scheduleSessionChoices(state, 'ws-1'))).toBeUndefined();
  });
  it('never substitutes another session for a removed or blank explicit choice', () => {
    const sessions = sampleState.sessions;
    expect(scheduleSessionTarget('existing', 's_1', '', true, sessions)).toEqual({ mode: 'existing', sessionId: 's_1' });
    expect(scheduleSessionTarget('existing', 'removed-session', '', true, sessions)).toBeUndefined();
    expect(scheduleSessionTarget('existing', '', '', true, sessions)).toBeUndefined();
    expect(scheduleSessionTarget('derive-from-session', '', 'removed-session', true, sessions)).toBeUndefined();
    expect(scheduleSessionTarget('derive-from-session', '', 's_1', false, sessions)).toEqual({ mode: 'derive-from-session', sourceSessionId: 's_1', reuseDerived: false });
    expect(scheduleSessionTarget('create-and-reuse', '', '', true, sessions)).toEqual({ mode: 'create-and-reuse' });
    expect(scheduleSessionTarget('new-each-run', '', '', true, sessions)).toEqual({ mode: 'new-each-run' });
  });
  it.each([
    ['daily', '15:45', '1', '45 15 * * *'],
    ['weekdays', '08:05', '1', '5 8 * * 1-5'],
    ['weekly', '23:59', '5', '59 23 * * 5'],
    ['hourly', '', '1', '0 * * * *'],
  ] as const)('converts %s into the exact intended host cron', (recurrence, time, weekday, cron) => {
    expect(scheduleRecurrenceTrigger(recurrence, time, weekday)).toEqual({ kind: 'cron', cron });
  });
  it('keeps custom schedules distinguishable and recognizes editable presets without reinterpreting them', () => {
    expect(scheduleTriggerPreset({ kind: 'cron', cron: '*/17 9-17 * * 1-5' }).recurrence).toBe('custom');
    expect(scheduleTriggerPreset({ kind: 'interval', intervalMinutes: 17 }).recurrence).toBe('custom');
    expect(scheduleTriggerPreset({ kind: 'cron', cron: '45 15 * * 5' })).toEqual({ recurrence: 'weekly', time: '15:45', weekday: '5' });
    expect(scheduleTriggerPreset({ kind: 'cron', cron: '5 8 * * 1-5' })).toEqual({ recurrence: 'weekdays', time: '08:05', weekday: '1' });
    expect(scheduleRecurrenceTrigger('weekly', '12:00', '9')).toBeUndefined();
    expect(scheduleRecurrenceTrigger('daily', '24:00')).toBeUndefined();
    expect(scheduleRecurrenceTrigger('daily', '12:60')).toBeUndefined();
    expect(scheduleRecurrenceTrigger('custom', '09:00')).toBeUndefined();
  });
  it('describes a successful scheduler dispatch as a sent prompt rather than completed model work', () => {
    expect(MESSAGES.en.schedules.outcomes.succeeded).toBe('Prompt sent');
    expect(MESSAGES.id.schedules.outcomes.succeeded).toBe('Prompt terkirim');
  });
  it('shows a localized retry time when the chosen session is busy', () => {
    const recovery = { reason: 'busy' as const, dueAt: '2026-11-16T09:02:00.000Z', attempt: 1 };
    expect(scheduleRecoveryStatus(recovery, 'Nov 16, 2026, 9:02 AM', MESSAGES.en.schedules))
      .toBe('Waiting for this session · retry Nov 16, 2026, 9:02 AM');
    expect(scheduleRecoveryStatus(recovery, '16 Nov 2026 pukul 09.02', MESSAGES.id.schedules))
      .toBe('Menunggu session ini · coba lagi 16 Nov 2026 pukul 09.02');
    const disconnected = { reason: 'connection-unavailable' as const, dueAt: '2026-11-16T09:02:00.000Z', attempt: 1 };
    expect(scheduleRecoveryStatus(disconnected, 'Nov 16, 2026, 9:02 AM', MESSAGES.en.schedules))
      .toBe('Waiting for the agent connection · retry Nov 16, 2026, 9:02 AM');
    expect(scheduleRecoveryStatus(disconnected, '16 Nov 2026 pukul 09.02', MESSAGES.id.schedules))
      .toBe('Menunggu koneksi agent · coba lagi 16 Nov 2026 pukul 09.02');
    expect(scheduleRecoveryStatus(undefined, undefined, MESSAGES.en.schedules)).toBeUndefined();
    expect(MESSAGES.en.schedules.outcomes['deferred-connection']).toBe('Waiting for agent connection');
    expect(MESSAGES.id.schedules.outcomes['deferred-connection']).toBe('Menunggu koneksi agent');
  });
});
