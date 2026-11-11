import type { AgentHostApi, WorkspaceKnowledgeMethod } from '@extalia/platform';
import { WORKSPACE_KNOWLEDGE_METHODS } from '@extalia/platform';
import { describe, expect, it, vi } from 'vitest';
import { workspaceKnowledgeHost } from '../src/knowledge/workspaceKnowledgeHost';

function fixture() {
  const result = { scoped: true };
  const workspaceKnowledge = vi.fn(async (_workspace: string, _method: WorkspaceKnowledgeMethod, _args: unknown[]) => result);
  const ordinary = vi.fn(async () => ({ ordinary: true }));
  const subscribe = vi.fn(() => () => undefined);
  const host = { workspaceKnowledge, knowledgeOverview: ordinary, knowledgeSettings: ordinary,
    setKnowledgeVaultRoot: ordinary, getState: ordinary, subscribe } as unknown as AgentHostApi;
  return { host, workspaceKnowledge, ordinary, subscribe, result };
}

describe('workspace Knowledge presentation adapter', () => {
  it('binds every permitted Knowledge action to the selected workspace and keeps unrelated capabilities', async () => {
    const f = fixture(), scoped = workspaceKnowledgeHost(f.host, 'workspace-alpha');
    expect(scoped.getState).toBe(f.host.getState);
    expect(scoped.subscribe).toBe(f.subscribe);
    for (const method of WORKSPACE_KNOWLEDGE_METHODS) {
      const action = scoped[method] as (...args: unknown[]) => Promise<unknown>;
      const args = ['first', { second: true }];
      expect(await action(...args)).toBe(f.result);
      expect(f.workspaceKnowledge).toHaveBeenLastCalledWith('workspace-alpha', method, args);
    }
    expect(f.ordinary).not.toHaveBeenCalled();
  });

  it('forwards reads, settings and user CAS payloads without converting the workspace into a raw profile or vault path', async () => {
    const f = fixture(), scoped = workspaceKnowledgeHost(f.host, 'workspace-alpha');
    await scoped.knowledgeSettings!();
    await scoped.setKnowledgeVaultRoot!(null);
    await scoped.knowledgeOverview!({ nodeLimit: 20 });
    await scoped.readKnowledgeNote!('Notes/Topic.md');
    const write = { path: 'Notes/Topic.md', content: '# Topic', expectedSha256: null };
    await scoped.writeKnowledgeNote!(write);
    expect(f.workspaceKnowledge.mock.calls).toEqual([
      ['workspace-alpha', 'knowledgeSettings', []],
      ['workspace-alpha', 'setKnowledgeVaultRoot', [null]],
      ['workspace-alpha', 'knowledgeOverview', [{ nodeLimit: 20 }]],
      ['workspace-alpha', 'readKnowledgeNote', ['Notes/Topic.md']],
      ['workspace-alpha', 'writeKnowledgeNote', [write]],
    ]);
    expect(f.workspaceKnowledge.mock.calls.every(call => call.length === 3)).toBe(true);
  });

  it('trims only trailing undefined arguments so the bridge does not turn omitted values into null', async () => {
    const f = fixture(), scoped = workspaceKnowledgeHost(f.host, 'workspace-alpha');
    const search = scoped.searchKnowledge as unknown as (...args: unknown[]) => Promise<unknown>;
    await search('topic', undefined, undefined);
    expect(f.workspaceKnowledge).toHaveBeenLastCalledWith('workspace-alpha', 'searchKnowledge', ['topic']);
    await search('topic', undefined, { limit: 5 }, undefined);
    expect(f.workspaceKnowledge).toHaveBeenLastCalledWith('workspace-alpha', 'searchKnowledge', ['topic', undefined, { limit: 5 }]);
  });

  it('keeps workspace bindings immutable across adapters and leaves unsupported or unselected hosts intact', async () => {
    const f = fixture(), first = workspaceKnowledgeHost(f.host, 'workspace-alpha'), second = workspaceKnowledgeHost(f.host, 'workspace-beta');
    await first.knowledgeStatus!(); await second.knowledgeStatus!(); await first.syncKnowledge!();
    expect(f.workspaceKnowledge.mock.calls.map(call => call[0])).toEqual(['workspace-alpha', 'workspace-beta', 'workspace-alpha']);
    expect(workspaceKnowledgeHost(f.host, undefined)).toBe(f.host);
    const old = { knowledgeOverview: f.ordinary } as unknown as AgentHostApi;
    expect(workspaceKnowledgeHost(old, 'workspace-alpha')).toBe(old);
  });
});
