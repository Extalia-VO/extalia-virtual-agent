import { EventEmitter, getEventListeners } from 'node:events';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Worker, WorkerOptions } from 'node:worker_threads';
import type * as WorkerThreads from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileTools } from '../src/tools/files.js';
import { runTool, useTempDirs } from './helpers.js';

const workerFactory = vi.hoisted(() => ({
  create: undefined as ((script: string | URL, options?: WorkerOptions) => Worker) | undefined,
}));

// Intercept construction inside this suite without adding a worker injection API to the tools.
vi.mock('node:worker_threads', async importOriginal => {
  const actual = await importOriginal<typeof WorkerThreads>();
  return {
    ...actual,
    Worker: class {
      constructor(script: string | URL, options?: WorkerOptions) {
        return workerFactory.create?.(script, options) ?? new actual.Worker(script, options);
      }
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class SearchWorker extends EventEmitter {
  readonly stopped = deferred<number>();
  readonly terminate = vi.fn(() => this.stopped.promise);
}

const tempDir = useTempDirs();
const searchResult = { matches: ['sample.txt:1: needle'], searched: 1, skipped: 0, truncated: false };
let root: string;
let worker: SearchWorker;
let created: ReturnType<typeof deferred<void>>;

beforeEach(async () => {
  root = await tempDir('extalia-search-lifecycle-');
  await writeFile(path.join(root, 'sample.txt'), 'needle\n');
  worker = new SearchWorker();
  created = deferred<void>();
  workerFactory.create = () => {
    created.resolve();
    return worker as unknown as Worker;
  };
});

afterEach(() => {
  workerFactory.create = undefined;
  vi.useRealTimers();
});

async function search(controller = new AbortController()) {
  const promise = runTool(createFileTools(root, { searchTimeoutMs: 1000 }), 'search_files', { pattern: 'needle', path: 'sample.txt' }, controller.signal);
  const observed = { settled: false };
  void promise.then(() => { observed.settled = true; }, () => { observed.settled = true; });
  await created.promise;
  return { promise, observed, controller };
}

async function flush() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function expectCleaned(controller: AbortController) {
  expect(worker.listenerCount('message')).toBe(0);
  expect(worker.listenerCount('error')).toBe(0);
  expect(worker.listenerCount('exit')).toBe(0);
  expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  // No late abort may issue another termination request after completion.
  controller.abort();
  expect(worker.terminate).toHaveBeenCalledTimes(1);
}

describe('search worker physical settlement', () => {
  it.each(['message', 'error', 'abort', 'timeout'] as const)('waits for confirmed termination after %s and ignores competing outcomes', async trigger => {
    vi.useFakeTimers();
    const pending = await search();
    if (trigger === 'message') worker.emit('message', searchResult);
    if (trigger === 'error') worker.emit('error', new Error('search failed'));
    if (trigger === 'abort') pending.controller.abort();
    if (trigger === 'timeout') await vi.advanceTimersByTimeAsync(1000);
    worker.emit('message', searchResult);
    worker.emit('error', new Error('late error'));
    pending.controller.abort();
    await vi.advanceTimersByTimeAsync(2000);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(pending.observed.settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    worker.stopped.resolve(1);
    if (trigger === 'error') await expect(pending.promise).rejects.toThrow('search failed');
    else if (trigger === 'message') await expect(pending.promise).resolves.toMatchObject({ ok: true, output: 'sample.txt:1: needle' });
    else await expect(pending.promise).resolves.toMatchObject({ ok: false, output: expect.stringContaining(trigger === 'abort' ? 'cancelled' : 'was stopped') });
    expectCleaned(pending.controller);
  });

  it('accepts an exit event as confirmation while terminate is still pending', async () => {
    const pending = await search();
    worker.emit('message', searchResult);
    await flush();
    expect(pending.observed.settled).toBe(false);
    worker.emit('exit', 0);
    await expect(pending.promise).resolves.toMatchObject({ ok: true });
    expectCleaned(pending.controller);
    worker.stopped.resolve(0);
    await flush();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects an unexpected exit without requesting termination again', async () => {
    const pending = await search();
    worker.emit('exit', 1);
    worker.emit('message', searchResult);
    await expect(pending.promise).rejects.toThrow('stopped unexpectedly');
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(worker.eventNames()).toEqual([]);
    expect(getEventListeners(pending.controller.signal, 'abort')).toEqual([]);
  });

  it.each([
    ['message', 'reject'], ['message', 'throw'], ['timeout', 'reject'], ['timeout', 'throw'],
  ] as const)('does not claim success or stopped after %s when termination fails by %s', async (trigger, failure) => {
    vi.useFakeTimers();
    const pending = await search();
    if (failure === 'throw') worker.terminate.mockImplementation(() => { throw new Error('terminate failed'); });
    if (trigger === 'message') worker.emit('message', searchResult);
    else await vi.advanceTimersByTimeAsync(1000);
    if (failure === 'reject') worker.stopped.reject(new Error('terminate failed'));
    await flush();
    expect(pending.observed.settled).toBe(false);
    worker.emit('error', new Error('late worker error'));
    worker.emit('exit', 1);
    await expect(pending.promise).rejects.toThrow('Search worker termination failed.');
    expectCleaned(pending.controller);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not construct a worker for an already aborted signal, including a direct file search', async () => {
    const controller = new AbortController();
    controller.abort();
    const construct = vi.fn(workerFactory.create!);
    workerFactory.create = construct;
    await expect(runTool(createFileTools(root), 'search_files', { pattern: 'needle', path: 'sample.txt' }, controller.signal)).resolves.toMatchObject({ ok: false, output: expect.stringContaining('cancelled') });
    expect(construct).not.toHaveBeenCalled();
  });

  it('handles an abort during worker construction', async () => {
    const controller = new AbortController();
    workerFactory.create = () => {
      controller.abort();
      created.resolve();
      return worker as unknown as Worker;
    };
    const pending = await search(controller);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(pending.observed.settled).toBe(false);
    worker.stopped.resolve(1);
    await expect(pending.promise).resolves.toMatchObject({ ok: false, output: expect.stringContaining('cancelled') });
    expectCleaned(controller);
  });

  it('rejects synchronous worker construction failures without leaving timers or abort listeners', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const listen = vi.spyOn(controller.signal, 'addEventListener');
    workerFactory.create = () => { throw new Error('worker unavailable'); };
    await expect(runTool(createFileTools(root), 'search_files', { pattern: 'needle', path: 'sample.txt' }, controller.signal)).rejects.toThrow('worker unavailable');
    expect(listen).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns from an adversarial regular expression only after the real worker has exited', async () => {
    const actual = await vi.importActual<typeof WorkerThreads>('node:worker_threads');
    let realWorker: Worker | undefined;
    let exited = false;
    let online = false;
    workerFactory.create = (script, options) => {
      realWorker = new actual.Worker(script, options);
      realWorker.once('online', () => { online = true; });
      realWorker.once('exit', () => { exited = true; });
      return realWorker;
    };
    await writeFile(path.join(root, 'sample.txt'), `${'a'.repeat(40)}!\n`);
    const result = await runTool(createFileTools(root, { searchTimeoutMs: 500 }), 'search_files', { pattern: '^(a+)+$', path: 'sample.txt' });
    expect(result).toMatchObject({ ok: false, output: expect.stringContaining('was stopped') });
    expect(online).toBe(true);
    expect(exited).toBe(true);
    expect(realWorker?.threadId).toBe(-1);
  });
});
