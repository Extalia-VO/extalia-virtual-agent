import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DAEMON_KNOWLEDGE_OPS } from '@extalia/protocol';
import type { DaemonClient, DaemonSidecar } from '../src/daemon/index.js';
import { KnowledgeService } from '../src/knowledge.js';
import { KnowledgeVault } from '../src/knowledgeVault.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }

describe('vault switch ownership and write order', () => {
  it('keeps prior queued writes on the old root and refuses new writes until the switch settles', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-vault-queue-'));
    try {
      await mkdir(path.join(root, 'notes'));
      let configured: string | undefined;
      const order: string[] = [];
      const ready = deferred(), release = deferred();
      const client = { capabilities: [...DAEMON_KNOWLEDGE_OPS], request: async () => ({ vaultPresent: false }) } as unknown as DaemonClient;
      const daemon = { connect: async () => client, restart: async () => { order.push('restart'); } } as unknown as DaemonSidecar;
      const vault = new KnowledgeVault({ dataDirectory: path.join(root, 'data'), homeDirectory: path.join(root, 'home'), profile: 'default', configured: () => configured });
      const knowledge = new KnowledgeService({ daemon, vault: { check: () => vault.check(), label: () => vault.label(), admit: () => vault.assertStable() } });
      vault.attach({ daemon, knowledge, busy: () => false, persist: async next => { order.push('persist'); configured = next; } });
      const first = knowledge.exclusive(async () => { ready.resolve(); await release.promise; order.push(`first:${configured ?? 'default'}`); });
      await ready.promise;
      const second = knowledge.exclusive(async () => { order.push(`second:${configured ?? 'default'}`); });
      const switched = vault.set(path.join(root, 'notes'));
      expect(() => vault.assertStable()).toThrow(/being changed/);
      expect(() => knowledge.exclusive(async () => undefined)).toThrow(/being changed/);
      expect(configured).toBeUndefined();
      release.resolve();
      await Promise.all([first, second, switched]);
      expect(order).toEqual(['first:default', 'second:default', 'persist', 'restart']);
      expect(configured).toBe(await realpath(path.join(root, 'notes')));
      expect(() => vault.assertStable()).not.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('reports a failed configuration save rather than claiming the folder was saved', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-vault-save-'));
    try {
      await mkdir(path.join(root, 'notes'));
      const failure = new Error('Synthetic save failure');
      const restart = vi.fn();
      const vault = new KnowledgeVault({ dataDirectory: path.join(root, 'data'), homeDirectory: path.join(root, 'home'), profile: 'default', configured: () => undefined });
      vault.attach({ busy: () => false, persist: async () => { throw failure; }, daemon: { restart } as unknown as DaemonSidecar,
        knowledge: { switchVault: async (apply: () => Promise<void>) => { await apply(); } } as unknown as KnowledgeService });
      await expect(vault.set(path.join(root, 'notes'))).rejects.toBe(failure);
      expect(restart).not.toHaveBeenCalled();
      expect(() => vault.assertStable()).not.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rechecks global lifetimes immediately before changing saved configuration', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-vault-busy-'));
    try {
      await mkdir(path.join(root, 'notes'));
      const hold = deferred();
      const persist = vi.fn(), restart = vi.fn();
      let busy = false;
      const vault = new KnowledgeVault({ dataDirectory: path.join(root, 'data'), homeDirectory: path.join(root, 'home'), profile: 'default', configured: () => undefined });
      vault.attach({ busy: () => busy, persist, daemon: { restart } as unknown as DaemonSidecar,
        knowledge: { switchVault: async (apply: () => Promise<void>) => { await hold.promise; await apply(); } } as unknown as KnowledgeService });
      const switched = vault.set(path.join(root, 'notes'));
      busy = true; hold.resolve();
      await expect(switched).rejects.toThrow(/Agent work/);
      expect(persist).not.toHaveBeenCalled(); expect(restart).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
