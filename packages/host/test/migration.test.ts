import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { legacyDataDirectories, resolveDataDirectory } from '@extalia/platform';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FORWARDER_SOURCE, MIGRATION_NOTE, createAgentHost, createConnectService, endpointFile, forwarderPath, migrateLegacyDataDirectory, readMigrationMarker,
} from '../src/index.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const posix = process.platform !== 'win32';
const modeOf = async (file: string) => (await stat(file)).mode & 0o777;
const exists = (file: string) => lstat(file).then(() => true, () => false);
const TOKEN = 'a'.repeat(64);

/** A data folder as Extalia 0.0.20 left it, at the macOS location below a temporary home. */
async function legacyFixture(platform = 'darwin', env: Record<string, string> = {}) {
  const home = await temp('extalia-migrate-');
  const legacy = path.resolve(legacyDataDirectories({ platform, env, homeDirectory: home })[0]!);
  const target = path.resolve(resolveDataDirectory({ platform, env: {}, homeDirectory: home }));
  const write = async (relative: string, text: string, mode = 0o600) => {
    const file = path.join(legacy, relative);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, text, { mode });
    if (posix) await chmod(file, mode);
    return file;
  };
  const config = { schema: 'extalia.host-config.v1', setupComplete: true, workflow: 'managed', profile: { id: 'default', name: 'Personal' }, connections: [], workspaces: [] };
  await write('config/extalia.json', `${JSON.stringify(config)}\n`);
  await write('sessions/s_1/session.json', '{"id":"s_1"}\n');
  await write('state/library.json', '{"sessions":[]}\n');
  await write('state/host.lock', '{"pid":1}\n');
  await write('hooks/token', TOKEN);
  await write('hooks/endpoint.json', '{"port":1,"pid":1,"kind":"bridge"}');
  await write('hooks/forward.mjs', FORWARDER_SOURCE, 0o755);
  await write('connect/backups/gemini/2026/settings.json', '{}\n');
  await write('connect/manifest.json', JSON.stringify({
    schema: 'extalia.connect-manifest.v1',
    apps: { gemini: { configPath: path.join(home, '.gemini', 'settings.json'), original: { existed: true, backupDir: path.join(legacy, 'connect', 'backups', 'gemini', '2026'), backupFile: path.join(legacy, 'connect', 'backups', 'gemini', '2026', 'settings.json') } } },
  }));
  await write('cache/big.bin', 'cache');
  await write('Cache/Chromium.bin', 'not extalia data');
  if (posix) await symlink('/etc', path.join(legacy, 'state', 'outside'));
  return { home, legacy, target, config };
}

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });

function runNode(script: string, app: string, body: string): Promise<number | null> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, app], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('close', resolve);
    child.stdin.end(body);
  });
}

