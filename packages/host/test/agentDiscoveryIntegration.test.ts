import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createConnectService, type ConnectContext } from '../src/connect/service.js';
import { NativeImportService } from '../src/nativeImport.js';
import { createAgentHost } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
async function config(directory: string, label: string) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'config.yaml'), before = `# ${label}\nmodel: example/model\n`;
  await writeFile(file, before);
  const database = new DatabaseSync(path.join(directory, 'state.db'));
  try { database.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT)'); }
  finally { database.close(); }
  return { file, before };
}
async function fixture() {
  const root = await temp(), home = path.join(root, 'home'), local = path.join(home, 'AppData', 'Local'), data = path.join(root, 'extalia');
  await mkdir(home); await mkdir(data);
  const official = path.join(local, 'hermes'), legacy = path.join(home, '.hermes');
  const native = await config(official, 'Official Windows home'), nativeProfile = await config(path.join(official, 'profiles', 'team'), 'Official team profile');
  const old = await config(legacy, 'Legacy home remains untouched'), oldProfile = await config(path.join(legacy, 'profiles', 'legacy-team'), 'Legacy team remains untouched');
  const binary = path.join(official, 'bin', 'hermes.exe'); await mkdir(path.dirname(binary)); await writeFile(binary, 'Synthetic executable fixture; never launched.'); await chmod(binary, 0o755);
  const env: Record<string, string> = { EXTALIA_HOME: data, LOCALAPPDATA: local, PATH: '' };
  const calls: { binary: string; args: string[] }[] = [];
  const context: ConnectContext = { platform: 'win32', homeDirectory: home, extaliaHome: data, env, nodePath: process.execPath,
    managedClaudeSettings: [],
    run: async (binary, args) => { calls.push({ binary, args }); return { code: 0, stdout: `${binary.toLowerCase().includes('hermes') ? 'hermes 0.4.2' : 'gemini-cli 0.5.0'}\n`, stderr: '' }; },
    fetch: async () => new Response(null, { status: 204 }),
  };
  return { root, home, local, data, official, legacy, native, nativeProfile, old, oldProfile, binary, env, calls, context };
}

