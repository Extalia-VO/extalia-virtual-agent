import { describe, expect, it } from 'vitest';
import { createMockPlatform, mockOptionsFromSearch } from '../src/host/mockHost';
import { NativeStandbyRotation } from '../src/office/nativeStandby';
import { officeHistoryIds } from '../src/office/historyIds';
import { projectOfficePresence } from '../src/office/presence';
import { presenceTeamMembers } from '../src/office/useSessionTeams';

describe('idle Native standby mock fixture', () => {
  it.each([1, 10, 20, 32])('seeds one idle Native session with %i configured members and no work events', async size => {
    const agents = createMockPlatform(mockOptionsFromSearch(`?mock=ready&standby=${size}`)).capabilities.agents!;
    const state = await agents.getState();
    expect(state.setupComplete).toBe(true);
    expect(state.sessions).toHaveLength(1);
    const lead = state.sessions[0]!;
    expect(lead).toMatchObject({ control: 'managed', running: false, team: { enabled: true, size } });
    expect(lead.runtime).toBeUndefined();
    const team = (await agents.getSessionTeam!(lead.id))!;
    expect(team.members).toHaveLength(size);
    expect(new Set(team.members.map(member => member.id)).size).toBe(size);
    const events = await agents.sessionEvents(lead.id);
    expect(events.map(event => event.body.type)).toEqual(['session.started']);
    expect(events.every(event => event.agentId === 'primary')).toBe(true);
    const teams = new Map([[lead.id, presenceTeamMembers(team, lead)]]);
    const presences = projectOfficePresence(state.sessions, events, Date.now(), teams);
    expect(presences).toHaveLength(1);
    expect(presences[0]).toMatchObject({ agentId: 'primary', status: 'idle', running: false });
    const rendered = new NativeStandbyRotation().project({
      sessions: state.sessions, presences, teams, readySessionIds: new Set([lead.id]), now: Date.now(),
    });
    expect(rendered.filter(agent => agent.nativeStandby === 'on-shift')).toHaveLength(Math.min(size, 5, 1 + Math.ceil(size / 8)));
    expect(rendered.some(agent => agent.running)).toBe(false);
    // Reading and projecting the fixture never creates a host turn or worker event.
    expect(await agents.sessionEvents(lead.id)).toEqual(events);
  });

  it.each(['', '0', '33', '-1', '1.5', '032', 'Infinity', 'unknown'])('ignores invalid standby size %s', value => {
    expect(mockOptionsFromSearch(`?mock=ready&standby=${value}`).standby).toBeUndefined();
  });

  it('preserves the ordinary ready fixture and its three-member configured team', async () => {
    const options = mockOptionsFromSearch('?mock=ready');
    expect(options.standby).toBeUndefined();
    const agents = createMockPlatform(options).capabilities.agents!;
    const state = await agents.getState();
    expect(state.sessions).toHaveLength(3);
    const lead = state.sessions.find(item => item.team?.enabled)!;
    expect(lead.team?.size).toBe(3);
    expect((await agents.getSessionTeam!(lead.id))?.members).toHaveLength(3);
    const histories = await Promise.all(state.sessions.map(item => agents.sessionEvents(item.id)));
    expect(histories.some(events => events.some(event => event.body.type === 'prompt.submitted'))).toBe(true);
    for (const item of (await agents.getState()).sessions) if (item.running) await agents.cancel(item.id);
  });

  it.each([24, 48])('projects exactly %i active Native avatars through the visible-session history path', async count => {
    const options = mockOptionsFromSearch(`?mock=ready&officeLoad=${count}`);
    expect(options.officeLoad).toBe(count);
    const agents = createMockPlatform(options).capabilities.agents!;
    const state = await agents.getState();
    const visible = state.sessions.slice(0, 24);
    expect(visible).toHaveLength(Math.ceil(count / 2));
    expect(visible.every(session => session.running && session.control === 'managed' && !session.runtime)).toBe(true);
    const historyIds = officeHistoryIds(visible);
    expect(historyIds).toHaveLength(visible.length);
    const histories = await Promise.all(historyIds.map(id => agents.sessionEvents(id)));
    const roster = projectOfficePresence(visible, histories.flat(), Date.now());
    expect(roster).toHaveLength(count);
    expect(roster.every(agent => agent.status === 'working' && agent.running)).toBe(true);
    expect(roster.filter(agent => agent.agentId === 'primary')).toHaveLength(Math.ceil(count / 2));
    expect(roster.filter(agent => agent.parentId)).toHaveLength(Math.floor(count / 2));
    expect(new Set(roster.map(agent => agent.id)).size).toBe(count);
    // The fixture uses only protocol presence events; it never starts mock model turns.
    expect(histories.flat().some(event => event.body.type === 'prompt.submitted' || event.body.type === 'tool.started')).toBe(false);
  });

  it.each(['', '0', '49', '-1', '1.5', '024', 'Infinity', 'unknown'])('ignores invalid Office load size %s', value => {
    expect(mockOptionsFromSearch(`?mock=ready&officeLoad=${value}`).officeLoad).toBeUndefined();
  });
});
