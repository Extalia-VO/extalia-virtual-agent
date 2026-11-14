import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentHostApi, HostState } from '@extalia/platform';
import { MESSAGES } from '../src/i18n';
import { SchedulesPage, previewTriggerNextRun } from '../src/schedules/SchedulesPage';

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
    agentName: 'Nadine',
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
  it('renders the schedule editor and list in English and Indonesian', () => {
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
      expect(html).toContain(t.schedules.cronLabel);
      expect(html).toContain(t.schedules.empty);
    }
  });

  it('computes a valid next-run preview for cron and interval triggers', () => {
    const base = Date.parse('2026-11-14T08:00:00.000Z');
    expect(previewTriggerNextRun({ kind: 'cron', cron: '0 9 * * 1-5' }, base)).toBeDefined();
    expect(previewTriggerNextRun({ kind: 'cron', cron: 'not-a-cron' }, base)).toBeUndefined();
    expect(previewTriggerNextRun({ kind: 'interval', intervalMinutes: 15 }, base)).toBe('2026-11-14T08:15:00.000Z');
  });
});
