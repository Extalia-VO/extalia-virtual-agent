import type { Workspace } from '@extalia/core';
import type { SessionSummary } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PendingApproval } from '../src/approvals/model';
import { MESSAGES } from '../src/i18n';
import { OfficeFallback2D } from '../src/office/OfficeFallback2D';
import {
  deduplicateOfficeAgents,
  filterOfficeSessions,
  OFFICE_SOURCE_FILTERS,
  resolveOfficeDisplayMode,
  sessionSourceKind,
} from '../src/office/officeFilters';
import type { OfficeAgent } from '../src/office/presence';

const AT = '2030-01-01T00:00:00.000Z';

function makeSession(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    workspaceId: 'ws-alpha',
    connectionId: 'conn-1',
    title: `Session ${id}`,
    control: 'managed',
    createdAt: AT,
    lastActiveAt: AT,
    running: false,
    ...patch,
  };
}

function makeAgent(id: string, patch: Partial<OfficeAgent> = {}): OfficeAgent {
  const [sessionId = 'sess-1', agentId = 'primary'] = id.split(':');
  return {
    id,
    sessionId,
    agentId,
    displayName: `Agent ${id}`,
    control: 'managed',
    status: 'working',
    running: true,
    ...patch,
  };
}

describe('officeFilters (Slice E)', () => {
  it('classifies session source kinds accurately', () => {
    expect(sessionSourceKind({ control: 'managed' })).toBe('native');
    expect(sessionSourceKind({ control: 'managed', runtime: { id: 'hermes', profile: 'default' } })).toBe('hermes');
    expect(sessionSourceKind({ control: 'observed' })).toBe('observed');
  });

  it('filters sessions by source and removes duplicate session ids while preserving order', () => {
    const nativeAssigned = makeSession('nat-1', { workspaceId: 'ws-alpha' });
    const nativeUnassigned = makeSession('nat-2', { workspaceId: null });
    const hermes = makeSession('her-1', {
      workspaceId: 'ws-beta',
      runtime: { id: 'hermes', profile: 'default' },
    });
    const observed = makeSession('obs-1', {
      workspaceId: 'ws-alpha',
      control: 'observed',
      observation: { sourceId: 'codex', nativeSessionId: 'ext-1', watching: true, status: 'watching' },
    });
    const duplicate = makeSession('nat-1', { workspaceId: 'ws-other' });

    const input = [nativeAssigned, nativeUnassigned, hermes, observed, duplicate];

    expect(OFFICE_SOURCE_FILTERS).toEqual(['all', 'native', 'hermes', 'observed', 'unassigned']);
    expect(filterOfficeSessions(input, { source: 'all' }).map(item => item.id)).toEqual([
      'nat-1',
      'nat-2',
      'her-1',
      'obs-1',
    ]);
    expect(filterOfficeSessions(input, { source: 'native' }).map(item => item.id)).toEqual(['nat-1', 'nat-2']);
    expect(filterOfficeSessions(input, { source: 'hermes' }).map(item => item.id)).toEqual(['her-1']);
    expect(filterOfficeSessions(input, { source: 'observed' }).map(item => item.id)).toEqual(['obs-1']);
    expect(filterOfficeSessions(input, { source: 'unassigned' }).map(item => item.id)).toEqual(['nat-2']);
  });

  it('deduplicates office agents by canonical identity, preferring non-earlier and fresher activity (AC-23)', () => {
    const olderEarlier = makeAgent('sess-a:primary', {
      displayName: 'Earlier Copy',
      earlier: true,
      lastActivityAt: '2030-01-01T00:05:00.000Z',
    });
    const fresherActive = makeAgent('sess-a:primary', {
      displayName: 'Active Lead',
      earlier: false,
      lastActivityAt: '2030-01-01T00:02:00.000Z',
    });
    const workerOlder = makeAgent('sess-a:worker-1', {
      displayName: 'Worker Stale',
      lastActivityAt: '2030-01-01T00:01:00.000Z',
    });
    const workerFresher = makeAgent('sess-a:worker-1', {
      displayName: 'Worker Fresh',
      lastActivityAt: '2030-01-01T00:09:00.000Z',
    });
    const otherLead = makeAgent('sess-b:primary', {
      displayName: 'Second Lead',
    });

    const deduped = deduplicateOfficeAgents([
      olderEarlier,
      otherLead,
      fresherActive,
      workerFresher,
      workerOlder,
    ]);

    expect(deduped).toHaveLength(3);
    expect(deduped.map(agent => [agent.sessionId, agent.agentId, agent.displayName])).toEqual([
      ['sess-a', 'primary', 'Active Lead'],
      ['sess-b', 'primary', 'Second Lead'],
      ['sess-a', 'worker-1', 'Worker Fresh'],
    ]);
  });

  it('forces 2d display mode when WebGL rendering has failed', () => {
    expect(resolveOfficeDisplayMode('3d', false)).toBe('3d');
    expect(resolveOfficeDisplayMode('2d', false)).toBe('2d');
    expect(resolveOfficeDisplayMode('3d', true)).toBe('2d');
    expect(resolveOfficeDisplayMode('2d', true)).toBe('2d');
  });
});

