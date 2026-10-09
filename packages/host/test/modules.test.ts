import { createEvent } from '@extalia/protocol';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireHostLock } from '../src/lock.js';
import { MemoryStore, createMemoryTools } from '../src/memory.js';
import {
  FileSecretStore, MacKeychainStore, MemorySecretStore, SecretServiceStore, createSecretStore, resolveCredential, type CommandRunner,
} from '../src/secrets.js';
import { SessionStore, newSessionId } from '../src/sessions.js';
import { createSkillTools, loadSkills } from '../src/skills.js';
import { CANCELLED_EXIT_CODE, TIMEOUT_EXIT_CODE, commandEnvironment, commandKind, commandRisk, createCommandTool } from '../src/tools/command.js';
import { runTool, useTempDirs } from './helpers.js';

const temp = useTempDirs();
const posix = process.platform !== 'win32';

describe('secret stores', () => {
  it('passes keychain secrets on stdin, never as arguments', async () => {
    const calls: { command: string; args: readonly string[]; stdin?: string }[] = [];
    const run: CommandRunner = async (command, args, stdin) => {
      calls.push({ command, args, ...(stdin !== undefined ? { stdin } : {}) });
      return args[0] === 'find-generic-password' ? { code: 44, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' };
    };
    const store = new MacKeychainStore({ run, securityPath: '/usr/bin/security' });
    await store.set('connection-1', 'sk-abc123'); // extalia-allow-secret
    expect(calls[0]?.args).toEqual(['-i']);
    expect(calls[0]?.stdin).toContain('add-generic-password -U -s "Extalia" -a "connection-1" -w "sk-abc123"'); // extalia-allow-secret
    expect(calls.flatMap(call => call.args).join(' ')).not.toContain('sk-abc123'); // extalia-allow-secret
    expect(await store.get('connection-1')).toBeUndefined();
    await expect(store.set('connection-1', 'has space')).rejects.toThrow();
    await expect(store.set('connection-1', 'quote"inside')).rejects.toThrow();
  });

  it('stores Secret Service secrets through stdin', async () => {
    const calls: { args: readonly string[]; stdin?: string }[] = [];
    const store = new SecretServiceStore({ run: async (_command, args, stdin) => { calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) }); return { code: 0, stdout: 'value\n', stderr: '' }; } });
    await store.set('ref-1', 'token-value');
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['store', 'service', 'Extalia', 'account', 'ref-1']));
    expect(calls[0]?.stdin).toBe('token-value');
    expect(await store.get('ref-1')).toBe('value');
  });

  it.skipIf(!posix)('keeps the file store private', async () => {
    const dir = await temp();
    const file = path.join(dir, 'state', 'secrets.json');
    const store = new FileSecretStore(file);
    await store.set('a', 'one');
    expect(await store.get('a')).toBe('one');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await store.delete('a');
    expect(await store.get('a')).toBeUndefined();
  });

  it('honors the store override and resolves credentials from every source', async () => {
    const dir = await temp();
    expect((await createSecretStore({ stateDirectory: dir, platform: 'linux', env: { EXTALIA_SECRET_STORE: 'memory' } })).kind).toBe('memory');
    expect((await createSecretStore({ stateDirectory: dir, platform: 'linux', env: { EXTALIA_SECRET_STORE: 'file', PATH: '' } })).kind).toBe('file');
    const store = new MemorySecretStore();
    await store.set('ref', 'stored');
    expect(await resolveCredential({ kind: 'stored', ref: 'ref' }, store, {})).toBe('stored');
    expect(await resolveCredential({ kind: 'env', variable: 'API_KEY_X' }, store, { API_KEY_X: 'from-env' })).toBe('from-env');
    expect(await resolveCredential({ kind: 'none' }, store, {})).toBeUndefined();
  });
});

describe('run_command', () => {
  it('removes credentials from the environment and classifies commands', () => {
    const env = commandEnvironment({ PATH: '/bin', HOME: '/home/someone', OPENAI_API_KEY: 'x', GITHUB_TOKEN: 'y', MY_SECRET: 'z', LANG: 'C' });
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/home/someone', LANG: 'C' });
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining(['OPENAI_API_KEY']));
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.MY_SECRET).toBeUndefined();
    expect(commandKind('pnpm test')).toBe('test');
    expect(commandKind('ls -la')).toBe('command');
    expect(commandRisk('rm -rf build')).toBe('high');
    expect(commandRisk('git push origin main')).toBe('high');
    expect(commandRisk('ls')).toBe('medium');
  });

  it.skipIf(!posix)('captures output and exit codes and hides credentials from the command', async () => {
    const root = await temp();
    const tools = [createCommandTool(root, { env: { PATH: process.env.PATH, SERVICE_TOKEN: 'hidden-value' }, outputIntervalMs: 0 })];
    const ok = await runTool(tools, 'run_command', { command: 'echo hello; echo "token:${SERVICE_TOKEN:-none}"' });
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain('hello');
    expect(ok.output).toContain('token:none');
    expect(ok.output).toMatch(/exit code 0/);
    expect(ok.events.map(event => event.type)).toEqual(expect.arrayContaining(['command.started', 'command.completed']));
    const failing = await runTool(tools, 'run_command', { command: 'exit 3' });
    expect(failing).toMatchObject({ ok: false });
    expect(failing.events.find(event => event.type === 'command.completed')).toMatchObject({ exitCode: 3 });
  });

  it.skipIf(!posix)('stops commands that time out or are cancelled, with their children', async () => {
    const root = await temp();
    const tools = [createCommandTool(root, { env: { PATH: process.env.PATH }, killGraceMs: 200 })];
    const started = Date.now();
    const timedOut = await runTool(tools, 'run_command', { command: 'sleep 30 & sleep 30; wait', timeout_seconds: 1 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(timedOut.events.find(event => event.type === 'command.completed')).toMatchObject({ exitCode: TIMEOUT_EXIT_CODE });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const cancelled = await runTool(tools, 'run_command', { command: 'sleep 30' }, controller.signal);
    expect(cancelled.events.find(event => event.type === 'command.completed')).toMatchObject({ exitCode: CANCELLED_EXIT_CODE });
  });
});

