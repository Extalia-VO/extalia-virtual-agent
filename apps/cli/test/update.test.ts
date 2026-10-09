import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UpdateStatus } from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REGISTRY_LATEST_URL, SOURCE_DETAIL, UPDATE_CHECK_INTERVAL_MS, UPDATE_COMMAND, compareVersions, createUpdater, installBlocker, installKind,
  isCacheFresh, isGlobalInstall, isNewerVersion, npmInstallCommand, readInstalledVersion, runUpdateCommand, type UpdaterOptions,
} from '../src/update';

const identity = (value: string) => value;

describe('versions', () => {
  it('orders versions by semantic versioning precedence', () => {
    const ordered = ['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0'];
    for (let index = 1; index < ordered.length; index++) {
      expect(compareVersions(ordered[index - 1]!, ordered[index]!), `${ordered[index - 1]} < ${ordered[index]}`).toBe(-1);
      expect(compareVersions(ordered[index]!, ordered[index - 1]!)).toBe(1);
    }
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('treats invalid versions as never newer', () => {
    expect(() => compareVersions('1.0', '1.0.0')).toThrow(/Invalid version/);
    expect(isNewerVersion('latest', '1.0.0')).toBe(false);
    expect(isNewerVersion('01.0.0', '0.0.1')).toBe(false);
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0-rc.1')).toBe(true);
    expect(isNewerVersion('1.0.0-rc.1', '1.0.0')).toBe(false);
  });
});

describe('installation detection', () => {
  it('detects global npm installs on POSIX and Windows paths', () => {
    expect(isGlobalInstall('/usr/local/lib/node_modules/extalia-vo/dist/extalia.mjs', identity)).toBe(true);
    expect(isGlobalInstall('/home/someone/.nvm/versions/node/v24.1.0/lib/node_modules/extalia-vo/dist/extalia.mjs', identity)).toBe(true);
    expect(isGlobalInstall('C:\\Users\\name\\AppData\\Roaming\\npm\\node_modules\\extalia-vo\\dist\\extalia.mjs', identity)).toBe(true);
  });

  it('treats source checkouts, look-alike names and npx caches as unsupported', () => {
    expect(installKind('/home/someone/src/extalia-virtual-agent/apps/cli/dist/extalia.mjs', identity)).toBe('source');
    expect(installKind('/usr/local/lib/node_modules/extalia-vo-fork/dist/extalia.mjs', identity)).toBe('source');
    expect(installKind('/usr/local/lib/node_modules/extalia-vo', identity)).toBe('source');
    expect(installKind('C:\\code\\extalia\\apps\\cli\\dist\\extalia.mjs', identity)).toBe('source');
    expect(installKind('/home/someone/.npm/_npx/1a2b/node_modules/extalia-vo/dist/extalia.mjs', identity)).toBe('npx');
  });

  it('uses the real path of the bin, so a linked checkout is not a global install', () => {
    const realpath = (value: string) => (value === '/usr/local/bin/extalia' ? '/home/someone/src/extalia/apps/cli/dist/extalia.mjs' : value);
    expect(isGlobalInstall('/usr/local/bin/extalia', realpath)).toBe(false);
    const npmLink = (value: string) => (value === '/usr/local/bin/extalia' ? '/usr/local/lib/node_modules/extalia-vo/dist/extalia.mjs' : value);
    expect(isGlobalInstall('/usr/local/bin/extalia', npmLink)).toBe(true);
  });

  it('builds the npm command for each platform', () => {
    expect(npmInstallCommand('linux')).toEqual({ command: 'npm', args: ['i', '-g', 'extalia-vo@latest', '--prefer-online'], shell: false });
    expect(npmInstallCommand('win32')).toEqual({ command: 'npm.cmd i -g extalia-vo@latest --prefer-online', args: [], shell: true });
    expect(UPDATE_COMMAND).toBe('npm i -g extalia-vo@latest --prefer-online');
  });
});

describe('updater', () => {
  let dir: string, cacheFile: string, requests: { url: string; init: RequestInit | undefined }[], registry: () => Response, now: number;

  const fakeFetch = (async (url: string, init?: RequestInit) => { requests.push({ url, init }); return registry(); }) as unknown as typeof fetch;
  const options = (overrides: Partial<UpdaterOptions> = {}): UpdaterOptions => ({
    current: '1.0.0', kind: 'global', cacheFile, fetch: fakeFetch, now: () => now,
    runInstall: async () => 0, installedVersion: async () => '1.1.0', ...overrides,
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'extalia-update-'));
    cacheFile = path.join(dir, 'state', 'update-check.json');
    requests = [];
    registry = () => Response.json({ name: 'extalia-vo', version: '1.1.0' });
    now = Date.parse('2026-03-01T12:00:00.000Z');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('asks the registry without caching and stores the result', async () => {
    const updater = createUpdater(options());
    expect(updater.status().state).toBe('idle');
    const status = await updater.check();
    expect(status).toEqual({ current: '1.0.0', latest: '1.1.0', channel: 'stable', state: 'available', command: UPDATE_COMMAND });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(REGISTRY_LATEST_URL);
    expect(requests[0]?.init?.cache).toBe('no-store');
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toEqual({ checkedAt: '2026-03-01T12:00:00.000Z', latest: '1.1.0' });
  });

  it('uses the cache for 12 hours unless the check is forced', async () => {
    await createUpdater(options()).check();
    registry = () => Response.json({ version: '1.2.0' });
    now += UPDATE_CHECK_INTERVAL_MS - 1;
    expect((await createUpdater(options()).check()).latest).toBe('1.1.0');
    expect(requests).toHaveLength(1);
    expect((await createUpdater(options()).check({ force: true })).latest).toBe('1.2.0');
    expect(requests).toHaveLength(2);
    now += UPDATE_CHECK_INTERVAL_MS;
    registry = () => Response.json({ version: '1.3.0' });
    expect((await createUpdater(options()).check()).latest).toBe('1.3.0');
    expect(requests).toHaveLength(3);
  });

  it('judges cache freshness, including clocks that moved backwards', () => {
    const cache = { checkedAt: '2026-03-01T12:00:00.000Z', latest: '1.0.0' };
    const at = Date.parse(cache.checkedAt);
    expect(isCacheFresh(cache, at + 1000)).toBe(true);
    expect(isCacheFresh(cache, at + UPDATE_CHECK_INTERVAL_MS)).toBe(false);
    expect(isCacheFresh(cache, at - 1000)).toBe(false);
    expect(isCacheFresh({ checkedAt: 'garbage', latest: '1.0.0' }, at)).toBe(false);
    expect(isCacheFresh(undefined, at)).toBe(false);
  });

  it('ignores a corrupt cache and reports up-to-date or older registry versions', async () => {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, '{not json');
    registry = () => Response.json({ version: '1.0.0' });
    expect((await createUpdater(options()).check()).state).toBe('up-to-date');
    registry = () => Response.json({ version: '0.9.0' });
    expect((await createUpdater(options()).check({ force: true })).state).toBe('up-to-date');
    registry = () => Response.json({ version: '1.1.0-beta.1' });
    expect((await createUpdater(options({ current: '1.1.0-alpha.3' })).check({ force: true })).state).toBe('available');
  });

  it('reports registry failures as errors without caching them', async () => {
    registry = () => new Response('nope', { status: 503 });
    const status = await createUpdater(options()).check();
    expect(status.state).toBe('error');
    expect(status.detail).toMatch(/Could not check for updates: the npm registry answered 503/);
    registry = () => Response.json({ version: 'not-a-version' });
    expect((await createUpdater(options()).check()).detail).toMatch(/no valid version/);
    const timeout = (async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as unknown as typeof fetch;
    expect((await createUpdater(options({ fetch: timeout })).check()).detail).toMatch(/did not answer in time/);
    await expect(readFile(cacheFile, 'utf8')).rejects.toThrow();
  });

  it('shares one request between concurrent checks', async () => {
    const updater = createUpdater(options());
    const [a, b] = await Promise.all([updater.check({ force: true }), updater.check({ force: true })]);
    expect(a).toBe(b);
    expect(requests).toHaveLength(1);
  });

  it('is unsupported when running from source and never contacts the registry', async () => {
    const updater = createUpdater(options({ kind: 'source' }));
    const status = await updater.check({ force: true });
    expect(status).toEqual({ current: '1.0.0', channel: 'stable', state: 'unsupported', detail: SOURCE_DETAIL, command: UPDATE_COMMAND });
    expect(SOURCE_DETAIL).toBe('Running from source; update with git pull and pnpm install.');
    expect(requests).toHaveLength(0);
    expect((await createUpdater(options({ kind: 'npx' })).check()).detail).toMatch(/npx extalia-vo@latest/);
  });

  it('installs, verifies the installed version and reports failures', async () => {
    const updater = createUpdater(options());
    await updater.check();
    const done = updater.install();
    expect(updater.status().state).toBe('installing');
    expect(await done).toMatchObject({ state: 'ready', latest: '1.1.0' });

    const failing = createUpdater(options({ runInstall: async () => 243 }));
    await failing.check();
    expect(await failing.install()).toMatchObject({ state: 'error', detail: `npm exited with code 243. Run it yourself: ${UPDATE_COMMAND}`, latest: '1.1.0' });

    const missingNpm = createUpdater(options({ runInstall: async () => { throw new Error('spawn npm ENOENT'); } }));
    expect((await missingNpm.install()).detail).toMatch(/Could not run npm: spawn npm ENOENT/);

    // npm succeeded for another prefix: this copy did not change.
    const elsewhere = createUpdater(options({ installedVersion: async () => '1.0.0' }));
    expect(await elsewhere.install()).toMatchObject({ state: 'error', detail: expect.stringMatching(/still 1\.0\.0/) });
  });

  it('decides when an install may start', () => {
    const base: UpdateStatus = { current: '1.0.0', latest: '1.1.0', channel: 'stable', state: 'available' };
    expect(installBlocker(base, false)).toBeUndefined();
    expect(installBlocker(base, true)).toMatch(/Agents are still working/);
    expect(installBlocker({ ...base, state: 'error' }, false)).toBeUndefined();
    expect(installBlocker({ ...base, state: 'installing' }, false)).toMatch(/already being installed/);
    expect(installBlocker({ ...base, state: 'ready' }, false)).toMatch(/already being installed/);
    expect(installBlocker({ ...base, state: 'checking' }, false)).toMatch(/Still checking/);
    expect(installBlocker({ ...base, state: 'up-to-date', latest: '1.0.0' }, false)).toMatch(/No update is available/);
    expect(installBlocker({ current: '1.0.0', channel: 'stable', state: 'idle' }, false)).toMatch(/No update is available/);
    expect(installBlocker({ ...base, state: 'unsupported', detail: SOURCE_DETAIL }, false)).toBe(SOURCE_DETAIL);
  });

  it('reads the installed version next to the bundle', async () => {
    const bin = path.join(dir, 'node_modules', 'extalia-vo', 'dist', 'extalia.mjs');
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(path.join(dir, 'node_modules', 'extalia-vo', 'package.json'), JSON.stringify({ name: 'extalia-vo', version: '2.0.0' }));
    expect(await readInstalledVersion(bin, identity)).toBe('2.0.0');
    await writeFile(path.join(dir, 'node_modules', 'extalia-vo', 'package.json'), JSON.stringify({ name: 'other', version: '2.0.0' }));
    expect(await readInstalledVersion(bin, identity)).toBeUndefined();
    expect(await readInstalledVersion(path.join(dir, 'missing', 'extalia.mjs'), identity)).toBeUndefined();
  });
});

describe('extalia update', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'extalia-update-cli-')); });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const io = () => {
    const out: string[] = [], err: string[] = [];
    return { out, err, value: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } };
  };
  const updater = (overrides: Partial<UpdaterOptions> = {}, version = '1.1.0') => createUpdater({
    current: '1.0.0', kind: 'global', cacheFile: path.join(dir, 'state', 'update-check.json'),
    fetch: (async () => Response.json({ version })) as unknown as typeof fetch,
    runInstall: async () => 0, installedVersion: async () => version, ...overrides,
  });

  it('checks only with --check', async () => {
    let installs = 0;
    const result = io();
    expect(await runUpdateCommand({ check: true }, updater({ runInstall: async () => { installs++; return 0; } }), result.value)).toBe(0);
    expect(result.out).toEqual(['Extalia 1.1.0 is available (installed: 1.0.0). Run: extalia update']);
    expect(installs).toBe(0);
  });

  it('installs and prints the new version', async () => {
    const result = io();
    expect(await runUpdateCommand({ check: false }, updater(), result.value)).toBe(0);
    expect(result.out).toEqual([`Installing Extalia 1.1.0: ${UPDATE_COMMAND}`, 'Extalia updated to 1.1.0. Restart running Extalia instances to use it.']);
  });

  it('reports up-to-date, unsupported and failed updates', async () => {
    const current = io();
    expect(await runUpdateCommand({ check: false }, updater({}, '1.0.0'), current.value)).toBe(0);
    expect(current.out).toEqual(['Extalia 1.0.0 is up to date.']);
    const source = io();
    expect(await runUpdateCommand({ check: false }, updater({ kind: 'source' }), source.value)).toBe(1);
    expect(source.err).toEqual([SOURCE_DETAIL]);
    const failed = io();
    expect(await runUpdateCommand({ check: false }, updater({ runInstall: async () => 1 }), failed.value)).toBe(1);
    expect(failed.err[0]).toMatch(/npm exited with code 1/);
  });
});
