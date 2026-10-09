import { PORTABLE_SESSION_FORMAT, type PortableSession } from '@extalia/core';
import type { ImportCandidate, LibrarySessionSummary } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { countByState, filterCandidates, groupLibrary, previewRows, selectableIds } from '../src/library/library';

const summary = (id: string, patch: Partial<LibrarySessionSummary> = {}): LibrarySessionSummary => ({
  id, title: `Title ${id}`, sourceId: 'codex', importMode: 'imported', state: 'active', messageCount: 2,
  startedAt: '2026-01-31T09:00:00.000Z', lastMessageAt: '2026-01-31T10:00:00.000Z', ...patch,
});

const candidate = (id: string, patch: Partial<ImportCandidate> = {}): ImportCandidate => ({
  id, sourceId: 'codex', locationId: 'loc', sourceName: 'Codex', nativeSessionId: id, title: `Session ${id}`,
  updatedAt: '2026-01-31T10:00:00.000Z', format: 'JSONL', supported: true, ...patch,
});

describe('library grouping', () => {
  it('groups one state by workspace, Unassigned last, newest first, with search', () => {
    const items = [
      summary('a', { workspaceName: 'Website', lastMessageAt: '2026-01-31T08:00:00.000Z' }),
      summary('b', { workspaceName: 'Website', lastMessageAt: '2026-01-31T12:00:00.000Z' }),
      summary('c'),
      summary('d', { workspaceName: 'API', title: 'Fix the café menu' }),
      summary('e', { workspaceName: 'API', state: 'archived' }),
      summary('f', { workspaceName: '  ' }),
    ];
    const groups = groupLibrary(items, 'active');
    expect(groups.map(group => group.workspaceName)).toEqual(['API', 'Website', undefined]);
    expect(groups[1]!.sessions.map(item => item.id)).toEqual(['b', 'a']);
    expect(groups[2]!.sessions.map(item => item.id).sort()).toEqual(['c', 'f']);
    expect(groupLibrary(items, 'archived').map(group => group.sessions[0]!.id)).toEqual(['e']);
    expect(groupLibrary(items, 'active', 'CAFE menu').flatMap(group => group.sessions.map(item => item.id))).toEqual(['d']);
    expect(groupLibrary(items, 'active', 'website').flatMap(group => group.sessions.map(item => item.id))).toEqual(['b', 'a']);
    expect(countByState(items)).toEqual({ active: 5, archived: 1, trashed: 0 });
  });
});

describe('import helpers', () => {
  it('filters candidates by title, project and source, and never selects unsupported ones', () => {
    const list = [candidate('1', { projectPath: '/projects/shop' }), candidate('2', { sourceName: 'Claude Code', sourceId: 'claude-code' }), candidate('3', { supported: false })];
    expect(filterCandidates(list, 'shop').map(item => item.id)).toEqual(['1']);
    expect(filterCandidates(list, 'claude').map(item => item.id)).toEqual(['2']);
    expect(filterCandidates(list, '').length).toBe(3);
    expect(selectableIds(list)).toEqual(['1', '2']);
  });

  it('pairs previewed sessions with their plan result by source key', () => {
    const session: PortableSession = {
      format: PORTABLE_SESSION_FORMAT, title: 'T', importMode: 'imported', provenance: { sourceId: 'codex', sourceSessionId: 'n1', exportedAt: '2026-01-31T10:00:00.000Z' },
      messages: [], startedAt: '2026-01-31T09:00:00.000Z', lastMessageAt: '2026-01-31T10:00:00.000Z',
    };
    const rows = previewRows({
      sessions: [{ candidateId: 'c1', session }, { candidateId: 'c2', session: { ...session, provenance: { ...session.provenance, sourceSessionId: 'n2' } } }],
      plan: { results: [{ sourceKey: 'codex:n1', title: 'T', action: 'update', redactions: 1 }], addCount: 0, updateCount: 1, skipCount: 0 },
      diagnostics: [],
    });
    expect(rows[0]).toMatchObject({ candidateId: 'c1', result: { action: 'update', redactions: 1 } });
    expect(rows[1]!.result).toBeUndefined();
  });
});
