import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexNativeQueueError, type CodexNativeQueueOptions, type CodexNativeQueueResult } from '../src/codexNativeQueue.js';
import { ObservedCodexNativeQueueService } from '../src/observedCodexNativeQueueService.js';
import type { ObservedCodexQueueTarget } from '../src/observedCodexQueueService.js';

const roots: string[] = [], services: ObservedCodexNativeQueueService[] = [];
const ID = 'observed-one', THREAD = '11111111-1111-4111-8111-111111111111';
const result = (): CodexNativeQueueResult => ({ items: [{ id: 'source-one', text: 'original waiting text', nonTextItems: 0 }] });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map(service => service.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-native-queue-service-')); roots.push(root);
  let source: ObservedCodexQueueTarget | undefined = { threadId: THREAD, codexHome: root, cwd: root, sourceFingerprint: 'registered-source-inode-one', watching: true };
  let privacy = false, now = 1_700_000_000_000;
  const read = vi.fn(async (_options: CodexNativeQueueOptions): Promise<CodexNativeQueueResult> => result());
  const options = { env: { HOME: root, CODEX_HOME: path.join(root, 'wrong-profile'), EXTALIA_CODEX_BIN: process.execPath, PATH: '' },
    target: (id: string) => id === ID ? source : undefined, labelsOnly: () => privacy, read, now: () => now };
  const service = new ObservedCodexNativeQueueService(options); services.push(service);
  return { root, service, options, read, source: () => source!, change: (next: ObservedCodexQueueTarget | undefined) => { source = next; },
    privacy: (next: boolean) => { privacy = next; }, advance: (ms: number) => { now += ms; } };
}

