import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostMissionRun } from '@extalia/platform';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { backendEnv, backendOptions, backends, type Backend } from './daemonBackend.js';
import { useTempDirs } from './helpers.js';

// Write-capable mission workers through the real host (ADR 0028), with scripted provider replies
// and a fresh `git init` repository in a temporary folder.
const tempDir = useTempDirs();
const PROCESS_TEST_TIMEOUT_MS = 60_000;
const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();
const runtimes: AgentHostRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); });

type Message = { role: string; content?: string | null; tool_call_id?: string };
type Body = { model: string; messages: Message[]; tools?: { function?: { name: string } }[] };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const reply = (text: string) => Response.json({ model: 'model-a', choices: [{ message: { content: text }, finish_reason: 'stop' }] });
const calls = (...items: { name: string; input: Record<string, unknown> }[]) => Response.json({ model: 'model-a', choices: [{ message: { content: '', tool_calls: items.map((item, index) => ({ id: `call-${index}`, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.input) } })) }, finish_reason: 'tool_calls' }] });

async function setup(fetch: (body: Body) => Promise<Response>, backend: Backend = 'typescript') {
  const root = await tempDir('extalia-mission-worktrees-');
  const project = path.join(root, 'project'), home = path.join(root, 'home'), data = path.join(root, 'data');
  await mkdir(project, { recursive: true }); await mkdir(home, { recursive: true });
  const gitEnv = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: project, env: gitEnv, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  await writeFile(path.join(project, 'README.md'), 'base\n');
  await writeFile(path.join(project, 'shared.txt'), 'one\ntwo\nthree\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const runtime = await createAgentHost({
    kind: 'bridge', version: '0.0.0-test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000,
    env: { EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: process.env.PATH, MISSION_KEY_A: 'opaque-secret-a-value', ...backendEnv(backend) },
    fetch: async (_url, init) => fetch(JSON.parse(String(init?.body)) as Body), ...backendOptions(backend),
  });
  runtimes.push(runtime);
  const state = await runtime.host.saveConnection({ name: 'Provider A', preset: 'custom', api: 'openai-chat', baseUrl: 'https://a.example.com/v1', model: 'model-a', credential: { kind: 'env', variable: 'MISSION_KEY_A' }, features: { memory: 'off', skills: 'off', history: true } });
  const connection = state.connections[0]!;
  const workspace = (await runtime.host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: connection.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  const session = await runtime.host.createSession(workspace.id);
  return { root, project, data, git, runtime, host: runtime.host, worktrees: runtime.worktrees!, connection, session };
}

