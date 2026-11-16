import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '@extalia/core';
import type { AgentHostRuntime } from '../src/service.js';
import { createAgentHost } from '../src/service.js';
import { mockModelDiscovery } from './modelDiscoveryFixture.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const runtimes: AgentHostRuntime[] = [];
afterEach(async () => { while (runtimes.length) await runtimes.pop()!.close(); });
const permissions = { fileWrite: 'ask' as const, commands: 'ask' as const };

async function setup(existingRoot?: string) {
  const root = existingRoot ?? await temp();
  const home = path.join(root, 'home'), project = path.join(root, 'project');
  await mkdir(project, { recursive: true });
  for (const profile of ['original', 'replacement']) {
    const folder = path.join(home, '.hermes', 'profiles', profile);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'config.yaml'), `model:\n  default: example/${profile}\n  provider: openrouter\n`);
  }
  const executable = path.join(root, 'hermes-fixture');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--help')) { process.stdout.write('usage: hermes chat [--reasoning LEVEL]\\n'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(process.env.HERMES_HOME, 'call.json'), JSON.stringify(args));
  process.stdout.write(JSON.stringify({ type: 'result', session_id: 'fixture-session', exit_code: 0, text: 'Done.' }) + '\\n');
});
`);
  await chmod(executable, 0o755);
  const requests: { url: string; body?: Record<string, unknown> }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ url, ...(body ? { body } : {}) });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: url.includes('original') ? 'native-original' : 'native-replacement' }] });
    return new Response('data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const runtime = await createAgentHost({
    kind: 'bridge', version: '0.0.0-test', dataDirectory: path.join(root, 'data'), homeDirectory: home, importHome: home,
    env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_NATIVE_CORE: 'typescript', HOME: home, HERMES_HOME: path.join(home, '.hermes'), HERMES_MANAGED_DIR: path.join(root, 'no-managed-scope'), EXTALIA_HERMES_BIN: executable, PATH: process.env.PATH },
    fetch,
    modelDiscovery: mockModelDiscovery(fetch),
  });
  runtimes.push(runtime);
  return { root, home, project, runtime, host: runtime.host, requests };
}

async function connection(host: AgentHostRuntime['host'], name: string, api: 'openai-chat' | 'anthropic-messages' = 'openai-chat') {
  const state = await host.saveConnection({
    name, preset: 'custom', api, baseUrl: `http://${name}.example.test/v1`, model: `native-${name}`,
    credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' },
    ...(api === 'anthropic-messages' ? { effort: 'medium' as const } : {}),
    orchestration: { enabled: false, maxDelegations: 0, tiers: {} },
  });
  return state.connections.find(item => item.name === name)!;
}

async function saveNative(host: AgentHostRuntime['host'], project: string, connectionId: string, id?: string) {
  const state = await host.saveWorkspace({ id, name: 'Project', projectLocation: project, connectionId, permissions });
  return state.workspaces.find(item => item.id === id) ?? state.workspaces.at(-1)!;
}

async function saveHermes(host: AgentHostRuntime['host'], project: string, id?: string, profile = 'original') {
  const state = await host.saveWorkspace({ id, name: 'Project', projectLocation: project, runtimeId: 'hermes', runtimeProfileId: profile, runtimeModel: 'example/pinned', permissions });
  return state.workspaces.find(item => item.id === id) ?? state.workspaces.at(-1)!;
}

function expectNative(workspace: Workspace, connectionId: string) {
  expect(workspace.providerProfileId).toBe(connectionId);
  expect(workspace.runtimeId).toBeUndefined();
  expect(workspace.runtimeProfileId).toBeUndefined();
  expect(workspace.runtimeModel).toBeUndefined();
}

