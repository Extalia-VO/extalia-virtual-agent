import { describe, expect, it } from 'vitest';
import { MOCK_OTP_TEAM_PROMPT, createMockPlatform, mockOptionsFromSearch } from '../src/host/mockHost';

describe('mock host subagent teams', () => {
  it('seeds a lead with a team whose members appear as subagents and plans heuristically', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    expect(typeof agents.planTeam).toBe('function');
    const state = await agents.getState();
    const lead = state.sessions.find(session => session.team)!;
    expect(lead.team).toEqual({ enabled: true, size: 3 });
    const team = (await agents.getSessionTeam(lead.id))!;
    expect(team.members.map(member => member.role)).toEqual(['Researcher', 'Reviewer', 'Analyst']);

    let spawned: string[] = [];
    for (let i = 0; i < 100 && spawned.length < 3; i++) {
      spawned = (await agents.sessionEvents(lead.id)).flatMap(event => (event.body.type === 'subagent.spawned' ? [event.body.subagentId] : []));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(spawned).toEqual(team.members.map(member => member.id));

    const plan = await agents.planTeam(state.workspaces[0]!.id, { goal: 'Ship the docs', count: 2, allowedModels: ['claude-opus-5-5'] });
    expect(plan).toMatchObject({ source: 'heuristic', members: [{ role: 'Researcher', models: ['claude-opus-5-5'] }, { role: 'Reviewer' }] });
    await expect(agents.saveSessionTeam(lead.id, { ...team, members: [{ ...team.members[0]!, models: ['nope'] }] })).rejects.toThrow(/allowed models/);
    expect(await agents.saveSessionTeam(lead.id, null)).toBeUndefined();
    expect((await agents.getState()).sessions.find(session => session.id === lead.id)?.team).toBeUndefined();

  });

  it('v0.0.32: plans and keeps teams on a Hermes workspace without a goal or ticked models', async () => {
    const hermes = createMockPlatform({ seed: 'ready', host: 'bridge', hermes: true }).capabilities.agents!;
    const state = await hermes.getState();
    const workspace = state.workspaces.find(item => item.runtimeId === 'hermes')!;
    expect(workspace.name).toBe('agent-lab');
    const plan = await hermes.planTeam(workspace.id, { goal: '', count: 8, allowedModels: [] });
    expect(plan.members).toHaveLength(8);
    expect(plan.members.every(member => member.name && member.role && member.task && member.models.length)).toBe(true);
    expect(plan.members[0]!.task).toContain('agent-lab');
    expect(plan.allowedModels!.length).toBeGreaterThan(2);
    expect(plan.allowedModels!.some(model => model.includes('embedding'))).toBe(false);
    const session = state.sessions.find(item => item.workspaceId === workspace.id)!;
    expect(session.runtime?.id).toBe('hermes');
    const saved = await hermes.saveSessionTeam(session.id, { enabled: true, allowedModels: plan.allowedModels!, members: plan.members });
    expect(saved?.members).toHaveLength(8);
    expect((await hermes.getState()).sessions.find(item => item.id === session.id)?.team).toEqual({ enabled: true, size: 8 });
    const created = await hermes.createSession(workspace.id, { team: saved! } as never);
    expect(created).toMatchObject({ runtime: { id: 'hermes' }, team: { enabled: true, size: 8 } });
  });

  it('names every lead uniquely and gives seeded members full names, gender, soul and access', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const state = await agents.getState();
    const managed = state.sessions.filter(session => session.control === 'managed');
    expect(managed.every(session => /^\S+ \S+$/.test(session.agentName ?? '') && ['female', 'male'].includes(session.agentGender ?? ''))).toBe(true);
    const team = (await agents.getSessionTeam(state.sessions.find(session => session.team)!.id))!;
    const names = [...managed.map(session => session.agentName!), ...team.members.map(member => member.name)];
    expect(new Set(names.map(name => name.toLowerCase())).size).toBe(names.length);
    expect(team.members.every(member => /^\S+ \S+$/.test(member.name) && member.gender && member.soul && member.access)).toBe(true);
    expect(team.members[0]).toMatchObject({ access: 'write', scope: ['package.json', 'src'] });
    const created = await agents.createSession(state.workspaces[0]!.id);
    expect(names.map(name => name.toLowerCase())).not.toContain(created.agentName!.toLowerCase());
  });

  it('turns a prompt with a team spec into the session team and shows the members at once', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const state = await agents.getState();
    const session = await agents.createSession(state.workspaces[0]!.id);
    await agents.sendPrompt(session.id, MOCK_OTP_TEAM_PROMPT);
    const team = (await agents.getSessionTeam(session.id))!;
    expect(team).toMatchObject({ enabled: true, goal: 'Eksekusi fitur OTP Login Endpoint' });
    expect(team.members.map(member => [member.name, member.gender, member.access, member.models])).toEqual([
      ['Elena Mark', 'female', 'write', ['claude-sonnet-5-5']],
      ['Kaelen Vael', 'male', 'write', ['claude-opus-5-5', 'claude-sonnet-5-5']],
    ]);
    expect(team.members[0]!.scope).toEqual(['src/auth']);
    expect(team.members[1]!.forbidden).toEqual(['migrations', '.env']);
    const spawned = (await agents.sessionEvents(session.id)).flatMap(event => (event.body.type === 'subagent.spawned' ? [event.body.label] : []));
    expect(spawned.slice(0, 2)).toEqual(['Elena Mark', 'Kaelen Vael']);
    await agents.cancel(session.id);
    expect(mockOptionsFromSearch('?mock=ready&otp').otp).toBe(true);
    const seeded = createMockPlatform({ seed: 'ready', host: 'bridge', otp: true }).capabilities.agents!;
    expect((await seeded.getState()).sessions.filter(item => item.team)).toHaveLength(2);
  });
});
