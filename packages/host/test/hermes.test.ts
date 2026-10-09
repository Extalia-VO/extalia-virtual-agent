import type { ExtaliaEvent, EventBody } from '@extalia/protocol';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverRuntimes, hermesProfiles, hermesRoot, runHermesTurn } from '../src/hermes.js';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';

/**
 * A stand-in `hermes` executable: records its arguments, folder, prompt and
 * environment names to `$HERMES_HOME/calls.jsonl`, then prints scripted
 * stream-json lines like Hermes Agent 0.21. The real Hermes is never run.
 */
const FAKE_HERMES = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const log = entry => fs.appendFileSync(path.join(process.env.HERMES_HOME, 'calls.jsonl'), JSON.stringify(entry) + '\\n');
const out = record => process.stdout.write(JSON.stringify({ ...record, timestamp: Date.now() }) + '\\n');
const zero = { input: 0, output: 0, total: 0, cache_read: 0, cache_write: 0 };
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const session = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'fake_session_1';
  log({ args, cwd: process.cwd(), stdin: input, env: Object.keys(process.env).sort(), pid: process.pid });
  out({ type: 'system', subtype: 'init', model: 'fake/model', session_id: session });
  if (input.includes('CRASH')) {
    process.stderr.write('Traceback (most recent call last):\\nRuntimeError: the provider exploded\\n');
    process.exitCode = 2;
    return;
  }
  if (input.includes('FAIL')) {
    process.stderr.write('\\u001b[33mError: the provider rejected the request (HTTP 401)\\u001b[0m\\n');
    out({ type: 'result', session_id: session, exit_code: 1, text: '', error: 'credentials or agent init failed', tokens: zero, duration_ms: 1 });
    process.stderr.write('\\nsession_id: ' + session + '\\n');
    process.exitCode = 1;
    return;
  }
  if (input.includes('SLOW')) {
    const timer = setInterval(() => {}, 1000);
    process.on('SIGTERM', () => {
      if (input.includes('STUBBORN')) { log({ signal: 'ignored' }); return; }
      log({ signal: 'SIGTERM' });
      out({ type: 'result', session_id: session, exit_code: 130, text: '', error: 'Interrupted', tokens: zero, duration_ms: 1 });
      clearInterval(timer);
      process.exitCode = 130;
    });
    out({ type: 'tool_use', name: 'terminal', tool_call_id: 'call_slow', input: { command: 'sleep 100' } });
    return;
  }
  console.log('Some banner that is not JSON');
  out({ type: 'text', text: 'Writing' });
  out({ type: 'text', text: ' the note.' });
  const file = path.join(process.cwd(), 'notes.txt');
  out({ type: 'tool_use', name: 'write_file', tool_call_id: 'call_1', input: { path: file, content: 'hi' } });
  out({ type: 'tool_result', name: 'write_file', tool_call_id: 'call_1', output: JSON.stringify({ success: true, files_modified: [file] }), duration_ms: 3, is_error: false });
  out({ type: 'text', text: 'Done.' });
  out({ type: 'result', session_id: session, exit_code: 0, text: 'Done.', tokens: { input: 120, output: 30, total: 150, cache_read: 10, cache_write: 0 }, duration_ms: 12 });
  process.stderr.write('\\nsession_id: ' + session + '\\n');
});
`;

interface Call { args: string[]; cwd: string; stdin: string; env: string[]; pid: number; signal?: string }

const tempDir = useTempDirs();
const runtimes: AgentHostRuntime[] = [];
afterEach(async () => { while (runtimes.length) await runtimes.pop()!.close(); });

async function fakeHermes(directory: string, name = 'hermes'): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(file, FAKE_HERMES);
  await chmod(file, 0o755);
  return file;
}

async function calls(hermesHome: string): Promise<Call[]> {
  const text = await readFile(path.join(hermesHome, 'calls.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Call);
}

async function setup(options: { missingBinary?: boolean } = {}) {
  const root = await tempDir();
  const home = path.join(root, 'home'), hermesHome = path.join(home, '.hermes'), project = path.join(root, 'project'), bin = path.join(root, 'bin');
  for (const directory of [project, path.join(hermesHome, 'profiles', 'work'), bin]) await mkdir(directory, { recursive: true });
  const executable = await fakeHermes(bin);
  const env = { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH, HOME: home, HERMES_HOME: hermesHome, EXTALIA_HERMES_BIN: options.missingBinary ? path.join(bin, 'missing') : executable, SOME_API_KEY: 'not-for-hermes' };
  const runtime = await createAgentHost({ kind: 'bridge', version: '0.0.0-test', dataDirectory: path.join(root, 'data'), importHome: home, env });
  runtimes.push(runtime);
  const events: ExtaliaEvent[] = [];
  runtime.host.subscribe(event => events.push(event));
  return { root, home, hermesHome, project, bin, executable, runtime, host: runtime.host, events };
}

async function waitFor(events: ExtaliaEvent[], predicate: (event: ExtaliaEvent) => boolean, from = 0): Promise<ExtaliaEvent> {
  for (let i = 0; i < 500; i++) {
    const found = events.slice(from).find(predicate);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out; saw ${events.map(event => event.body.type).join(', ')}`);
}

