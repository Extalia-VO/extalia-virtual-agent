import { describe, expect, it, vi } from 'vitest';
import type * as React from 'react';
import type { AgentHostApi, SessionSummary } from '@extalia/platform';
import { MESSAGES } from '../src/i18n';
import type { OfficeAgent, PresenceTeams } from '../src/office/presence';
import { subagentLingerMs } from '../src/office/presence';
import { useNativeStandby } from '../src/office/useNativeStandby';
import { agentStatusLabel, standbyMode } from '../src/office/overlay/status';
import { popoverSummary } from '../src/office/overlay/popoverModel';
import { officeKpis } from '../src/office/overlay/kpis';
import { officeHistoryIds } from '../src/office/historyIds';

// The cache belongs to the host/profile, so it must survive fresh page memo callbacks.
vi.mock('react', async original => ({ ...await original<typeof React>(), useMemo: (factory: () => unknown) => factory() }));

const session: SessionSummary = { id: 'session', workspaceId: 'workspace', connectionId: 'connection', title: 'Team',
  control: 'managed', running: false, createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), team: { enabled: true, size: 10 } };
const lead: OfficeAgent = { id: 'session:primary', sessionId: 'session', agentId: 'primary', displayName: 'Lead', control: 'managed', status: 'idle', running: false };
const teams: PresenceTeams = new Map([[session.id, Array.from({ length: 10 }, (_, index) => ({ id: `member-${index}`, name: `Member ${index}`, model: 'configured-model' }))]]);
const ready = new Set([session.id]);
const crew = (rows: readonly OfficeAgent[]) => rows.filter(row => row.nativeStandby === 'on-shift').map(row => row.id);

describe('Native standby view boundaries', () => {
  it('hydrates current idle Native teams without loading dormant historical or Hermes teams', () => {
    const old = { ...session, id: 'old', lastActiveAt: new Date(0).toISOString() };
    const current = { ...session, id: 'current', lastActiveAt: new Date(1_000).toISOString() };
    const hermes: SessionSummary = { ...session, id: 'hermes', workspaceId: 'other', runtime: { id: 'hermes', profile: 'default' } };
    expect(officeHistoryIds([old, current, hermes])).toEqual(['current']);
    expect(officeHistoryIds([old, { ...current, team: { enabled: false, size: 10 } }, hermes])).toEqual([]);
  });

  it('preserves rotation through navigation while isolating host and profile caches', () => {
    const host = {} as AgentHostApi;
    const view = (scope: string, now: number, client = host) => useNativeStandby(client, scope, [lead], [session], teams, now, ready);
    const first = crew(view('profile-a', 0));
    const later = Math.max(...first.map(subagentLingerMs)) + 1;
    const rotated = crew(view('profile-a', later));
    expect(rotated).toHaveLength(3);
    expect(rotated.some(id => first.includes(id))).toBe(false);
    expect(crew(view('profile-a', later + 1))).toEqual(rotated);
    expect(crew(view('profile-b', later))).toEqual(first);
    expect(crew(view('profile-a', later, {} as AgentHostApi))).toEqual(first);
  });

  it('waits for both roster metadata and history without discarding cached fairness', () => {
    const host = {} as AgentHostApi;
    const view = (now: number, roster = teams, loaded = ready, rosterReady = ready) => useNativeStandby(host, 'profile', [lead], [session], roster, now, loaded, rosterReady);
    expect(crew(view(0, new Map()))).toEqual([]);
    expect(crew(view(0, teams, new Set()))).toEqual([]);
    expect(crew(view(0, teams, ready, new Set()))).toEqual([]);
    const first = crew(view(0));
    const later = Math.max(...first.map(subagentLingerMs)) + 1;
    const rotated = crew(view(later));
    expect(rotated).not.toEqual(first);
    expect(crew(view(later + 1, new Map()))).toEqual([]);
    expect(crew(view(later + 1, teams, ready, new Set()))).toEqual([]);
    expect(crew(view(later + 2))).toEqual(rotated);
  });
});

describe('Native standby labels', () => {
  const standby: OfficeAgent = { ...lead, id: 'session:member', agentId: 'member', parentId: lead.id, nativeStandby: 'on-shift' };
  it.each(['en', 'id'] as const)('describes roster availability without pretending work is running in %s', language => {
    const t = MESSAGES[language];
    expect(agentStatusLabel(t, standby)).toBe(t.office.standby);
    expect(popoverSummary(t, standby)).toBe(t.characterPopover.summary.standby);
    expect(popoverSummary(t, standby, true)).toBe(t.characterPopover.summary.break);
    const away: OfficeAgent = { ...standby, status: 'offline', nativeStandby: 'off-shift' };
    expect(agentStatusLabel(t, away)).toBe(t.office.offShift);
    expect(popoverSummary(t, away)).toBe(t.characterPopover.summary.offShift);
    expect(officeKpis([lead, standby, away])).toMatchObject({ idle: 2, working: 0, running: 0 });
  });
  it('never lets a stale standby marker cover work, errors or an approval', () => {
    for (const patch of [{ status: 'working' as const }, { phase: 'error' as const }, { pendingApprovalId: 'approval' }, { stalled: true }, { running: true }]) {
      expect(standbyMode({ ...standby, ...patch })).toBeUndefined();
      expect(agentStatusLabel(MESSAGES.en, { ...standby, ...patch })).not.toBe(MESSAGES.en.office.standby);
    }
  });
});
