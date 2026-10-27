import { describe, expect, it } from 'vitest';
import {
  AGENT_HOST_METHODS, KNOWLEDGE_HOST_METHODS, KNOWLEDGE_UI_LIMITS, isAgentHostMethod, normalizeKnowledgeCursor, normalizeKnowledgeGraphDepth, normalizeKnowledgeNodeId,
  KNOWLEDGE_OVERVIEW_LIMITS, normalizeKnowledgeNodeLookup, normalizeKnowledgeOverviewOptions, normalizeKnowledgePath, normalizeKnowledgeQuery, normalizeKnowledgeSyncMode,
} from '../src/index.js';
import { DAEMON_KNOWLEDGE_LIMITS } from '@extalia/protocol';

describe('Knowledge contract (W5)', () => {
  it('forwards every knowledge method through Desktop IPC and the Bridge', () => {
    for (const method of KNOWLEDGE_HOST_METHODS) expect(isAgentHostMethod(method)).toBe(true);
    expect(AGENT_HOST_METHODS).toEqual(expect.arrayContaining([...KNOWLEDGE_HOST_METHODS]));
    expect(KNOWLEDGE_HOST_METHODS).toEqual(['knowledgeStatus', 'syncKnowledge', 'knowledgeNode', 'knowledgeLinks', 'knowledgeBacklinks', 'searchKnowledge', 'knowledgeGraph', 'knowledgeOverview']);
  });

  it('accepts only the two sync modes, incremental by default', () => {
    expect(normalizeKnowledgeSyncMode(undefined)).toBe('incremental');
    expect(normalizeKnowledgeSyncMode('rebuild')).toBe('rebuild');
    for (const bad of ['full', 'REBUILD', 1, {}]) expect(() => normalizeKnowledgeSyncMode(bad)).toThrow(/Invalid knowledge sync mode/);
  });

  it('accepts vault-relative note paths only', () => {
    expect(normalizeKnowledgePath('Knowledge/N+1 Query.md')).toBe('Knowledge/N+1 Query.md');
    for (const bad of ['', '/etc/passwd', '../x.md', 'a/../b.md', 'a//b.md', 'a/./b.md', '.obsidian/app.md', 'a\\b.md', 'a\nb.md', 'x'.repeat(DAEMON_KNOWLEDGE_LIMITS.path + 1), 7]) {
      expect(() => normalizeKnowledgePath(bad)).toThrow(/Invalid note path/);
    }
  });

  it('accepts front matter ids and path ids', () => {
    expect(normalizeKnowledgeNodeId('know.laravel.n-plus-one')).toBe('know.laravel.n-plus-one');
    expect(normalizeKnowledgeNodeId('path:Inbox.md')).toBe('path:Inbox.md');
    for (const bad of ['Know.Upper', '-x', 'a'.repeat(129), 'path:', 'path:../x.md', 'path:/abs.md', '', null]) expect(() => normalizeKnowledgeNodeId(bad)).toThrow(/Invalid note id/);
  });

  it('takes a note reference by id or by path, never both', () => {
    expect(normalizeKnowledgeNodeLookup({ nodeId: 'dec.cache.redis' })).toEqual({ nodeId: 'dec.cache.redis' });
    expect(normalizeKnowledgeNodeLookup({ path: 'Inbox.md' })).toEqual({ path: 'Inbox.md' });
    expect(() => normalizeKnowledgeNodeLookup({ nodeId: 'a', path: 'b.md' })).toThrow(/by id or by path/);
    expect(() => normalizeKnowledgeNodeLookup('a')).toThrow(/by id or by path/);
    expect(() => normalizeKnowledgeNodeLookup({ path: '../secret.md' })).toThrow(/Invalid note path/);
  });

  it('bounds search text and graph depth', () => {
    expect(normalizeKnowledgeQuery('  eager loading ')).toBe('eager loading');
    expect(() => normalizeKnowledgeQuery('   ')).toThrow(/Enter search text/);
    expect(() => normalizeKnowledgeQuery(42)).toThrow(/Enter search text/);
    expect(() => normalizeKnowledgeQuery('a\nb')).toThrow(/one line/);
    expect(() => normalizeKnowledgeQuery('a'.repeat(DAEMON_KNOWLEDGE_LIMITS.query + 1))).toThrow(/one line/);
    expect(normalizeKnowledgeGraphDepth(undefined)).toBe(1);
    expect(normalizeKnowledgeGraphDepth(2)).toBe(2);
    for (const bad of [0, 4, 1.5, '2']) expect(() => normalizeKnowledgeGraphDepth(bad)).toThrow(/Invalid graph depth/);
    expect(normalizeKnowledgeCursor(undefined)).toBe(0);
    expect(normalizeKnowledgeCursor(100)).toBe(100);
    for (const bad of [-1, 1.5, '3']) expect(() => normalizeKnowledgeCursor(bad)).toThrow(/Invalid page cursor/);
    // The UI asks for less than the daemon allows.
    expect(KNOWLEDGE_UI_LIMITS.graphNodes).toBeLessThanOrEqual(DAEMON_KNOWLEDGE_LIMITS.graphNodes);
    expect(KNOWLEDGE_UI_LIMITS.searchResults).toBeLessThanOrEqual(DAEMON_KNOWLEDGE_LIMITS.searchLimit);
  });

  it('bounds the overview to the daemon caps, leaving defaults to the daemon', () => {
    expect(KNOWLEDGE_OVERVIEW_LIMITS).toEqual({ nodes: DAEMON_KNOWLEDGE_LIMITS.overviewNodes, edges: DAEMON_KNOWLEDGE_LIMITS.overviewEdges });
    expect(normalizeKnowledgeOverviewOptions(undefined)).toEqual({});
    expect(normalizeKnowledgeOverviewOptions(null)).toEqual({});
    expect(normalizeKnowledgeOverviewOptions({})).toEqual({});
    expect(normalizeKnowledgeOverviewOptions({ nodeLimit: 1, edgeLimit: 8000 })).toEqual({ nodeLimit: 1, edgeLimit: 8000 });
    expect(normalizeKnowledgeOverviewOptions({ nodeLimit: 2000, edgeLimit: null, extra: 'ignored' })).toEqual({ nodeLimit: 2000 });
    for (const bad of [{ nodeLimit: 0 }, { nodeLimit: 2001 }, { nodeLimit: 1.5 }, { nodeLimit: '10' }]) expect(() => normalizeKnowledgeOverviewOptions(bad)).toThrow(/note limit must be a whole number from 1 to 2000/);
    for (const bad of [{ edgeLimit: 0 }, { edgeLimit: 8001 }, { edgeLimit: Number.NaN }]) expect(() => normalizeKnowledgeOverviewOptions(bad)).toThrow(/link limit must be a whole number from 1 to 8000/);
    for (const bad of ['all', 5, [1]]) expect(() => normalizeKnowledgeOverviewOptions(bad)).toThrow(/Invalid graph overview options/);
  });
});
