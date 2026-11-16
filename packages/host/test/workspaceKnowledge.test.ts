import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_KNOWLEDGE_OPS, type KnowledgeScopedParams } from '@extalia/protocol';
import type { DaemonClient } from '../src/daemon/index.js';
import { KNOWLEDGE_AUTO_SYNC_WAIT_MS, type KnowledgeClient } from '../src/knowledge.js';
import { serializeKnowledgeRequests, WorkspaceKnowledge, type WorkspaceKnowledgeTarget } from '../src/workspaceKnowledge.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function target(index: number): WorkspaceKnowledgeTarget {
  return { profileId: `vp-00000000-0000-0000-0000-${String(index).padStart(12, '0')}`, root: `/tmp/example-vaults/${index}`, custom: false };
}
const STATUS = { state: 'ready', vaultRoot: 'vaults/example', vaultPresent: false, generation: 1 };
const SYNC = { mode: 'incremental', at: '2026-01-01T00:00:00Z', generation: 2, notes: 1, added: 1, updated: 0, removed: 0,
  unchanged: 0, unresolvedLinks: 0, renamed: [], renamedTotal: 0, skipped: [], skippedTotal: 0, vaultCreated: false };

/** Scripted transport fixtures only; production request types remain fully correlated. */
function fakeClient(request: (op: string, params: unknown, deadlineMs?: number) => Promise<unknown>, scoped = true): KnowledgeClient {
  return { capabilities: scoped ? [...DAEMON_KNOWLEDGE_OPS] : DAEMON_KNOWLEDGE_OPS.filter(op => op !== 'knowledge.scoped'), request } as unknown as KnowledgeClient;
}

describe('workspace Knowledge request ownership', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('shares the default/scoped lane, starts deadlines only at actual dispatch, and survives a later failure', async () => {
    const held = deferred<unknown>();
    const calls: { op: string; at: number; deadlineMs?: number }[] = [];
    const raw = fakeClient(async (op, _params, deadlineMs) => {
      calls.push({ op, at: Date.now(), deadlineMs });
      if (calls.length === 1) return held.promise;
      if (calls.length === 2) return new Promise((_resolve, reject) => { setTimeout(() => reject(new Error('request deadline')), deadlineMs); });
      return STATUS;
    });
    const lane = serializeKnowledgeRequests({ connect: async () => raw as DaemonClient });
    const defaultClient = await lane.connect();
    const scopedClient = await lane.connect();
    const first = defaultClient.request('knowledge.status', {}, 10_000);
    const second = scopedClient.request('knowledge.scoped', { profileId: target(1).profileId, vaultRoot: null, op: 'knowledge.status', params: {} }, 50);
    const failed = expect(second).rejects.toThrow('request deadline');
    const third = defaultClient.request('knowledge.status', {}, 200);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);
    held.resolve(STATUS);
    await first;
    await vi.advanceTimersByTimeAsync(49);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at - calls[0]!.at).toBe(1_000);
    expect(calls[1]!.deadlineMs).toBe(50);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(await third).toEqual(STATUS);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.at - calls[1]!.at).toBe(50);
  });

  it('routes registered scopes and gives every scoped operation the cold-index deadline', async () => {
    const calls: { params: KnowledgeScopedParams; deadlineMs?: number }[] = [];
    const client = fakeClient(async (op, params, deadlineMs) => {
      expect(op).toBe('knowledge.scoped');
      const scope = params as KnowledgeScopedParams;
      calls.push({ params: scope, deadlineMs });
      return { op: scope.op, result: scope.op === 'knowledge.sync' ? SYNC : STATUS };
    });
    const knowledge = new WorkspaceKnowledge({ daemon: { connect: async () => client }, workspaces: () => ['workspace-a'] });
    const managed = target(1), custom = { ...target(2), custom: true, root: '/tmp/example-notes' };
    await knowledge.call(managed, 'knowledgeStatus', []);
    await knowledge.call(custom, 'syncKnowledge', ['incremental']);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every(call => call.deadlineMs === 300_000)).toBe(true);
    expect(calls[0]!.params).toMatchObject({ profileId: managed.profileId, vaultRoot: null, op: 'knowledge.status' });
    expect(calls.filter(call => call.params.profileId === custom.profileId).every(call => call.params.vaultRoot === custom.root)).toBe(true);
    await knowledge.close();
  });

  it.each(['evicted', 'replaced'] as const)('drains an %s service after the status auto-sync wait expires', async mode => {
    const heldSync = deferred<unknown>();
    const old = target(0);
    const client = fakeClient(async (_op, params) => {
      const scope = params as KnowledgeScopedParams;
      if (scope.profileId === old.profileId && scope.vaultRoot === null) {
        if (scope.op === 'knowledge.sync') return { op: scope.op, result: await heldSync.promise };
        return { op: scope.op, result: { ...STATUS, vaultPresent: true } };
      }
      return { op: scope.op, result: STATUS };
    });
    const knowledge = new WorkspaceKnowledge({ daemon: { connect: async () => client }, workspaces: () => [] });
    let answered = false;
    const oldCall = knowledge.call(old, 'knowledgeStatus', []).then(value => { answered = true; return value; });
    await vi.advanceTimersByTimeAsync(KNOWLEDGE_AUTO_SYNC_WAIT_MS + 1);
    expect(answered).toBe(false);
    if (mode === 'evicted') {
      for (let index = 1; index <= 8; index++) await knowledge.call(target(index), 'knowledgeStatus', []);
    } else await knowledge.call({ ...old, custom: true, root: '/tmp/replacement-notes' }, 'knowledgeStatus', []);
    let closed = false;
    const closing = knowledge.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closed).toBe(false);
    expect(answered).toBe(false);
    heldSync.resolve(SYNC);
    await closing;
    expect(await oldCall).toMatchObject({ state: 'ready', vaultPresent: true });
    expect(answered).toBe(true);
    expect(closed).toBe(true);
    await expect(knowledge.call(target(9), 'knowledgeStatus', [])).rejects.toThrow('shutting down');
  });

  it('labels unavailable scoped status with the selected managed or custom vault', async () => {
    const request = vi.fn(async () => STATUS);
    const client = fakeClient(request, false);
    const knowledge = new WorkspaceKnowledge({ daemon: { connect: async () => client }, workspaces: () => [] });
    const managed = target(1);
    expect(await knowledge.call(managed, 'knowledgeStatus', [])).toMatchObject({ state: 'unavailable', vaultRoot: `vaults/${managed.profileId}` });
    expect(await knowledge.call({ ...target(2), custom: true, root: '/tmp/example-custom-vault' }, 'knowledgeStatus', [])).toMatchObject({ state: 'unavailable', vaultRoot: 'custom:example-custom-vault' });
    expect(request).not.toHaveBeenCalled();
    await knowledge.close();
  });
});
