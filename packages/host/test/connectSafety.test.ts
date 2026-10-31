import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAppId } from '@extalia/platform';
import { createConnectService, type ConnectContext } from '../src/connect/service.js';
import { HERMES_EVENTS, planHermesConfig, removeHermesBlock } from '../src/connect/hermes.js';

describe('Agent app configuration safety', () => {
  let root: string;
  let homeDirectory: string;
  let extaliaHome: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'extalia-connect-safety-'));
    homeDirectory = path.join(root, 'home');
    extaliaHome = path.join(root, 'data');
    await mkdir(homeDirectory);
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function makeService(env: ConnectContext['env']) {
    return createConnectService({
      platform: 'linux', env: { EXTALIA_HOME: extaliaHome, ...env }, homeDirectory, extaliaHome,
      nodePath: process.execPath, findBinary: async () => undefined, managedClaudeSettings: [],
      fetch: async () => new Response(null, { status: 204 }),
    });
  }

  const roots: Record<AgentAppId, { variable: string; filename: string; original: (label: string) => string }> = {
    codex: { variable: 'CODEX_HOME', filename: 'config.toml', original: label => `model = "${label}"\n` },
    claude: { variable: 'CLAUDE_CONFIG_DIR', filename: 'settings.json', original: label => `{"theme":"${label}"}\n` },
    gemini: { variable: 'GEMINI_CLI_HOME', filename: 'settings.json', original: label => `{"theme":"${label}"}\n` },
    antigravity: { variable: 'ANTIGRAVITY_CONFIG_DIR', filename: 'hooks.json', original: label => `{"theme":"${label}"}\n` },
    hermes: { variable: 'HERMES_HOME', filename: 'config.yaml', original: label => `model: ${label}\n` },
  };

  it.each(Object.keys(roots) as AgentAppId[])('refuses a %s config root switch before changing files or rotating the token', async app => {
    const { variable, filename, original } = roots[app];
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await mkdir(first);
    await mkdir(second);
    const firstFile = path.join(first, filename);
    const secondFile = path.join(second, filename);
    await writeFile(firstFile, original('first'));
    await writeFile(secondFile, original('second'));
    const firstService = makeService({ [variable]: first });
    await firstService.apply(app);

    const firstConnected = await readFile(firstFile, 'utf8');
    const manifestFile = path.join(extaliaHome, 'connect', 'manifest.json');
    const manifest = await readFile(manifestFile, 'utf8');
    const tokenFile = path.join(extaliaHome, 'hooks', 'token');
    const token = await readFile(tokenFile, 'utf8');
    const files = await readdir(extaliaHome, { recursive: true });
    const secondService = makeService({ [variable]: second });
    const error = new RegExp(`Disconnect that configuration first.*disconnect ${app}`);
    await expect(secondService.plan(app)).rejects.toThrow(error);
    await expect(secondService.apply(app, { rotate: true })).rejects.toThrow(error);
    expect(await readFile(firstFile, 'utf8')).toBe(firstConnected);
    expect(await readFile(secondFile, 'utf8')).toBe(original('second'));
    expect(await readFile(manifestFile, 'utf8')).toBe(manifest);
    expect(await readFile(tokenFile, 'utf8')).toBe(token);
    expect(await readdir(extaliaHome, { recursive: true })).toEqual(files);

    await firstService.disconnect(app);
    expect(await readFile(firstFile, 'utf8')).toBe(original('first'));
    await secondService.apply(app);
    await secondService.disconnect(app);
    expect(await readFile(secondFile, 'utf8')).toBe(original('second'));
  });

  it.each(['[]', '[] # no webhooks', '[{url: "https://example.com/hook"}]', '{}', 'null'])(
    'refuses Hermes inline outbound value %s without creating duplicate keys or writing files', async inline => {
      const hermes = path.join(homeDirectory, '.hermes');
      await mkdir(hermes);
      const configFile = path.join(hermes, 'config.yaml');
      const original = `hooks:\n  outbound: ${inline}\n`;
      await writeFile(configFile, original);
      expect(() => planHermesConfig(original, configFile, { port: 4317, token: 'test' })).toThrow('inline value');
      const service = makeService({});
      await expect(service.plan('hermes')).rejects.toThrow('inline value');
      await expect(service.apply('hermes')).rejects.toThrow('inline value');
      expect(await readFile(configFile, 'utf8')).toBe(original);
      await expect(readdir(extaliaHome)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('connects the default config alongside a selected named Hermes profile and restores each file from its own backup', async () => {
    const hermes = path.join(homeDirectory, '.hermes');
    const selected = path.join(hermes, 'profiles', 'selected');
    const originals = new Map([
      [path.join(hermes, 'config.yaml'), 'model: root-default\n'],
      [path.join(selected, 'config.yaml'), 'model: selected\n'],
      [path.join(hermes, 'profiles', 'default', 'config.yaml'), 'model: named-default\n'],
      [path.join(hermes, 'profiles', 'other', 'config.yaml'), 'model: other\n'],
    ]);
    for (const [file, original] of originals) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, original);
    }
    const service = makeService({ HERMES_HOME: selected });
    const plan = await service.plan('hermes');
    for (const file of originals.keys()) expect(plan.diff).toContain(file.slice(homeDirectory.length));
    await service.apply('hermes');
    for (const file of originals.keys()) expect(await readFile(file, 'utf8')).toContain('/api/hooks/hermes');
    expect((await service.plan('hermes')).changes).toBe(false);
    expect((await service.apply('hermes')).changed).toBe(false);
    const disconnected = await service.disconnect('hermes');
    expect(disconnected).toMatchObject({ changed: true, restoredExactly: true, removed: HERMES_EVENTS.length * originals.size });
    for (const [file, original] of originals) expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('reports stale, missing and unreadable enrolled Hermes profiles instead of reporting connected', async () => {
    const hermes = path.join(homeDirectory, '.hermes');
    const primary = path.join(hermes, 'config.yaml');
    const extra = path.join(hermes, 'profiles', 'team', 'config.yaml');
    await mkdir(path.dirname(extra), { recursive: true });
    await writeFile(primary, 'model: default\n');
    await writeFile(extra, 'model: team\n');
    const service = makeService({});
    await service.apply('hermes');
    const connection = async () => (await service.connections()).find(item => item.app === 'hermes');
    expect(await connection()).toMatchObject({ state: 'connected', connected: true });
    const written = await readFile(extra, 'utf8');
    await writeFile(extra, written.replace(/secret: "[0-9a-f]{64}"/, 'secret: "old-secret"'));
    expect(await connection()).toMatchObject({ state: 'stale', connected: false });
    expect((await connection())?.warnings.some(warning => warning.includes(extra.slice(homeDirectory.length)) && warning.includes('old secret'))).toBe(true);
    await writeFile(extra, removeHermesBlock(written).after);
    expect(await connection()).toMatchObject({ state: 'partial', connected: false, events: [] });
    await rm(extra);
    expect(await connection()).toMatchObject({ state: 'partial', connected: false });
    await service.apply('hermes');
    expect(await connection()).toMatchObject({ state: 'connected', connected: true });
    await writeFile(primary, 'hooks: []\n');
    expect(await connection()).toMatchObject({ state: 'partial', connected: false });
    expect((await connection())?.warnings.some(warning => warning.includes('scalar or inline value'))).toBe(true);
  });

  it('reports a profile-only Hermes disconnect and backs up edited profile bytes before surgical removal', async () => {
    const hermes = path.join(homeDirectory, '.hermes');
    const primary = path.join(hermes, 'config.yaml');
    const extra = path.join(hermes, 'profiles', 'team', 'config.yaml');
    await mkdir(path.dirname(extra), { recursive: true });
    await writeFile(primary, 'model: default\n');
    await writeFile(extra, 'model: team\n');
    const service = makeService({});
    await service.apply('hermes');
    await rm(primary);
    const edited = `${await readFile(extra, 'utf8')}user_setting: true\n`;
    await writeFile(extra, edited);
    expect(await service.disconnect('hermes')).toMatchObject({
      changed: true, restoredExactly: false, removed: HERMES_EVENTS.length, configPath: extra,
    });
    expect(await readFile(extra, 'utf8')).toBe('model: team\nuser_setting: true\n');
    const backupRoot = path.join(extaliaHome, 'connect', 'backups', 'hermes');
    const backupMetadata = (await readdir(backupRoot, { recursive: true })).filter(file => path.basename(file) === 'backup.json');
    const backups = await Promise.all(backupMetadata.map(async file => {
      const directory = path.dirname(path.join(backupRoot, file));
      const metadata = JSON.parse(await readFile(path.join(directory, 'backup.json'), 'utf8')) as { path: string };
      return { file: metadata.path, bytes: await readFile(path.join(directory, 'config.yaml'), 'utf8') };
    }));
    expect(backups).toContainEqual({ file: extra, bytes: edited });
  });

  it('reports exact removal of a created Hermes profile config even when the primary is already absent', async () => {
    const hermes = path.join(homeDirectory, '.hermes');
    const primary = path.join(hermes, 'config.yaml');
    const extra = path.join(hermes, 'profiles', 'team', 'config.yaml');
    await mkdir(path.dirname(extra), { recursive: true });
    await writeFile(primary, 'model: default\n');
    const service = makeService({});
    await service.apply('hermes');
    await rm(primary);
    expect(await service.disconnect('hermes')).toMatchObject({
      changed: true, restoredExactly: true, removed: HERMES_EVENTS.length, configPath: extra,
    });
    await expect(readFile(extra)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
