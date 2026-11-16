import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentTeam, ContextOptimization } from '@extalia/core';
import type { ConnectionInput } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import type { ContextCompactionReport } from '@extalia/runtime';
import type * as Caveman from '../src/cavemanContextOptimizer.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { NATIVE_CONTEXT_ARCHIVE_SUPPORTED } from '../src/nativeContextArchive.js';
import { DAEMON_BINARY } from './daemonBackend.js';
import { useTempDirs } from './helpers.js';

const engine = vi.hoisted(() => ({ script: '', factories: [] as string[], calls: [] as string[][] }));
vi.mock('../src/cavemanContextOptimizer.js', async importOriginal => {
  const original = await importOriginal<typeof Caveman>();
  const { spawn } = await import('node:child_process');
  return { ...original, createCavemanContextOptimizer: (options: Caveman.CavemanContextOptimizerOptions) => {
    engine.factories.push(options.executable);
    // The production adapter still validates configuration, owns process lifecycle,
    // verifies retrieve bytes, and disposes CCR. Only its executable test seam changes.
    return original.createCavemanContextOptimizer({ ...options, spawn: (_binary, args, processOptions) => {
      engine.calls.push([...args]);
      return spawn(process.execPath, [engine.script, ...args], { ...processOptions, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } });
  } };
});

const temp = useTempDirs(), runtimes: AgentHostRuntime[] = [];
afterEach(async () => {
  while (runtimes.length) await runtimes.pop()!.close();
  engine.script = ''; engine.factories.splice(0); engine.calls.splice(0);
});
interface Request {
  model: string;
  messages: { role: string; content?: string; tool_calls?: unknown[] }[];
  tools?: { function: { name: string } }[];
}
const system = (request: Request) => request.messages[0]?.content ?? '';
const isWorker = (request: Request) => system(request).startsWith('You are a worker agent');
const tools = (request: Request) => request.tools?.map(tool => tool.function.name) ?? [];
function reply(text: string, call?: { name: string; input: Record<string, unknown> }, index = 0) {
  const delta = call ? { tool_calls: [{ index: 0, id: `fixture-call-${index}`, function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : { content: text };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
}
async function settled(runtime: AgentHostRuntime) {
  await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 10_000, interval: 10 });
}

async function setup(mode: ContextOptimization, workerMode?: ContextOptimization) {
  const root = await temp('extalia-context-host-'), project = path.join(root, 'project'), data = path.join(root, 'data');
  await mkdir(project);
  const evidence = ['Decision: retain first duplicate; limit 73.',
    ...Array.from({ length: 60 }, () => `INFO polling worker ${'sample '.repeat(38)}`),
    'ERROR: the legacy fixture failed; do not repeat the external action.',
    ...Array.from({ length: 30 }, () => `INFO polling worker ${'sample '.repeat(38)}`), 'Pending: verify empty input.'].join('\n');
  await writeFile(path.join(project, 'diagnostic.log'), evidence);
  engine.script = path.join(root, 'engine-contract-fixture.mjs');
  await writeFile(engine.script, `import fs from 'node:fs';
if (process.argv[2] === 'compress') {
  const input = fs.readFileSync(0); fs.writeFileSync(process.env.CAVEMAN_CCR_DB, input, { mode: 0o600 });
  const output = input.toString().split('\\n').filter(line => /Decision:|ERROR:|Pending:/.test(line)).join('\\n');
  process.stdout.write(output);
  process.stderr.write(JSON.stringify({ basis: 'inferred', tokens_before: Math.ceil(input.length / 4), tokens_after: Math.ceil(output.length / 4),
    token_count_basis: 'approx-chars/4', method: 'log', recovery_handle: 'ccr_' + 'b'.repeat(32) }) + '\\n');
} else if (process.argv[2] === 'retrieve') process.stdout.write(fs.readFileSync(process.env.CAVEMAN_CCR_DB));
else process.exit(2);
`, { mode: 0o600 });
  const requests: Request[] = [], events: ExtaliaEvent[] = [];
  const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: path.join(root, 'home'), importHome: path.join(root, 'home'),
    env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_NATIVE_CORE: 'typescript', EXTALIA_DAEMON_PATH: DAEMON_BINARY,
      EXTALIA_HERMES_BIN: path.join(root, 'not-installed'), PATH: '' }, knowledge: { watcher: false },
    modelDiscovery: async () => ['fixture-model'], fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as Request;
      if (system(request).startsWith('Suggest useful next user prompts')) return reply('{"prompts":[]}');
      requests.push(request);
      const count = request.messages.filter(message => message.role === 'tool').length;
      if (workerMode && !isWorker(request)) return count ? reply('Combined the worker report.')
        : reply('', { name: 'delegate_task', input: { member: 'Review worker', task: 'Read diagnostic.log four times and summarize confirmed findings.' } }, requests.length);
      return count < 4 ? reply('', { name: 'read_file', input: { path: 'diagnostic.log', limit: 2000 } }, requests.length)
        : reply('Retain first duplicate and limit 73. The failed fixture and pending empty-input check remain unresolved.');
    } });
  runtimes.push(runtime); runtime.host.subscribe(event => events.push(event));
  const input = (name: string, contextOptimization: ContextOptimization): ConnectionInput => ({ name, preset: 'custom', api: 'openai-chat',
    baseUrl: 'https://example.com/v1', model: 'fixture-model', credential: { kind: 'none' }, contextOptimization,
    features: { memory: 'extalia', skills: 'off', history: true }, orchestration: { enabled: false, maxDelegations: 0, tiers: {} } });
  const connection = (await runtime.host.saveConnection(input('Fixture lead', mode))).connections[0]!;
  const workspace = (await runtime.host.saveWorkspace({ name: 'Fixture workspace', projectLocation: project, connectionId: connection.id,
    permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  const profiles = await runtime.host.listVaultProfiles!();
  await runtime.host.saveVaultProfile!({ id: profiles.defaultProfileId, name: 'Fixture memory', vaultRoot: null, workspaceIds: [workspace.id], minutesEnabled: false,
    automaticLearning: { enabled: true, skills: false, notes: false }, expectedRevision: profiles.revision });
  let team: AgentTeam | undefined;
  if (workerMode) {
    const saved = await runtime.host.saveConnection(input('Fixture worker', workerMode));
    const worker = saved.connections.find(item => item.name === 'Fixture worker')!;
    team = { enabled: true, allowedModels: ['fixture-model'], connections: [
      { connectionId: connection.id, allowedModels: ['fixture-model'] }, { connectionId: worker.id, allowedModels: ['fixture-model'] },
    ], members: [{ id: 'review-worker', name: 'Review worker', role: 'Reviewer', connectionId: worker.id, models: ['fixture-model'] }] };
  }
  const session = await runtime.host.createSession(workspace.id, team ? { team } : {});
  await runtime.host.sendPrompt(session.id, workerMode ? 'Delegate the log review to the Review worker.' : 'Read diagnostic.log four times, then report the constraints and unresolved evidence.');
  await settled(runtime);
  return { runtime, requests, events, data, root, workspace, session, connection, evidence };
}
function receipts(events: ExtaliaEvent[], agentId = 'primary') {
  return events.filter(event => event.agentId === agentId && event.body.type === 'tool.completed' && event.body.tool === 'context_optimization')
    .map(event => ({ event, report: JSON.parse(event.body.type === 'tool.completed' ? event.body.output! : '') as ContextCompactionReport }));
}

describe.skipIf(!NATIVE_CONTEXT_ARCHIVE_SUPPORTED)('connection context optimization through the production host', () => {
  it.each(['off', 'local', 'caveman'] as const)('uses the saved lead %s mode on actual provider input and persists structured receipts', async mode => {
    const f = await setup(mode === 'caveman' ? { mode, executable: process.execPath } : { mode });
    const lead = f.requests.filter(request => !isWorker(request));
    expect(lead).toHaveLength(5);
    expect(f.events.some(event => event.agentId === 'primary' && event.body.type === 'turn.completed')).toBe(true);
    expect((await f.runtime.host.getState()).connections[0]!.contextOptimization).toEqual(f.connection.contextOptimization);
    const final = lead.at(-1)!, reports = receipts(f.events);
    if (mode === 'off') {
      expect(tools(final)).not.toContain('context_archive_read');
      expect(reports).toEqual([]); expect(engine.factories).toEqual([]);
      expect(final.messages.filter(message => message.role === 'tool').every(message => message.content!.length > 20_000)).toBe(true);
    } else {
      expect(tools(final)).toContain('context_archive_read'); expect(reports.length).toBeGreaterThan(0);
      expect(JSON.stringify(final.messages)).toContain(`[Optimized tool output; method: ${mode === 'local' ? 'local:' : 'caveman:'}`);
      const transforms = reports.flatMap(item => item.report.transforms);
      expect(transforms.every(item => item.method.startsWith(`${mode === 'local' ? 'local' : 'caveman'}:`))).toBe(true);
      expect(transforms.every(item => item.projectedCharacters < item.originalCharacters)).toBe(true);
      expect(reports.every(item => item.report.estimatedTokensAfter < item.report.estimatedTokensBefore)).toBe(true);
      const persisted = await f.runtime.host.sessionEvents(f.session.id);
      expect(reports.every(item => persisted.some(event => event.id === item.event.id))).toBe(true);
      expect(JSON.stringify(reports)).not.toContain('INFO polling worker');
      if (mode === 'caveman') {
        expect(engine.factories).toEqual([process.execPath]);
        expect(engine.calls.filter(call => call[0] === 'compress').length).toBeGreaterThan(0);
        expect(engine.calls.filter(call => call[0] === 'compress').length).toBe(engine.calls.filter(call => call[0] === 'retrieve').length);
        expect(await readdir(path.join(f.data, 'workspaces', f.workspace.id, 'context-optimizer'))).toEqual([]);
      } else expect(engine.factories).toEqual([]);
    }
    for (const message of final.messages.filter(message => message.role === 'tool')) {
      expect(message.content).toContain('limit 73'); expect(message.content).toContain('legacy fixture failed'); expect(message.content).toContain('Pending: verify empty input.');
    }
  });

  it('reports a missing configured engine and continues through the verified local fallback', async () => {
    const missing = path.join(await temp(), 'missing-caveman-engine');
    const f = await setup({ mode: 'caveman', executable: missing });
    expect(f.requests).toHaveLength(5); expect(engine.calls).toEqual([]);
    const transforms = receipts(f.events).flatMap(item => item.report.transforms);
    expect(transforms.length).toBeGreaterThan(0);
    expect(transforms.every(item => item.method.startsWith('local:') && item.optimizer?.status === 'unavailable' && item.optimizer.reason === 'engine-unavailable')).toBe(true);
    expect(f.events.some(event => event.body.type === 'turn.completed')).toBe(true);
  });

  it.each(['off', 'local', 'caveman'] as const)('uses the worker connection %s mode independently of the lead connection', async mode => {
    const leadMode: ContextOptimization = mode === 'off' ? { mode: 'caveman', executable: process.execPath } : { mode: 'off' };
    const workerMode: ContextOptimization = mode === 'caveman' ? { mode, executable: process.execPath } : { mode };
    const f = await setup(leadMode, workerMode);
    const worker = f.requests.filter(isWorker), lead = f.requests.filter(request => !isWorker(request));
    expect(worker).toHaveLength(5); expect(lead).toHaveLength(2);
    expect(receipts(f.events)).toEqual([]);
    const reports = receipts(f.events, 'review-worker'), final = worker.at(-1)!;
    expect(tools(lead[0]!).includes('context_archive_read')).toBe(leadMode.mode !== 'off');
    expect(tools(final).includes('context_archive_read')).toBe(mode !== 'off');
    if (mode === 'off') {
      expect(reports).toEqual([]); expect(engine.calls).toEqual([]);
      expect(final.messages.filter(message => message.role === 'tool').every(message => message.content!.length > 20_000)).toBe(true);
    } else {
      expect(reports.length).toBeGreaterThan(0);
      expect(reports.flatMap(item => item.report.transforms).every(item => item.method.startsWith(mode === 'caveman' ? 'caveman:' : 'local:'))).toBe(true);
      expect(JSON.stringify(final.messages)).toContain('[Optimized tool output;');
      expect(engine.calls.some(call => call[0] === 'compress')).toBe(mode === 'caveman');
    }
    expect(f.events.some(event => event.agentId === 'primary' && event.body.type === 'turn.completed')).toBe(true);
  });
});
