import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ObservedCodexPermissionService, type ObservedCodexPermissionTarget } from '../src/observedCodexPermissionService.js';
import { codexPermissionTokenFile } from '../src/connect/codexPermissionForwarder.js';
import * as setup from '../src/connect/codexPermissionHookSetup.js';

const THREAD = '22222222-2222-4222-8222-222222222222';
const cleanups: Array<() => Promise<void>> = [];
async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  expect(await check()).toBe(true);
}
async function make() {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-permission-service-'));
  const dataDirectory = path.join(root, 'data'), codexHome = path.join(root, 'codex'), cwd = path.join(root, 'workspace');
  await Promise.all([mkdir(codexHome), mkdir(cwd)]);
  const configPath = path.join(codexHome, 'config.toml');
  await writeFile(configPath, 'model = "synthetic-model"\n', { mode: 0o600 });
  const target: ObservedCodexPermissionTarget = { threadId: THREAD, codexHome, cwd, transcriptPath: path.join(codexHome, 'rollout.jsonl'), sourceFingerprint: 'a'.repeat(64), watching: true };
  const options = { dataDirectory, env: {}, target: (id: string) => id === 'observed-1' ? target : undefined, resolve: (payload: Record<string, unknown>) => payload.session_id === target.threadId && payload.transcript_path === target.transcriptPath ? 'observed-1' : undefined };
  let service = await ObservedCodexPermissionService.create(options);
  const services = [service];
  const server = createServer((request, response) => { void service.handle(request, response); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing synthetic listener.');
  const url = `http://127.0.0.1:${address.port}/api/permissions/codex`;
  const payload = () => ({ session_id: THREAD, turn_id: 'turn-1', transcript_path: target.transcriptPath, cwd: target.cwd, hook_event_name: 'PermissionRequest', model: 'test-model', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'printf synthetic-service-command', description: 'Synthetic invocation' } });
  const send = async (token?: string) => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token ?? (await readFile(codexPermissionTokenFile(dataDirectory), 'utf8')).trim()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), payload: payload() }) });
  cleanups.push(async () => {
    await Promise.all(services.map(item => item.close()));
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  });
  return { root, dataDirectory, configPath, target, options, send, service,
    async restart() { await service.close(); service = await ObservedCodexPermissionService.create(options); services.push(service); return service; },
  };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

