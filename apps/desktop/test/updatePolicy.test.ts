import type { UpdateStatus } from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTART_DELAY_SECONDS, UpdatePolicy, WAITING_FOR_AGENTS, updateChannel, updateErrorDetail, type UpdateDriver } from '../src/updatePolicy';

class FakeWork {
  busy = false;
  private listeners = new Set<() => void>();
  isBusy = () => this.busy;
  onIdle = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get waiting() { return this.listeners.size; }
  finish() { this.busy = false; for (const listener of [...this.listeners]) listener(); }
}

function setup(options: { driver?: UpdateDriver | null } = {}) {
  const work = new FakeWork();
  const driver = { check: vi.fn(async () => undefined), quitAndInstall: vi.fn() };
  const statuses: UpdateStatus[] = [];
  const policy = new UpdatePolicy({
    current: '0.1.0',
    channel: 'stable',
    driver: options.driver === null ? undefined : options.driver ?? driver,
    unsupportedDetail: 'Updates are installed by packaged builds.',
    work,
    onStatus: status => statuses.push(status),
  });
  return { policy, work, driver, statuses };
}

/** Simulate electron-updater finding and downloading 0.2.0. */
function download(policy: UpdatePolicy): void {
  policy.handle({ type: 'checking' });
  policy.handle({ type: 'available', version: '0.2.0' });
  policy.handle({ type: 'progress', percent: 50 });
  policy.handle({ type: 'downloaded', version: '0.2.0' });
}