const ended = (sessionId: string) => (event: ExtaliaEvent) => event.sessionId === sessionId && event.body.type === 'agent.state' && event.body.state === 'idle';
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function idle(runtime: AgentHostRuntime) {
  for (let i = 0; i < 300 && runtime.isBusy(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(runtime.isBusy()).toBe(false);
}

async function hermesWorkspace(host: AgentHostRuntime['host'], project: string, extra: { runtimeModel?: string; permissions?: { fileWrite: 'ask' | 'allow'; commands: 'ask' | 'allow' } } = {}) {
  const state = await host.saveWorkspace({ name: 'Project', projectLocation: project, runtimeId: 'hermes', runtimeProfileId: 'work', permissions: extra.permissions ?? { fileWrite: 'ask', commands: 'ask' }, ...(extra.runtimeModel ? { runtimeModel: extra.runtimeModel } : {}) });
  return state.workspaces[0]!;
}

describe('Hermes Agent discovery', () => {
  it('finds the executable without a shell and lists profile names only', async () => {
    const root = await tempDir();
    const home = path.join(root, 'home'), hermes = path.join(home, '.hermes'), bin = path.join(root, 'bin');
    for (const name of ['beta', 'alpha', 'Not Valid', '.deleted']) await mkdir(path.join(hermes, 'profiles', name), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(hermes, 'profiles', 'notes.txt'), 'not a profile');
    expect(await hermesProfiles({}, home)).toEqual(['default', 'alpha', 'beta']);
    expect(await hermesProfiles({ HERMES_HOME: path.join(root, 'missing') }, home)).toEqual(['default']);
    // A HERMES_HOME that names a profile resolves to the Hermes root.
    expect(hermesRoot({ HERMES_HOME: path.join(hermes, 'profiles', 'alpha') }, home)).toBe(hermes);

    expect(await discoverRuntimes({ PATH: bin }, home)).toEqual([
      { id: 'extalia-native', available: true, profiles: [] },
      { id: 'hermes', available: false, profiles: [] },
    ]);
    await fakeHermes(bin);
    expect((await discoverRuntimes({ PATH: bin }, home))[1]).toEqual({ id: 'hermes', available: true, profiles: ['default', 'alpha', 'beta'] });
    // An explicit override wins and must be an executable file.
    const plain = path.join(root, 'plain');
    await writeFile(plain, 'not executable');
    expect((await discoverRuntimes({ PATH: bin, EXTALIA_HERMES_BIN: plain }, home))[1]?.available).toBe(false);
    // Apps launched from the Dock have no shell PATH; the per-user install folder is still found.
    expect((await discoverRuntimes({ PATH: '/nonexistent' }, home))[1]?.available).toBe(false);
    await mkdir(path.join(home, '.local', 'bin'), { recursive: true });
    await fakeHermes(path.join(home, '.local', 'bin'));
    expect((await discoverRuntimes({ PATH: '/nonexistent' }, home))[1]?.available).toBe(true);
  });
});

describe('Hermes Agent workspaces', () => {
  it('needs no model connection and validates the profile and model', async () => {
    const { host, project } = await setup();
    expect((await host.runtimes()).find(item => item.id === 'hermes')).toEqual({ id: 'hermes', available: true, profiles: ['default', 'work'] });
    await expect(host.saveWorkspace({ name: 'Native', projectLocation: project, permissions: { fileWrite: 'ask', commands: 'ask' } })).rejects.toThrow(/connection/);
    await expect(host.saveWorkspace({ name: 'Bad', projectLocation: project, runtimeId: 'hermes', runtimeProfileId: 'Bad Name', permissions: { fileWrite: 'ask', commands: 'ask' } })).rejects.toThrow(/profile/);
    await expect(host.saveWorkspace({ name: 'Bad', projectLocation: project, runtimeId: 'hermes', runtimeModel: '--yolo', permissions: { fileWrite: 'ask', commands: 'ask' } })).rejects.toThrow(/model/);
    await expect(host.saveWorkspace({ name: 'Bad', projectLocation: project, runtimeId: 'other' as 'hermes', permissions: { fileWrite: 'ask', commands: 'ask' } })).rejects.toThrow(/Hermes/);

    const state = await host.saveWorkspace({ name: 'Project', projectLocation: project, runtimeId: 'hermes', connectionId: 'ignored', runtimeModel: ' example/model ', permissions: { fileWrite: 'ask', commands: 'ask' } });
    expect(state.workspaces[0]).toMatchObject({ runtimeId: 'hermes', runtimeProfileId: 'default', runtimeModel: 'example/model' });
    expect(state.workspaces[0]?.providerProfileId).toBeUndefined();
    expect((await host.completeSetup()).setupComplete).toBe(true);
    expect((await host.setWorkflow('managed')).setupComplete).toBe(true);
  });

  it('runs prompts through hermes, streams protocol events and resumes the Hermes session', async () => {
    const { runtime, host, events, project, hermesHome } = await setup();
    const workspace = await hermesWorkspace(host, project);
    await host.completeSetup();
    const session = await host.createSession(workspace.id);
    expect(session).toMatchObject({ connectionId: '', runtime: { id: 'hermes', profile: 'work' } });

    await host.sendPrompt(session.id, 'Write a note');
    expect(runtime.isBusy()).toBe(true);
    await expect(host.sendPrompt(session.id, 'again')).rejects.toThrow(/still working/);
    await waitFor(events, ended(session.id));
    await idle(runtime);

    const stored = await host.sessionEvents(session.id);
    expect(stored.map(event => event.body.type)).toEqual([
      'session.started', 'prompt.submitted', 'agent.state', 'model.delta', 'model.delta', 'agent.state', 'tool.started',
      'file.written', 'tool.completed', 'agent.state', 'model.delta', 'model.completed', 'turn.completed', 'agent.state',
    ]);
    expect(stored.every(event => event.source.runtime === 'hermes' && event.source.channel === 'stream')).toBe(true);
    expect(stored.every((event, index) => event.seq === index)).toBe(true);
    const bodies = stored.map(event => event.body);
    expect(bodies.filter(body => body.type === 'session.started')).toHaveLength(1);
    expect(bodies).toContainEqual({ type: 'file.written', path: 'notes.txt', change: 'update' });
    expect(bodies).toContainEqual({ type: 'turn.completed', model: 'fake/model', usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 10 } });
    expect(bodies.at(-1)).toEqual({ type: 'agent.state', state: 'idle' });

    const [first] = await calls(hermesHome);
    const folder = workspace.projectLocation!;
    expect(first!.args).toEqual(['-p', 'work', 'chat', '--query-file', '-', '--oneshot', '--format', 'stream-json', '--source', 'extalia', '--in', folder]);
    expect(first!.cwd).toBe(folder);
    expect(first!.stdin).toBe('Write a note');
    // A minimal environment: no Extalia settings or unrelated secrets.
    expect(first!.env).toEqual(expect.arrayContaining(['HERMES_HOME', 'HOME', 'PATH']));
    expect(first!.env.filter(name => name.startsWith('EXTALIA_') || name === 'SOME_API_KEY')).toEqual([]);

    const after = (await host.getState()).sessions.find(item => item.id === session.id);
    expect(after).toMatchObject({ title: 'Write a note', running: false, runtime: { id: 'hermes', profile: 'work', sessionId: 'fake_session_1' } });

    const mark = events.length;
    await host.sendPrompt(session.id, 'And another');
    await waitFor(events, ended(session.id), mark);
    expect((await calls(hermesHome))[1]!.args).toEqual(expect.arrayContaining(['--resume', 'fake_session_1']));
    const all = await host.sessionEvents(session.id);
    expect(new Set(all.map(event => event.id)).size).toBe(all.length);
    expect(all.filter(event => event.body.type === 'turn.completed')).toHaveLength(2);
  });

  it('passes the model and bypasses Hermes approvals only when the workspace allows everything', async () => {
    const { runtime, host, events, project, hermesHome } = await setup();
    const careful = await hermesWorkspace(host, project, { runtimeModel: 'example/model', permissions: { fileWrite: 'allow', commands: 'ask' } });
    const session = await host.createSession(careful.id);
    await host.sendPrompt(session.id, 'one');
    await waitFor(events, ended(session.id));
    await idle(runtime);
    expect((await calls(hermesHome))[0]!.args).toEqual(expect.arrayContaining(['--model=example/model']));
    expect((await calls(hermesHome))[0]!.args).not.toContain('--yolo');

    await host.saveWorkspace({ id: careful.id, name: 'Project', projectLocation: project, runtimeId: 'hermes', runtimeProfileId: 'work', permissions: { fileWrite: 'allow', commands: 'allow' } });
    const mark = events.length;
    await host.sendPrompt(session.id, 'two');
    await waitFor(events, ended(session.id), mark);
    expect((await calls(hermesHome))[1]!.args).toContain('--yolo');
  });

  it('refuses a prompt while Hermes is not installed', async () => {
    const { runtime, host, project } = await setup({ missingBinary: true });
    expect((await host.runtimes()).find(item => item.id === 'hermes')).toEqual({ id: 'hermes', available: false, profiles: [] });
    const session = await host.createSession((await hermesWorkspace(host, project)).id);
    await expect(host.sendPrompt(session.id, 'hello')).rejects.toThrow(/EXTALIA_HERMES_BIN/);
    expect(runtime.isBusy()).toBe(false);
    expect((await host.sessionEvents(session.id)).map(event => event.body.type)).toEqual(['session.started']);
  });

  it('reports a failed run with Hermes’ own error text', async () => {
    const { runtime, host, events, project } = await setup();
    const session = await host.createSession((await hermesWorkspace(host, project)).id);
    await host.sendPrompt(session.id, 'FAIL please');
    const failed = await waitFor(events, event => event.sessionId === session.id && event.body.type === 'turn.failed');
    const error = (failed.body as Extract<EventBody, { type: 'turn.failed' }>).error;
    expect(error).toContain('credentials or agent init failed');
    expect(error).toContain('the provider rejected the request (HTTP 401)');
    expect(error).not.toContain('\u001b[');
    expect(error).not.toContain('session_id:');
    await waitFor(events, ended(session.id));
    await idle(runtime);
    // Hermes never worked on the session, so there is nothing to resume.
    expect((await host.getState()).sessions.find(item => item.id === session.id)?.runtime?.sessionId).toBeUndefined();

    const mark = events.length;
    await host.sendPrompt(session.id, 'CRASH now');
    const crashed = await waitFor(events, event => event.sessionId === session.id && event.body.type === 'turn.failed', mark);
    expect((crashed.body as Extract<EventBody, { type: 'turn.failed' }>).error).toMatch(/exited with code 2[\s\S]*the provider exploded/);
  });

  it('stops a running Hermes process on cancel and when the host closes', async () => {
    const { runtime, host, events, project, hermesHome } = await setup();
    const session = await host.createSession((await hermesWorkspace(host, project)).id);
    await host.sendPrompt(session.id, 'SLOW work');
    await waitFor(events, event => event.sessionId === session.id && event.body.type === 'tool.started');
    const { pid } = (await calls(hermesHome))[0]!;
    expect(alive(pid)).toBe(true);
    await host.cancel(session.id);
    const failed = await waitFor(events, event => event.sessionId === session.id && event.body.type === 'turn.failed');
    expect(failed.body).toEqual({ type: 'turn.failed', error: 'Stopped by the user.' });
    await idle(runtime);
    expect(alive(pid)).toBe(false);
    expect((await calls(hermesHome)).some(call => call.signal === 'SIGTERM')).toBe(true);
    const types = (await host.sessionEvents(session.id)).map(event => event.body.type);
    expect(types).toEqual(expect.arrayContaining(['user.intervention', 'turn.failed']));
    expect(types).not.toContain('turn.completed');

    const mark = events.length;
    await host.sendPrompt(session.id, 'SLOW again');
    await waitFor(events, event => event.sessionId === session.id && event.body.type === 'tool.started', mark);
    const second = (await calls(hermesHome)).filter(call => call.pid).at(-1)!.pid;
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    expect(alive(second)).toBe(false);
  });

  it('carries a continued conversation into the first Hermes prompt', async () => {
    const { runtime, host, events, project, hermesHome } = await setup();
    const workspace = await hermesWorkspace(host, project);
    const at = (minute: number) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
    const imported = await host.importPortable(JSON.stringify({
      format: 'extalia.session.v1', title: 'Fix the login bug', importMode: 'imported',
      provenance: { sourceId: 'codex', sourceSessionId: 'rollout-1', exportedAt: at(9) },
      messages: [
        { index: 0, role: 'user', content: 'Fix the login bug', createdAt: at(0) },
        { index: 1, role: 'assistant', content: 'Found it in auth.ts.', createdAt: at(1) },
      ],
      startedAt: at(0), lastMessageAt: at(1),
    }));
    const session = await host.continueSession({ kind: 'library', id: imported.state.library[0]!.id }, workspace.id);
    await host.sendPrompt(session.id, 'Please continue');
    await waitFor(events, ended(session.id));
    await idle(runtime);
    const stdin = (await calls(hermesHome))[0]!.stdin;
    expect(stdin).toContain('started in Codex');
    expect(stdin).toContain('Found it in auth.ts.');
    expect(stdin.endsWith('Please continue')).toBe(true);

    const mark = events.length;
    await host.sendPrompt(session.id, 'Next');
    await waitFor(events, ended(session.id), mark);
    expect((await calls(hermesHome))[1]!.stdin).toBe('Next');
  });
});

describe('runHermesTurn', () => {
  it('kills a Hermes process that ignores SIGTERM after the grace period', async () => {
    const root = await tempDir();
    const executable = await fakeHermes(root);
    const bodies: EventBody[] = [];
    const controller = new AbortController();
    const turn = runHermesTurn({
      executable, cwd: root, prompt: 'SLOW STUBBORN', profile: 'default', yolo: false, killGraceMs: 200,
      env: { PATH: process.env.PATH, HERMES_HOME: root }, signal: controller.signal, emit: body => { bodies.push(body); },
    });
    for (let i = 0; i < 300 && !bodies.some(body => body.type === 'tool.started'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const { pid } = (await calls(root))[0]!;
    controller.abort();
    expect(await turn).toEqual({ outcome: 'cancelled', sessionId: 'fake_session_1' });
    expect((await calls(root)).some(call => call.signal === 'ignored')).toBe(true);
    expect(alive(pid)).toBe(false);
    expect(bodies.slice(-2)).toEqual([{ type: 'turn.failed', error: 'Stopped by the user.' }, { type: 'agent.state', state: 'idle' }]);
  });

  it('fails cleanly when the executable cannot be started', async () => {
    const root = await tempDir();
    const bodies: EventBody[] = [];
    const result = await runHermesTurn({
      executable: path.join(root, 'missing-hermes'), cwd: root, prompt: 'hi', profile: 'default', yolo: false,
      env: {}, signal: new AbortController().signal, emit: body => { bodies.push(body); },
    });
    expect(result).toEqual({ outcome: 'failed' });
    expect(bodies.at(-2)).toMatchObject({ type: 'turn.failed', error: expect.stringContaining('could not be started') });
  });
});