describe('shared read-only native queue status', () => {
  it('shares concurrent reads and five-second cache across views without requiring submission opt-in', async () => {
    const f = await fixture(), pending = deferred<CodexNativeQueueResult>(); f.read.mockReturnValueOnce(pending.promise);
    const views = [f.service.status(ID), f.service.status(ID), f.service.status(ID)];
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    pending.resolve(result());
    const replies = await Promise.all(views);
    expect(replies).toEqual(Array(3).fill({ sessionId: ID, threadId: THREAD, state: 'ready', items: result().items, observedAt: '2023-11-14T22:13:20.000Z' }));
    replies[0]!.items[0]!.text = 'renderer mutation';
    expect((await f.service.status(ID)).items[0]?.text).toBe('original waiting text');
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.read).toHaveBeenCalledWith({ bin: process.execPath, env: f.options.env, codexHome: f.root, cwd: f.root, threadId: THREAD, signal: expect.any(AbortSignal) });
    f.advance(5000); await f.service.status(ID); expect(f.read).toHaveBeenCalledTimes(2);
  });
  it.each(['codexHome', 'threadId', 'sourceFingerprint', 'cwd'] as const)('never returns old text after source %s changes during a read', async field => {
    const f = await fixture(), pending = deferred<CodexNativeQueueResult>(); f.read.mockReturnValueOnce(pending.promise);
    const reply = f.service.status(ID); await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    f.change({ ...f.source(), [field]: field === 'threadId' ? '22222222-2222-4222-8222-222222222222' : field === 'sourceFingerprint' ? 'new-source-inode' : path.join(f.root, 'replacement') });
    pending.resolve(result()); expect(await reply).toEqual({ sessionId: ID, state: 'unavailable', items: [] });
    expect((await f.service.status(ID)).state).toBe('ready'); expect(f.read).toHaveBeenCalledTimes(2);
  });
  it('never reuses cached text after source replacement and never reads unrelated or paused sources', async () => {
    const f = await fixture(); await f.service.status(ID);
    f.change({ ...f.source(), sourceFingerprint: 'new-inode' }); await f.service.status(ID);
    expect(f.read).toHaveBeenCalledTimes(2);
    f.change({ ...f.source(), watching: false });
    expect(await f.service.status(ID)).toEqual({ sessionId: ID, state: 'unavailable', items: [] });
    expect((await f.service.status('unrelated')).state).toBe('unavailable'); expect(f.read).toHaveBeenCalledTimes(2);
  });
  it('skips all content reads in labels-only mode and clears previous cache content', async () => {
    const f = await fixture(); f.privacy(true);
    expect(await f.service.status(ID)).toEqual({ sessionId: ID, state: 'private', items: [] }); expect(f.read).not.toHaveBeenCalled();
    f.privacy(false); await f.service.status(ID); expect(f.read).toHaveBeenCalledOnce();
    f.privacy(true); expect((await f.service.status(ID)).state).toBe('private');
    f.privacy(false); await f.service.status(ID); expect(f.read).toHaveBeenCalledTimes(2);
  });
  it('aborts and rejects late content through privacy on/off transitions even when the reader ignores abort', async () => {
    const f = await fixture(), pending = deferred<CodexNativeQueueResult>(); f.read.mockReturnValueOnce(pending.promise);
    const reply = f.service.status(ID); await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    f.service.invalidatePrivacy(); f.privacy(true); f.privacy(false); f.service.invalidatePrivacy();
    expect(f.read.mock.calls[0]![0].signal?.aborted).toBe(true);
    pending.resolve(result()); expect((await reply).state).toBe('unavailable');
    await f.service.status(ID); expect(f.read).toHaveBeenCalledTimes(2);
  });
  it('checks labels-only again after read completion without relying on lifecycle notification', async () => {
    const f = await fixture(), pending = deferred<CodexNativeQueueResult>(); f.read.mockReturnValueOnce(pending.promise);
    const reply = f.service.status(ID); await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    f.privacy(true); pending.resolve(result()); expect(await reply).toEqual({ sessionId: ID, state: 'private', items: [] });
  });
  it('drop blocks synchronously, awaits the admitted read and prevents resume from reviving its reply', async () => {
    const f = await fixture(), pending = deferred<CodexNativeQueueResult>(); f.read.mockReturnValueOnce(pending.promise);
    const reply = f.service.status(ID); await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    let stopped = false; const stop = f.service.drop(ID).then(() => { stopped = true; });
    expect((await f.service.status(ID)).state).toBe('unavailable'); expect(stopped).toBe(false);
    expect(f.read.mock.calls[0]![0].signal?.aborted).toBe(true);
    f.service.resume(ID); pending.resolve(result());
    expect((await reply).state).toBe('unavailable'); await stop; expect(stopped).toBe(true);
    expect((await f.service.status(ID)).state).toBe('ready');
  });
  it('close revokes readers, waits for cleanup and permanently disables future reads', async () => {
    const f = await fixture(), pending = deferred<CodexNativeQueueResult>(); f.read.mockReturnValueOnce(pending.promise);
    const reply = f.service.status(ID); await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    let closed = false; const close = f.service.close().then(() => { closed = true; });
    expect(closed).toBe(false); expect(f.read.mock.calls[0]![0].signal?.aborted).toBe(true);
    pending.resolve(result()); await close; expect((await reply).state).toBe('unavailable');
    expect((await f.service.status(ID)).state).toBe('unavailable'); expect(f.read).toHaveBeenCalledOnce();
  });
  it('briefly caches sanitized unsupported/error outcomes and never retries inside a request', async () => {
    const f = await fixture(); f.read.mockRejectedValueOnce(new CodexNativeQueueError('unsupported'));
    expect(await f.service.status(ID)).toEqual({ sessionId: ID, state: 'unsupported', items: [] });
    expect((await f.service.status(ID)).state).toBe('unsupported'); expect(f.read).toHaveBeenCalledOnce();
    f.advance(1000); f.read.mockRejectedValueOnce(new Error('/private/provider-secret'));
    expect(await f.service.status(ID)).toEqual({ sessionId: ID, state: 'unavailable', items: [] }); expect(f.read).toHaveBeenCalledTimes(2);
  });
  it('poisons further reads and reports lifecycle failure when actual cleanup is unconfirmed', async () => {
    const f = await fixture(); f.read.mockRejectedValueOnce(new CodexNativeQueueError('unavailable', true));
    expect((await f.service.status(ID)).state).toBe('unavailable'); f.advance(10_000);
    expect((await f.service.status(ID)).state).toBe('unavailable'); expect(f.read).toHaveBeenCalledOnce();
    await expect(f.service.drop(ID)).rejects.toMatchObject({ cleanupUnconfirmed: true });
    await expect(f.service.close()).rejects.toMatchObject({ cleanupUnconfirmed: true });
  });
  it('bounds concurrency to two profile readers while sharing an exact source across observation IDs', async () => {
    const f = await fixture(), pending = deferred<CodexNativeQueueResult>(); f.read.mockReturnValue(pending.promise);
    const source = f.source();
    const service = new ObservedCodexNativeQueueService({ ...f.options, target: id => ({ ...source, codexHome: id === 'alias' ? source.codexHome : path.join(f.root, id) }) }); services.push(service);
    const first = service.status('one'), second = service.status('two');
    expect((await service.status('three')).state).toBe('unavailable');
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2)); pending.resolve(result()); await Promise.all([first, second]);
    f.read.mockClear();
    await Promise.all([service.status(ID), service.status('alias')]); expect(f.read).toHaveBeenCalledTimes(2);
    // Both IDs deliberately map to a single exact source in this independent registry.
    const shared = new ObservedCodexNativeQueueService({ ...f.options, target: () => source }); services.push(shared); f.read.mockClear();
    await Promise.all([shared.status('one'), shared.status('two'), shared.status('three')]); expect(f.read).toHaveBeenCalledOnce();
  });
  it('fails safely on unavailable binaries or malformed host source bindings without fallback', async () => {
    const f = await fixture();
    const service = new ObservedCodexNativeQueueService({ ...f.options, env: { HOME: f.root, CODEX_HOME: f.root, EXTALIA_CODEX_BIN: path.join(f.root, 'missing'), PATH: '' } }); services.push(service);
    expect((await service.status(ID)).state).toBe('unavailable'); expect(f.read).not.toHaveBeenCalled();
    f.change({ ...f.source(), codexHome: '../wrong' }); expect((await f.service.status(ID)).state).toBe('unavailable'); expect(f.read).not.toHaveBeenCalled();
  });
});