describe('OfficeFallback2D (AC-22 & AC-24)', () => {
  const workspaces: Workspace[] = [
    { id: 'ws-alpha', name: 'Workspace Alpha', rootPath: '/Users/example/alpha' } as unknown as Workspace,
  ];
  const sessions: SessionSummary[] = [
    makeSession('sess-native', { workspaceId: null }),
    makeSession('sess-obs', {
      workspaceId: 'ws-alpha',
      control: 'observed',
      observation: { sourceId: 'codex', nativeSessionId: 'ext-obs', watching: true, status: 'watching' },
    }),
  ];
  const nativeLead = makeAgent('sess-native:primary', {
    displayName: 'Native Lead',
    control: 'managed',
    status: 'waiting',
    phase: 'approval',
    pendingApprovalId: 'appr-1',
    model: 'gpt-example',
    title: 'Implement Slice E',
    summary: 'Waiting for tool approval',
    origin: { mark: 'extalia-native', label: 'Extalia Native' },
  });
  const observedLead = makeAgent('sess-obs:primary', {
    displayName: 'Observed Codex',
    control: 'observed',
    status: 'observing',
    running: false,
    stalled: true,
    lastActivityAt: AT,
    model: 'codex-example',
    origin: { mark: 'codex', label: 'Codex', channel: 'hook' },
  });
  const pendingApproval: PendingApproval = {
    id: 'appr-1',
    source: 'native',
    sessionId: 'sess-native',
    agentName: 'Native Lead',
    sessionTitle: 'Session sess-native',
    action: 'Run workspace verification',
    detail: 'pnpm test',
    risk: 'medium',
    requestedAt: AT,
    choices: ['allow-once', 'deny'],
  };

  it.each(['en', 'id'] as const)(
    'renders WebGL-unavailable fallback with actionable approvals, unassigned badge, and observed read-only tag (%s)',
    lang => {
      const t = MESSAGES[lang];
      const markup = renderToStaticMarkup(
        createElement(OfficeFallback2D, {
          t,
          language: lang,
          reason: 'webgl-unavailable',
          agents: [nativeLead, observedLead],
          sessions,
          workspaces,
          approvalFor: agent => (agent.pendingApprovalId === pendingApproval.id ? pendingApproval : undefined),
          renderApprovalActions: approval =>
            createElement('div', { 'data-approval-actions': approval.id }, t.approval.allowOnce),
          onOpenSession: vi.fn(),
          onOpenChat: vi.fn(),
          onOpenMissions: vi.fn(),
          onSwitchTo3D: vi.fn(),
        }),
      );

      expect(markup).toContain(t.office.fallback2d.title);
      expect(markup).toContain(t.office.fallback2d.leadWebglUnavailable);
      expect(markup).toContain(t.office.fallback2d.retry3d);
      expect(markup).toContain(t.office.fallback2d.openChat);
      expect(markup).toContain(t.office.fallback2d.openMissions);
      expect(markup).toContain(t.office.fallback2d.agentCount(2));
      expect(markup).toContain('Native Lead');
      expect(markup).toContain('Observed Codex');
      expect(markup).toContain(t.office.fallback2d.workspaceUnassigned);
      expect(markup).toContain('Workspace Alpha');
      expect(markup).toContain(t.office.fallback2d.observedReadOnly);
      expect(markup).toContain('data-approval-actions="appr-1"');
      expect(markup).toContain(pendingApproval.action);
      expect(markup).toContain(t.office.fallback2d.openSession);
    },
  );

  it('renders switch-to-3d action when manual 2d mode is active', () => {
    const t = MESSAGES.en;
    const markup = renderToStaticMarkup(
      createElement(OfficeFallback2D, {
        t,
        language: 'en',
        reason: 'manual-2d',
        agents: [nativeLead],
        sessions,
        workspaces,
        onSwitchTo3D: vi.fn(),
      }),
    );

    expect(markup).toContain(t.office.fallback2d.leadManual2d);
    expect(markup).toContain(t.office.viewMode.switchTo3d);
    expect(markup).not.toContain(t.office.fallback2d.retry3d);
  });

  it('renders empty notice when no agents match', () => {
    const t = MESSAGES.en;
    const markup = renderToStaticMarkup(
      createElement(OfficeFallback2D, {
        t,
        language: 'en',
        reason: 'manual-2d',
        agents: [],
        sessions: [],
        workspaces: [],
      }),
    );

    expect(markup).toContain(t.office.fallback2d.empty);
    expect(markup).toContain(t.office.fallback2d.agentCount(0));
  });
});