describe('workspace runtime changes preserve session targets', () => {
  it('persists both switch directions and creates fresh sessions with the current default', async () => {
    const f = await setup();
    const saved = await connection(f.host, 'replacement');
    const hermes = await saveHermes(f.host, f.project);
    const old = await f.host.createSession(hermes.id);
    expect(old.options?.model).toBe('example/pinned');
    expectNative(await saveNative(f.host, f.project, saved.id, hermes.id), saved.id);
    await runtimes.pop()!.close();

    const reopened = await setup(f.root);
    expectNative((await reopened.host.getState()).workspaces[0]!, saved.id);
    const fresh = await reopened.host.createSession(hermes.id);
    expect(fresh.runtime).toBeUndefined();
    expect(fresh.connectionId).toBe(saved.id);
    expect((await reopened.host.getState()).sessions.find(item => item.id === old.id)).toMatchObject({ runtime: { id: 'hermes', profile: 'original' }, options: { model: 'example/pinned' } });
    await reopened.host.sendPrompt(fresh.id, 'Hello');
    await vi.waitFor(() => expect(reopened.runtime.isBusy()).toBe(false));
    expect(reopened.requests.find(item => item.body)?.body?.model).toBe('native-replacement');

    const switched = await saveHermes(reopened.host, f.project, hermes.id, 'replacement');
    expect(switched.providerProfileId).toBeUndefined();
    const mark = reopened.requests.length;
    await reopened.host.sendPrompt(fresh.id, 'Continue after switching');
    await vi.waitFor(() => expect(reopened.runtime.isBusy()).toBe(false));
    expect(reopened.requests.slice(mark).find(item => item.body)).toMatchObject({ url: 'http://replacement.example.test/v1/chat/completions', body: { model: 'native-replacement' } });
    await runtimes.pop()!.close();
    const again = await setup(f.root);
    expect((await again.host.getState()).workspaces[0]).toMatchObject({ runtimeId: 'hermes', runtimeProfileId: 'replacement' });
    expect((await again.host.getState()).sessions.find(item => item.id === fresh.id)).toMatchObject({ connectionId: saved.id });
    expect((await again.host.createSession(hermes.id)).runtime).toMatchObject({ id: 'hermes', profile: 'replacement' });
  });

  it('uses the saved Native connection for model choices, effort validation, permissions and learning gates', async () => {
    const f = await setup();
    const original = await connection(f.host, 'original', 'anthropic-messages');
    const replacement = await connection(f.host, 'replacement');
    const workspace = await saveNative(f.host, f.project, original.id);
    const session = await f.host.createSession(workspace.id);
    await saveNative(f.host, f.project, replacement.id, workspace.id);
    expect(await f.host.modelChoices(workspace.id)).toMatchObject({ defaultModel: 'native-replacement', efforts: [] });
    expect(await f.host.modelChoices(workspace.id, session.id)).toMatchObject({ runtime: 'extalia-native', defaultModel: 'native-original', models: ['native-original'], defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    await saveHermes(f.host, f.project, workspace.id);
    expect((await f.host.modelChoices(workspace.id, session.id)).runtime).toBe('extalia-native');
    expect((await f.host.setSessionOptions(session.id, { effort: 'high', permissionMode: 'ask' })).options).toEqual({ effort: 'high', permissionMode: 'ask' });
    await expect(f.host.sendPrompt(session.id, '/learn-skill Example')).rejects.toThrow(/requires Extalia skills and the Rust skill registry/);
    await f.host.setSessionOptions(session.id, { permissionMode: 'plan' });
    await expect(f.host.sendPrompt(session.id, '/learn-skill Example')).rejects.toThrow(/read-only plan mode/);
  });

  it.skipIf(process.platform === 'win32')('uses the saved Hermes profile and runtime capabilities after changing the workspace', async () => {
    const f = await setup();
    const saved = await connection(f.host, 'replacement');
    const workspace = await saveHermes(f.host, f.project);
    const session = await f.host.createSession(workspace.id);
    await saveHermes(f.host, f.project, workspace.id, 'replacement');
    expect((await f.host.modelChoices(workspace.id, session.id)).defaultModel).toBe('example/original');
    // Older sessions can have no explicit model; a new workspace profile's model must not leak into them.
    await f.host.setSessionOptions(session.id, {});
    await f.host.sendPrompt(session.id, 'Use the original profile');
    await vi.waitFor(() => expect(f.runtime.isBusy()).toBe(false));
    const args = JSON.parse(await readFile(path.join(f.home, '.hermes', 'call.json'), 'utf8')) as string[];
    expect(args.slice(0, 2)).toEqual(['-p', 'original']);
    expect(args.some(value => value.startsWith('--model'))).toBe(false);
    await saveNative(f.host, f.project, saved.id, workspace.id);
    expect(await f.host.modelChoices(workspace.id, session.id)).toMatchObject({ runtime: 'hermes', defaultModel: 'example/original', permissionModes: ['workspace'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    await expect(f.host.setSessionOptions(session.id, { effort: 'high' })).resolves.toMatchObject({ options: { effort: 'high' } });
    await expect(f.host.setSessionOptions(session.id, { permissionMode: 'plan' })).rejects.toThrow(/Hermes Agent manages/);
    await expect(f.host.sendPrompt(session.id, '/learn-skill Example')).rejects.toThrow(/requires an Extalia Native session/);
  });

  it('refuses missing, foreign and observed session catalog targets', async () => {
    const f = await setup();
    const saved = await connection(f.host, 'replacement');
    const first = await saveNative(f.host, f.project, saved.id);
    const second = await saveNative(f.host, f.project, saved.id);
    const session = await f.host.createSession(first.id);
    await expect(f.host.modelChoices(second.id, session.id)).rejects.toThrow(/another workspace/);
    await expect(f.host.modelChoices(first.id, 's_missing123')).rejects.toThrow(/no longer exists/);
    await expect(f.host.modelChoices(first.id, null as unknown as string)).rejects.toThrow(/managed session/);
    const folder = path.join(f.home, '.codex', 'sessions');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'rollout.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: 'observed-example', cwd: f.project, timestamp: '2026-10-09T00:00:00.000Z' } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Example' }] } })}\n`);
    const scan = await f.host.scanImports(['codex']);
    const state = await f.host.observeImports(scan.scanId, [scan.sessions[0]!.id]);
    const observed = state.sessions.find(item => item.control === 'observed')!;
    await expect(f.host.modelChoices(first.id, observed.id)).rejects.toThrow(/Observed sessions/);
  });
});
