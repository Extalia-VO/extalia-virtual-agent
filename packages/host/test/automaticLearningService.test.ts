import { createAgentHost } from '../src/service.js';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtaliaEvent } from '@extalia/protocol';
import { type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';
import { DAEMON_BINARY } from './daemonBackend.js';

const temp = useTempDirs();
const runtimes: AgentHostRuntime[] = [];
afterEach(async () => { while (runtimes.length) await runtimes.pop()!.close(); });
interface Body { model: string; messages: { role: string; content?: string }[]; tools?: { function: { name: string } }[] }
type Reply = { text: string } | { tool: string; args: Record<string, unknown> };
const curator = (body: Body) => body.messages[0]?.content?.startsWith('You are a bounded post-task Skills curator.') ?? false;
function response(reply: Reply, call: number) {
  const delta = 'tool' in reply ? { tool_calls: [{ index: 0, id: `call-${call}`, function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] } : { content: reply.text };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool' in reply ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(options: { enabled?: boolean; history?: boolean; holdCurator?: Promise<void> } = {}) {
  const root = await temp('extalia-automatic-learning-'), data = path.join(root, 'data'), home = path.join(root, 'home'), project = path.join(root, 'project');
  await mkdir(home); await mkdir(project); await writeFile(path.join(project, 'parser.txt'), 'Validate input before saving parsed data.');
  const requests: Body[] = [], events: ExtaliaEvent[] = [], readPrompts = new Set<string>();
  const runtime = await createAgentHost({
    kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
    env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_NATIVE_CORE: 'typescript', EXTALIA_DAEMON_PATH: DAEMON_BINARY, EXTALIA_HERMES_BIN: path.join(root, 'missing'), PATH: '' },
    fetch: async (url, init) => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'fixture-model' }] });
      const body = JSON.parse(String(init?.body)) as Body; requests.push(body);
      const call = requests.length;
      if (curator(body)) {
        if (body.messages.at(-1)?.role === 'tool') return response({ text: 'Learning findings submitted.' }, call);
        await options.holdCurator;
        const prompt = body.messages.find(item => item.role === 'user')!.content!;
        const evidence = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as { id: string }[];
        return response({ tool: 'submit_learning', args: { title: 'Validate parser input', lesson: 'Validate input before saving parsed data and report validation failures.', evidenceIds: evidence.map(item => item.id) } }, call);
      }
      const prompt = body.messages.filter(item => item.role === 'user').at(-1)?.content ?? '';
      if (prompt.startsWith('Read') && !readPrompts.has(prompt)) {
        readPrompts.add(prompt); return response({ tool: 'read_file', args: { path: 'parser.txt' } }, call);
      }
      return response({ text: 'Source task completed.' }, call);
    },
  });
  runtimes.push(runtime);
  const host = runtime.host; host.subscribe(event => events.push(event));
  const connection = (await host.saveConnection({ name: 'Fixture', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'fixture-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history: options.history ?? true }, orchestration: { enabled: false, maxDelegations: 0, tiers: {} } })).connections[0]!;
  const workspace = (await host.saveWorkspace({ name: 'Fixture', projectLocation: project, connectionId: connection.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  const before = await host.listVaultProfiles!();
  const catalog = await host.saveVaultProfile!({ name: 'Learning fixture', vaultRoot: null, workspaceIds: [workspace.id], minutesEnabled: false,
    automaticLearning: { enabled: options.enabled ?? true, skills: false, notes: true }, expectedRevision: before.revision });
  const profile = catalog.profiles.find(item => item.workspaceIds.includes(workspace.id))!;
  const session = await host.createSession(workspace.id);
  return { root, data, runtime, host, requests, events, session, workspace, profile };
}
const idle = async (runtime: AgentHostRuntime) => { await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5_000, interval: 5 }); };
const noteFiles = async (root: string, workspace: string) => readdir(path.join(root, 'Learning', workspace)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });

describe.skipIf(process.platform === 'win32')('saved profile automatic learning through the Native host', () => {
  it('runs a real curator without a per-message flag and saves only to the assigned profile', async () => {
    const f = await fixture();
    await f.host.sendPrompt(f.session.id, 'Read the parser and report its validation order.'); await idle(f.runtime);
    const worker = f.requests.filter(curator);
    expect(worker).toHaveLength(2);
    expect(worker.every(body => body.model === 'fixture-model')).toBe(true);
    expect(worker[0]!.tools?.map(item => item.function.name)).toContain('submit_learning');
    expect(worker[0]!.tools?.some(item => /write|command|delegat|manage|skill_propose/.test(item.function.name))).toBe(false);
    const spawns = f.events.filter(event => event.body.type === 'subagent.spawned'); expect(spawns).toHaveLength(1);
    const agentId = spawns[0]!.body.type === 'subagent.spawned' ? spawns[0]!.body.subagentId : '';
    expect(f.events.some(event => event.agentId === agentId && event.body.type === 'agent.state' && event.body.activity === 'knowledge')).toBe(true);
    const files = await noteFiles(f.profile.root, f.workspace.id); expect(files).toHaveLength(1);
    const note = await readFile(path.join(f.profile.root, 'Learning', f.workspace.id, files[0]!), 'utf8');
    expect(note).toContain(`profile: "${f.profile.id}"`); expect(note).toContain(`session: "${f.session.id}"`);
    expect(note).toContain('Validate input before saving parsed data.'); expect(note).toContain('## Current-turn evidence');
    expect(await noteFiles(path.join(f.data, 'vaults', 'default'), f.workspace.id)).toEqual([]);
    expect(f.events.filter(event => event.agentId === 'primary' && event.body.type === 'turn.completed')).toHaveLength(1);
    expect(f.events.some(event => event.body.type === 'tool.completed' && event.body.tool === 'automatic_learning' && event.body.ok)).toBe(true);
  });

  it('retains busy ownership and seals steering through curation before any terminal/idle/next prompt', async () => {
    const release = deferred(), f = await fixture({ holdCurator: release.promise });
    let idleNotifications = 0; const unsubscribe = f.runtime.onIdle(() => { idleNotifications++; });
    try {
      await f.host.sendPrompt(f.session.id, 'Read the parser before finishing.');
      await vi.waitFor(() => expect(f.requests.some(curator)).toBe(true), { timeout: 5_000, interval: 5 });
      const idleBefore = idleNotifications;
      expect(f.runtime.isBusy()).toBe(true);
      expect((await f.host.getState()).sessions.find(item => item.id === f.session.id)?.running).toBe(true);
      expect(f.events.some(event => event.body.type === 'turn.completed' || event.body.type === 'agent.state' && event.body.state === 'idle')).toBe(false);
      expect(await noteFiles(f.profile.root, f.workspace.id)).toEqual([]);
      let queue = await f.host.promptQueueStatus!(f.session.id); expect(queue.canSteer).toBe(false);
      queue = await f.host.changePromptQueue!(f.session.id, { revision: queue.revision, action: 'add', text: 'Follow up after learning settles.', start: true });
      expect(queue.items[0]?.state).toBe('pending');
      expect(f.requests.some(body => body.messages.some(message => message.content === 'Follow up after learning settles.'))).toBe(false);
      expect(idleNotifications).toBe(idleBefore);
      release.resolve(); await idle(f.runtime);
      await vi.waitFor(async () => expect((await f.host.promptQueueStatus!(f.session.id)).items[0]?.state).toBe('sent'), { timeout: 5_000, interval: 5 });
      await idle(f.runtime);
      expect(await noteFiles(f.profile.root, f.workspace.id)).toHaveLength(1);
      expect(f.events.filter(event => event.agentId === 'primary' && event.body.type === 'turn.completed')).toHaveLength(2);
    } finally { release.resolve(); unsubscribe(); }
  });

  it.each(['profile-off', 'plan', 'paused-team', 'history-off', 'trivial'] as const)('skips %s source work without invoking a curator or saving a note', async mode => {
    const f = await fixture({ enabled: mode !== 'profile-off', history: mode !== 'history-off' });
    if (mode === 'plan') await f.host.setSessionOptions(f.session.id, { permissionMode: 'plan' });
    if (mode === 'paused-team') await f.host.saveSessionTeam(f.session.id, { enabled: false, allowedModels: ['fixture-model'], members: [{ id: 'paused-member', name: 'Reviewer', role: 'Review', models: ['fixture-model'] }] });
    await f.host.sendPrompt(f.session.id, mode === 'trivial' ? 'Hello.' : 'Read the parser and explain it.'); await idle(f.runtime);
    expect(f.requests.some(curator)).toBe(false);
    expect(f.events.some(event => event.body.type === 'subagent.spawned')).toBe(false);
    expect(await noteFiles(f.profile.root, f.workspace.id)).toEqual([]);
    expect(f.events.filter(event => event.agentId === 'primary' && event.body.type === 'turn.completed')).toHaveLength(1);
  });

  it('never replays successful older-turn evidence into learning for a later trivial turn', async () => {
    const f = await fixture();
    await f.host.sendPrompt(f.session.id, 'Read the parser and explain validation.'); await idle(f.runtime);
    expect(f.requests.filter(curator)).toHaveLength(2); expect(await noteFiles(f.profile.root, f.workspace.id)).toHaveLength(1);
    await f.host.sendPrompt(f.session.id, 'Thanks.'); await idle(f.runtime);
    expect(f.requests.filter(curator)).toHaveLength(2); expect(await noteFiles(f.profile.root, f.workspace.id)).toHaveLength(1);
    const lastLead = f.requests.filter(body => !curator(body)).at(-1)!;
    expect(lastLead.messages.some(message => message.role === 'tool' && message.content?.includes('Validate input before saving parsed data.'))).toBe(true);
  });
});
