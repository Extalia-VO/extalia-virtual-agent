import { createAgentHost } from '../src/service.js';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelGuideStore } from '../src/modelGuideStore.js';
import { type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const tempDir = useTempDirs();
const runtimes: AgentHostRuntime[] = [];
afterEach(async () => { while (runtimes.length) await runtimes.pop()!.close(); });
const guide = { title: 'Team guide', revision: 'r1', text: 'Use allowed-fast for quick surveys.' };

describe('profile Model Selection Guide', () => {
  it('persists atomically in only the configured profile, with host timestamp and private permissions', async () => {
    const root = await tempDir();
    const first = new ModelGuideStore(path.join(root, 'first', 'config'));
    const second = new ModelGuideStore(path.join(root, 'second', 'config'));
    expect(await first.get()).toBeNull();
    const saved = await first.save(guide);
    expect(saved).toEqual({ ...guide, updatedAt: expect.any(String) });
    expect(await new ModelGuideStore(path.join(root, 'first', 'config')).get()).toEqual(saved);
    expect(await second.get()).toBeNull();
    if (process.platform !== 'win32') {
      expect((await stat(first.file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(first.file))).mode & 0o777).toBe(0o700);
    }
    expect(await first.save(null)).toBeNull();
    expect(await first.get()).toBeNull();
  });

  it('refuses malformed and oversized data without replacing the saved reference', async () => {
    const store = new ModelGuideStore(path.join(await tempDir(), 'config'));
    await store.save(guide);
    const before = await readFile(store.file, 'utf8');
    for (const bad of [{ ...guide, title: 'x'.repeat(121) }, { ...guide, revision: 'r'.repeat(81) }, { ...guide, text: 'x'.repeat(24001) }, { ...guide, text: '' }, { ...guide, updatedAt: 'forged' }, []]) {
      await expect(store.save(bad)).rejects.toThrow(/Guide/);
      expect(await readFile(store.file, 'utf8')).toBe(before);
    }
    await writeFile(store.file, '{broken');
    await expect(store.get()).rejects.toThrow(/left it unchanged/);
  });

  it('loads fresh shared guidance on every team plan and cannot widen model access or accept forged basis', async () => {
    const root = await tempDir();
    const project = path.join(root, 'project');
    await mkdir(project);
    const prompts: string[] = [];
    const runtime = await createAgentHost({
      kind: 'bridge', version: '0.0.0-test', dataDirectory: path.join(root, 'data'), homeDirectory: path.join(root, 'home'), importHome: path.join(root, 'home'),
      env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH },
      fetch: async (url, init) => {
        if (url.endsWith('/models')) return Response.json({ data: [{ id: 'allowed-fast' }] });
        const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
        prompts.push(body.messages.map(message => message.content).join('\n'));
        const text = JSON.stringify({ planningBasis: { kind: 'guide', title: 'forged' }, members: [{ role: 'Surveyor', task: 'Survey project', soul: 'Check evidence', models: ['unavailable-model', 'allowed-fast'] }] });
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    runtimes.push(runtime);
    const host = runtime.host;
    const connections = await host.saveConnection({ name: 'Mock', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.test/v1', model: 'allowed-fast', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' }, orchestration: { enabled: false, maxDelegations: 0, tiers: {} } });
    const state = await host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: connections.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
    const workspace = state.workspaces.at(-1)!;
    const request = { goal: 'Review project', count: 1, allowedModels: ['allowed-fast'] };
    const initial = await host.planTeam(workspace.id, request);
    expect(initial.planningBasis).toEqual({ kind: 'model-knowledge' });
    expect(prompts.at(-1)).toContain('own model knowledge as the primary basis');
    const saved = await host.saveModelSelectionGuide!(guide);
    const planned = await host.planTeam(workspace.id, request);
    expect(planned.source).toBe('model');
    expect(planned.planningBasis).toEqual({ kind: 'guide', title: guide.title, revision: guide.revision, updatedAt: saved!.updatedAt });
    expect(prompts.at(-1)).toContain(guide.text);
    expect(planned.members[0]!.models).toEqual(['allowed-fast']);
    const revised = { ...guide, revision: 'r2', text: 'Revised full guide: prefer deep context for review.' };
    await host.saveModelSelectionGuide!(revised);
    const replanned = await host.planTeam(workspace.id, request);
    expect(prompts.at(-1)).toContain(revised.text);
    expect(prompts.at(-1)).not.toContain(guide.text);
    expect(replanned.planningBasis).toMatchObject({ revision: 'r2' });
    await host.saveModelSelectionGuide!(null);
    expect((await host.planTeam(workspace.id, request)).planningBasis).toEqual({ kind: 'model-knowledge' });
  });
});


it.each(['null', '{}', '[]'])('does not treat malformed persisted %s as a missing guide', async raw => {
  const store = new ModelGuideStore(path.join(await tempDir(), 'config'));
  await mkdir(path.dirname(store.file), { recursive: true });
  await writeFile(store.file, raw);
  await expect(store.get()).rejects.toThrow(/left it unchanged/);
});
