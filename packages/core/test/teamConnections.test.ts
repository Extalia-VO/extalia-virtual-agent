import { describe, expect, it } from 'vitest';
import {
  MAX_TEAM_CONNECTIONS, applyTeamSpec, decodeAgentTeam, initialSessionTeam, parseTeamPlanResult, parseTeamSpec,
  planTeamHeuristic, teamPlanPrompt, type AgentTeam, type TeamMember,
} from '../src/index.js';

const member: TeamMember = { id: 'm-reader', name: 'Example Reader', role: 'Reviewer', connectionId: 'secondary', models: ['extra-b'] };
const team: AgentTeam = { enabled: true, allowedModels: ['lead'], connections: [{ connectionId: 'secondary', allowedModels: ['extra-a', 'extra-b'] }], members: [member] };

describe('approved team connections', () => {
  it('round trips grants and selected models independently from the lead allowlist', () => {
    expect(MAX_TEAM_CONNECTIONS).toBe(8);
    expect(decodeAgentTeam(team)).toEqual({ ok: true, value: team });
    const copied = initialSessionTeam(team, undefined)!;
    copied.connections![0]!.allowedModels.push('another');
    expect(team.connections![0]!.allowedModels).toEqual(['extra-a', 'extra-b']);
    expect(decodeAgentTeam({ ...team, members: [{ ...member, models: [] }] }).ok).toBe(true);
  });

  it('accepts 32 permitted models per connection while member chains remain bounded to eight', () => {
    const models = Array.from({ length: 32 }, (_, index) => `model-${index}`);
    const expanded = { ...team, allowedModels: models, connections: [{ connectionId: 'secondary', allowedModels: models }], members: [{ ...member, models: models.slice(0, 8) }] };
    expect(decodeAgentTeam(expanded).ok).toBe(true);
    expect(decodeAgentTeam({ ...expanded, members: [{ ...member, models: models.slice(0, 9) }] }).ok).toBe(false);
    expect(decodeAgentTeam({ ...expanded, allowedModels: [...models, 'extra'] }).ok).toBe(false);
    expect(decodeAgentTeam({ ...expanded, connections: [{ connectionId: 'secondary', allowedModels: [...models, 'extra'] }] }).ok).toBe(false);
  });

  it.each([
    { members: [{ ...member, connectionId: 'unapproved' }] },
    { members: [{ ...member, models: ['lead'] }] },
    { members: [{ ...member, connectionId: undefined }] },
    { connections: [{ connectionId: 'secondary', allowedModels: [] }] },
    { connections: [{ connectionId: '../unsafe', allowedModels: ['extra-b'] }] },
    { connections: [{ connectionId: 'x'.repeat(65), allowedModels: ['extra-b'] }] },
    { connections: [team.connections![0], team.connections![0]] },
    { connections: Array.from({ length: 9 }, (_, index) => ({ connectionId: `c-${index}`, allowedModels: ['extra-b'] })) },
    { connections: [{ connectionId: 'secondary', allowedModels: Array.from({ length: 33 }, (_, index) => `m-${index}`) }] },
    { connections: [{ connectionId: 'secondary', allowedModels: ['--unsafe'] }] },
  ])('rejects invalid or unapproved access %#', overrides => {
    expect(decodeAgentTeam({ ...team, ...overrides }).ok).toBe(false);
  });

  it('keeps grants and members through prompt team specifications without expanding access', () => {
    const updated = applyTeamSpec(team, parseTeamSpec('Subagent 1: Example Reader\nRole: Analyst\nTask: Inspect the implementation')!);
    expect(updated.connections).toEqual(team.connections);
    expect(updated.members[0]).toMatchObject({ id: member.id, connectionId: 'secondary', models: ['extra-b'], role: 'Analyst' });
    expect(() => applyTeamSpec(team, parseTeamSpec('Subagent 1: Example Reader\nModel: unapproved')!)).toThrow(/allowed models/);
    expect(() => applyTeamSpec(team, { members: [{ name: 'New Reader', role: 'Reader', models: ['extra-a'], connectionId: 'secondary' }] })).toThrow(/prompt cannot/);
    expect(team.members[0]).toEqual(member);
  });

  it('retains the saved goal document through a team spec unless that spec supplies a new goal', () => {
    const fullTeam = { ...team, goal: 'Full goal attached: goal.txt', goalDocument: { name: 'goal.txt', text: 'Complete request.' } };
    expect(applyTeamSpec(fullTeam, parseTeamSpec('Subagent 1: Example Reader\nRole: Analyst')!).goalDocument).toEqual(fullTeam.goalDocument);
    expect(applyTeamSpec(fullTeam, { goal: 'A replacement goal', members: [] }).goalDocument).toBeUndefined();
  });

  it.each([{ models: ['extra-b'] }, { models: [] }])('keeps a selected connection and its model chain %j through both planners', ({ models }) => {
    const kept = { ...member, models };
    const request = { goal: 'Review changes', count: 2, allowedModels: ['lead'], connections: team.connections, members: [kept] };
    const heuristic = planTeamHeuristic(request, () => 'm-new');
    expect(heuristic[0]).toMatchObject({ connectionId: 'secondary', models });
    const reply = JSON.stringify({ connections: [{ connectionId: 'unapproved', allowedModels: ['new'] }], members: [
      { role: 'Analyst', task: 'Inspect', models: ['lead'], connectionId: 'unapproved' },
      { role: 'Scout', task: 'Find', models: ['lead'], connectionId: 'unapproved' },
    ] });
    const parsed = parseTeamPlanResult(reply, request, () => 'm-new');
    expect(parsed.members[0]).toMatchObject({ connectionId: 'secondary', models });
    expect(parsed.members[1]!.connectionId).toBeUndefined();
    expect(decodeAgentTeam({ ...team, members: parsed.members }).ok).toBe(true);
    expect(teamPlanPrompt(request).user).toContain('Never create, expand or select connection grants');
  });
});
