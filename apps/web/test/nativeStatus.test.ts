import type { HostState, NativeStatus } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { NativeStatusContent, NativeStatusPanel } from '../src/native/NativeStatusPanel';
import { cancelNativeStatusOperation, createNativeStatusMonitor, isNativeStatus } from '../src/native/nativeStatusModel';

const sample = (): NativeStatus => ({
  schema: 'extalia.native-status.v1', sampledAt: '2026-11-08T10:00:00.000Z', backend: 'rust', providerLoop: 'typescript', daemon: { state: 'ready' },
  active: [{ id: 'operation', sessionId: 'session', workspaceId: 'workspace', kind: 'planning', cancellationRequested: true, approvalId: 'approval' }],
  workers: [
    { id: 'worker', sessionId: 'session', workspaceId: 'workspace', kind: 'delegated', state: 'working', active: true, evidence: 'local-invocation', label: 'Research worker' },
    { id: 'task', sessionId: 'session', workspaceId: 'workspace', kind: 'mission-task', state: 'running', active: false, evidence: 'recorded-task', missionId: 'mission' },
  ],
  missions: [{ id: 'mission', sessionId: 'session', workspaceId: 'workspace', title: 'Saved research', state: 'recovering', backend: 'rust', tasks: [{ id: 'task-record', taskId: 'task', title: 'Read sources', state: 'unknown' }] }],
  blockers: [{ id: 'blocker', sessionId: 'session', workspaceId: 'workspace', kind: 'mission-recovery', localActive: false, reason: 'execution-uncertain', missionId: 'mission' }],
  totals: { active: 1, workers: 2, missions: 1, blockers: 1 }, truncated: { active: false, workers: false, missions: false, blockers: false },
});
const state = { sessions: [{ id: 'session', workspaceId: 'workspace', title: 'User session' }], workspaces: [{ id: 'workspace' }] } as HostState;
const render = (language: 'en' | 'id' = 'en', data = sample(), phase: 'ready' | 'stale' = 'ready', hostState = state) => renderToStaticMarkup(createElement(NativeStatusContent, {
  t: MESSAGES[language], state: hostState, view: { phase, data }, onInspect: () => undefined,
}));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());

describe('Native status response boundary', () => {
  it('accepts the versioned DTO and rejects missing/foreign schemas', () => {
    expect(isNativeStatus(sample())).toBe(true);
    expect(isNativeStatus({})).toBe(false);
    expect(isNativeStatus({ ...sample(), schema: 'extalia.native-status.v0' })).toBe(false);
    expect(isNativeStatus({ ...sample(), sampledAt: 'invalid' })).toBe(false);
  });
  it('requires complete evidence and honest totals rather than defaulting malformed arrays to empty', () => {
    expect(isNativeStatus({ ...sample(), active: undefined })).toBe(false);
    expect(isNativeStatus({ ...sample(), truncated: { ...sample().truncated, workers: true } })).toBe(false);
    expect(isNativeStatus({ ...sample(), workers: [{ id: 'worker' }] })).toBe(false);
    expect(isNativeStatus({ ...sample(), totals: { ...sample().totals, workers: 0 } })).toBe(false);
    expect(isNativeStatus({ ...sample(), totals: { ...sample().totals, workers: 3 } })).toBe(false);
    expect(isNativeStatus({ ...sample(), totals: { ...sample().totals, workers: 3 }, truncated: { ...sample().truncated, workers: true } })).toBe(true);
  });
  it('requires an explicit receipt recheck outcome and skipped local activity count', () => {
    const recheck = { status: 'partial', skippedActive: 1, inspected: 2, retired: 0, retained: 2, remaining: 3 };
    expect(isNativeStatus({ ...sample(), recheck })).toBe(true);
    expect(isNativeStatus({ ...sample(), recheck: { ...recheck, status: undefined } })).toBe(false);
    expect(isNativeStatus({ ...sample(), recheck: { ...recheck, skippedActive: undefined } })).toBe(false);
  });
});

