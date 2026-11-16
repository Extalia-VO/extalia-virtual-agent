import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { discoverAntigravityHandoverEndpoint } from '../src/antigravityEndpoint.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const record = (pid: number, httpPort: number, csrfToken = 'fixture-csrf-token') => ({ pid, httpPort, csrfToken, lsVersion: 'fixture-version' });
async function fixture() {
  const homeDirectory = await temp('extalia-endpoint-'), root = path.join(homeDirectory, '.gemini', 'antigravity'), daemon = path.join(root, 'daemon');
  await mkdir(daemon, { recursive: true }); return { homeDirectory, root, daemon };
}
async function metadata(folder: string, name: string, value: unknown, time?: number) {
  const location = path.join(folder, name); await writeFile(location, JSON.stringify(value));
  if (time !== undefined) await utimes(location, new Date(time), new Date(time));
  return location;
}

describe('Antigravity handover endpoint discovery', () => {
  it('uses the complete explicit endpoint without probing or falling back to a daemon record', async () => {
    const f = await fixture(), alive = vi.fn(() => { throw new Error('Daemon discovery must not run'); });
    await metadata(f.daemon, 'live.json', record(101, 4101));
    const selected = await discoverAntigravityHandoverEndpoint({ homeDirectory: f.homeDirectory, alive, env: { ANTIGRAVITY_LS_ADDRESS: ' 127.0.0.1:4999 ', ANTIGRAVITY_CSRF_TOKEN: ' explicit-fixture-token ' } });
    expect(selected).toEqual({ address: '127.0.0.1:4999', csrfToken: 'explicit-fixture-token', identity: 'explicit-native-endpoint' });
    expect(alive).not.toHaveBeenCalled();
  });

  it('rejects malformed, dead, out-of-range and oversized daemon metadata', async () => {
    const f = await fixture(), alive = vi.fn(() => false);
    await writeFile(path.join(f.daemon, 'malformed.json'), '{not JSON');
    const invalid: unknown[] = [null, {}, record(-1, 4101), record(1.5, 4101), record(102, 0), record(103, 65536), record(104, 4101.5),
      { ...record(105, 4101), httpPort: '4101' }, record(106, 4101, ''), record(107, 4101, 'bad\ntoken'), record(108, 4101, 'x'.repeat(4097)), { ...record(109, 4101), padding: 'x'.repeat(17 * 1024) }];
    await Promise.all(invalid.map((value, index) => metadata(f.daemon, `invalid-${index}.json`, value)));
    await metadata(f.daemon, 'dead.json', record(110, 4110));
    expect(await discoverAntigravityHandoverEndpoint({ homeDirectory: f.homeDirectory, env: {}, alive })).toBeUndefined();
    expect(alive).toHaveBeenCalledExactlyOnceWith(110);
  });

  it('chooses the newest valid live daemon and retains a stable secret-free identity', async () => {
    const f = await fixture(), base = Date.UTC(2020, 0, 1), alive = vi.fn((pid: number) => pid !== 203);
    await metadata(f.daemon, 'older.json', record(201, 4201, 'older-fixture-token'), base);
    await metadata(f.daemon, 'newer.json', record(202, 4202, 'selected-fixture-token'), base + 1000);
    await metadata(f.daemon, 'newest-but-dead.json', record(203, 4203), base + 2000);
    const options = { homeDirectory: f.homeDirectory, env: {}, alive }, selected = await discoverAntigravityHandoverEndpoint(options);
    expect(selected).toMatchObject({ address: '127.0.0.1:4202', csrfToken: 'selected-fixture-token' });
    expect(selected?.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(selected?.identity).not.toContain('selected-fixture-token'); expect(selected?.identity).not.toContain(f.homeDirectory);
    expect(selected?.identity).not.toContain('fixture-version'); expect(Object.keys(selected!).sort()).toEqual(['address', 'csrfToken', 'identity']);
    expect(await discoverAntigravityHandoverEndpoint(options)).toEqual(selected);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked daemon record instead of reading its target', async () => {
    const f = await fixture(), outside = await temp('extalia-endpoint-outside-'), alive = vi.fn(() => true);
    const target = await metadata(outside, 'external.json', record(301, 4301));
    await symlink(target, path.join(f.daemon, 'linked.json'));
    expect(await discoverAntigravityHandoverEndpoint({ homeDirectory: f.homeDirectory, env: {}, alive })).toBeUndefined();
    expect(alive).not.toHaveBeenCalled();
  });

  it('honors ANTIGRAVITY_HOME and never falls back to the default home when that override has no live daemon', async () => {
    const f = await fixture(), override = await temp('extalia-endpoint-profile-'), daemon = path.join(override, 'daemon'); await mkdir(daemon);
    await metadata(f.daemon, 'default.json', record(401, 4401), Date.UTC(2020, 0, 3));
    await metadata(daemon, 'override.json', record(402, 4402), Date.UTC(2020, 0, 1));
    const env = { ANTIGRAVITY_HOME: ` ${override} ` };
    expect(await discoverAntigravityHandoverEndpoint({ homeDirectory: f.homeDirectory, env, alive: () => true })).toMatchObject({ address: '127.0.0.1:4402' });
    const alive = vi.fn((pid: number) => pid === 401);
    expect(await discoverAntigravityHandoverEndpoint({ homeDirectory: f.homeDirectory, env, alive })).toBeUndefined();
    expect(alive).toHaveBeenCalledExactlyOnceWith(402);
  });

  it('returns no endpoint for absent discovery data or a failed liveness check', async () => {
    const homeDirectory = await temp('extalia-endpoint-empty-'), alive = vi.fn(() => { throw new Error('Not alive'); });
    expect(await discoverAntigravityHandoverEndpoint({ homeDirectory, env: {}, alive })).toBeUndefined(); expect(alive).not.toHaveBeenCalled();
    const f = await fixture(); await metadata(f.daemon, 'unreachable.json', record(501, 4501));
    expect(await discoverAntigravityHandoverEndpoint({ homeDirectory: f.homeDirectory, env: {}, alive })).toBeUndefined();
    expect(alive).toHaveBeenCalledExactlyOnceWith(501);
  });
});