describe('ObservedCodexPermissionService', () => {
  it('previews without writing and enables only an exact approved scoped installation', async () => {
    const { service, dataDirectory, configPath, send } = await make();
    expect(await service.status('observed-1')).toMatchObject({ state: 'unavailable', installed: false, requests: [] });
    const before = await readFile(configPath, 'utf8');
    const plan = await service.preview('observed-1');
    expect(plan).toMatchObject({ changed: true, nativeSessionId: THREAD, needsTrust: true });
    expect(plan.diff).toContain('async = false');
    expect(await readFile(configPath, 'utf8')).toBe(before);
    await expect(readFile(path.join(dataDirectory, 'state', 'observed-codex-permissions.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(service.apply('observed-1', 'stale')).rejects.toThrow('changed');
    expect(await service.apply('observed-1', plan.revision)).toMatchObject({ installed: true, state: 'ready' });
    const stored = await readFile(path.join(dataDirectory, 'state', 'observed-codex-permissions.json'), 'utf8');
    expect(JSON.parse(stored)).toEqual({ version: 1, bindings: [{ sessionId: 'observed-1', threadId: THREAD, codexHome: path.dirname(configPath), sourceFingerprint: 'a'.repeat(64) }] });
    expect(stored).not.toContain('synthetic-service-command');
    expect(stored).not.toContain('allow');
    const call = send();
    await waitFor(async () => (await service.status('observed-1')).requests.length === 1);
    const request = (await service.status('observed-1')).requests[0]!;
    await service.answer('observed-1', { ...request, decision: 'allow' });
    expect(await (await call).json()).toMatchObject({ decision: 'allow', confirmed: true, nativeSessionId: THREAD });
  });

  it('restores only an approved exact source and config, without changing trust or resending', async () => {
    const fixture = await make();
    const plan = await fixture.service.preview('observed-1');
    await fixture.service.apply('observed-1', plan.revision);
    const config = await readFile(fixture.configPath, 'utf8');
    const restored = await fixture.restart();
    expect(await restored.status('observed-1')).toMatchObject({ installed: true, state: 'ready', requests: [] });
    expect(await readFile(fixture.configPath, 'utf8')).toBe(config);
    expect(config).not.toContain('hooks.state');
    fixture.target.sourceFingerprint = 'b'.repeat(64);
    expect(await restored.status('observed-1')).toMatchObject({ installed: false, state: 'unavailable' });
    expect(await (await fixture.send()).json()).toEqual({ decision: 'pass', confirmed: false });
  });

  it('binds preview approval to the original source fingerprint and refuses edited config on restore', async () => {
    const fixture = await make();
    const preview = await fixture.service.preview('observed-1');
    fixture.target.sourceFingerprint = 'b'.repeat(64);
    await expect(fixture.service.apply('observed-1', preview.revision)).rejects.toThrow('changed');
    const current = await fixture.service.preview('observed-1');
    await fixture.service.apply('observed-1', current.revision);
    await writeFile(fixture.configPath, `${await readFile(fixture.configPath, 'utf8')}\n# outside change\n`);
    const restored = await fixture.restart();
    // Unrelated comments are preserved by the plan, so exact managed scope still verifies.
    expect(await restored.status('observed-1')).toMatchObject({ installed: true });
    const text = await readFile(fixture.configPath, 'utf8');
    await writeFile(fixture.configPath, text.replace('async = false', 'async = true'));
    expect(await restored.status('observed-1')).toMatchObject({ installed: false, state: 'unavailable' });
    expect(await (await fixture.send()).json()).toEqual({ decision: 'pass', confirmed: false });
  });

  it('keeps pause sealed and returns pass if config changes before an explicit answer', async () => {
    const { service, configPath, send } = await make();
    await service.apply('observed-1', (await service.preview('observed-1')).revision);
    service.drop('observed-1');
    expect(await (await send()).json()).toEqual({ decision: 'pass', confirmed: false });
    expect(await service.status('observed-1')).toMatchObject({ installed: true, state: 'unavailable' });
    service.resume('observed-1');
    const call = send();
    await waitFor(async () => (await service.status('observed-1')).requests.length === 1);
    const request = (await service.status('observed-1')).requests[0]!;
    await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('async = false', 'async = true'));
    expect(await service.answer('observed-1', { ...request, decision: 'allow' })).toMatchObject({ installed: false, requests: [] });
    expect(await (await call).json()).toEqual({ decision: 'pass', confirmed: false });
  });

  it('does not accept notification secrets or unsafe dedicated token files', async () => {
    const { service, dataDirectory, send } = await make();
    await service.apply('observed-1', (await service.preview('observed-1')).revision);
    expect((await send('synthetic-notification-token')).status).toBe(401);
    if (process.platform !== 'win32') {
      await chmod(codexPermissionTokenFile(dataDirectory), 0o644);
      expect(await service.status('observed-1')).toMatchObject({ installed: false });
      expect((await send('0'.repeat(64))).status).toBe(401);
    }
  });

  it('previews undo and removes only after approving its current revision', async () => {
    const { service, configPath, send } = await make();
    const original = await readFile(configPath, 'utf8');
    await service.apply('observed-1', (await service.preview('observed-1')).revision);
    const undo = await service.preview('observed-1', true);
    expect(undo.changed).toBe(true);
    expect(await readFile(configPath, 'utf8')).not.toBe(original);
    await expect(service.apply('observed-1', 'stale', true)).rejects.toThrow('changed');
    expect(await service.apply('observed-1', undo.revision, true)).toMatchObject({ installed: false, state: 'unavailable' });
    expect(await readFile(configPath, 'utf8')).toBe(original);
    expect(await (await send()).json()).toEqual({ decision: 'pass', confirmed: false });
  });

  it('preserves corrupt binding metadata and disables admission without writing config', async () => {
    const fixture = await make();
    await mkdir(path.join(fixture.dataDirectory, 'state'), { recursive: true });
    const file = path.join(fixture.dataDirectory, 'state', 'observed-codex-permissions.json');
    await writeFile(file, '{', { mode: 0o600 });
    const service = await fixture.restart();
    expect(await service.status('observed-1')).toMatchObject({ installed: false, state: 'unavailable' });
    await expect(service.preview('observed-1')).rejects.toThrow('unavailable');
    expect(await readFile(file, 'utf8')).toBe('{');
    expect(await readFile(fixture.configPath, 'utf8')).toBe('model = "synthetic-model"\n');
  });

  it('requires explicit local binding approval even when a CLI installation is already current', async () => {
    const { service, dataDirectory, configPath } = await make();
    const options = { extaliaHome: dataDirectory, codexHome: path.dirname(configPath), nativeSessionId: THREAD, nodePath: process.execPath, platform: process.platform };
    await setup.applyCodexPermissionHookSetup(options, (await setup.previewCodexPermissionHookSetup(options)).revision);
    expect((await setup.previewCodexPermissionHookSetup(options)).changed).toBe(false);
    expect(await service.status('observed-1')).toMatchObject({ installed: false });
    const plan = await service.preview('observed-1');
    expect(plan.changed).toBe(true);
    expect(plan.diff).toContain('Extalia local metadata: enable');
    expect(await service.apply('observed-1', plan.revision)).toMatchObject({ installed: true });
  });

  it('does not let stale async inspections reactivate a paused or removed source', async () => {
    const { service, send } = await make();
    await service.apply('observed-1', (await service.preview('observed-1')).revision);
    const original = setup.previewCodexPermissionHookSetup;
    const spy = vi.spyOn(setup, 'previewCodexPermissionHookSetup');
    async function holdStatus() {
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const starting = new Promise<void>(resolve => { entered = resolve; });
      spy.mockImplementationOnce(async options => { entered(); await gate; return original(options); });
      const status = service.status('observed-1');
      await starting;
      return { status, release };
    }
    const pause = await holdStatus();
    service.drop('observed-1'); pause.release();
    expect(await pause.status).toMatchObject({ state: 'unavailable' });
    expect(await service.status('observed-1')).toMatchObject({ installed: true, state: 'unavailable' });
    expect(await (await send()).json()).toEqual({ decision: 'pass', confirmed: false });
    service.resume('observed-1');
    const removal = await holdStatus();
    const undo = await service.preview('observed-1', true);
    await service.apply('observed-1', undo.revision, true);
    removal.release();
    expect(await removal.status).toMatchObject({ installed: false, state: 'unavailable' });
    expect(await service.status('observed-1')).toMatchObject({ installed: false, state: 'unavailable' });
    expect(await (await send()).json()).toEqual({ decision: 'pass', confirmed: false });
  });

  it('can safely preview and remove the scoped hook after install prerequisites change', async () => {
    const { service, configPath, dataDirectory } = await make();
    const original = await readFile(configPath, 'utf8');
    await service.apply('observed-1', (await service.preview('observed-1')).revision);
    await writeFile(path.join(path.dirname(configPath), 'hooks.json'), '{}');
    await writeFile(path.join(dataDirectory, 'hooks', 'codex-permission.mjs'), '// independently changed\n');
    const undo = await service.preview('observed-1', true);
    expect(undo.changed).toBe(true);
    expect(await service.apply('observed-1', undo.revision, true)).toMatchObject({ installed: false });
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });
});
