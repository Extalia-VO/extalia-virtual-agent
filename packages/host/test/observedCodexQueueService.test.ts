import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ObservedCodexQueueService, type ObservedCodexQueueTarget } from '../src/observedCodexQueueService.js';
import { CodexQueueError, type CodexQueueOptions, type CodexQueueResult } from '../src/codexQueue.js';

const ID = 'observed-one';
const THREAD = '12345678-1234-5678-9abc-123456789abc';
const SECOND_THREAD = '87654321-4321-8765-cba9-cba987654321';
const MESSAGE = 'abcdef12-3456-789a-bcde-f123456789ab';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'extalia-codex-queue-'));
  const dataDirectory = path.join(root, 'profile');
  let binding: ObservedCodexQueueTarget | undefined = { threadId: THREAD, codexHome: path.join(root, 'codex'), sourceFingerprint: 'registered-source:one:inode:1', watching: true };
  const queue = vi.fn(async (_options: CodexQueueOptions): Promise<CodexQueueResult> => ({ state: 'queued' }));
  const options = { dataDirectory, env: { EXTALIA_CODEX_BIN: process.execPath, PATH: '', CODEX_HOME: path.join(root, 'wrong-profile') },
    target: (id: string) => id === ID ? binding : undefined, queue };
  const service = await ObservedCodexQueueService.create(options);
  const services = [service];
  return { root, options, service, queue, binding: () => binding!, change: (next: ObservedCodexQueueTarget | undefined) => { binding = next; },
    reopen: async () => { const next = await ObservedCodexQueueService.create(options); services.push(next); return next; },
    file: path.join(dataDirectory, 'state', 'observed-codex-queue.json'),
    cleanup: async () => { await Promise.allSettled(services.map(item => item.close())); await rm(root, { recursive: true, force: true }); } };
}