describe('Native status evidence presentation', () => {
  it('separates selected backend, provider loop, daemon and recorded versus live worker evidence', () => {
    const html = render();
    expect(html).toContain('Backend for new missions');
    expect(html).toContain('Provider and tool loop');
    expect(html).toContain('Rust daemon');
    expect(html).toContain('Local invocation evidence');
    expect(html).toContain('Recorded task state · does not prove a live process');
    expect(html).toContain('Unresolved saved evidence');
    expect(html).toContain('Execution settlement remains uncertain.');
    expect(html).toContain('Cancellation requested · waiting for settlement');
    expect(html).toContain('Waiting for approval');
    expect(html).toContain('Inspect recovery');
  });
  it('localizes authored states and actions in Indonesian while keeping user content', () => {
    const html = render('id');
    expect(html).toContain('Backend untuk misi baru');
    expect(html).toContain('Penyelesaian eksekusi masih belum pasti.');
    expect(html).toContain('Periksa pemulihan');
    expect(html).toContain('Research worker');
    expect(html).toContain('Saved research');
  });
  it('disables stale actions and explains that the snapshot is last known evidence', () => {
    const html = render('en', sample(), 'stale');
    expect(html).toContain('Last known status · stale');
    expect(html).toMatch(/disabled=""[^>]*>Inspect recovery/);
    expect(html).toMatch(/disabled=""[^>]*>Open Chat/);
  });
  it('never turns unsupported or failed reads into empty healthy sections', () => {
    for (const phase of ['unsupported', 'unavailable'] as const) {
      const html = renderToStaticMarkup(createElement(NativeStatusContent, { t: MESSAGES.en, state, view: { phase } }));
      expect(html).not.toContain('No blocker is reported');
      expect(html).not.toContain('No local Native operation');
      expect(html).toContain(MESSAGES.en.nativeStatus[phase]);
    }
  });
  it('does not offer session actions for unknown current host sessions', () => {
    const html = render('en', sample(), 'ready', { ...state, sessions: [] });
    expect(html).toContain('This session is not available on the current host.');
    expect(html).not.toContain('>Open Chat<');
    expect(html).not.toContain('>Open mission<');
    expect(html).toMatch(/disabled=""[^>]*>Inspect recovery/);
  });
  it('shows truncation and stable daemon problem text without rendering raw errors', () => {
    const data = sample();
    data.totals.workers = 40; data.truncated.workers = true;
    data.daemon.lastError = 'private-provider-detail';
    const html = render('en', data);
    expect(html).toContain('2 of 40');
    expect(html).toContain('additional entries are not shown');
    expect(html).toContain('The daemon reports a problem.');
    expect(html).not.toContain('private-provider-detail');
  });
  it('does not claim an empty section when its entries are truncated away', () => {
    const data = sample(); data.blockers = []; data.truncated.blockers = true;
    const html = render('en', data);
    expect(html).toContain('0 of 1');
    expect(html).not.toContain('No blocker is reported in this snapshot.');
  });
  it('renders an accessible modal without requiring the browser during server rendering', () => {
    const html = renderToStaticMarkup(createElement(NativeStatusPanel, {
      t: MESSAGES.en, agents: {} as Parameters<typeof NativeStatusPanel>[0]['agents'],
      state, onState: () => undefined, onOpenSession: () => undefined, onOpenMissions: () => undefined, onClose: () => undefined,
    }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('aria-describedby=');
    expect(html).toContain('Close Native status');
    expect(html).toContain('Reading Native status…');
  });
  it('labels retired entries as inactive markers and retains partial recheck status', () => {
    const data = sample(); data.recheck = { status: 'partial', skippedActive: 1, inspected: 2, retired: 1, retained: 1, remaining: 2 };
    const html = render('en', data);
    expect(html).toContain('Recheck incomplete');
    expect(html).toContain('1 inactive markers retired');
    expect(html).toContain('1 active operations skipped');
  });
});

describe('Native preparation navigation', () => {
  it('does not turn a preallocated preparation id into a recorded mission link', () => {
    const data = sample();
    data.active = []; data.workers = []; data.missions = [];
    data.blockers = [{ id: 'preparation:example', kind: 'preparation', sessionId: 'session', workspaceId: 'workspace', localActive: false, reason: 'inspection-required', missionId: 'not-created' }];
    data.totals = { active: 0, workers: 0, missions: 0, blockers: 1 };
    const html = render('en', data);
    expect(html).toContain('Preparation');
    expect(html).not.toContain('>Open mission<');
  });
});

describe('Native status reader ownership', () => {
  it('recognizes an older Bridge and stops automatic unsupported-method polling', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => { throw new Error('Unknown method.'); });
    const monitor = createNativeStatusMonitor({ read, onChange: () => undefined });
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.current().phase).toBe('unsupported');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledOnce();
    monitor.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    monitor.dispose();
  });
  it('polls only for its lifetime and discards a reply after the owner closes', async () => {
    vi.useFakeTimers();
    const pending = deferred<NativeStatus>();
    const read = vi.fn(() => pending.promise), onChange = vi.fn();
    const monitor = createNativeStatusMonitor({ read, onChange });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledOnce();
    monitor.dispose(); pending.resolve(sample());
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenLastCalledWith({ phase: 'loading' });
  });
  it('does not begin a scheduled read after immediate disposal', async () => {
    const read = vi.fn(async () => sample());
    const monitor = createNativeStatusMonitor({ read, onChange: () => undefined });
    monitor.dispose();
    await Promise.resolve(); await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
  });
  it('suppresses overlap after a bounded timeout and ignores the late reply', async () => {
    vi.useFakeTimers();
    const pending = deferred<NativeStatus>(), onChange = vi.fn();
    const read = vi.fn<() => Promise<NativeStatus>>().mockReturnValueOnce(pending.promise).mockResolvedValue(sample());
    const monitor = createNativeStatusMonitor({ read, onChange });
    await vi.advanceTimersByTimeAsync(20_000);
    monitor.refresh();
    expect(read).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenLastCalledWith({ phase: 'unavailable', error: 'timeout' });
    pending.resolve(sample()); await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledTimes(2);
    monitor.refresh(); await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenLastCalledWith({ phase: 'ready', data: sample() });
    monitor.dispose();
  });
  it('retains the last successful data as stale when a later read is malformed or fails', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const read = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(sample()).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('private detail'));
    const monitor = createNativeStatusMonitor({ read, onChange });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(onChange).toHaveBeenLastCalledWith({ phase: 'stale', data: sample(), error: 'malformed' });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(onChange).toHaveBeenLastCalledWith({ phase: 'stale', data: sample(), error: 'read' });
    monitor.dispose();
  });
  it('passes the exact run id and rejects stale callbacks before they can cancel a replacement operation', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn<(...args: [string, string?]) => Promise<void>>().mockResolvedValue(undefined);
    const pending = deferred<NativeStatus>();
    const read = vi.fn<() => Promise<NativeStatus>>().mockResolvedValueOnce(sample()).mockReturnValueOnce(pending.promise);
    const monitor = createNativeStatusMonitor({ read, onChange: () => undefined });
    await vi.advanceTimersByTimeAsync(0);
    await cancelNativeStatusOperation({ cancel }, monitor.current, 'session', 'operation');
    expect(cancel).toHaveBeenCalledExactlyOnceWith('session', 'operation');
    monitor.invalidate();
    expect(cancelNativeStatusOperation({ cancel }, monitor.current, 'session', 'operation')).toBe(false);
    monitor.refresh();
    expect(cancelNativeStatusOperation({ cancel }, monitor.current, 'session', 'operation')).toBe(false);
    const replacement = sample(); replacement.active[0]!.id = 'replacement-operation';
    pending.resolve(replacement); await vi.advanceTimersByTimeAsync(0);
    expect(cancelNativeStatusOperation({ cancel }, monitor.current, 'session', 'operation')).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    await cancelNativeStatusOperation({ cancel }, monitor.current, 'session', 'replacement-operation');
    expect(cancel).toHaveBeenLastCalledWith('session', 'replacement-operation');
    monitor.dispose();
  });
  it('invalidates immediately and ignores an older in-flight reply before one fresh follow-up read', async () => {
    vi.useFakeTimers();
    const older = deferred<NativeStatus>(), newer = deferred<NativeStatus>();
    const read = vi.fn<() => Promise<NativeStatus>>().mockResolvedValueOnce(sample()).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const monitor = createNativeStatusMonitor({ read, onChange: () => undefined });
    await vi.advanceTimersByTimeAsync(0);
    monitor.refresh(); await vi.advanceTimersByTimeAsync(0);
    expect(monitor.current().phase).toBe('refreshing');
    monitor.invalidate(); monitor.invalidate();
    expect(monitor.current()).toMatchObject({ phase: 'stale', error: 'changed' });
    expect(read).toHaveBeenCalledTimes(2);
    older.resolve(sample()); await vi.advanceTimersByTimeAsync(0);
    expect(monitor.current().phase).toBe('refreshing');
    expect(read).toHaveBeenCalledTimes(3);
    const replacement = sample(); replacement.active = []; replacement.totals.active = 0;
    newer.resolve(replacement); await vi.advanceTimersByTimeAsync(0);
    expect(monitor.current()).toEqual({ phase: 'ready', data: replacement });
    monitor.dispose();
  });
  it('reports optional older host capability as unsupported', () => {
    const onChange = vi.fn();
    const monitor = createNativeStatusMonitor({ onChange });
    monitor.refresh();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenLastCalledWith({ phase: 'unsupported' });
    monitor.dispose();
  });
});
