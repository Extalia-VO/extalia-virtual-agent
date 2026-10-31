import type { HostState } from '@extalia/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostStateMonitor } from '../src/host/hostStateMonitor';

const state = (dataDirectory: string) => ({ dataDirectory }) as HostState;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

afterEach(() => vi.useRealTimers());

describe('host connection monitor', () => {
  it('detects an idle host disconnect and recovers when polling succeeds again', async () => {
    vi.useFakeTimers();
    const first = state('first');
    const recovered = state('recovered');
    const failure = new TypeError('Failed to fetch');
    const getState = vi.fn<() => Promise<HostState>>()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(recovered);
    const onState = vi.fn();
    const onError = vi.fn();
    const monitor = createHostStateMonitor({ getState, onState, onError });
    await vi.advanceTimersByTimeAsync(0);
    expect(onState).toHaveBeenLastCalledWith(first);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onError).toHaveBeenLastCalledWith(failure);
    expect(onState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onState).toHaveBeenLastCalledWith(recovered);
    monitor.dispose();
  });

  it('bounds stalled calls, coalesces refreshes and ignores their late results', async () => {
    vi.useFakeTimers();
    const stalled = deferred<HostState>();
    const recovered = state('recovered');
    const getState = vi.fn<() => Promise<HostState>>()
      .mockReturnValueOnce(stalled.promise)
      .mockResolvedValue(recovered);
    const onState = vi.fn();
    const onError = vi.fn();
    const monitor = createHostStateMonitor({ getState, onState, onError });
    monitor.refresh();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    monitor.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(onState).toHaveBeenLastCalledWith(recovered);
    stalled.resolve(state('stale'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onState).toHaveBeenCalledTimes(1);
    monitor.dispose();
  });

  it('does not replace an applied mutation with an older request or its failure', async () => {
    vi.useFakeTimers();
    const stale = deferred<HostState>();
    const applied = state('applied');
    const onState = vi.fn();
    const onError = vi.fn();
    const monitor = createHostStateMonitor({ getState: () => stale.promise, onState, onError });
    await vi.advanceTimersByTimeAsync(0);
    monitor.apply(applied);
    stale.reject(new Error('Old request failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onState).toHaveBeenCalledExactlyOnceWith(applied);
    expect(onError).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it('retries manually and stops timers and pending callbacks on disposal', async () => {
    vi.useFakeTimers();
    const pending = deferred<HostState>();
    const getState = vi.fn<() => Promise<HostState>>()
      .mockRejectedValueOnce(new Error('Host stopped'))
      .mockReturnValue(pending.promise);
    const onState = vi.fn();
    const onError = vi.fn();
    const monitor = createHostStateMonitor({ getState, onState, onError });
    await vi.advanceTimersByTimeAsync(0);
    monitor.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(getState).toHaveBeenCalledTimes(2);
    monitor.dispose();
    pending.resolve(state('late'));
    monitor.refresh();
    monitor.apply(state('late apply'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onState).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(getState).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