describe('update policy', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reads the channel from the environment value', () => {
    expect(updateChannel(undefined)).toBe('stable');
    expect(updateChannel(' Beta ')).toBe('beta');
    expect(updateChannel('nightly')).toBe('stable');
  });

  it('maps updater events to statuses', () => {
    const { policy, statuses } = setup();
    expect(policy.status()).toEqual({ current: '0.1.0', channel: 'stable', state: 'idle' });
    policy.handle({ type: 'checking' });
    policy.handle({ type: 'not-available', version: '0.1.0' });
    policy.handle({ type: 'available', version: '0.2.0' });
    policy.handle({ type: 'progress', percent: 42.5 });
    policy.handle({ type: 'progress', percent: 140 });
    policy.handle({ type: 'error', error: Object.assign(new Error('Cannot find latest.yml\nXML: <feed/>'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }) });
    expect(statuses.map(({ state, latest, progress, detail }) => ({ state, latest, progress, detail }))).toEqual([
      { state: 'checking', latest: undefined, progress: undefined, detail: undefined },
      { state: 'up-to-date', latest: '0.1.0', progress: undefined, detail: undefined },
      { state: 'available', latest: '0.2.0', progress: undefined, detail: undefined },
      { state: 'downloading', latest: '0.2.0', progress: 0.425, detail: undefined },
      { state: 'downloading', latest: '0.2.0', progress: 1, detail: undefined },
      { state: 'error', latest: '0.2.0', progress: undefined, detail: 'No release is published for this platform yet.' },
    ]);
    expect(statuses.every(status => status.current === '0.1.0' && status.channel === 'stable')).toBe(true);
    expect(Object.keys(statuses[0]!)).toEqual(['current', 'channel', 'state']);
  });

  it('keeps error details short and readable', () => {
    expect(updateErrorDetail(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe('The update server could not be reached.');
    expect(updateErrorDetail(new Error('Could not get code signature for running application'))).toBe('This build is not code-signed, so it cannot install updates.');
    expect(updateErrorDetail(new Error(`Something odd ${'x'.repeat(400)}\n    at stack`))).toHaveLength(160);
    expect(updateErrorDetail(undefined)).toBe('The update failed.');
  });

  it('restarts into a downloaded update after a ten-second countdown', () => {
    const { policy, driver, statuses } = setup();
    download(policy);
    expect(policy.status()).toMatchObject({ state: 'ready', latest: '0.2.0', restartInSeconds: RESTART_DELAY_SECONDS });
    vi.advanceTimersByTime(1000);
    expect(policy.status().restartInSeconds).toBe(9);
    vi.advanceTimersByTime(8000);
    expect(policy.status().restartInSeconds).toBe(1);
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(driver.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(policy.status()).toEqual({ current: '0.1.0', channel: 'stable', state: 'installing', latest: '0.2.0' });
    expect(statuses.filter(status => status.restartInSeconds !== undefined).map(status => status.restartInSeconds)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it('waits until agents are idle before counting down', () => {
    const { policy, work, driver } = setup();
    work.busy = true;
    download(policy);
    expect(policy.status()).toEqual({ current: '0.1.0', channel: 'stable', state: 'ready', latest: '0.2.0', detail: WAITING_FOR_AGENTS });
    vi.advanceTimersByTime(60_000);
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    work.finish();
    expect(work.waiting).toBe(0);
    expect(policy.status().restartInSeconds).toBe(RESTART_DELAY_SECONDS);
    vi.advanceTimersByTime(RESTART_DELAY_SECONDS * 1000);
    expect(driver.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('waits again when an agent starts during the countdown', () => {
    const { policy, work, driver } = setup();
    download(policy);
    vi.advanceTimersByTime(5000);
    work.busy = true;
    vi.advanceTimersByTime(5000);
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    expect(policy.status()).toMatchObject({ state: 'ready', detail: WAITING_FOR_AGENTS });
    expect(policy.status().restartInSeconds).toBeUndefined();
    work.finish();
    vi.advanceTimersByTime(RESTART_DELAY_SECONDS * 1000);
    expect(driver.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('postpone cancels the countdown and the wait for idle agents', () => {
    const { policy, driver } = setup();
    download(policy);
    vi.advanceTimersByTime(3000);
    policy.postpone();
    expect(policy.status()).toEqual({ current: '0.1.0', channel: 'stable', state: 'ready', latest: '0.2.0' });
    vi.advanceTimersByTime(60_000);
    expect(driver.quitAndInstall).not.toHaveBeenCalled();

    const waiting = setup();
    waiting.work.busy = true;
    download(waiting.policy);
    waiting.policy.postpone();
    expect(waiting.work.waiting).toBe(0);
    waiting.work.finish();
    vi.advanceTimersByTime(60_000);
    expect(waiting.driver.quitAndInstall).not.toHaveBeenCalled();
  });

  it('install restarts immediately but refuses while an agent works', () => {
    const { policy, work, driver } = setup();
    expect(() => policy.install()).toThrow('No update is ready to install.');
    policy.handle({ type: 'available', version: '0.2.0' });
    expect(() => policy.install()).toThrow('The update is still downloading.');
    policy.handle({ type: 'downloaded', version: '0.2.0' });
    policy.postpone();
    work.busy = true;
    expect(() => policy.install()).toThrow('An agent is still working. Restart when it has finished.');
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    work.busy = false;
    policy.install();
    expect(driver.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(policy.status().state).toBe('installing');
  });

  it('reports a failed install as an error', () => {
    const { policy, driver } = setup();
    driver.quitAndInstall.mockImplementation(() => { throw new Error('Squirrel failed'); });
    download(policy);
    policy.install();
    expect(policy.status()).toMatchObject({ state: 'error', detail: 'Squirrel failed' });
    vi.advanceTimersByTime(60_000);
    expect(driver.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('checks the feed unless an update is already on its way', async () => {
    const { policy, driver } = setup();
    expect(await policy.check()).toMatchObject({ state: 'idle' });
    expect(driver.check).toHaveBeenCalledTimes(1);
    driver.check.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));
    expect(await policy.check()).toMatchObject({ state: 'error', detail: 'The update server could not be reached.' });
    download(policy);
    await policy.check();
    expect(driver.check).toHaveBeenCalledTimes(2);
  });

  it('reports unpackaged builds as unsupported', async () => {
    const { policy, statuses } = setup({ driver: null });
    const unsupported = { current: '0.1.0', channel: 'stable', state: 'unsupported', detail: 'Updates are installed by packaged builds.' };
    expect(policy.status()).toEqual(unsupported);
    expect(await policy.check()).toEqual(unsupported);
    expect(() => policy.install()).toThrow('Updates are installed by packaged builds.');
    policy.postpone();
    expect(statuses).toEqual([]);
  });
});
