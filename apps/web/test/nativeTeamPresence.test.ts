import type { AgentTeam, SessionSummary } from '@extalia/platform';
import { createEvent, type EventBody } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { projectOfficePresence, type PresenceTeams } from '../src/office/presence';
import { withTeamMembers } from '../src/office/overlay/boardTree';
import { presenceTeamMembers, sessionTeamPresenceKey } from '../src/office/useSessionTeams';

const session: SessionSummary = {
  id: 'native-team', workspaceId: 'workspace', connectionId: 'lead-connection', title: 'Native team', control: 'managed',
  createdAt: '2026-11-08T00:00:00.000Z', lastActiveAt: '2026-11-08T00:00:00.000Z', running: false,
  options: { model: 'lead-model' }, team: { enabled: true, size: 2 },
};
const team: AgentTeam = {
  enabled: true, allowedModels: ['lead-model'], connections: [{ connectionId: 'worker-connection', allowedModels: ['worker-model-b', 'worker-fallback'] }],
  members: [
    { id: 'reviewer-a', name: 'Iris Vale', role: 'Reviewer', models: ['worker-explicit'], connectionId: 'other-connection' },
    { id: 'reviewer-b', name: 'Nova Vale', role: 'Reviewer', models: [], connectionId: 'worker-connection' },
  ],
};
const event = (seq: number, body: EventBody) => createEvent({
  id: `native-team-${seq}`, sessionId: session.id, agentId: 'primary', seq, at: `2026-11-08T00:00:0${seq}.000Z`,
  source: { runtime: 'extalia-native', channel: 'stream' }, body,
});
const teamsFor = (target = session, configured = team): PresenceTeams => new Map([[target.id, presenceTeamMembers(configured, target)]]);

describe('Native team model display', () => {
  it('refreshes cached member models on persisted team revisions without changing the team size', () => {
    const original = { ...session, team: { enabled: true, size: 2, updatedAt: '2026-11-08T00:00:00.000Z' } };
    const edited = { ...original, team: { ...original.team, updatedAt: '2026-11-08T00:00:01.000Z' } };
    expect(sessionTeamPresenceKey(edited)).not.toBe(sessionTeamPresenceKey(original));
    expect(sessionTeamPresenceKey({ ...original })).toBe(sessionTeamPresenceKey(original));
    expect(sessionTeamPresenceKey(edited, 1)).not.toBe(sessionTeamPresenceKey(edited));
    expect(sessionTeamPresenceKey(session)).toContain('extalia-native');
  });

  it('shows explicit and external approved default models on never-invoked board members', () => {
    const members = presenceTeamMembers(team, session);
    expect(members.map(member => member.model)).toEqual(['worker-explicit', 'worker-model-b']);
    const rows = withTeamMembers(projectOfficePresence([session], []), teamsFor());
    expect(rows.find(agent => agent.agentId === 'reviewer-b')).toMatchObject({ model: 'worker-model-b', status: 'offline' });
    // Primary model selection stays with the existing session options/default display path.
    expect(rows.find(agent => agent.agentId === 'primary')?.model).toBeUndefined();
    expect(session.options?.model).toBe('lead-model');
  });

  it('uses the configured connection default until an actual spawn reports a model, then tracks fallback', () => {
    const spawn = event(1, { type: 'subagent.spawned', subagentId: 'reviewer-b', label: 'Nova Vale' });
    expect(projectOfficePresence([session], [spawn], undefined, teamsFor()).find(agent => agent.agentId === 'reviewer-b')?.model).toBe('worker-model-b');
    const actual = event(2, { type: 'subagent.spawned', subagentId: 'reviewer-b', label: 'Nova Vale', model: 'worker-actual' });
    const fallback = event(3, { type: 'subagent.spawned', subagentId: 'reviewer-b', label: 'Nova Vale', model: 'worker-fallback' });
    expect(projectOfficePresence([session], [spawn, actual], undefined, teamsFor()).find(agent => agent.agentId === 'reviewer-b')?.model).toBe('worker-actual');
    expect(projectOfficePresence([session], [fallback, spawn, actual], undefined, teamsFor()).find(agent => agent.agentId === 'reviewer-b')?.model).toBe('worker-fallback');
  });

  it('leaves an unresolved external default unknown instead of showing the lead model', () => {
    const missing = { ...team, connections: [] };
    expect(presenceTeamMembers(missing, session)[1]?.model).toBeUndefined();
    const rows = withTeamMembers(projectOfficePresence([session], []), teamsFor(session, missing));
    expect(rows.find(agent => agent.agentId === 'reviewer-b')?.model).toBeUndefined();
  });

  it('does not claim configured models for Hermes members; actual delegated metadata remains visible', () => {
    const hermes = { ...session, runtime: { id: 'hermes' as const, profile: 'default' } };
    expect(presenceTeamMembers(team, hermes).every(member => member.model === undefined)).toBe(true);
    const spawn = event(1, { type: 'subagent.spawned', subagentId: 'reviewer-b', model: 'hermes-delegated' });
    expect(projectOfficePresence([hermes], [spawn], undefined, teamsFor(hermes)).find(agent => agent.agentId === 'reviewer-b')?.model).toBe('hermes-delegated');
    expect(withTeamMembers(projectOfficePresence([hermes], []), teamsFor(hermes)).find(agent => agent.agentId === 'reviewer-b')?.model).toBeUndefined();
  });

  it('keeps observed member models based on source events rather than Native configuration', () => {
    const observed = { ...session, control: 'observed' as const, observation: { sourceId: 'codex', nativeSessionId: 'observed-native', watching: true, status: 'watching' as const } };
    expect(presenceTeamMembers(team, observed).every(member => member.model === undefined)).toBe(true);
    const spawn = event(1, { type: 'subagent.spawned', subagentId: 'reviewer-b', model: 'observed-actual' });
    expect(projectOfficePresence([observed], [spawn], undefined, teamsFor()).find(agent => agent.agentId === 'reviewer-b')?.model).toBe('observed-actual');
  });
});
