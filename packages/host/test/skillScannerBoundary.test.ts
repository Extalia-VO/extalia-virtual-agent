import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BUILTIN_SKILLS } from '../src/builtinSkills.js';
import { buildAgentSkillCatalog, createSkillTools, withBuiltinSkills, type AgentSkillCatalog, type Skill } from '../src/skills.js';
import { createAgentHost } from '../src/service.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';
import { findTool, runTool, useTempDirs } from './helpers.js';

// Synthetic authoritative reload fixture only. Production still has UnavailableInspector;
// a host-supplied boolean, local consent or source label never stands in for skill.read.
const external = (patch: Partial<Skill> = {}): Skill => ({ name: 'external-review', source: 'imported', description: 'External metadata sentinel', body: 'External body sentinel', revisionId: `skr_${'a'.repeat(64)}`, sha256: 'b'.repeat(64), ...patch });
afterEach(() => vi.restoreAllMocks());
const temp = useTempDirs();
/** The real daemon's immutable objects need write permission only for temporary fixture cleanup. */
async function unlockFixture(directory: string): Promise<void> {
  const info = await lstat(directory).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory)) await unlockFixture(path.join(directory, entry));
  } else await chmod(directory, 0o600);
}

describe('mandatory scanner boundary for agent skill offerings', () => {
  it('keeps inventory arrays and unminted catalog objects outside external metadata and tools', async () => {
    const skill = external(), reload = vi.fn(async () => skill);
    const tools = createSkillTools([skill], { reload });
    expect(findTool(tools, 'skill_read').description).not.toContain(skill.name);
    expect((await runTool(tools, 'skill_read', { name: skill.name })).ok).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(withBuiltinSkills([skill]).map(item => item.name)).not.toContain(skill.name);
    expect(createSkillTools({ skills: [skill], verified: true } as AgentSkillCatalog)).toEqual([]);
    const noReload = await buildAgentSkillCatalog([skill]);
    expect(noReload.skills.some(item => item.name === skill.name)).toBe(false);
  });

  it('requires a fresh authoritative reload before metadata and again before every external read', async () => {
    const skill = external(), reload = vi.fn(async (listed: Skill) => ({ ...listed }));
    const catalog = await buildAgentSkillCatalog([skill], { reload });
    expect(reload).toHaveBeenCalledTimes(1); expect(Object.isFrozen(catalog)).toBe(true); expect(Object.isFrozen(catalog.skills)).toBe(true);
    const tools = createSkillTools(catalog);
    expect(findTool(tools, 'skill_read').description).toContain(skill.description);
    const first = await runTool(tools, 'skill_read', { name: skill.name });
    expect(first).toMatchObject({ ok: true }); expect(first.output).toContain('untrusted'); expect(first.output).toContain('<skill-content>'); expect(first.output).toContain(skill.body);
    await runTool(tools, 'skill_read', { name: skill.name }); expect(reload).toHaveBeenCalledTimes(3);
    await buildAgentSkillCatalog([skill], { reload }); expect(reload).toHaveBeenCalledTimes(4);
  });

  it.each(['name', 'description', 'body', 'source', 'revisionId', 'sha256'] as const)('refuses returned %s identity drift without using cached content', async field => {
    const skill = external(); let changed = false;
    const reload = vi.fn(async () => changed ? { ...skill, [field]: field === 'source' ? 'generated' : 'changed' } as Skill : { ...skill });
    const catalog = await buildAgentSkillCatalog([skill], { reload }); const tools = createSkillTools(catalog);
    changed = true;
    const refused = await runTool(tools, 'skill_read', { name: skill.name });
    expect(refused.ok).toBe(false); expect(refused.output).not.toContain(skill.body);
    expect((await buildAgentSkillCatalog([skill], { reload })).skills.some(item => item.name === skill.name)).toBe(false);
  });

  it('keeps canonical builtin contents despite forged flags, modified bodies and name collisions', async () => {
    const builtin = BUILTIN_SKILLS[0]!;
    const forged = [external({ name: builtin.name, body: 'Forged canonical override' }), external({ name: 'forged-builtin', source: 'builtin' }), { ...builtin, body: 'Modified shipped body' }];
    const reload = vi.fn(async (skill: Skill) => skill);
    const catalog = await buildAgentSkillCatalog(forged, { reload }); const tools = createSkillTools(catalog);
    expect(reload).not.toHaveBeenCalled(); expect(catalog.skills.find(item => item.name === builtin.name)).toMatchObject({ description: builtin.description, body: builtin.body, source: 'builtin' });
    expect(findTool(tools, 'skill_read').description).not.toContain('forged-builtin');
    const read = await runTool(tools, 'skill_read', { name: builtin.name }); expect(read.output).toContain(builtin.body); expect(read.output).not.toContain('override');
    const plain = await runTool(createSkillTools(forged), 'skill_read', { name: builtin.name }); expect(plain.output).toBe(read.output);
  });

  it('rejects paths, URLs, padded names and additional arguments before any authoritative reload or I/O', async () => {
    const skill = external(), reload = vi.fn(async () => ({ ...skill }));
    const catalog = await buildAgentSkillCatalog([skill], { reload }); reload.mockClear();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const tools = createSkillTools(catalog);
    for (const input of [{ name: '../external-review' }, { name: '/projects/example/SKILL.md' }, { name: 'https://example.com/SKILL.md' }, { name: ' external-review ' }, { name: skill.name, path: 'SKILL.md' }, { name: skill.name, url: 'https://example.com' }, { name: skill.name, verified: true }]) {
      expect((await runTool(tools, 'skill_read', input)).ok).toBe(false);
    }
    expect(reload).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores caller-supplied reload replacement and never falls back after the authoritative source disappears', async () => {
    const skill = external(); let available = true;
    const authoritative = vi.fn(async () => { if (!available) throw new Error('scanner unavailable'); return { ...skill }; });
    const catalog = await buildAgentSkillCatalog([skill], { reload: authoritative });
    available = false; const forgedReload = vi.fn(async () => skill);
    const refused = await runTool(createSkillTools(catalog, { reload: forgedReload }), 'skill_read', { name: skill.name });
    expect(refused.ok).toBe(false); expect(refused.output).not.toContain(skill.body); expect(forgedReload).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'skr_invalid'])('omits external items with missing/invalid revision %s before reload', async revisionId => {
    const skill = external({ revisionId }); const reload = vi.fn(async () => skill);
    expect((await buildAgentSkillCatalog([skill], { reload })).skills.some(item => item.name === skill.name)).toBe(false); expect(reload).not.toHaveBeenCalled();
  });
});