describe('persistent observed Codex queue setup', () => {
  it('performs no queue command on create/status, persists opt-in once, and reopens without storing text or credentials', async () => {
    const f = await fixture();
    try {
      expect(await f.service.status(ID)).toMatchObject({ enabled: false, canQueue: false });
      expect(await f.service.status('unrelated')).toMatchObject({ enabled: false, canQueue: false });
      expect(f.queue).not.toHaveBeenCalled();
      expect(await f.service.setEnabled(ID, true)).toMatchObject({ enabled: true, canQueue: true });
      const before = await readFile(f.file, 'utf8');
      expect(JSON.parse(before)).toEqual({ version: 2, bindings: [{ sessionId: ID, threadId: THREAD, codexHome: f.binding().codexHome, sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
      if (process.platform !== 'win32') expect((await stat(f.file)).mode & 0o777).toBe(0o600);
      const reopened = await f.reopen();
      expect(await reopened.status(ID)).toMatchObject({ enabled: true, canQueue: true });
      expect(f.queue).not.toHaveBeenCalled();
      expect(await reopened.send(ID, { text: 'Continue the original native conversation' })).toMatchObject({ enabled: true, canQueue: true, delivery: 'queued' });
      expect(f.queue).toHaveBeenCalledExactlyOnceWith({ bin: process.execPath, env: { ...f.options.env, CODEX_HOME: f.binding().codexHome }, threadId: THREAD, text: 'Continue the original native conversation', signal: expect.any(AbortSignal) });
      const saved = await readFile(f.file, 'utf8');
      expect(JSON.parse(saved).bindings[0]).toEqual({ ...JSON.parse(before).bindings[0], lastDelivery: 'queued' });
      expect(saved).not.toContain('Continue the original native conversation');
      expect(saved).not.toContain('wrong-profile');
    } finally { await f.cleanup(); }
  });

  it.each(['sourceFingerprint', 'threadId', 'codexHome'] as const)('refuses stale %s bindings after restart and requires explicit setup', async key => {
    const f = await fixture();
    try {
      await f.service.setEnabled(ID, true);
      const changed = { ...f.binding(), [key]: key === 'threadId' ? SECOND_THREAD : key === 'codexHome' ? path.join(f.root, 'other-codex') : 'replaced-source-inode' };
      f.change(changed);
      const reopened = await f.reopen();
      expect(await reopened.status(ID)).toMatchObject({ enabled: false, canQueue: false, problem: expect.stringContaining('source changed') });
      await expect(reopened.send(ID, { text: 'Do not submit to replacement' })).rejects.toThrow('source changed');
      expect(f.queue).not.toHaveBeenCalled();
      await reopened.setEnabled(ID, true);
      await reopened.send(ID, { text: 'Explicit replacement setup' });
      expect(f.queue).toHaveBeenCalledTimes(1);
    } finally { await f.cleanup(); }
  });

  it('disables and removes only Extalia opt-in metadata', async () => {
    const f = await fixture();
    try {
      await f.service.setEnabled(ID, true);
      expect(await f.service.setEnabled(ID, false)).toMatchObject({ enabled: false, canQueue: false });
      expect(JSON.parse(await readFile(f.file, 'utf8'))).toEqual({ version: 2, bindings: [] });
      expect(f.queue).not.toHaveBeenCalled();
      expect(await (await f.reopen()).status(ID)).toMatchObject({ enabled: false, canQueue: false });
    } finally { await f.cleanup(); }
  });

  it('seals pause synchronously, drains the one owned call, and preserves uncertain cancellation after resume', async () => {
    const f = await fixture(), entered = deferred<void>(), queued = deferred<CodexQueueResult>();
    f.queue.mockImplementationOnce(async () => { entered.resolve(); return queued.promise; });
    try {
      await f.service.setEnabled(ID, true);
      const sending = f.service.send(ID, { text: 'Admitted once' });
      await entered.promise;
      expect(await f.service.status(ID)).toMatchObject({ busy: true, canQueue: false });
      const dropping = f.service.drop(ID);
      expect(f.queue.mock.calls[0]![0].signal?.aborted).toBe(true);
      let drained = false;
      void dropping.then(() => { drained = true; });
      await expect(f.service.send(ID, { text: 'Concurrent late message' })).rejects.toThrow('current');
      await Promise.resolve();
      expect(drained).toBe(false);
      queued.resolve({ state: 'queued' });
      expect(await sending).toMatchObject({ canQueue: false, delivery: 'unknown' });
      await dropping;
      expect(await (await f.reopen()).status(ID)).toMatchObject({ enabled: true, canQueue: false, delivery: 'unknown' });
      f.service.resume(ID);
      expect(await f.service.status(ID)).toMatchObject({ enabled: true, canQueue: false, delivery: 'unknown' });
      await expect(f.service.send(ID, { text: 'No implicit retry' })).rejects.toThrow('unknown');
      expect(f.queue).toHaveBeenCalledTimes(1);
      await f.service.setEnabled(ID, true);
      expect(await f.service.status(ID)).toMatchObject({ canQueue: true });
    } finally { queued.resolve({ state: 'unknown' }); await f.cleanup(); }
  });

  it('cannot resurrect setup sealed before its asynchronous work starts', async () => {
    const f = await fixture();
    try {
      const enabling = f.service.setEnabled(ID, true);
      const dropping = f.service.drop(ID);
      await expect(enabling).rejects.toThrow('watched');
      await dropping;
      f.service.resume(ID);
      expect(await f.service.status(ID)).toMatchObject({ enabled: false, canQueue: false });
      expect(f.queue).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it('aborts a replaced source and suppresses its late receipt for the replacement identity', async () => {
    const f = await fixture(), entered = deferred<void>(), queued = deferred<CodexQueueResult>();
    f.queue.mockImplementationOnce(async () => { entered.resolve(); return queued.promise; });
    try {
      await f.service.setEnabled(ID, true);
      const sending = f.service.send(ID, { text: 'Original exact source only' });
      await entered.promise;
      f.change({ ...f.binding(), sourceFingerprint: 'different-inode', threadId: SECOND_THREAD });
      expect(await f.service.status(ID)).toMatchObject({ enabled: false, canQueue: false, threadId: SECOND_THREAD });
      expect(f.queue.mock.calls[0]![0].signal?.aborted).toBe(true);
      queued.resolve({ state: 'queued' });
      const status = await sending;
      expect(status).toMatchObject({ enabled: false, canQueue: false });
      expect(status.delivery).toBeUndefined();
      expect(f.queue).toHaveBeenCalledTimes(1);
    } finally { queued.resolve({ state: 'unknown' }); await f.cleanup(); }
  });

  it.each(['unknown', 'failure'] as const)('keeps %s delivery uncertain without automatically retrying', async outcome => {
    const f = await fixture();
    if (outcome === 'failure') f.queue.mockRejectedValueOnce(new CodexQueueError());
    else f.queue.mockResolvedValueOnce({ state: 'unknown' });
    try {
      await f.service.setEnabled(ID, true);
      expect(await f.service.send(ID, { text: 'One attempt' })).toMatchObject({ delivery: 'unknown', canQueue: false });
      await expect(f.service.send(ID, { text: 'No automatic repeat' })).rejects.toThrow('unknown');
      await f.service.status(ID);
      expect(f.queue).toHaveBeenCalledTimes(1);
    } finally { await f.cleanup(); }
  });

  it('keeps unconfirmed cleanup sticky even when an old generation fails after pause', async () => {
    const f = await fixture(), entered = deferred<void>(), queued = deferred<CodexQueueResult>();
    f.queue.mockImplementationOnce(async () => { entered.resolve(); return queued.promise; });
    try {
      await f.service.setEnabled(ID, true);
      const sending = f.service.send(ID, { text: 'One uncertain child' });
      await entered.promise;
      const dropping = f.service.drop(ID);
      const dropResult = dropping.catch(error => error);
      queued.reject(Object.assign(new CodexQueueError(), { cleanupUnconfirmed: true }));
      await sending;
      expect(await dropResult).toBeInstanceOf(Error);
      f.service.resume(ID);
      await expect(f.service.setEnabled(ID, true)).rejects.toThrow('cleanup');
      expect(await f.service.status(ID)).toMatchObject({ canQueue: false, problem: expect.stringContaining('cleanup') });
      await expect(f.service.close()).rejects.toThrow('cleanup');
      expect(f.queue).toHaveBeenCalledTimes(1);
    } finally { queued.resolve({ state: 'unknown' }); await f.cleanup(); }
  });

  it('seals shutdown before waiting and never publishes a late queued receipt', async () => {
    const f = await fixture(), entered = deferred<void>(), queued = deferred<CodexQueueResult>();
    f.queue.mockImplementationOnce(async () => { entered.resolve(); return queued.promise; });
    try {
      await f.service.setEnabled(ID, true);
      const sending = f.service.send(ID, { text: 'In flight at shutdown' });
      await entered.promise;
      const closing = f.service.close();
      expect(f.queue.mock.calls[0]![0].signal?.aborted).toBe(true);
      await expect(f.service.send(ID, { text: 'Too late' })).rejects.toThrow('closed');
      queued.resolve({ state: 'queued' });
      expect(await sending).toMatchObject({ canQueue: false, delivery: 'unknown', problem: expect.stringContaining('closed') });
      await closing;
      expect(await (await f.reopen()).status(ID)).toMatchObject({ enabled: true, canQueue: false, delivery: 'unknown' });
    } finally { queued.resolve({ state: 'unknown' }); await f.cleanup(); }
  });

  it('bounds persisted records and refuses corrupt metadata without overwriting it', async () => {
    const f = await fixture();
    try {
      await f.service.setEnabled(ID, true);
      const invalid = JSON.stringify({ version: 1, bindings: Array.from({ length: 129 }, () => ({})) });
      await writeFile(f.file, invalid);
      await expect(f.reopen()).rejects.toThrow('Invalid');
      expect(await readFile(f.file, 'utf8')).toBe(invalid);
      await writeFile(f.file, 'x'.repeat(1024 * 1024 + 1));
      await expect(f.reopen()).rejects.toThrow('size limit');
    } finally { await f.cleanup(); }
  });

  it('rejects unverified native identities and text before invoking the CLI', async () => {
    const f = await fixture();
    try {
      f.change({ ...f.binding(), threadId: '--other-profile' });
      await expect(f.service.setEnabled(ID, true)).rejects.toThrow('verified');
      expect(f.queue).not.toHaveBeenCalled();
      f.change({ ...f.binding(), threadId: THREAD });
      await f.service.setEnabled(ID, true);
      await expect(f.service.send(ID, { text: ' ' })).rejects.toThrow('text');
      await expect(f.service.send(ID, { text: 'contains\0null' })).rejects.toThrow('text');
      expect(f.queue).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it('restores a confirmed receipt after restart without requiring another setup or requeueing', async () => {
    const f = await fixture();
    f.queue.mockResolvedValueOnce({ state: 'queued', messageId: MESSAGE });
    try {
      await f.service.setEnabled(ID, true);
      expect(await f.service.send(ID, { text: 'Private message content' })).toMatchObject({ delivery: 'queued', messageId: MESSAGE });
      await f.service.close();
      const reopened = await f.reopen();
      expect(await reopened.status(ID)).toMatchObject({ enabled: true, canQueue: true, delivery: 'queued', messageId: MESSAGE });
      const saved = await readFile(f.file, 'utf8');
      expect(saved).not.toContain('Private message content');
      expect(JSON.parse(saved).bindings[0]).toMatchObject({ lastDelivery: 'queued', lastMessageId: MESSAGE });
      expect(f.queue).toHaveBeenCalledTimes(1);
    } finally { await f.cleanup(); }
  });

  it('never projects a previous source receipt while replacement setup is being persisted', async () => {
    const f = await fixture();
    f.queue.mockResolvedValueOnce({ state: 'queued', messageId: MESSAGE });
    try {
      await f.service.setEnabled(ID, true);
      await f.service.send(ID, { text: 'Previous source only' });
      f.change({ ...f.binding(), sourceFingerprint: 'replacement-source', threadId: SECOND_THREAD });
      const enabling = f.service.setEnabled(ID, true);
      await Promise.resolve();
      const status = await f.service.status(ID);
      expect(status.threadId).toBe(SECOND_THREAD);
      expect(status.delivery).toBeUndefined();
      expect(status.messageId).toBeUndefined();
      await enabling;
      expect((await f.service.status(ID)).delivery).toBeUndefined();
    } finally { await f.cleanup(); }
  });

  it('durably records uncertainty before entering the CLI and blocks a crash-intent retry until explicit setup', async () => {
    const f = await fixture(), entered = deferred<void>(), queued = deferred<CodexQueueResult>();
    let intent: unknown;
    f.queue.mockImplementationOnce(async () => { intent = JSON.parse(await readFile(f.file, 'utf8')); entered.resolve(); return queued.promise; });
    try {
      await f.service.setEnabled(ID, true);
      const sending = f.service.send(ID, { text: 'Never save or replay this text' });
      await entered.promise;
      expect(intent).toMatchObject({ version: 2, bindings: [{ lastDelivery: 'unknown' }] });
      const restarted = await f.reopen();
      expect(await restarted.status(ID)).toMatchObject({ enabled: true, canQueue: false, delivery: 'unknown' });
      await expect(restarted.send(ID, { text: 'Implicit crash retry forbidden' })).rejects.toThrow('unknown');
      expect(f.queue).toHaveBeenCalledTimes(1);
      queued.resolve({ state: 'unknown' });
      await sending;
      await f.service.close();
      await restarted.setEnabled(ID, true);
      expect(await restarted.status(ID)).toMatchObject({ enabled: true, canQueue: true });
      const saved = await readFile(f.file, 'utf8');
      expect(saved).not.toContain('Never save or replay this text');
      expect(JSON.parse(saved).bindings[0].lastDelivery).toBeUndefined();
      expect(f.queue).toHaveBeenCalledTimes(1);
    } finally { queued.resolve({ state: 'unknown' }); await f.cleanup(); }
  });

  it('reads version-one setup without rewriting and upgrades only on an explicit metadata write', async () => {
    const f = await fixture();
    try {
      await f.service.setEnabled(ID, true);
      const old = JSON.stringify({ ...JSON.parse(await readFile(f.file, 'utf8')), version: 1 });
      await writeFile(f.file, old);
      const reopened = await f.reopen();
      expect(await reopened.status(ID)).toMatchObject({ enabled: true, canQueue: true });
      expect(await readFile(f.file, 'utf8')).toBe(old);
      expect(f.queue).not.toHaveBeenCalled();
      await reopened.setEnabled(ID, true);
      expect(JSON.parse(await readFile(f.file, 'utf8')).version).toBe(2);
    } finally { await f.cleanup(); }
  });

  it.each(['intent', 'receipt'] as const)('fails closed when the %s persistence acknowledgement fails', async phase => {
    const f = await fixture();
    const obstruct = async () => { await rm(f.file); await mkdir(f.file); };
    if (phase === 'receipt') f.queue.mockImplementationOnce(async () => { await obstruct(); return { state: 'queued', messageId: MESSAGE }; });
    try {
      await f.service.setEnabled(ID, true);
      if (phase === 'intent') await obstruct();
      const sending = f.service.send(ID, { text: 'No false confirmed receipt' });
      if (phase === 'intent') await expect(sending).rejects.toBeInstanceOf(Error);
      else expect(await sending).toMatchObject({ delivery: 'unknown', canQueue: false });
      const status = await f.service.status(ID);
      expect(status).toMatchObject({ delivery: 'unknown', canQueue: false });
      expect(status.messageId).toBeUndefined();
      expect(f.queue).toHaveBeenCalledTimes(phase === 'intent' ? 0 : 1);
      await expect(f.service.close()).rejects.toThrow('persistence');
    } finally { await f.cleanup(); }
  });
});