describe('legacy data migration', () => {
  it('copies Extalia data once, keeps modes, skips caches and runtime files, and leaves the old folder in place', async () => {
    const { legacy, target, home } = await legacyFixture();
    const before = await readFile(path.join(legacy, 'config', 'extalia.json'), 'utf8');
    const result = await migrateLegacyDataDirectory({ target, platform: 'darwin', env: {}, homeDirectory: home, now: () => new Date('2026-10-01T00:00:00.000Z') });
    expect(result).toMatchObject({ status: 'migrated', from: legacy, forwarderShim: true });

    expect(await readFile(path.join(target, 'config', 'extalia.json'), 'utf8')).toBe(before);
    expect(await readFile(path.join(target, 'sessions', 's_1', 'session.json'), 'utf8')).toBe('{"id":"s_1"}\n');
    expect(await readFile(path.join(target, 'hooks', 'token'), 'utf8')).toBe(TOKEN);
    expect(await readFile(path.join(target, 'hooks', 'forward.mjs'), 'utf8')).toBe(FORWARDER_SOURCE);
    for (const skipped of ['cache', 'Cache', 'state/host.lock', 'hooks/endpoint.json', 'state/outside']) expect(await exists(path.join(target, skipped))).toBe(false);
    if (posix) {
      expect(await modeOf(path.join(target, 'config', 'extalia.json'))).toBe(0o600);
      expect(await modeOf(path.join(target, 'hooks', 'token'))).toBe(0o600);
      expect(await modeOf(path.join(target, 'sessions'))).toBe(0o700);
      expect(await modeOf(target)).toBe(0o700);
    }
    expect(await readMigrationMarker(target)).toEqual({ from: legacy, at: '2026-10-01T00:00:00.000Z' });

    // Backup paths in the connect manifest now point into the new folder.
    const manifest = JSON.parse(await readFile(path.join(target, 'connect', 'manifest.json'), 'utf8')) as { apps: { gemini: { configPath: string; original: { backupFile: string } } } };
    expect(manifest.apps.gemini.original.backupFile).toBe(path.join(target, 'connect', 'backups', 'gemini', '2026', 'settings.json'));
    expect(manifest.apps.gemini.configPath).toBe(path.join(home, '.gemini', 'settings.json'));

    // The old folder keeps its data; only the note and the forwarder shim are new.
    expect(await readFile(path.join(legacy, 'config', 'extalia.json'), 'utf8')).toBe(before);
    expect(await exists(path.join(legacy, 'cache', 'big.bin'))).toBe(true);
    expect(await readFile(path.join(legacy, MIGRATION_NOTE), 'utf8')).toContain(target);
    expect(await readFile(path.join(legacy, 'hooks', 'forward.mjs'), 'utf8')).toMatch(/^\/\/ extalia-hook-forwarder-shim v1/);

    // Later starts do nothing.
    expect(await migrateLegacyDataDirectory({ target, platform: 'darwin', env: {}, homeDirectory: home })).toEqual({ status: 'not-needed' });
  });

  it('runs once when two hosts start together', async () => {
    const { target, home } = await legacyFixture();
    const options = { target, platform: 'darwin', env: {}, homeDirectory: home };
    const results = await Promise.all([migrateLegacyDataDirectory(options), migrateLegacyDataDirectory(options), migrateLegacyDataDirectory(options)]);
    expect(results.filter(result => result.status === 'migrated')).toHaveLength(1);
    expect(results.filter(result => result.status !== 'migrated').map(result => result.status)).toEqual(['migrated-elsewhere', 'migrated-elsewhere']);
    expect((await readdir(target)).filter(name => name.startsWith('.migration'))).toEqual([]);
  });

  it('finishes an interrupted copy without overwriting files already in the new folder', async () => {
    const { target, home, legacy } = await legacyFixture();
    await mkdir(path.join(target, 'sessions', 's_1'), { recursive: true });
    await writeFile(path.join(target, 'sessions', 's_1', 'session.json'), 'newer');
    expect(await migrateLegacyDataDirectory({ target, platform: 'darwin', env: {}, homeDirectory: home })).toMatchObject({ status: 'migrated', from: legacy });
    expect(await readFile(path.join(target, 'sessions', 's_1', 'session.json'), 'utf8')).toBe('newer');
    expect(await exists(path.join(target, 'state', 'library.json'))).toBe(true);
  });

  it('does nothing when the new folder is already set up, there is no old folder, or it already ran', async () => {
    const { target, home } = await legacyFixture();
    await mkdir(path.join(target, 'config'), { recursive: true });
    await writeFile(path.join(target, 'config', 'extalia.json'), '{}');
    expect(await migrateLegacyDataDirectory({ target, platform: 'darwin', env: {}, homeDirectory: home })).toEqual({ status: 'not-needed' });
    const empty = await temp();
    expect(await migrateLegacyDataDirectory({ target: path.join(empty, '.extalia-vo'), platform: 'darwin', env: {}, homeDirectory: empty })).toEqual({ status: 'no-legacy' });
    const marked = path.join(empty, 'marked');
    await mkdir(path.join(marked, 'state'), { recursive: true });
    await writeFile(path.join(marked, 'state', 'migrated-from.json'), JSON.stringify({ from: '/old', at: '2026-01-01T00:00:00.000Z' }));
    expect(await migrateLegacyDataDirectory({ target: marked, platform: 'darwin', env: {}, homeDirectory: home })).toEqual({ status: 'already-migrated', from: '/old' });
  });

  it('does not bring old data back after the user deletes the new folder', async () => {
    const { target, home, legacy } = await legacyFixture();
    expect((await migrateLegacyDataDirectory({ target, platform: 'darwin', env: {}, homeDirectory: home })).status).toBe('migrated');
    expect(await exists(path.join(legacy, MIGRATION_NOTE))).toBe(true);
    await rm(target, { recursive: true, force: true });
    expect(await migrateLegacyDataDirectory({ target, platform: 'darwin', env: {}, homeDirectory: home })).toEqual({ status: 'no-legacy' });
    expect(await exists(path.join(target, 'sessions'))).toBe(false);
  });

  // XDG_DATA_HOME must be a POSIX absolute path, which a Windows temp folder is not.
  it.skipIf(process.platform === 'win32')('finds the Linux XDG location', async () => {
    const xdg = await temp();
    const { target, home, legacy } = await legacyFixture('linux', { XDG_DATA_HOME: xdg });
    expect(legacy).toBe(path.join(xdg, 'extalia'));
    expect(await migrateLegacyDataDirectory({ target, platform: 'linux', env: { XDG_DATA_HOME: xdg }, homeDirectory: home })).toMatchObject({ status: 'migrated', from: legacy });
  });

  it.runIf(posix)('keeps hooks that run the old forwarder working through the shim', async () => {
    const { target, home, legacy } = await legacyFixture();
    await migrateLegacyDataDirectory({ target, platform: 'darwin', env: {}, homeDirectory: home });
    const received: { url: string; auth: string | undefined; body: string }[] = [];
    const server = createServer((request: IncomingMessage, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => { received.push({ url: request.url ?? '', auth: request.headers.authorization, body: Buffer.concat(chunks).toString('utf8') }); response.writeHead(204); response.end(); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    // Only the new folder knows the running host's port.
    await writeFile(endpointFile(target), JSON.stringify({ port: (server.address() as AddressInfo).port, pid: process.pid, kind: 'bridge' }));
    const payload = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's-1' });
    expect(await runNode(path.join(legacy, 'hooks', 'forward.mjs'), 'codex', payload)).toBe(0);
    expect(received).toEqual([{ url: '/api/hooks/codex', auth: `Bearer ${TOKEN}`, body: payload }]);
  });

  it('tells connected apps to connect again until their hooks use the new folder', async () => {
    const { home, legacy } = await legacyFixture();
    const context = {
      platform: 'linux', env: {}, homeDirectory: home, nodePath: process.execPath,
      findBinary: async (name: string) => `/usr/local/bin/${name}`,
      run: async () => ({ code: 0, stdout: 'gemini-cli 0.5.0\n', stderr: '' }),
    };
    await mkdir(path.join(home, '.gemini'), { recursive: true });
    // Connected by 0.0.20 against the old folder.
    await createConnectService({ ...context, extaliaHome: legacy }).apply('gemini');
    const target = path.join(home, '.extalia-vo');
    await migrateLegacyDataDirectory({ target, platform: 'darwin', env: {}, homeDirectory: home });
    const service = createConnectService({ ...context, extaliaHome: target });
    const before = (await service.connections()).find(item => item.app === 'gemini')!;
    expect(before.state).toBe('stale');
    expect(before.warnings[0]).toContain('extalia connect gemini');
    expect(before.warnings[0]).toContain(target);
    await service.apply('gemini');
    expect(await readFile(path.join(home, '.gemini', 'settings.json'), 'utf8')).toContain(forwarderPath(target).replace(/\\/g, '\\\\'));
    const after = (await service.connections()).find(item => item.app === 'gemini')!;
    expect(after.state).toBe('connected');
    expect(after.warnings.join(' ')).not.toContain('extalia connect gemini');
  });
});

describe('agent host and the default data folder', () => {
  it('migrates into the default folder on start, keeps connections, and asks for the new welcome setup once', async () => {
    const home = await temp('extalia-host-home-');
    const env = { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH };
    const legacy = legacyDataDirectories({ platform: process.platform, env, homeDirectory: home })[0]!;
    await mkdir(path.join(legacy, 'config'), { recursive: true });
    const connection = { id: 'c_1', profileId: 'default', name: 'Local', preset: 'custom', api: 'openai-chat', baseUrl: 'http://localhost:9/v1', model: 'm', credential: { kind: 'none' }, features: { memory: 'extalia', skills: 'off' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    await writeFile(path.join(legacy, 'config', 'extalia.json'), JSON.stringify({ schema: 'extalia.host-config.v1', setupComplete: true, workflow: 'observe', profile: { id: 'default', name: 'Personal' }, connections: [connection], workspaces: [] }));

    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', homeDirectory: home, importHome: home, env });
    try {
      const state = await runtime.host.getState();
      expect(state.dataDirectory).toBe(path.join(home, '.extalia-vo'));
      expect(state.storage.dataDirectory).toBe(path.join(home, '.extalia-vo'));
      expect(state.connections.map(item => item.id)).toEqual(['c_1']);
      expect(state.setupComplete).toBe(false);
      expect(await readMigrationMarker(state.dataDirectory)).toMatchObject({ from: legacy });
      expect(await runtime.host.completeSetup('observe')).toMatchObject({ setupComplete: true });
    } finally { await runtime.close(); }
  });

  it('never migrates into an explicit EXTALIA_HOME', async () => {
    const home = await temp('extalia-host-home-');
    const explicit = path.join(home, 'explicit');
    const legacy = legacyDataDirectories({ platform: process.platform, env: {}, homeDirectory: home })[0]!;
    await mkdir(path.join(legacy, 'config'), { recursive: true });
    await writeFile(path.join(legacy, 'config', 'extalia.json'), '{}');
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', homeDirectory: home, importHome: home, env: { EXTALIA_HOME: explicit, EXTALIA_SECRET_STORE: 'memory' } });
    try {
      expect((await runtime.host.getState()).dataDirectory).toBe(explicit);
      expect(await exists(path.join(explicit, 'config', 'extalia.json'))).toBe(false);
      expect(await exists(path.join(home, '.extalia-vo'))).toBe(false);
    } finally { await runtime.close(); }
  });
});
