import type { AgentTeam, TeamMember } from '@extalia/core';
import type { EventBody } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt, createDelegationTool, createManageTeamTool, guardMemberTools, memberEditRefusal, runTurn,
  type AnyTool, type ApprovalRequest, type ModelProvider, type ModelRequest, type ModelResult,
} from '../src/index.js';

const writer: TeamMember = { id: 'm-elena', name: 'Elena Mark', role: 'Backend Engineer', models: ['m'], access: 'write', scope: ['src/auth', 'tests/**/*.test.ts'], forbidden: ['src/auth/secrets', 'src/**/*.sql'] };

describe('member edit scope', () => {
  it.each([
    ['src/auth/otp.ts', undefined],
    ['./src/auth/routes/otp.ts', undefined],
    ['src\\auth\\otp.ts', undefined],
    ['tests/auth/otp.test.ts', undefined],
    ['tests/otp.test.ts', undefined],
    ['src/other.ts', /outside Elena Mark's scope/],
    ['src/authz/x.ts', /outside/],
    ['src/auth/secrets/key.ts', /forbidden for Elena Mark \(src\/auth\/secrets\)/],
    ['SRC/AUTH/SECRETS/key.ts', /forbidden|outside/],
    ['src/auth/schema.sql', /forbidden/],
    ['src/auth/../../etc/passwd', /uses ".."/],
    ['../outside.ts', /uses ".."/],
    ['/etc/passwd', /absolute path/],
    ['~/x', /absolute path/],
    ['C:\\x', /absolute path/],
    ['', /Give a file path/],
  ])('%s', (path, refusal) => {
    const result = memberEditRefusal(writer, path);
    if (refusal) expect(result).toMatch(refusal); else expect(result).toBeUndefined();
  });

  it('allows the whole workspace with an empty scope, but forbidden paths still win', () => {
    const open = { ...writer, scope: [] };
    expect(memberEditRefusal(open, 'anything/at/all.ts')).toBeUndefined();
    expect(memberEditRefusal(open, 'src/auth/secrets/a')).toMatch(/forbidden/);
    expect(memberEditRefusal({ ...writer, access: 'read' }, 'src/auth/otp.ts')).toMatch(/read-only/);
  });

  it('refuses before approval and never runs the tool; allowed edits get the normalized path', async () => {
    const ran: unknown[] = [];
    const write: AnyTool = {
      name: 'write_file', description: 'Write', access: 'write', kind: 'edit',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      describe: input => ({ label: `Writing ${String(input.path)}` }),
      run: async input => { ran.push(input.path); return { ok: true, output: 'written' }; },
    };
    const [guarded] = guardMemberTools([write], writer);
    const context = { signal: new AbortController().signal, toolCallId: 'c', emit: () => undefined };
    expect(await guarded!.run({ path: '../x', content: '' }, context)).toMatchObject({ ok: false, output: expect.stringContaining('..') });
    expect(await guarded!.run({ path: './src/auth/a.ts', content: '' }, context)).toEqual({ ok: true, output: 'written' });
    expect(ran).toEqual(['src/auth/a.ts']);

    // In a turn, the refusal is a tool error and no approval is requested.
    const approvals: ApprovalRequest[] = [];
    let step = 0;
    const provider: ModelProvider = {
      api: 'openai-chat', listModels: async () => [],
      complete: async () => (step++ === 0
        ? { text: '', toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'src/auth/secrets/k.ts', content: 'x' } }], stop: 'tool_use' }
        : { text: 'ok', toolCalls: [], stop: 'end' }),
    };
    const events: EventBody[] = [];
    const result = await runTurn({
      provider, system: '', history: [], prompt: 'go', tools: [guarded!], permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: new Set(),
      emit: body => events.push(body), requestApproval: async request => { approvals.push(request); return 'once'; }, signal: new AbortController().signal,
    });
    expect(result.outcome).toBe('completed');
    expect(approvals).toEqual([]);
    expect(events.find(event => event.type === 'tool.completed')).toMatchObject({ ok: false, output: expect.stringContaining('forbidden') });
    expect(ran).toEqual(['src/auth/a.ts']);
  });
});

