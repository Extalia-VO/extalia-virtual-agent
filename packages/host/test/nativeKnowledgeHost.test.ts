import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtaliaEvent } from '@extalia/protocol';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';
import { DAEMON_BINARY, HAS_DAEMON, type Backend } from './daemonBackend.js';

const temp = useTempDirs(), runtimes: AgentHostRuntime[] = [];
afterEach(async () => { while (runtimes.length) await runtimes.pop()!.close(); });
type Body = { messages: { role: string; content: string | null }[]; tools?: { function: { name: string } }[] };
function reply(tool?: { name: string; args: object }): Response {
  const delta = tool ? { tool_calls: [{ index: 0, id: `call-${tool.name}`, function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { content: 'Reviewed the selected workspace note.' };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

describe.skipIf(!HAS_DAEMON || process.platform === 'win32')('Native Knowledge through actual host tools and Rust indexes', () => {
  for (const backend of ['typescript', 'rust'] as Backend[]) it(`keeps lead and delegated reads in each selected vault with ${backend} mission ownership`, async () => {
    const root = await realpath(await temp()), home = path.join(root, 'home'), data = path.join(root, 'data');
    await mkdir(home);
    const requests: Body[] = [], events: ExtaliaEvent[] = [];
    let delegate = false;
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
      env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_NATIVE_CORE: backend, EXTALIA_DAEMON_PATH: DAEMON_BINARY, EXTALIA_HERMES_BIN: path.join(root, 'missing'), PATH: '' },
      knowledge: { watcher: false }, daemon: { log: () => undefined },
      fetch: async (url, init) => {
        if (url.endsWith('/models')) return Response.json({ data: [{ id: 'fixture-model' }] });
        const body = JSON.parse(String(init?.body)) as Body; requests.push(body);
        const worker = body.messages[0]?.content?.startsWith('You are a worker agent');
        const results = body.messages.filter(message => message.role === 'tool');
        if (!worker && delegate) return results.length ? reply() : reply({ name: 'delegate_task', args: { member: 'scout', task: 'Read the selected vault sentinel.' } });
        if (!results.length) return reply({ name: 'knowledge_search', args: { query: 'sentinel' } });
        if (results.length === 1) return reply({ name: 'knowledge_read', args: { path: 'Sentinel.md' } });
        if (results.length === 2) return reply({ name: 'knowledge_read', args: { path: 'Excluded.md' } });
        return reply();
      },
    }); runtimes.push(runtime); runtime.host.subscribe(event => events.push(event));
    const host = runtime.host;
    const saved = await host.saveConnection({ name: 'Fixture', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'fixture-model',
      credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history: true }, orchestration: { enabled: false, maxDelegations: 0, tiers: {} } });
    for (const name of ['Alpha', 'Beta']) {
      const project = path.join(root, `${name}-project`), vault = path.join(root, `${name}-vault`);
      await mkdir(project); await mkdir(vault); await mkdir(path.join(vault, '.obsidian'));
      await writeFile(path.join(vault, '.obsidian', 'preferences.json'), '{"unchanged":true}\n');
      await writeFile(path.join(vault, 'Sentinel.md'), `# Sentinel\n${name} sentinel only.\n`);
      await writeFile(path.join(vault, 'Excluded.md'), '---\nprofile: foreign-profile\n---\n# Excluded\nPRIVATE SENTINEL\n');
      const state = await host.saveWorkspace({ name, projectLocation: project, connectionId: saved.connections[0]!.id, crossWorkspaceAccess: 'isolated', permissions: { fileWrite: 'ask', commands: 'ask' } });
      const workspace = state.workspaces.find(item => item.name === name)!;
      await host.workspaceKnowledge!(workspace.id, 'setKnowledgeVaultRoot', [vault]);
      for (delegate of [false, true]) {
        const start = requests.length;
        const session = await host.createSession(workspace.id, delegate ? { team: { enabled: true, allowedModels: ['fixture-model'],
          members: [{ id: 'scout', name: 'Scout', role: 'Researcher', models: ['fixture-model'], access: 'read' }] } } : undefined);
        if (!delegate) await host.setSessionOptions(session.id, { permissionMode: 'plan' });
        await host.sendPrompt(session.id, 'Read this workspace vault sentinel.');
        for (let i = 0; i < 500 && runtime.isBusy(); i++) await new Promise(resolve => setTimeout(resolve, 10));
        expect(runtime.isBusy()).toBe(false);
        expect(events.find(event => event.sessionId === session.id && event.agentId === 'primary' && event.body.type === 'turn.failed')).toBeUndefined();
        const turn = requests.slice(start), reads = turn.filter(body => !delegate || body.messages[0]?.content?.startsWith('You are a worker agent'));
        expect(reads, JSON.stringify(turn.map(body => ({ system: body.messages[0]?.content?.slice(0, 80), results: body.messages.filter(message => message.role === 'tool') })))).toHaveLength(4);
        const tools = reads[0]!.tools!.map(tool => tool.function.name);
        expect(tools).toEqual(expect.arrayContaining(['knowledge_search', 'knowledge_read']));
        expect(tools).not.toContain('memory_read'); expect(tools).not.toContain('knowledge_write'); expect(tools).not.toContain('write_file');
        const results = reads.at(-1)!.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content!));
        expect(results[0].hits.map((hit: { path: string }) => hit.path)).toEqual(['Sentinel.md']);
        expect(results[1]).toMatchObject({ workspaceId: workspace.id, profileId: workspace.profileId, path: 'Sentinel.md', status: 'found' });
        expect(results[1].body).toContain(`${name} sentinel only.`);
        expect(results[2].status).toBe('missing');
        expect(JSON.stringify(results)).not.toContain('PRIVATE SENTINEL');
        expect(JSON.stringify(results)).not.toContain(vault);
        expect(JSON.stringify(results)).not.toContain(`${name === 'Alpha' ? 'Beta' : 'Alpha'} sentinel only.`);
      }
      expect(await readFile(path.join(vault, '.obsidian', 'preferences.json'), 'utf8')).toBe('{"unchanged":true}\n');
      expect(await readFile(path.join(vault, 'Sentinel.md'), 'utf8')).toBe(`# Sentinel\n${name} sentinel only.\n`);
    }
  });
});
