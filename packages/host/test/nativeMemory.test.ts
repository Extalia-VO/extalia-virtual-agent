import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LearningSchedule } from '../src/learningSchedule.js';
import { MemoryStore } from '../src/memory.js';
import { NativeMemoryService } from '../src/nativeMemory.js';
import { createAgentHost } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
async function setup() {
  const directory = await temp();
  const stores = new Map(['a', 'b'].map(id => [id, new MemoryStore(path.join(directory, id))]));
  const service = new NativeMemoryService({
    store: id => { const store = stores.get(id); if (!store) throw new Error('Workspace unavailable.'); return store; },
    checkOpen: () => undefined,
  });
  return { service, api: service.methods, stores };
}
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };

describe('human-facing Native memory', () => {
  it('exposes the same scoped store through the actual host and model-facing memory directory', async () => {
    const root = await temp();
    const project = path.join(root, 'project'); await mkdir(project);
    const runtime = await createAgentHost({
      kind: 'bridge', version: '0.0.0-test', dataDirectory: path.join(root, 'data'), homeDirectory: path.join(root, 'home'), importHome: path.join(root, 'home'),
      env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_HERMES_BIN: path.join(root, 'not-installed') }, knowledge: { watcher: false },
    });
    try {
      const connected = await runtime.host.saveConnection({ name: 'Example', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'example-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
      const state = await runtime.host.saveWorkspace({ name: 'Example workspace', projectLocation: project, connectionId: connected.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
      const workspace = state.workspaces[0]!;
      const saved = await runtime.host.nativeMemoryWrite!(workspace.id, { name: 'workflow', content: 'A confirmed workflow.', expectedRevision: null });
      expect(saved.status).toBe('saved');
      const modelStore = new MemoryStore(path.join(root, 'data', 'workspaces', workspace.id, 'memory'));
      expect(await modelStore.read('workflow')).toBe('A confirmed workflow.');
      expect(await runtime.host.nativeMemoryList!(workspace.id)).toMatchObject({ notes: [{ name: 'workflow' }] });
      // A human may inspect retained notes while agent recall is disabled; this does not enable it.
      expect((await runtime.host.getState()).connections[0]!.features.memory).toBe('off');
      await expect(runtime.host.nativeMemoryList!('foreign-workspace')).rejects.toThrow('workspace');
    } finally { await runtime.close(); }
  });
  it('scopes a real catalog, reads and guarded edits to a registered workspace', async () => {
    const { api } = await setup();
    const created = await api.nativeMemoryWrite('a', { name: 'workflow', content: '# Confirmed workflow\nRun tests before review.', expectedRevision: null });
    expect(created.status).toBe('saved');
    if (created.status !== 'saved') throw new Error('Expected a saved note.');
    expect(await api.nativeMemoryList('b')).toMatchObject({ workspaceId: 'b', notes: [], incomplete: false });
    const catalog = await api.nativeMemoryList('a');
    expect(catalog.notes).toMatchObject([{ name: 'workflow', summary: 'Confirmed workflow', revision: created.revision }]);
    expect(await api.nativeMemoryRead('a', 'workflow', { limit: 12 })).toMatchObject({ status: 'found', note: { workspaceId: 'a', revision: created.revision, nextOffset: 12, text: '# Confirmed ', offsetUnit: 'unicode-code-points' } });
    await expect(api.nativeMemoryRead('../a', 'workflow')).rejects.toThrow('Workspace unavailable.');
    const changed = await api.nativeMemoryWrite('a', { name: 'workflow', content: '# Updated workflow', expectedRevision: created.revision });
    expect(changed.status).toBe('saved');
    expect(await api.nativeMemoryWrite('a', { name: 'workflow', content: 'Stale overwrite', expectedRevision: created.revision })).toEqual({ status: 'conflict' });
    expect(await api.nativeMemoryDelete('a', { name: 'workflow', expectedRevision: created.revision })).toEqual({ status: 'conflict' });
    expect(await api.nativeMemoryRead('a', 'workflow', { expectedRevision: created.revision })).toEqual({ status: 'conflict' });
    if (changed.status !== 'saved') throw new Error('Expected a saved note.');
    expect(await api.nativeMemoryDelete('a', { name: 'workflow', expectedRevision: changed.revision })).toEqual({ status: 'deleted' });
    expect(await api.nativeMemoryRead('a', 'workflow')).toEqual({ status: 'missing' });
  });

  it('never falls back to an unconditional human write or delete when a revision is missing', async () => {
    const { api } = await setup();
    await api.nativeMemoryWrite('a', { name: 'workflow', content: 'Original', expectedRevision: null });
    await expect(api.nativeMemoryWrite('a', { name: 'workflow', content: 'Overwrite' } as never)).rejects.toThrow('revision');
    await expect(api.nativeMemoryDelete('a', { name: 'workflow' } as never)).rejects.toThrow('revision');
    expect(await api.nativeMemoryWrite('a', { name: 'workflow', content: 'Duplicate', expectedRevision: null })).toEqual({ status: 'conflict' });
    expect(await api.nativeMemoryRead('a', 'workflow')).toMatchObject({ status: 'found', note: { text: 'Original' } });
  });

  it('keeps redaction before human pages and validates bounded requests', async () => {
    const { api } = await setup();
    const created = await api.nativeMemoryWrite('a', { name: 'example', content: '# Example\napi_key=abcdef123456\n🙂🙂 confirmed', expectedRevision: null });
    expect(created).toMatchObject({ status: 'saved', masked: 1 });
    expect(JSON.stringify(await api.nativeMemoryRead('a', 'example', { offset: 15, limit: 50 }))).not.toContain('abcdef123456');
    await expect(api.nativeMemoryList('a', { limit: 51 })).rejects.toThrow('page');
    await expect(api.nativeMemoryRead('a', 'example', { limit: 8001 })).rejects.toThrow('page');
    await expect(api.nativeMemoryRead('a', '../example')).rejects.toThrow('name');
  });

  it('drains admitted operations before closure and denies new work', async () => {
    const directory = await temp(); await mkdir(path.join(directory, 'memory'));
    const entered = gate(), release = gate();
    class HeldStore extends MemoryStore {
      override async readPage(...args: Parameters<MemoryStore['readPage']>) {
        entered.resolve(); await release.promise; return super.readPage(...args);
      }
    }
    const store = new HeldStore(path.join(directory, 'memory'));
    await store.write('example', 'Confirmed example.');
    const service = new NativeMemoryService({ store: () => store, checkOpen: () => undefined });
    const reading = service.methods.nativeMemoryRead('a', 'example'); await entered.promise;
    expect(service.isBusy('a')).toBe(true);
    expect(service.isBusy('b')).toBe(false);
    await expect(service.withWorkspaceDeletion('a', async () => undefined)).rejects.toThrow('Wait');
    let closed = false; const closing = service.close().then(() => { closed = true; });
    await expect(service.methods.nativeMemoryList('a')).rejects.toThrow('closing');
    await Promise.resolve(); expect(closed).toBe(false);
    release.resolve(); expect(await reading).toMatchObject({ status: 'found' });
    await closing; expect(closed).toBe(true); expect(service.isBusy()).toBe(false);
  });

  it.each(['throw', 'reject'])('releases pending ownership when foreground preparation fails by %s', async mode => {
    const directory = await temp();
    const list = vi.fn();
    class CheckedStore extends MemoryStore {
      override async listPage(...args: Parameters<MemoryStore['listPage']>) {
        list(); return super.listPage(...args);
      }
    }
    const store = new CheckedStore(path.join(directory, 'memory'));
    const idle = vi.fn();
    const service = new NativeMemoryService({
      store: () => store, checkOpen: () => undefined, onIdle: idle,
      beforeForeground: () => {
        expect(service.isBusy('a')).toBe(true);
        if (mode === 'throw') throw new Error('Foreground preparation failed.');
        return Promise.reject(new Error('Foreground preparation failed.'));
      },
    });
    const listing = service.methods.nativeMemoryList('a');
    expect(service.isBusy('a')).toBe(true);
    await expect(listing).rejects.toThrow('Foreground preparation failed.');
    expect(list).not.toHaveBeenCalled();
    expect(service.isBusy()).toBe(false);
    expect(idle).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it('validates workspace membership before preparing foreground work', async () => {
    const beforeForeground = vi.fn();
    const idle = vi.fn();
    const service = new NativeMemoryService({
      store: () => { throw new Error('Workspace unavailable.'); }, checkOpen: () => undefined, beforeForeground, onIdle: idle,
    });
    await expect(service.methods.nativeMemoryList('foreign-workspace')).rejects.toThrow('Workspace unavailable.');
    expect(beforeForeground).not.toHaveBeenCalled();
    expect(idle).not.toHaveBeenCalled();
    expect(service.isBusy()).toBe(false);
    await service.close();
  });

  it('reserves workspace deletion before any await, without blocking other workspaces', async () => {
    const { service, api } = await setup(); const entered = gate(), release = gate();
    const removing = service.withWorkspaceDeletion('a', async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    expect(service.isBusy()).toBe(true);
    expect(service.isBusy('a')).toBe(true);
    await expect(api.nativeMemoryList('a')).rejects.toThrow('unavailable');
    expect(await api.nativeMemoryList('b')).toMatchObject({ workspaceId: 'b', notes: [] });
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release.resolve(); await removing; await closing;
    expect(closed).toBe(true);
    expect(service.isBusy()).toBe(false);
    await expect(api.nativeMemoryList('a')).rejects.toThrow('closing');
  });
});

describe('Native memory foreground scheduling', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('restarts the full selected snooze after a quick memory write between timer callbacks', async () => {
    const directory = await temp();
    const store = new MemoryStore(path.join(directory, 'memory'));
    const schedule = new LearningSchedule();
    const service = new NativeMemoryService({
      store: () => store, checkOpen: () => undefined,
      beforeForeground: () => schedule.yieldForForeground(), onIdle: () => schedule.wake(),
    });
    const execute = vi.fn(async () => undefined);
    schedule.schedule({ id: 'meeting', workspaceId: 'a', profileId: 'profile-a', profileName: 'Example', sessionId: 'session-a',
      kind: 'knowledge-meeting', execute, validate: async () => true, ready: () => !service.isBusy(),
    });
    schedule.act({ id: 'meeting', revision: schedule.snapshot().revision, action: 'snooze' });
    try {
      await vi.advanceTimersByTimeAsync(550_123);
      const writing = service.methods.nativeMemoryWrite('a', { name: 'example', content: 'Confirmed example.', expectedRevision: null });
      expect(service.isBusy('a')).toBe(true);
      expect(await writing).toMatchObject({ status: 'saved' });
      expect(service.isBusy()).toBe(false);
      expect(schedule.snapshot().jobs[0]).toMatchObject({ state: 'scheduled', waitingForIdle: false, dueAt: '2026-01-01T00:19:10.123Z' });
      await vi.advanceTimersByTimeAsync(599_999);
      expect(execute).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await store.read('example')).toBe('Confirmed example.');
    } finally { await service.close(); await schedule.close(); }
  });

  it('drains an abort-ignoring executor before writing memory and retains admitted work during close', async () => {
    const directory = await temp();
    const finish = gate(), preparing = gate();
    const events: string[] = [];
    let signal: AbortSignal | undefined;
    class CheckedStore extends MemoryStore {
      override async write(...args: Parameters<MemoryStore['write']>) {
        events.push('memory-write'); return super.write(...args);
      }
    }
    const store = new CheckedStore(path.join(directory, 'memory'));
    const schedule = new LearningSchedule();
    const service = new NativeMemoryService({
      store: () => store, checkOpen: () => undefined,
      beforeForeground: async () => {
        const yielding = schedule.yieldForForeground(); preparing.resolve(); await yielding;
      },
      onIdle: () => schedule.wake(),
    });
    schedule.schedule({ id: 'meeting', workspaceId: 'a', profileId: 'profile-a', profileName: 'Example', sessionId: 'session-a',
      kind: 'knowledge-meeting', validate: async () => true, ready: () => !service.isBusy(),
      execute: async value => {
        signal = value; events.push('learning-started'); await finish.promise; events.push('learning-settled');
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(events).toEqual(['learning-started']);
      const writing = service.methods.nativeMemoryWrite('a', { name: 'example', content: 'Confirmed example.', expectedRevision: null });
      expect(service.isBusy('a')).toBe(true);
      await preparing.promise;
      expect(signal?.aborted).toBe(true);
      let closed = false;
      const closing = service.close().then(() => { closed = true; });
      await expect(service.methods.nativeMemoryList('a')).rejects.toThrow('closing');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(events).toEqual(['learning-started']);
      expect(closed).toBe(false);
      expect(schedule.isBusy).toBe(true);
      expect(service.isBusy('a')).toBe(true);
      finish.resolve();
      expect(await writing).toMatchObject({ status: 'saved' });
      await closing;
      expect(events).toEqual(['learning-started', 'learning-settled', 'memory-write']);
      expect(await store.read('example')).toBe('Confirmed example.');
      expect(service.isBusy()).toBe(false);
      expect(schedule.snapshot().jobs[0]).toMatchObject({ state: 'cancelled', reason: 'busy' });
    } finally { finish.resolve(); await service.close(); await schedule.close(); }
  });
});
