import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAppId } from '@extalia/platform';
import { createConnectService, type ConnectContext } from '../src/connect/service.js';
import { forwarderPath } from '../src/connect/forwarder.js';

const COMMAND_APPS = ['codex', 'claude', 'gemini', 'antigravity'] as const;
const CONFIGS: Record<AgentAppId, string[]> = {
  codex: ['.codex', 'config.toml'], claude: ['.claude', 'settings.json'],
  gemini: ['.gemini', 'settings.json'], antigravity: ['.gemini', 'config', 'hooks.json'],
  hermes: ['.hermes', 'config.yaml'],
};

describe('agent-app Node prerequisites', () => {
  let root: string;
  let homeDirectory: string;
  let extaliaHome: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'extalia-connect-node-'));
    homeDirectory = path.join(root, 'home');
    extaliaHome = path.join(root, 'data');
    await mkdir(homeDirectory);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function context(overrides: Partial<ConnectContext> = {}): ConnectContext {
    return {
      platform: 'linux', env: { PATH: '', EXTALIA_HOME: extaliaHome }, homeDirectory, extaliaHome,
      findBinary: async () => undefined, managedClaudeSettings: [],
      fetch: async () => new Response(null, { status: 204 }), ...overrides,
    };
  }
  async function original(app: AgentAppId): Promise<{ file: string; before: string }> {
    const file = path.join(homeDirectory, ...CONFIGS[app]);
    const before = app === 'codex' ? '# user setting\nmodel = "example-model"\n'
      : app === 'hermes' ? '# user setting\nmodel: example-model\n' : '{"userSetting":true}\n';
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, before);
    return { file, before };
  }

  for (const platform of ['linux', 'darwin', 'win32']) {
    it(`keeps Hermes preview/apply/test/status/undo independent of Node (${platform})`, async () => {
      const primary = await original('hermes');
      const profile = path.join(homeDirectory, '.hermes', 'profiles', 'team', 'config.yaml');
      await mkdir(path.dirname(profile), { recursive: true });
      await writeFile(profile, 'model: profile-model\n');
      const resolveNodePath = vi.fn(async () => { throw new Error('GUI Node lookup failed'); });
      const service = createConnectService(context({ platform, resolveNodePath }));
      const plan = await service.plan('hermes', { port: 4517 });
      expect(plan).toMatchObject({ nodeStatus: 'not-required', changes: true, port: 4517 });
      expect(plan.diff.replaceAll('\\', '/')).toContain('profiles/team/config.yaml');
      expect(await readFile(primary.file, 'utf8')).toBe(primary.before);
      const applied = await service.apply('hermes', { port: 4517, expectedPreviewDigest: plan.previewDigest });
      expect(applied.test.ok).toBe(true);
      expect(await service.test('hermes')).toMatchObject({ ok: true });
      expect(resolveNodePath).not.toHaveBeenCalled();
      const states = await service.connections();
      expect(states.find(app => app.app === 'hermes')).toMatchObject({ nodeStatus: 'not-required', connected: true, port: 4517 });
      expect(states.filter(app => app.app !== 'hermes').every(app => app.nodeStatus === 'missing')).toBe(true);
      expect(resolveNodePath).toHaveBeenCalledTimes(1);
      expect(await readdir(path.join(extaliaHome, 'hooks'))).not.toContain('forward.mjs');
      expect(await service.disconnect('hermes')).toMatchObject({ changed: true, restoredExactly: true });
      expect(await readFile(primary.file, 'utf8')).toBe(primary.before);
      expect(await readFile(profile, 'utf8')).toBe('model: profile-model\n');
      expect(resolveNodePath).toHaveBeenCalledTimes(1);
    });

    it(`refuses every new command-hook installation without Node before any writes (${platform})`, async () => {
      const configs = await Promise.all(COMMAND_APPS.map(original));
      const resolveNodePath = vi.fn(async () => undefined);
      const service = createConnectService(context({ platform, resolveNodePath }));
      const states = await service.connections();
      expect(resolveNodePath).toHaveBeenCalledTimes(1);
      for (const app of COMMAND_APPS) {
        expect(states.find(state => state.app === app)).toMatchObject({ supported: true, nodeStatus: 'missing', state: 'not-connected' });
        const plan = await service.plan(app);
        expect(plan).toMatchObject({ supported: true, nodeStatus: 'missing', changes: false, diff: '' });
        expect(plan.warnings.some(warning => warning.includes('standalone Node.js'))).toBe(true);
        await expect(service.apply(app, { expectedPreviewDigest: plan.previewDigest })).rejects.toThrow('standalone Node.js');
      }
      for (const config of configs) expect(await readFile(config.file, 'utf8')).toBe(config.before);
      await expect(readdir(extaliaHome)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it(`preserves valid installed command paths when discovery fails and allows undo (${platform})`, async () => {
      const configs = await Promise.all(COMMAND_APPS.map(original));
      const installed = createConnectService(context({ platform, nodePath: process.execPath }));
      for (const app of COMMAND_APPS) await installed.apply(app);
      const written = await Promise.all(configs.map(config => readFile(config.file, 'utf8')));
      const resolveNodePath = vi.fn(async () => undefined);
      const service = createConnectService(context({ platform, resolveNodePath }));
      const states = await service.connections();
      expect(resolveNodePath).toHaveBeenCalledTimes(1);
      for (const app of COMMAND_APPS) {
        expect(states.find(state => state.app === app)).toMatchObject({ nodeStatus: 'ready', connected: true });
        const plan = await service.plan(app);
        expect(plan).toMatchObject({ nodeStatus: 'ready', changes: false });
        await service.apply(app, { expectedPreviewDigest: plan.previewDigest });
      }
      for (const [index, config] of configs.entries()) expect(await readFile(config.file, 'utf8')).toBe(written[index]);
      resolveNodePath.mockClear();
      for (const app of COMMAND_APPS) {
        expect(await service.test(app)).toMatchObject({ ok: true });
        expect(await service.disconnect(app)).toMatchObject({ changed: true, restoredExactly: true });
      }
      expect(resolveNodePath).not.toHaveBeenCalled();
      for (const config of configs) expect(await readFile(config.file, 'utf8')).toBe(config.before);
    });
  }

  it('keeps other app diagnostics available when one config cannot be read as a file', async () => {
    const unreadable = path.join(homeDirectory, ...CONFIGS.codex);
    await mkdir(unreadable, { recursive: true });
    const service = createConnectService(context());
    await service.apply('hermes');
    const states = await service.connections();
    expect(states).toHaveLength(5);
    expect(states.find(state => state.app === 'hermes')).toMatchObject({ nodeStatus: 'not-required', connected: true });
    const codex = states.find(state => state.app === 'codex');
    expect(codex).toMatchObject({ installed: true, connected: false });
    expect(codex?.warnings.some(warning => warning.includes(unreadable))).toBe(true);
    await expect(service.plan('codex')).rejects.toThrow();
  });

  it('shares failed discovery across concurrent snapshots and retries after Node becomes available', async () => {
    const resolveNodePath = vi.fn<() => Promise<string | undefined>>().mockResolvedValueOnce(undefined).mockResolvedValue(process.execPath);
    const service = createConnectService(context({ resolveNodePath }));
    const missing = await Promise.all([service.connections(), service.connections()]);
    expect(missing.every(states => states.filter(app => app.app !== 'hermes').every(app => app.nodeStatus === 'missing'))).toBe(true);
    expect(resolveNodePath).toHaveBeenCalledTimes(1);
    const plan = await service.plan('codex');
    expect(plan).toMatchObject({ nodeStatus: 'ready', changes: true });
    await service.apply('codex', { expectedPreviewDigest: plan.previewDigest });
    expect(resolveNodePath).toHaveBeenCalledTimes(2);
  });

  for (const candidate of ['', 'relative-node', '/nonexistent-example/node']) {
    it(`rejects an invalid runtime candidate ${JSON.stringify(candidate)}`, async () => {
      const service = createConnectService(context({ nodePath: candidate }));
      for (const app of COMMAND_APPS) {
        expect(await service.plan(app)).toMatchObject({ nodeStatus: 'missing', changes: false });
        await expect(service.apply(app)).rejects.toThrow('standalone Node.js');
      }
      await expect(readdir(extaliaHome)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  }

  it('reports malformed installed commands as stale and permits surgical removal without Node', async () => {
    const configs = await Promise.all(COMMAND_APPS.map(original));
    const installed = createConnectService(context({ nodePath: process.execPath }));
    for (const app of COMMAND_APPS) await installed.apply(app);
    for (const config of configs) {
      const content = await readFile(config.file, 'utf8');
      await writeFile(config.file, content.replaceAll(JSON.stringify(process.execPath).slice(1, -1), ''));
    }
    const service = createConnectService(context());
    const states = await service.connections();
    for (const app of COMMAND_APPS) {
      expect(states.find(state => state.app === app)).toMatchObject({ nodeStatus: 'missing', state: 'stale' });
      await expect(service.apply(app)).rejects.toThrow('standalone Node.js');
      expect(await service.disconnect(app)).toMatchObject({ changed: true });
    }
    for (const [index, config] of configs.entries()) {
      const restored = await readFile(config.file, 'utf8');
      if (COMMAND_APPS[index] === 'codex') expect(restored).toBe(config.before);
      else expect(JSON.parse(restored)).toEqual(JSON.parse(config.before));
    }
  });

  it('rejects Electron both as a new runtime and in existing commands without preventing removal', async () => {
    const installed = createConnectService(context({ nodePath: process.execPath }));
    await installed.apply('codex');
    const service = createConnectService(context({ nodePath: process.execPath, electronPath: process.execPath }));
    expect((await service.connections()).find(app => app.app === 'codex')).toMatchObject({ nodeStatus: 'missing', state: 'stale' });
    for (const app of COMMAND_APPS) await expect(service.apply(app)).rejects.toThrow('standalone Node.js');
    expect(await service.disconnect('codex')).toMatchObject({ changed: true });
  });

  it.skipIf(process.platform === 'win32')('rejects an Electron alias and retries when a different standalone Node is found', async () => {
    const alias = path.join(root, 'node-alias');
    await symlink(process.execPath, alias);
    const resolveNodePath = vi.fn<() => Promise<string | undefined>>().mockResolvedValueOnce(alias);
    const service = createConnectService(context({ resolveNodePath, electronPath: process.execPath }));
    expect(await service.plan('gemini')).toMatchObject({ nodeStatus: 'missing' });
    const standalone = path.join(root, 'Node installation', 'bin', 'node');
    await mkdir(path.dirname(standalone), { recursive: true });
    await writeFile(standalone, 'temporary executable fixture', { mode: 0o755 });
    resolveNodePath.mockResolvedValue(standalone);
    const plan = await service.plan('gemini');
    expect(plan).toMatchObject({ nodeStatus: 'ready' });
    expect(plan.diff).toContain(standalone);
    await service.apply('gemini', { expectedPreviewDigest: plan.previewDigest });
    expect(await readFile(path.join(homeDirectory, ...CONFIGS.gemini), 'utf8')).toContain(forwarderPath(extaliaHome));
  });
});
