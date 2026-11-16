import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('EXTALIA_TEST_REQUIRE_DAEMON', '0');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules(); });

describe('real daemon test prerequisites', () => {
  it('keeps the TypeScript backend runnable when an explicitly selected test daemon is absent', async () => {
    const missing = path.join(await temp(), 'unbuilt-daemon');
    vi.stubEnv('EXTALIA_TEST_DAEMON_PATH', missing);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = await import('./daemonBackend.js');
    expect(fixture.DAEMON_BINARY).toBe(missing);
    expect(fixture.HAS_DAEMON).toBe(false);
    expect(fixture.backends()).toEqual(['typescript']);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('is not built'));
  });

  it('fails required-daemon integration jobs instead of silently skipping a missing binary', async () => {
    vi.stubEnv('EXTALIA_TEST_DAEMON_PATH', path.join(await temp(), 'unbuilt-daemon'));
    vi.stubEnv('EXTALIA_TEST_REQUIRE_DAEMON', '1');
    await expect(import('./daemonBackend.js')).rejects.toThrow('Required test daemon is missing');
  });
});
