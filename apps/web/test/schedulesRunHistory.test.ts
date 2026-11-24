import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  SCHEDULE_DELIVERY_STATES,
  SCHEDULE_REVIEW_ACTIONS,
  SCHEDULE_RUN_STATES,
  SCHEDULE_VERIFICATION_STATES,
  type AgentHostApi,
  type GeneralSchedule,
  type HostState,
  type NextRunPreview,
  type ScheduleRunDetail,
  type ScheduleRunV1,
} from '@extalia/platform';
import { MESSAGES } from '../src/i18n';
import { createMockPlatform } from '../src/host/mockHost';
import { SchedulesPage, scheduleRecurrenceTrigger } from '../src/schedules/SchedulesPage';
import { ScheduleRunDetailCard, ScheduleRunHistoryPanel } from '../src/schedules/ScheduleRunHistoryPanel';
import { NextRunsPreviewPanel, ScheduleTimezoneField } from '../src/schedules/ScheduleTimezoneField';
import {
  deliveryBadgeTone,
  runStateBadgeTone,
  scheduleTriggerZoneBadge,
  verificationBadgeTone,
} from '../src/schedules/scheduleFormatting';

const sampleState: HostState = {
  host: { kind: 'bridge', version: '0.4.356' },
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

const sampleSchedule: GeneralSchedule = {
  id: 'sch_1',
  revision: 2,
  workspaceId: 'ws-1',
  name: 'DST Morning Audit',
  prompt: 'Inspect status.',
  enabled: true,
  trigger: { kind: 'cron', cron: '30 1 * * *', timeZone: 'America/New_York', dstPolicy: 'each-valid-instant' },
  sessionTarget: { mode: 'existing', sessionId: 's_1' },
  assignment: { teamMode: 'workspace' },
  missedPolicy: 'run-once',
  state: 'scheduled',
  nextRunAt: '2026-11-01T05:30:00.000Z',
  runCount: 2,
  completedRunCount: 1,
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
};

describe('Schedule timezone editor & authoritative DST preview (WP-SCH-07)', () => {
  it('renders quick preset options, custom input, legacy fallback notice, and invalid zone validation in EN and ID', () => {
    for (const lang of ['en', 'id'] as const) {
      const text = MESSAGES[lang].schedules;
      const validHtml = renderToStaticMarkup(createElement(ScheduleTimezoneField, {
        text,
        timeZone: 'America/New_York',
        hostZone: 'Asia/Jakarta',
        isLegacyNoZone: false,
        onChangeTimeZone: vi.fn(),
      }));
      expect(validHtml).toContain('America/New_York');
      expect(validHtml).not.toContain('data-testid="schedule-timezone-error"');

      const legacyHtml = renderToStaticMarkup(createElement(ScheduleTimezoneField, {
        text,
        timeZone: '',
        hostZone: 'Asia/Jakarta',
        isLegacyNoZone: true,
        onChangeTimeZone: vi.fn(),
      }));
      expect(legacyHtml).toContain('data-testid="schedule-timezone-legacy-notice"');
      expect(legacyHtml).toContain('Asia/Jakarta');

      const invalidHtml = renderToStaticMarkup(createElement(ScheduleTimezoneField, {
        text,
        timeZone: 'Mars/Olympus_Mons',
        hostZone: 'Asia/Jakarta',
        isLegacyNoZone: false,
        onChangeTimeZone: vi.fn(),
      }));
      expect(invalidHtml).toContain('data-testid="schedule-timezone-error"');
      expect(invalidHtml).toContain(text.timeZoneInvalid);
      expect(invalidHtml).toContain('aria-invalid="true"');
    }
  });

  it('renders 5 authoritative occurrences with UTC ISO, local time, zone badge, and DST transition warnings', () => {
    const preview: NextRunPreview = {
      timeZone: 'America/New_York',
      usedFallbackTimeZone: false,
      dstPolicy: 'each-valid-instant',
      runs: [
        { utc: '2026-11-01T05:30:00.000Z', localTime: '2026-11-01 01:30 (UTC-04:00)', timeZone: 'America/New_York', dstNote: 'repeated-first' },
        { utc: '2026-11-01T06:30:00.000Z', localTime: '2026-11-01 01:30 (UTC-05:00)', timeZone: 'America/New_York', dstNote: 'repeated-second' },
        { utc: '2026-03-09T06:30:00.000Z', localTime: '2026-03-09 02:30 (UTC-04:00)', timeZone: 'America/New_York', dstNote: 'after-skipped-gap' },
        { utc: '2026-03-10T06:30:00.000Z', localTime: '2026-03-10 02:30 (UTC-04:00)', timeZone: 'America/New_York' },
        { utc: '2026-03-11T06:30:00.000Z', localTime: '2026-03-11 02:30 (UTC-04:00)', timeZone: 'America/New_York' },
      ],
      notes: ['DST fall-back repeated wall time in America/New_York; each valid UTC instant is scheduled (each-valid-instant).'],
    };

    for (const lang of ['en', 'id'] as const) {
      const text = MESSAGES[lang].schedules;
      const html = renderToStaticMarkup(createElement(NextRunsPreviewPanel, {
        text,
        preview,
        loading: false,
        error: null,
        supported: true,
      }));
      expect(html).toContain(text.nextRunsHeading(5));
      expect(html).toContain('2026-11-01T05:30:00.000Z');
      expect(html).toContain('2026-11-01 01:30 (UTC-04:00)');
      expect(html).toContain('2026-11-01T06:30:00.000Z');
      expect(html).toContain(text.dstNotes['repeated-first']);
      expect(html).toContain(text.dstNotes['repeated-second']);
      expect(html).toContain(text.dstNotes['after-skipped-gap']);
      expect(html).toContain('data-testid="schedule-dst-badge-repeated-first"');
      expect(html).toContain('data-testid="schedule-dst-badge-repeated-second"');
      expect(html).toContain('data-testid="schedule-dst-badge-after-skipped-gap"');
    }
  });

  it('builds cron triggers with explicit IANA timezone and formats saved schedule zone badges', () => {
    expect(scheduleRecurrenceTrigger('daily', '09:15', '1', 'Asia/Jakarta')).toEqual({
      kind: 'cron',
      cron: '15 9 * * *',
      timeZone: 'Asia/Jakarta',
      dstPolicy: 'each-valid-instant',
    });
    expect(scheduleTriggerZoneBadge(sampleSchedule.trigger, 'UTC', MESSAGES.en.schedules)).toBe('Zone: America/New_York');
    expect(scheduleTriggerZoneBadge({ kind: 'cron', cron: '0 9 * * *' }, 'Asia/Jakarta', MESSAGES.id.schedules)).toBe('Lokal host (Asia/Jakarta)');
    expect(scheduleTriggerZoneBadge({ kind: 'interval', intervalMinutes: 15 }, 'UTC', MESSAGES.en.schedules)).toBeUndefined();
  });
});

describe('Schedule Run History & Unknown Review UI (WP-SCH-05)', () => {
  const baseRun: ScheduleRunV1 = {
    id: 'run_unknown_1',
    revision: 1,
    scheduleId: sampleSchedule.id,
    scheduleRevision: 2,
    occurrenceKey: 'auto:sch_1:2026-11-01T05:30:00.000Z:g1',
    occurrenceKind: 'automatic',
    scheduledFor: '2026-11-01T05:30:00.000Z',
    workspaceId: 'ws-1',
    runtimeId: 'extalia-native',
    sessionId: 's_1',
    correlationId: 'corr-abc',
    turnId: 'turn-xyz',
    executionGeneration: 'gen-1',
    state: 'unknown',
    admittedAt: '2026-11-01T05:30:01.000Z',
    verification: 'not-checked',
    statusReason: 'Host restarted while run was in progress.',
    attemptCount: 2,
    createdAt: '2026-11-01T05:30:00.000Z',
    updatedAt: '2026-11-01T05:31:00.000Z',
  };

  it('renders distinct badges for schedule, run, verification, and delivery states without an ambiguous green Success', () => {
    const detail: ScheduleRunDetail = {
      run: { ...baseRun, state: 'completed', settledAt: '2026-11-01T05:32:00.000Z', terminalEvidenceRef: 'event:ev_1' },
      scheduleName: sampleSchedule.name,
      deliveries: [{
        id: 'del_1',
        runId: baseRun.id,
        destinationBindingId: 'bind_1',
        destinationRevision: 1,
        notificationKind: 'terminal-summary',
        targetGuildId: 'guild_1',
        targetChannelId: 'chan_1',
        payloadDigest: 'a'.repeat(64),
        state: 'sent',
        attemptCount: 1,
        discordMessageId: 'msg_1',
        acknowledgedAt: '2026-11-01T05:32:05.000Z',
        createdAt: '2026-11-01T05:32:01.000Z',
        updatedAt: '2026-11-01T05:32:05.000Z',
      }],
    };

    for (const lang of ['en', 'id'] as const) {
      const text = MESSAGES[lang].schedules;
      const html = renderToStaticMarkup(createElement(ScheduleRunDetailCard, {
        text,
        detail,
        schedule: sampleSchedule,
        loading: false,
        reviewBusy: false,
        reviewError: null,
        onClose: vi.fn(),
        onOpenSession: vi.fn(),
        onReviewUnknownRun: vi.fn(async () => undefined),
      }));

      expect(html).toContain(text.scheduleStateBadge(text.states.scheduled));
      expect(html).toContain(text.runStates.completed);
      expect(html).toContain(text.verificationStates['not-checked']);
      expect(html).toContain(text.deliveryStates.sent);
      expect(html).toContain('corr-abc');
      expect(html).toContain('turn-xyz');
      expect(html).toContain('event:ev_1');
      expect(html).toContain('msg_1');
      expect(html).toContain(text.openSession);
      // Completed turn must not render the unknown-run review form or claim "Success"
      expect(html).not.toContain('data-testid="schedule-unknown-review"');
      expect(html).not.toMatch(/>Success</);
    }
  });

  it('renders the Review Unknown Run form for unknown runs and records operator review metadata', () => {
    const reviewedDetail: ScheduleRunDetail = {
      run: {
        ...baseRun,
        revision: 2,
        reviewDecision: 'dismiss-for-new-run',
        reviewedAt: '2026-11-01T06:00:00.000Z',
        reviewNote: 'Verified transcript; safe to run a fresh slot.',
      },
      scheduleName: sampleSchedule.name,
      deliveries: [{
        id: 'del_2',
        runId: baseRun.id,
        destinationBindingId: 'bind_1',
        destinationRevision: 1,
        notificationKind: 'terminal-summary',
        targetGuildId: 'guild_1',
        targetChannelId: 'chan_1',
        payloadDigest: 'b'.repeat(64),
        state: 'unknown',
        attemptCount: 1,
        lastErrorCode: 'GATEWAY_TIMEOUT',
        createdAt: '2026-11-01T05:31:00.000Z',
        updatedAt: '2026-11-01T05:31:00.000Z',
      }],
    };

    for (const lang of ['en', 'id'] as const) {
      const text = MESSAGES[lang].schedules;
      const html = renderToStaticMarkup(createElement(ScheduleRunDetailCard, {
        text,
        detail: reviewedDetail,
        schedule: sampleSchedule,
        loading: false,
        reviewBusy: false,
        reviewError: null,
        onClose: vi.fn(),
        onOpenSession: vi.fn(),
        onReviewUnknownRun: vi.fn(async () => undefined),
      }));

      const decoded = html.replace(/&amp;/g, '&');
      expect(decoded).toContain('data-testid="schedule-unknown-review"');
      expect(decoded).toContain(text.reviewUnknownHeading);
      expect(decoded).toContain(text.reviewSubmit);
      expect(decoded).toContain('data-testid="schedule-review-recorded"');
      expect(decoded).toContain(text.reviewActions['dismiss-for-new-run']);
      expect(decoded).toContain('Verified transcript; safe to run a fresh slot.');
      expect(decoded).toContain(text.deliveryStates.unknown);
      expect(decoded).toContain('GATEWAY_TIMEOUT');
    }
  });

  it('renders Run History panel with workspace filters, pagination, and WebGL-free SchedulesPage', () => {
    for (const lang of ['en', 'id'] as const) {
      const t = MESSAGES[lang];
      const text = t.schedules;
      const panelHtml = renderToStaticMarkup(createElement(ScheduleRunHistoryPanel, {
        text,
        workspaceName: 'Core Project',
        schedules: [sampleSchedule],
        runs: [baseRun, { ...baseRun, id: 'run_failed_1', state: 'failed', verification: 'failed', statusReason: 'Connection refused' }],
        total: 3,
        nextCursor: 'cursor-1',
        loading: false,
        loadingMore: false,
        error: null,
        supported: true,
        scheduleFilter: '',
        stateFilter: '',
        selectedRunId: baseRun.id,
        selectedDetail: { run: baseRun, deliveries: [], scheduleName: sampleSchedule.name },
        detailLoading: false,
        reviewBusy: false,
        reviewError: null,
        onChangeScheduleFilter: vi.fn(),
        onChangeStateFilter: vi.fn(),
        onRefresh: vi.fn(),
        onLoadMore: vi.fn(),
        onSelectRun: vi.fn(),
        onCloseDetail: vi.fn(),
        onClosePanel: vi.fn(),
        onOpenSession: vi.fn(),
        onReviewUnknownRun: vi.fn(async () => undefined),
      }));

      expect(panelHtml).toContain('data-testid="schedule-history-panel"');
      expect(panelHtml).toContain('Core Project');
      expect(panelHtml).toContain(text.runsTotal(2, 3));
      expect(panelHtml).toContain(text.loadMoreRuns);
      expect(panelHtml).toContain(text.runStates.unknown);
      expect(panelHtml).toContain(text.runStates.failed);
      expect(panelHtml).toContain(text.verificationStates.failed);
      expect(panelHtml).toContain(text.noDeliveries);

      const pageHtml = renderToStaticMarkup(createElement(SchedulesPage, {
        t,
        agents: {
          listSchedules: vi.fn(async () => ({ revision: 'rev-1', schedules: [sampleSchedule], timeZone: 'UTC' })),
          saveSchedule: vi.fn(async () => ({ revision: 'rev-2', schedules: [sampleSchedule] })),
          setScheduleEnabled: vi.fn(async () => ({ revision: 'rev-2', schedules: [sampleSchedule] })),
          runScheduleNow: vi.fn(async () => ({ revision: 'rev-2', schedules: [sampleSchedule] })),
          deleteSchedule: vi.fn(async () => ({ revision: 'rev-2', schedules: [] })),
          listScheduleRuns: vi.fn(async () => ({ runs: [], total: 0 })),
          scheduleRunDetail: vi.fn(async () => ({ run: baseRun, deliveries: [] })),
          previewScheduleNextRuns: vi.fn(async () => ({ timeZone: 'UTC', usedFallbackTimeZone: false, runs: [], notes: [] })),
          reviewUnknownScheduleRun: vi.fn(async () => ({ run: baseRun, deliveries: [] })),
          modelChoices: vi.fn(async () => ({ runtime: 'extalia-native', models: ['gpt-5'], efforts: ['low'] })),
          subscribe: () => () => undefined,
        } as unknown as AgentHostApi,
        state: sampleState,
        workspaceId: 'ws-1',
        onSelectWorkspace: vi.fn(),
        onOpenSession: vi.fn(),
        onOpenSettings: vi.fn(),
        onState: vi.fn(),
      }));
      expect(pageHtml).toContain('data-testid="schedules-open-history"');
      expect(pageHtml).toContain(text.runHistory);
    }
  });

  it('provides full EN/ID badge and review-action translation parity', () => {
    for (const lang of ['en', 'id'] as const) {
      const text = MESSAGES[lang].schedules;
      for (const state of SCHEDULE_RUN_STATES) {
        expect(text.runStates[state]).toBeTruthy();
        expect(runStateBadgeTone(state)).toBeTruthy();
      }
      for (const verification of SCHEDULE_VERIFICATION_STATES) {
        expect(text.verificationStates[verification]).toBeTruthy();
        expect(verificationBadgeTone(verification)).toBeTruthy();
      }
      for (const delivery of SCHEDULE_DELIVERY_STATES) {
        expect(text.deliveryStates[delivery]).toBeTruthy();
        expect(deliveryBadgeTone(delivery)).toBeTruthy();
      }
      for (const action of SCHEDULE_REVIEW_ACTIONS) {
        expect(text.reviewActions[action]).toBeTruthy();
      }
    }
  });
});

describe('mockHost schedule ledger & timezone parity', () => {
  it('supports listSchedules, previewScheduleNextRuns, listScheduleRuns, scheduleRunDetail, reviewUnknownScheduleRun, and runScheduleNow', async () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
    const agents = platform.capabilities.agents!;
    expect(agents).toBeDefined();
    const state = await agents.getState();
    const workspaceId = state.workspaces[0]!.id;

    const catalog = await agents.listSchedules!();
    expect(catalog.timeZone).toBeTruthy();
    expect(catalog.schedules.length).toBeGreaterThanOrEqual(2);
    expect(catalog.schedules[0]!.trigger).toMatchObject({ kind: 'cron', timeZone: 'America/New_York' });

    const preview = await agents.previewScheduleNextRuns!({ kind: 'cron', cron: '0 9 * * 1-5', timeZone: 'Asia/Jakarta' }, 5);
    expect(preview.timeZone).toBe('Asia/Jakarta');
    expect(preview.usedFallbackTimeZone).toBe(false);
    expect(preview.runs).toHaveLength(5);
    expect(preview.runs[0]!.localTime).toContain('(UTC+07:00)');

    await expect(
      agents.saveSchedule!({
        workspaceId,
        name: 'Invalid TZ',
        prompt: 'Test.',
        trigger: { kind: 'cron', cron: '0 9 * * *', timeZone: 'Mars/Phobos' },
        sessionTarget: { mode: 'create-and-reuse' },
      }),
    ).rejects.toThrow(/Invalid IANA time zone/);

    const page1 = await agents.listScheduleRuns!({ workspaceId, limit: 2 });
    expect(page1.runs).toHaveLength(2);
    expect(page1.total).toBeGreaterThanOrEqual(4);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await agents.listScheduleRuns!({ workspaceId, limit: 2, cursor: page1.nextCursor });
    expect(page2.runs.length).toBeGreaterThan(0);

    const unknownPage = await agents.listScheduleRuns!({ workspaceId, state: 'unknown' });
    expect(unknownPage.runs).toHaveLength(1);
    const unknownRun = unknownPage.runs[0]!;

    const detail = await agents.scheduleRunDetail!(unknownRun.id);
    expect(detail.run.id).toBe(unknownRun.id);
    expect(detail.deliveries).toHaveLength(1);
    expect(detail.deliveries[0]!.state).toBe('unknown');

    await expect(
      agents.reviewUnknownScheduleRun!(unknownRun.id, unknownRun.revision + 99, { action: 'acknowledge' }),
    ).rejects.toThrow(/changed/);

    const reviewed = await agents.reviewUnknownScheduleRun!(unknownRun.id, unknownRun.revision, {
      action: 'mark-resolved',
      note: 'Checked mock session output.',
    });
    expect(reviewed.run.state).toBe('unknown');
    expect(reviewed.run.verification).toBe('not-checked');
    expect(reviewed.run.reviewDecision).toBe('mark-resolved');
    expect(reviewed.run.reviewNote).toBe('Checked mock session output.');

    const targetJob = catalog.schedules[0]!;
    const afterManual = await agents.runScheduleNow!(targetJob.id, targetJob.revision);
    expect(afterManual.schedules.find(item => item.id === targetJob.id)!.runCount).toBe(targetJob.runCount + 1);
  });
});