describe('memory', () => {
  it('stores notes with masked credentials and validates names', async () => {
    const store = new MemoryStore(path.join(await temp(), 'memory'));
    await store.write('stack', 'Frontend is Vue.\napi_key=abcdef123456');
    expect(await store.read('stack')).toContain('api_key=[redacted]');
    expect((await store.list())[0]).toMatchObject({ name: 'stack', summary: 'Frontend is Vue.' });
    await expect(store.write('Bad Name', 'x')).rejects.toThrow();
    const tools = createMemoryTools(store);
    expect((await runTool(tools, 'memory_list', {})).output).toContain('stack');
    await store.delete('stack');
    expect(await store.list()).toEqual([]);
  });
});

describe('skills', () => {
  it('loads built-ins and lets user and workspace skills override them', async () => {
    const dir = await temp();
    const user = path.join(dir, 'skills');
    const workspace = path.join(dir, 'project');
    await mkdir(path.join(user, 'code-review'), { recursive: true });
    await writeFile(path.join(user, 'code-review', 'SKILL.md'), '---\nname: code-review\ndescription: Team review rules\n---\nCheck tests first.');
    await mkdir(path.join(workspace, '.extalia', 'skills', 'deploy'), { recursive: true });
    await writeFile(path.join(workspace, '.extalia', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Ship it\n---\nRun the deploy script.');
    await mkdir(path.join(user, 'broken'), { recursive: true });
    await writeFile(path.join(user, 'broken', 'SKILL.md'), 'no front matter');
    const loaded = await loadSkills({ userDirectory: user, workspaceRoot: workspace });
    const byName = Object.fromEntries(loaded.skills.map(skill => [skill.name, skill]));
    expect(byName['code-review']).toMatchObject({ source: 'user', description: 'Team review rules' });
    expect(byName.deploy).toMatchObject({ source: 'workspace' });
    expect(byName['write-tests']).toMatchObject({ source: 'builtin' });
    const read = await runTool(createSkillTools(loaded.skills), 'skill_read', { name: 'deploy' });
    expect(read.output).toContain('Run the deploy script.');
  });
});

describe('sessions', () => {
  it('round-trips records, events and messages and skips invalid event lines', async () => {
    const directory = path.join(await temp(), 'sessions');
    const store = new SessionStore(directory);
    const id = newSessionId();
    const stamp = '2026-01-31T10:00:00.000Z';
    await store.create({ id, workspaceId: 'w', connectionId: 'c', title: 'T', createdAt: stamp, lastActiveAt: stamp });
    await store.appendEvent(id, createEvent({ sessionId: id, agentId: 'primary', source: { runtime: 'demo', channel: 'system' }, body: { type: 'agent.state', state: 'idle' } }));
    await writeFile(path.join(directory, `${id}.events.jsonl`), '{broken\n', { flag: 'a' });
    expect((await store.readEvents(id)).map(event => event.body.type)).toEqual(['agent.state']);
    await store.writeMessages(id, [{ role: 'user', text: 'hi' }]);
    expect(await store.readMessages(id)).toEqual([{ role: 'user', text: 'hi' }]);
    await store.update(id, { title: 'Renamed' });
    expect((await store.get(id))?.title).toBe('Renamed');
    await store.remove(id);
    expect(await store.list()).toEqual([]);
    await expect(store.get('../escape')).rejects.toThrow();
  });
});

describe('host lock', () => {
  it('refuses a second live host and replaces stale locks', async () => {
    const state = await temp();
    const lock = await acquireHostLock(state, 'desktop');
    await expect(acquireHostLock(state, 'bridge')).rejects.toThrow(/already running/i);
    await lock.release();
    await writeFile(path.join(state, 'host.lock'), JSON.stringify({ pid: 999_999_999, kind: 'bridge', startedAt: '2026-01-31T10:00:00.000Z' }));
    const replaced = await acquireHostLock(state, 'desktop');
    expect(JSON.parse(await readFile(path.join(state, 'host.lock'), 'utf8'))).toMatchObject({ pid: process.pid, kind: 'desktop' });
    await replaced.release();
  });
});