describe('connected-agent configuration and history discovery agree', () => {
  it('uses native Windows Hermes files with an empty GUI PATH, backs up and restores only that installation', async () => {
    const f = await fixture(), service = createConnectService(f.context);
    const connection = (await service.connections()).find(item => item.app === 'hermes')!;
    expect(connection).toMatchObject({ installed: true, configPath: f.native.file, version: '0.4.2' });
    expect(f.calls.some(call => call.binary.toLowerCase() === f.binary.toLowerCase() && call.args.join(' ') === '--version')).toBe(true);
    const plan = await service.plan('hermes', { port: 4317 });
    expect(plan.configPath).toBe(f.native.file); expect(plan.previewDigest).toBeTruthy();
    expect(plan.diff.replaceAll('\\', '/')).toContain('profiles/team/config.yaml');
    expect(plan.diff).not.toContain('legacy-team');
    expect(await readFile(f.native.file, 'utf8')).toBe(f.native.before);
    const result = await service.apply('hermes', { port: 4317, expectedPreviewDigest: plan.previewDigest! });
    expect(result).toMatchObject({ changed: true, configPath: f.native.file });
    expect(result.backupPath).toBeTruthy();
    expect(await readFile(path.join(result.backupPath!, 'config.yaml'), 'utf8')).toBe(f.native.before);
    expect((await readdir(result.backupPath!)).length).toBeGreaterThan(0);
    expect(await readFile(f.native.file, 'utf8')).toContain('/api/hooks/hermes');
    expect(await readFile(f.nativeProfile.file, 'utf8')).toContain('/api/hooks/hermes');
    expect(await readFile(f.old.file, 'utf8')).toBe(f.old.before);
    expect(await readFile(f.oldProfile.file, 'utf8')).toBe(f.oldProfile.before);
    const importer = await NativeImportService.create({ homeDirectory: f.home, platform: 'win32', env: f.env });
    const locations = importer.locations().filter(item => item.sourceId === 'hermes');
    expect(locations.map(item => item.profile).sort()).toEqual(['default', 'team']);
    const discovery = JSON.parse(await readFile(path.join(f.data, 'state', 'observer-discovery.json'), 'utf8')) as { locations: Record<string, unknown> };
    expect(Object.keys(discovery.locations).sort()).toEqual(locations.map(item => item.id).sort());
    const undone = await service.disconnect('hermes');
    expect(undone).toMatchObject({ changed: true, restoredExactly: true });
    for (const file of [f.native, f.nativeProfile, f.old, f.oldProfile]) expect(await readFile(file.file, 'utf8')).toBe(file.before);
  });

  it('makes an explicit named Hermes home authoritative without enrolling a different Windows or legacy installation', async () => {
    const f = await fixture(), root = path.join(f.root, 'chosen-hermes');
    const selected = await config(path.join(root, 'profiles', 'selected-team'), 'Explicit selected profile');
    f.env.HERMES_HOME = path.dirname(selected.file);
    const service = createConnectService(f.context), plan = await service.plan('hermes', { port: 4317 });
    expect(plan.configPath).toBe(selected.file);
    expect(plan.diff).not.toContain('Official Windows home'); expect(plan.diff).not.toContain('legacy-team');
    await service.apply('hermes', { port: 4317, expectedPreviewDigest: plan.previewDigest! });
    expect(await readFile(selected.file, 'utf8')).toContain('/api/hooks/hermes');
    for (const file of [f.native, f.nativeProfile, f.old, f.oldProfile]) expect(await readFile(file.file, 'utf8')).toBe(file.before);
    const importer = await NativeImportService.create({ homeDirectory: f.home, platform: 'win32', env: f.env });
    const locations = importer.locations().filter(item => item.sourceId === 'hermes');
    expect(locations.map(item => item.profile)).toEqual(['selected-team']);
    const discovery = JSON.parse(await readFile(path.join(f.data, 'state', 'observer-discovery.json'), 'utf8')) as { locations: Record<string, unknown> };
    expect(Object.keys(discovery.locations)).toEqual(locations.map(item => item.id));
    await service.disconnect('hermes'); expect(await readFile(selected.file, 'utf8')).toBe(selected.before);
  });

  it('refuses a changed root between preview and Apply before changing either installation', async () => {
    const f = await fixture(), service = createConnectService(f.context);
    const preview = await service.plan('hermes', { port: 4317 });
    const replacement = await config(path.join(f.root, 'new-selected-hermes'), 'Changed selection');
    f.env.HERMES_HOME = path.dirname(replacement.file);
    await expect(service.apply('hermes', { port: 4317, expectedPreviewDigest: preview.previewDigest! })).rejects.toThrow(/preview changed|Review a new preview/i);
    for (const file of [f.native, f.nativeProfile, f.old, f.oldProfile, replacement]) expect(await readFile(file.file, 'utf8')).toBe(file.before);
  });

  it.each(['changed', 'invalid'])('keeps the original enrollment available for undo after a %s root', async mode => {
    const f = await fixture(), service = createConnectService(f.context);
    const plan = await service.plan('hermes', { port: 4317 });
    await service.apply('hermes', { port: 4317, expectedPreviewDigest: plan.previewDigest! });
    const replacement = await config(path.join(f.root, 'replacement-hermes'), 'Another installation');
    // The other installation also has hooks; undo must not remove those before restoring our recorded enrollment.
    const otherBytes = await readFile(f.native.file, 'utf8'); await writeFile(replacement.file, otherBytes);
    f.env.HERMES_HOME = mode === 'invalid' ? 'relative/hermes' : path.dirname(replacement.file);
    const connection = (await service.connections()).find(item => item.app === 'hermes')!;
    expect(connection).toMatchObject({ state: 'stale', connected: false, configPath: f.native.file });
    expect(connection.warnings.join(' ')).toContain('Disconnect the original configuration');
    await expect(service.plan('hermes')).rejects.toThrow(mode === 'invalid' ? /absolute folder/ : /already connected/);
    expect(await readFile(f.native.file, 'utf8')).toContain('/api/hooks/hermes');
    expect(await service.disconnect('hermes')).toMatchObject({ changed: true, restoredExactly: true, configPath: f.native.file });
    expect(await readFile(f.native.file, 'utf8')).toBe(f.native.before);
    expect(await readFile(f.nativeProfile.file, 'utf8')).toBe(f.nativeProfile.before);
    expect(await readFile(replacement.file, 'utf8')).toBe(otherBytes);
  });

  it('uses the Gemini override as a base home for both hook configuration and transcript discovery', async () => {
    const f = await fixture(), base = path.join(f.root, 'gemini-home'), gemini = path.join(base, '.gemini');
    const file = path.join(gemini, 'settings.json'), before = '{"theme":"example"}\n';
    await mkdir(path.join(gemini, 'tmp'), { recursive: true }); await writeFile(file, before);
    f.env.GEMINI_CLI_HOME = base;
    const service = createConnectService({ ...f.context, findBinary: async () => undefined });
    const plan = await service.plan('gemini', { port: 4317 });
    expect(plan.configPath).toBe(file);
    await service.apply('gemini', { port: 4317, expectedPreviewDigest: plan.previewDigest! });
    expect(await readFile(file, 'utf8')).toContain('hooks');
    const importer = await NativeImportService.create({ homeDirectory: f.home, platform: 'win32', env: f.env });
    const location = importer.locations().find(item => item.label === 'Gemini CLI')!;
    expect(location).toMatchObject({ path: path.join(gemini, 'tmp'), available: true });
    const discovery = JSON.parse(await readFile(path.join(f.data, 'state', 'observer-discovery.json'), 'utf8')) as { locations: Record<string, unknown> };
    expect(discovery.locations[location.id]).toBeDefined();
    await service.disconnect('gemini'); expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('reports an unsupported Windows command wrapper without probing or hiding other apps', async () => {
    const f = await fixture(), wrapper = path.join(f.root, 'hermes.cmd');
    await writeFile(wrapper, '@echo off\r\necho unsupported wrapper\r\n');
    f.env.EXTALIA_HERMES_BIN = wrapper;
    const service = createConnectService(f.context), connections = await service.connections();
    const hermes = connections.find(item => item.app === 'hermes')!;
    expect(hermes).toMatchObject({ installed: true, configPath: f.native.file });
    expect(hermes.warnings.join(' ')).toContain('not a supported npm Node shim');
    expect((await service.plan('hermes')).warnings.join(' ')).toContain('not a supported npm Node shim');
    expect(f.calls).toEqual([]); expect(connections).toHaveLength(5);
    expect(await readFile(f.native.file, 'utf8')).toBe(f.native.before);
  });

  it('does not substitute another executable for a blank explicit binary override', async () => {
    const f = await fixture(); f.env.EXTALIA_HERMES_BIN = '  ';
    const hermes = (await createConnectService(f.context).connections()).find(item => item.app === 'hermes')!;
    expect(hermes.version).toBeUndefined(); expect(f.calls).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('keeps managed runtime discovery inside an explicitly supplied custom home', async () => {
    const root = await temp(), home = path.join(root, 'custom-home'), binary = path.join(home, '.local', 'bin', 'hermes');
    await mkdir(path.dirname(binary), { recursive: true }); await writeFile(binary, 'Synthetic metadata-only executable'); await chmod(binary, 0o755);
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', homeDirectory: home, dataDirectory: path.join(root, 'extalia'),
      env: { EXTALIA_SECRET_STORE: 'memory', PATH: '', HERMES_MANAGED_DIR: path.join(root, 'no-managed-config') } });
    try {
      expect(await runtime.host.runtimes()).toEqual([{ id: 'extalia-native', available: true, profiles: [] }, { id: 'hermes', available: true, profiles: ['default'] }]);
    } finally { await runtime.close(); }
  });
});