/** A member model that edits one file, then reports. */
function editingProvider(model: string, timeline: string[], file: (system: string) => string, delayMs = 0): ModelProvider {
  return {
    api: 'openai-chat', listModels: async () => [],
    async complete(request: ModelRequest): Promise<ModelResult> {
      const name = /\nYou are ([^,\n]+), the team/.exec(request.system)?.[1] ?? model;
      if (request.messages.at(-1)?.role === 'user') {
        timeline.push(`start ${name}`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return { text: '', toolCalls: [{ id: `e-${name}`, name: 'write_file', input: { path: file(request.system), content: 'x' } }], stop: 'tool_use' };
      }
      timeline.push(`end ${name}`);
      return { text: `${name} done`, toolCalls: [], stop: 'end' };
    },
  };
}

describe('write members in delegate_task', () => {
  const writeTool = (written: string[]): AnyTool => ({
    name: 'write_file', description: 'Write', access: 'write', kind: 'edit',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    describe: input => ({ label: `Writing ${String(input.path)}`, risk: 'low' }),
    run: async input => { written.push(String(input.path)); return { ok: true, output: 'written', files: [{ path: String(input.path), change: 'add' }] }; },
  });
  const members: TeamMember[] = [
    { ...writer, scope: ['src'], forbidden: [] },
    { id: 'm-kaelen', name: 'Kaelen Vael', role: 'Security', models: ['m'], access: 'write', scope: ['src'], soul: 'Paranoid.' },
    { id: 'm-iris', name: 'Iris Vael', role: 'Researcher', models: ['m'] },
  ];

  function harness(permissions: { fileWrite: 'ask' | 'allow'; commands: 'ask' | 'allow' } = { fileWrite: 'ask', commands: 'ask' }, decision: 'once' | 'session' | 'reject' = 'once') {
    const timeline: string[] = [];
    const written: string[] = [];
    const events: { body: EventBody; agentId?: string }[] = [];
    const approvals: { request: ApprovalRequest; agentId: string }[] = [];
    const sessionGrants = new Set<'write' | 'execute' | 'read' | 'memory' | 'meta'>();
    const tool = createDelegationTool({
      providerFor: () => { throw new Error('unused'); },
      workerTools: [],
      maxDelegations: 1,
      workspace: { name: 'Site', root: '/projects/site' },
      emit: (body, agentId) => events.push({ body, ...(agentId ? { agentId } : {}) }),
      permissions, sessionGrants,
      requestApproval: async (request, agentId) => { approvals.push({ request, agentId }); return decision; },
      team: {
        members, rules: ['Run the tests before reporting.'], leadModels: ['m'], writeTools: [writeTool(written)],
        providerForModel: model => editingProvider(model, timeline, system => (system.includes('Elena') ? 'src/a.ts' : 'src/b.ts'), 20),
      },
    });
    return { tool, timeline, written, events, approvals, sessionGrants };
  }
  const context = { signal: new AbortController().signal, toolCallId: 'c', emit: () => undefined };

  it('runs writers one at a time while read members run in parallel', async () => {
    const h = harness({ fileWrite: 'allow', commands: 'ask' });
    const results = await Promise.all([
      h.tool.run({ task: 'Build the route', member: 'Elena Mark' }, context),
      h.tool.run({ task: 'Harden it', member: 'Kaelen Vael' }, context),
      h.tool.run({ task: 'Read the docs', member: 'Iris Vael' }, context),
    ]);
    expect(results.map(result => result.output)).toEqual(['Elena Mark done', 'Kaelen Vael done', 'Iris Vael done']);
    const at = (entry: string) => h.timeline.indexOf(entry);
    // The second writer starts only after the first finished; the reader overlaps the first writer.
    expect(at('start Kaelen Vael')).toBeGreaterThan(at('end Elena Mark'));
    expect(at('start Iris Vael')).toBeLessThan(at('end Elena Mark'));
    expect(h.events.some(event => event.body.type === 'subagent.state' && event.body.subagentId === 'm-kaelen' && event.body.state === 'waiting')).toBe(true);
    expect(h.written).toEqual(['src/a.ts', 'src/b.ts']);
    // Member edits are attributed to the member.
    expect(h.events.filter(event => event.body.type === 'file.written').map(event => event.agentId)).toEqual(['m-elena', 'm-kaelen']);
    // The delegation limit grows to reach every member once.
    expect(h.tool.description).toContain('At most 3 delegations');
  });

  it('asks the user through the approval flow with the member as agent, and honours a session grant', async () => {
    const h = harness({ fileWrite: 'ask', commands: 'ask' }, 'session');
    await h.tool.run({ task: 'Build the route', member: 'm-elena' }, context);
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]).toMatchObject({ agentId: 'm-elena', request: { access: 'write', action: 'Writing src/a.ts' } });
    expect(h.events.find(event => event.body.type === 'approval.requested')?.agentId).toBe('m-elena');
    expect(h.events.find(event => event.body.type === 'approval.resolved')).toMatchObject({ agentId: 'm-elena', body: { decision: 'granted' } });
    expect(h.sessionGrants.has('write')).toBe(true);
    // The grant is shared: the next writer is not asked again.
    await h.tool.run({ task: 'Harden it', member: 'm-kaelen' }, context);
    expect(h.approvals).toHaveLength(1);
    expect(h.written).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('gives writers a prompt with soul, scope, rules and edit tools; read members keep read-only tools', async () => {
    const systems: string[] = [];
    const tools: string[][] = [];
    const tool = createDelegationTool({
      providerFor: () => { throw new Error('unused'); },
      workerTools: [], maxDelegations: 3, workspace: { name: 'Site', root: '/projects/site' }, emit: () => undefined,
      team: {
        members: [{ ...members[1]!, forbidden: ['src/db'] }, members[2]!], rules: ['Run the tests before reporting.'], leadModels: ['m'], writeTools: [writeTool([])],
        providerForModel: () => ({ api: 'openai-chat', listModels: async () => [], complete: async request => { systems.push(request.system); tools.push(request.tools.map(item => item.name)); return { text: 'ok', toolCalls: [], stop: 'end' }; } }),
      },
    });
    await tool.run({ task: 'x', member: 'Kaelen Vael' }, context);
    await tool.run({ task: 'y', member: 'Iris Vael' }, context);
    expect(systems[0]).toContain('Your persona and principles: Paranoid.');
    expect(systems[0]).toContain('Edit only inside your scope: src.');
    expect(systems[0]).toContain('Never edit: src/db');
    expect(systems[0]).toContain('- Run the tests before reporting.');
    expect(tools[0]).toEqual(['write_file']);
    expect(systems[1]).toContain('You cannot edit files or run commands.');
    expect(tools[1]).toEqual([]);
  });
});

describe('manage_team', () => {
  function harness(initial?: AgentTeam, taken: string[] = []) {
    let team = initial;
    const events: EventBody[] = [];
    let n = 0;
    const tool = createManageTeamTool({
      getTeam: () => team, saveTeam: async next => { team = next; return next; }, takenNames: () => taken, seed: 's_1', emit: body => events.push(body), newId: () => `m-${++n}`,
    });
    const context = { signal: new AbortController().signal, toolCallId: 'c', emit: () => undefined };
    return { tool, events, team: () => team, run: (input: Record<string, unknown>) => tool.run(input as never, context) };
  }

  it('adds members with generated unique names, enables the team and announces them at once', async () => {
    const h = harness(undefined, ['Lead Person']);
    const added = await h.run({ action: 'add', role: 'Backend Engineer', task: 'Build the OTP route', models: ['fast', 'big'], access: 'write', scope: ['src/auth'] });
    expect(added.ok).toBe(true);
    const member = h.team()!.members[0]!;
    expect(member).toMatchObject({ id: 'm-1', role: 'Backend Engineer', access: 'write', scope: ['src/auth'], models: ['fast', 'big'] });
    expect(member.name).toMatch(/^\S+ \S+$/);
    expect(member.gender).toMatch(/female|male/);
    expect(h.team()).toMatchObject({ enabled: true, allowedModels: ['fast', 'big'] });
    expect(h.events[0]).toEqual({ type: 'subagent.spawned', subagentId: 'm-1', role: 'Backend Engineer', label: member.name });
    expect(added.output).toContain(`Added ${member.name}`);
  });

  it('updates and removes by name or id, and validates like a saved team', async () => {
    const h = harness({ enabled: true, allowedModels: ['a'], members: [{ id: 'm-x', name: 'Elena Mark', role: 'Dev', models: ['a'] }] }, ['Taken Name']);
    expect(await h.run({ action: 'update', member: 'elena mark', soul: 'Calm', scope: ['../x'] })).toMatchObject({ ok: false, output: expect.stringContaining('leaves the workspace') });
    expect(await h.run({ action: 'update', member: 'm-x', soul: 'Calm', access: 'write' })).toMatchObject({ ok: true });
    expect(h.team()!.members[0]).toMatchObject({ soul: 'Calm', access: 'write' });
    expect(await h.run({ action: 'add', role: 'QA', name: 'taken name' })).toMatchObject({ ok: false, output: expect.stringContaining('already used') });
    expect(await h.run({ action: 'add', role: 'QA', name: 'Elena Mark' })).toMatchObject({ ok: false, output: expect.stringContaining('used twice') });
    expect(await h.run({ action: 'add' })).toMatchObject({ ok: false, output: 'Give the new member a role.' });
    expect(await h.run({ action: 'remove', member: 'Nobody' })).toMatchObject({ ok: false });
    expect(await h.run({ action: 'remove', member: 'Elena Mark' })).toMatchObject({ ok: true });
    expect(h.team()).toMatchObject({ enabled: false, members: [] });
    expect(h.events.at(-1)).toEqual({ type: 'subagent.state', subagentId: 'm-x', state: 'offline', summary: 'Removed from the team' });
    expect((await h.run({ action: 'list' })).output).toBe('The team has no members.');
  });

  it('is described in the lead prompt, with write members and rules', () => {
    const system = buildSystemPrompt({
      workspace: { name: 'Site', root: '/p' }, platform: { os: 'macOS', shell: 'zsh' }, manageTeam: true, agentName: 'Seren Vael',
      team: { fromPrompt: true, rules: ['Run tests'], members: [{ name: 'Elena Mark', role: 'Dev', access: 'write', scope: ['src'], forbidden: ['src/db'] }, { name: 'Iris', role: 'Reader' }] },
    });
    expect(system).toContain('manage_team');
    expect(system).toContain('you appear as Seren Vael');
    expect(system).toContain('The user\'s latest message defined this team');
    expect(system).toContain('- Elena Mark (Dev) [can edit: src; never: src/db]');
    expect(system).toContain('- Iris (Reader)');
    expect(system).toContain('- Run tests');
  });
});
