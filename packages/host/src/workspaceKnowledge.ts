import type { AgentHostApi, WorkspaceKnowledgeMethod } from '@extalia/platform';
import type { DaemonOp, DaemonOperations, DaemonKnowledgeOrdinaryOp, KnowledgeScopedParams } from '@extalia/protocol';
import { DaemonUnavailableError, type DaemonSidecar } from './daemon/index.js';
import { KnowledgeService, knowledgeHostMethods, type KnowledgeClient } from './knowledge.js';
import { KnowledgeEditService, knowledgeEditHostMethods } from './knowledgeEdit.js';
import path from 'node:path';

/** One knowledge thread: spend request deadlines on execution, never on another profile's host queue. */
export function serializeKnowledgeRequests(daemon: Pick<DaemonSidecar, 'connect'>): { connect(): Promise<KnowledgeClient> } {
  let requests: Promise<void> = Promise.resolve();
  return { connect: async () => {
    const client = await daemon.connect();
    return {
      capabilities: client.capabilities,
      request: <O extends Exclude<DaemonOp, 'hello'>>(op: O, params: DaemonOperations[O]['params'], deadlineMs?: number): Promise<DaemonOperations[O]['result']> => {
        const work = requests.then(() => client.request(op, params, deadlineMs));
        requests = work.then(() => undefined, () => undefined);
        return work;
      },
    };
  } };
}

export interface WorkspaceKnowledgeTarget { profileId: string; root: string; custom: boolean }
interface Entry { key: string; service: KnowledgeService; methods: Partial<AgentHostApi> }

/** Reuse the sole Rust process/store lock; every scoped request names a host-resolved registered profile. */
export class WorkspaceKnowledge {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private readonly options: {
    daemon: { connect(): Promise<KnowledgeClient> };
    workspaces(profileId: string): string[];
  }) {}

  private entry(target: WorkspaceKnowledgeTarget): Entry {
    if (this.closed) throw new Error('The host is shutting down.');
    const key = JSON.stringify(target);
    let entry = this.entries.get(target.profileId);
    if (entry?.key === key) {
      this.entries.delete(target.profileId); this.entries.set(target.profileId, entry);
      return entry;
    }
    // Each call retains its service through drain, including after LRU eviction. Rust bounds its own LRU too.
    if (this.entries.size >= 8 && !this.entries.has(target.profileId)) this.entries.delete(this.entries.keys().next().value!);
    const connect = async (): Promise<KnowledgeClient> => {
      const client = await this.options.daemon.connect();
      if (!client.capabilities.includes('knowledge.scoped')) throw new DaemonUnavailableError('missing_capability');
      return {
        capabilities: client.capabilities,
        request: async <O extends Exclude<DaemonOp, 'hello'>>(op: O, params: DaemonOperations[O]['params'], deadlineMs?: number): Promise<DaemonOperations[O]['result']> => {
          if (!op.startsWith('knowledge.') || op === 'knowledge.scoped') throw new Error('Unsupported workspace Knowledge operation.');
          const result = await client.request('knowledge.scoped', {
            profileId: target.profileId, vaultRoot: target.custom ? target.root : null,
            op: op as DaemonKnowledgeOrdinaryOp, params,
          // The Rust LRU may have reopened this profile (including after a daemon restart),
          // and rebuilds the derived index before exposing a result. Give that work a sync deadline.
          } as KnowledgeScopedParams, Math.max(deadlineMs ?? 0, 300_000));
          if (result.op !== op) throw new DaemonUnavailableError('malformed_reply');
          return result.result as DaemonOperations[O]['result'];
        },
      };
    };
    const service = new KnowledgeService({ daemon: { connect }, autoSyncAfterMs: 5_000,
      vault: { check: () => undefined, label: () => target.custom ? `custom:${path.basename(target.root)}` : `vaults/${target.profileId}` },
    });
    entry = { key, service, methods: {
      ...knowledgeHostMethods(service),
      ...knowledgeEditHostMethods(new KnowledgeEditService(service, { workspaces: () => this.options.workspaces(target.profileId) })),
    } };
    this.entries.set(target.profileId, entry);
    return entry;
  }

  async call(target: WorkspaceKnowledgeTarget, method: WorkspaceKnowledgeMethod, args: unknown[]): Promise<unknown> {
    const entry = this.entry(target);
    const action = entry.methods[method as keyof AgentHostApi];
    if (typeof action !== 'function') throw new Error('Unsupported workspace Knowledge action.');
    // A status read may start an auto-sync and answer before it finishes. Keep both host
    // admission and shutdown ownership through that work, even if its cache entry is replaced.
    const work = Promise.resolve().then(async () => {
      try { return await (action as (...input: unknown[]) => Promise<unknown>)(...args); }
      finally { await entry.service.drain(); }
    });
    this.pending.add(work);
    try { return await work; } finally { this.pending.delete(work); }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    await Promise.all([...this.entries.values()].map(entry => entry.service.drain()));
    this.entries.clear();
  }
}