async function settled(runtime: AgentHostRuntime, sessionId: string, missionId: string): Promise<HostMissionRun> {
  for (let n = 0; n < 600; n++) {
    const run = await runtime.host.nativeMissionRun(sessionId, missionId);
    if (run.state !== 'running' && !runtime.isBusy()) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Mission did not settle.');
}

const task = (name: string, prompt: string) => (body: Body) => body.messages.some(message => message.role === 'user' && message.content?.includes(prompt)) ? name : undefined;

describe.skipIf(!hasGit)('write-capable mission workers (ADR 0028)', { timeout: PROCESS_TEST_TIMEOUT_MS }, () => {
  // With the Rust core, the daemon decides the worktree writes (permission.check) and journals the run.
  it.each(backends())('runs two writers in parallel in their own worktrees, never in the checkout, and integrates through the queue (%s core)', async backend => {
    const both = deferred(), entered = new Set<string>();
    const offered = new Map<string, string[]>(), results = new Map<string, string[]>();
    let project = '';
    const env = await setup(async body => {
      const name = task('alpha', 'TASK alpha')(body) ?? task('beta', 'TASK beta')(body) ?? 'reader';
      offered.set(name, (body.tools ?? []).map(tool => tool.function!.name).sort());
      const toolResults = body.messages.filter(message => message.role === 'tool').map(message => String(message.content));
      if (toolResults.length) { results.set(name, toolResults); return reply(`${name} done`); }
      if (name !== 'reader') { entered.add(name); if (entered.size === 2) both.resolve(); await both.promise; }
      if (name === 'alpha') return calls(
        { name: 'edit_file', input: { path: 'shared.txt', old_text: 'two', new_text: 'two from alpha' } },
        { name: 'write_file', input: { path: path.join(project, 'escape.txt'), content: 'escaped' } },
        { name: 'write_file', input: { path: '../project/escape.txt', content: 'escaped' } },
      );
      if (name === 'beta') return calls({ name: 'edit_file', input: { path: 'shared.txt', old_text: 'two', new_text: 'two from beta' } }, { name: 'write_file', input: { path: 'beta.txt', content: 'beta\n' } });
      return calls({ name: 'read_file', input: { path: 'README.md' } });
    }, backend);
    project = env.project;
    const started = await env.host.startNativeMission(env.session.id, { title: 'Parallel writers', maxConcurrency: 3, tasks: [
      { id: 'alpha', title: 'Alpha', instructions: 'TASK alpha', connectionId: env.connection.id, model: 'model-a', dependsOn: [], access: 'write' },
      { id: 'beta', title: 'Beta', instructions: 'TASK beta', connectionId: env.connection.id, model: 'model-a', dependsOn: [], access: 'write' },
      { id: 'reader', title: 'Reader', instructions: 'TASK reader', connectionId: env.connection.id, model: 'model-a', dependsOn: [] },
    ] });
    const run = await settled(env.runtime, env.session.id, started.id);
    expect(run.state).toBe('completed');
    // Edits reach the journal and the Office projection as bounded, worktree-relative activity only.
    expect(run.tasks.filter(item => item.access === 'write').map(item => item.id).sort()).toEqual(['alpha', 'beta']);
    const events = (await env.host.sessionEvents(env.session.id)).filter(event => event.correlationId === started.id);
    expect(events.flatMap(event => event.body.type === 'subagent.spawned' ? [event.body.role] : []).sort()).toEqual(['read-only-worker', 'write-worker', 'write-worker']);
    const alphaAgent = run.tasks.find(item => item.id === 'alpha')!.agentId;
    const alphaEdits = events.filter(event => event.agentId === alphaAgent && event.body.type === 'tool.started' && event.body.kind === 'edit').map(event => event.body);
    expect(alphaEdits).toEqual([
      { type: 'tool.started', tool: 'edit_file', kind: 'edit', label: 'edit_file', target: 'shared.txt' },
      // Paths that are absolute or leave the worktree are journaled without a target.
      { type: 'tool.started', tool: 'write_file', kind: 'edit', label: 'write_file' },
      { type: 'tool.started', tool: 'write_file', kind: 'edit', label: 'write_file' },
    ]);
    expect(events.some(event => event.agentId === alphaAgent && event.body.type === 'agent.state' && event.body.activity === 'edit')).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/two from alpha|escaped|escape\.txt/);
    expect(offered.get('alpha')).toEqual(['edit_file', 'list_files', 'read_file', 'search_files', 'write_file']);
    expect(offered.get('beta')).toEqual(['edit_file', 'list_files', 'read_file', 'search_files', 'write_file']);
    expect(offered.get('reader')).toEqual(['list_files', 'read_file', 'search_files']);
    // Writes inside the worktree ran without a per-call approval; escapes were refused by the tool root.
    expect(results.get('alpha')![0]).toMatch(/^Edited shared\.txt/);
    expect(results.get('alpha')!.slice(1).every(output => /outside the workspace/.test(output))).toBe(true);
    // The user's checkout is untouched.
    expect(existsSync(path.join(env.project, 'escape.txt'))).toBe(false);
    expect(existsSync(path.join(env.project, 'beta.txt'))).toBe(false);
    expect(await readFile(path.join(env.project, 'shared.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect(env.git('status', '--porcelain')).toBe('');
    // Each writer's work was committed on its own branch when its task ended.
    const records = await env.worktrees.list();
    expect(records).toHaveLength(2);
    // The renderer path (AgentHostApi) sees the same records and refuses unvalidated input.
    expect(await env.host.listWorktrees!()).toEqual(records);
    await expect(env.host.applyIntegration!('i-000000000000', { diffDigest: 'latest' })).rejects.toThrow(/diff digest/);
    expect(records.every(record => record.state === 'released' && record.owner.missionId === started.id && record.head !== record.baseCommit)).toBe(true);
    const byTask = new Map(records.map(record => [run.tasks.find(item => item.taskId === record.owner.taskId)!.id, record]));
    expect(await readFile(path.join(byTask.get('alpha')!.path, 'shared.txt'), 'utf8')).toBe('one\ntwo from alpha\nthree\n');
    expect(await readFile(path.join(byTask.get('beta')!.path, 'beta.txt'), 'utf8')).toBe('beta\n');
    expect(await env.worktrees.orphans()).toEqual([]);
    // Integration: alpha merges cleanly after its gate; beta then conflicts on the same line.
    const gate = { command: 'node -e "process.exit(0)"', timeoutSeconds: 60 };
    const alpha = await env.worktrees.propose(byTask.get('alpha')!.id, { gate });
    expect(alpha.status).toBe('ready');
    await env.worktrees.apply(alpha.id, { diffDigest: alpha.diffDigest! });
    expect(await readFile(path.join(env.project, 'shared.txt'), 'utf8')).toBe('one\ntwo from alpha\nthree\n');
    const beta = await env.worktrees.propose(byTask.get('beta')!.id, { gate });
    expect(beta).toMatchObject({ status: 'conflict', conflicts: ['shared.txt'] });
    expect(existsSync(path.join(env.project, 'beta.txt'))).toBe(false);
  });

  it('keeps default missions read-only and refuses write-capable tasks without a Git repository or history', async () => {
    const env = await setup(async () => reply('done'));
    const plain = path.join(env.root, 'plain');
    await mkdir(plain);
    const workspace = (await env.host.saveWorkspace({ name: 'Plain', projectLocation: plain, connectionId: env.connection.id, permissions: { fileWrite: 'allow', commands: 'ask' } })).workspaces.find(item => item.name === 'Plain')!;
    const session = await env.host.createSession(workspace.id);
    const writer = { id: 'writer', title: 'Writer', instructions: 'Write.', connectionId: env.connection.id, model: 'model-a', dependsOn: [], access: 'write' as const };
    await expect(env.host.startNativeMission(session.id, { title: 'No git', tasks: [writer] })).rejects.toThrow(/Git repository/);
    expect(existsSync(path.join(env.data, 'worktrees')) ? await env.worktrees.list() : []).toEqual([]);
    expect(env.runtime.isBusy()).toBe(false);
    // A read-only mission in the same folder still runs and creates no worktree.
    const started = await env.host.startNativeMission(session.id, { title: 'Read only', tasks: [{ ...writer, access: 'read' }] });
    expect((await settled(env.runtime, session.id, started.id)).state).toBe('completed');
    expect(await env.worktrees.list()).toEqual([]);
    await expect(env.host.startNativeMission(session.id, { title: 'Bad', tasks: [{ ...writer, access: 'admin' as 'write' }] })).rejects.toThrow();
  });

  it('runs the workspace integration gate when the request names none; without one the proposal stays gate_missing', async () => {
    const env = await setup(async body => {
      if (body.messages.some(message => message.role === 'tool')) return reply('done');
      return calls({ name: 'write_file', input: { path: 'gated.txt', content: 'gated\n' } });
    });
    const started = await env.host.startNativeMission(env.session.id, { title: 'Gated', tasks: [
      { id: 'writer', title: 'Writer', instructions: 'TASK writer', connectionId: env.connection.id, model: 'model-a', dependsOn: [], access: 'write' },
    ] });
    expect((await settled(env.runtime, env.session.id, started.id)).state).toBe('completed');
    const [record] = await env.worktrees.list();
    // No gate anywhere: merged but never approvable (there is no ungated integration).
    const missing = await env.host.proposeIntegration!(record!.id);
    expect(missing).toMatchObject({ status: 'gate_missing' });
    expect(missing.gate).toBeUndefined();
    expect(missing.gateSource).toBeUndefined();
    await expect(env.host.applyIntegration!(missing.id, { diffDigest: missing.diffDigest! })).rejects.toThrow(/test gate/);
    // The workspace setting runs (with its own timeout) when the request has no gate.
    const workspace = (await env.host.getState()).workspaces[0]!;
    await env.host.saveWorkspace({ id: workspace.id, name: workspace.name, projectLocation: env.project, connectionId: env.connection.id, permissions: { fileWrite: 'ask', commands: 'ask' },
      integrationGate: { command: 'node -e "process.exit(0)"', timeoutSeconds: 60 } });
    const fromWorkspace = await env.host.proposeIntegration!(record!.id, { targetBranch: 'main' });
    expect(fromWorkspace).toMatchObject({ status: 'ready', gateSource: 'workspace', gate: { command: 'node -e "process.exit(0)"', exitCode: 0, ok: true } });
    // A gate in the request wins over the workspace setting.
    const fromRequest = await env.worktrees.propose(record!.id, { gate: { command: 'node -e "process.exit(3)"', timeoutSeconds: 60 } });
    expect(fromRequest).toMatchObject({ status: 'gate_failed', gateSource: 'request', gate: { exitCode: 3, ok: false } });
    // The source is persisted with the proposal.
    expect((await env.host.integrationProposals!()).map(item => item.gateSource)).toEqual([undefined, 'workspace', 'request']);
    await env.host.applyIntegration!(fromWorkspace.id, { diffDigest: fromWorkspace.diffDigest! });
    expect(await readFile(path.join(env.project, 'gated.txt'), 'utf8')).toBe('gated\n');
  });
});