describe('unscanned skill inventory never enters lead or delegated provider requests', () => {
  for (const core of ['typescript', 'rust'] as const) it.skipIf(core === 'rust' && !HAS_DAEMON)(`keeps consented/project/user metadata and bodies outside ${core} agent prompts`, async () => {
    const base = await temp(), data = path.join(base, 'data'), home = path.join(base, 'home'), project = path.join(base, 'project');
    const write = async (directory: string, name: string, description: string, body: string) => {
      await mkdir(path.join(directory, name), { recursive: true }); await writeFile(path.join(directory, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
    };
    await mkdir(home, { recursive: true });
    await write(path.join(data, 'skills'), 'user-private', 'UNSCANNED_USER_METADATA', 'UNSCANNED_USER_BODY');
    await write(path.join(project, '.extalia', 'skills'), 'project-private', 'UNSCANNED_PROJECT_METADATA', 'UNSCANNED_PROJECT_BODY');
    await write(path.join(data, 'skills'), 'code-review', 'UNSCANNED_COLLISION_METADATA', 'UNSCANNED_COLLISION_BODY');
    const bodies: { model: string; tools?: { function: { name: string; description: string } }[] }[] = [];
    let leadCalls = 0;
    const runtime = await createAgentHost({
      kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000,
      env: { EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: '', EXTALIA_NATIVE_CORE: core, EXTALIA_DAEMON_PATH: DAEMON_BINARY }, daemon: { log: () => undefined },
      fetch: async (input, init) => {
        if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'lead-model' }, { id: 'worker-model' }] });
        const body = JSON.parse(String(init?.body)) as typeof bodies[number]; bodies.push(body);
        const tool = body.model === 'lead-model' && leadCalls++ === 0;
        const delta = tool ? { tool_calls: [{ index: 0, id: 'delegate-1', function: { name: 'delegate_task', arguments: JSON.stringify({ task: 'Inspect the synthetic project.', member: 'Worker' }) } }] } : { content: 'Reviewed.' };
        return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    try {
      const host = runtime.host;
      const connection = (await host.saveConnection({ name: 'Fixture', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'lead-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'extalia' } })).connections[0]!;
      const workspace = (await host.saveWorkspace({ name: 'Fixture', projectLocation: project, connectionId: connection.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
      const inventory = await host.workspaceSkills(workspace.id); await host.allowWorkspaceSkills(workspace.id, inventory.pending);
      expect((await host.workspaceSkills(workspace.id)).allowed.map(skill => skill.name)).toContain('project-private');
      if (core === 'rust') expect(await host.importSkill({ kind: 'workspace', workspaceId: workspace.id, name: 'project-private' })).toMatchObject({ state: 'quarantined', stateReason: 'scanner-unavailable' });
      const session = await host.createSession(workspace.id, { team: { enabled: true, allowedModels: ['lead-model', 'worker-model'], members: [{ id: 'm-worker', name: 'Worker', role: 'Reviewer', models: ['worker-model'] }] } });
      await host.sendPrompt(session.id, 'Review the current project.');
      await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5000, interval: 5 });
      expect(bodies.map(body => body.model)).toEqual(['lead-model', 'worker-model', 'lead-model']);
      for (const body of bodies) {
        const serialized = JSON.stringify(body); expect(serialized).not.toMatch(/UNSCANNED_|user-private|project-private/);
        const read = body.tools?.find(tool => tool.function.name === 'skill_read'); expect(read).toBeDefined();
        expect(read!.function.description).toContain(`- code-review: ${BUILTIN_SKILLS.find(skill => skill.name === 'code-review')!.description}`);
      }
    } finally { await runtime.close(); await unlockFixture(path.join(data, 'profiles')); }
  });
});
