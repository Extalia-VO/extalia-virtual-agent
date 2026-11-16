import { describe, expect, it } from 'vitest';
import {
  buildSessionBrowserSnapshot, sessionBrowserProject, type LibrarySessionSummary, type SessionSummary,
  type SessionBrowserSnapshotInput,
} from '@extalia/platform';
import { SessionBrowser } from '../src/sessionBrowser.js';

const day = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
function observed(id: string, projectPath?: string, at = 1, sourceId = 'codex'): SessionSummary {
  return { id, title: `Title ${id}`, workspaceId: '', connectionId: '', control: 'observed', running: false,
    createdAt: day(0), lastActiveAt: day(at), observation: { sourceId, nativeSessionId: id, watching: true, status: 'watching', ...(projectPath ? { projectPath } : {}) } };
}
function imported(id: string, projectLocation?: string, at = 1): LibrarySessionSummary {
  return { id, title: `Imported ${id}`, sourceId: 'codex', importMode: 'imported', state: 'active', messageCount: 2,
    startedAt: day(0), lastMessageAt: day(at), ...(projectLocation ? { projectLocation } : {}) };
}
function browser(observedRows: SessionSummary[] = [], library: LibrarySessionSummary[] = []) {
  let reads = 0, profile = 'profile-a', now = 10;
  const service = new SessionBrowser({ profileId: () => profile, now: () => now,
    metadata(collection) { reads++; return { collection, observed: observedRows, library }; },
  });
  return { service, reads: () => reads, profile: (value: string) => { profile = value; }, time: (value: number) => { now = value; } };
}

describe('source folder metadata identity', () => {
  it('normalizes separators, drive letter and dot segments without merging same basenames or reading folders', () => {
    expect(sessionBrowserProject('C:\\work\\site\\')?.id).toBe(sessionBrowserProject('c:/work/./site')?.id);
    expect(sessionBrowserProject('/work/./a/../site/')?.path).toBe('/work/site');
    expect(sessionBrowserProject('C:/../../site')?.path).toBe('C:/site');
    expect(sessionBrowserProject('//server/share/../site')?.path).toBe('//server/share/site');
    expect(sessionBrowserProject('/work/site')?.id).not.toBe(sessionBrowserProject('/other/site')?.id);
    expect(sessionBrowserProject('/work/Project')?.id).not.toBe(sessionBrowserProject('/work/project')?.id);
    expect(sessionBrowserProject('\\\\server\\share\\site\\')?.path).toBe('//server/share/site');
    expect(sessionBrowserProject(' ')).toBeUndefined();
    expect(sessionBrowserProject('/bad\0path')).toBeUndefined();
  });
  it('groups sources by full project path and retains separate registered workspace metadata', () => {
    const one = observed('one', '/work/site', 3), two = observed('two', '/work/site/', 2, 'claude-code');
    one.workspaceId = two.workspaceId = 'linked';
    const input: SessionBrowserSnapshotInput = { collection: 'observed', observed: [two, observed('other', '/other/site'), one, observed('unknown')], workspaces: [{ id: 'linked', name: 'Registered name' }] };
    const snapshot = buildSessionBrowserSnapshot(input, { collection: 'observed' });
    expect(snapshot.groups).toHaveLength(3);
    expect(snapshot.groups[0]).toMatchObject({ name: 'site', projectPath: '/work/site', workspaceId: 'linked', workspaceName: 'Registered name', sourceIds: ['claude-code', 'codex'], count: 2 });
    expect(snapshot.sessionsByGroup.get(snapshot.groups[0]!.id)?.map(row => row.id)).toEqual(['one', 'two']);
    expect(snapshot.groups.find(group => group.section === 'unassigned')?.count).toBe(1);
    expect(input.observed?.[0]?.observation?.projectPath).toBe('/work/site/');
  });
});

describe('metadata browser pagination', () => {
  it('returns only requested group/session metadata pages, with total counts and stable newest first ordering', () => {
    const rows = Array.from({ length: 125 }, (_, i) => observed(`row-${i}`, `/work/project-${Math.floor(i / 5)}`, i));
    const { service, reads } = browser(rows);
    const first = service.groups({ collection: 'observed', section: 'projects', limit: 10 });
    expect(first.groups).toHaveLength(10); expect(first.totalGroups).toBe(25); expect(first.totalSessions).toBe(125);
    expect(first.groups[0]?.name).toBe('project-24');
    expect('sessions' in first.groups[0]!).toBe(false);
    const second = service.groups({ collection: 'observed', section: 'projects', limit: 10, cursor: first.nextCursor });
    expect(second.groups[0]?.name).toBe('project-14'); expect(reads()).toBe(1);
    const groupId = first.groups[0]!.id;
    const sessions = service.sessions({ collection: 'observed', groupId, limit: 2 });
    expect(sessions.sessions.map(row => row.id)).toEqual(['row-124', 'row-123']);
    expect(sessions.total).toBe(5); expect(reads()).toBe(2);
    const next = service.sessions({ collection: 'observed', groupId, limit: 3, cursor: sessions.nextCursor });
    expect(next.sessions.map(row => row.id)).toEqual(['row-122', 'row-121', 'row-120']); expect(reads()).toBe(2);
  });
  it('pages top-level harnesses newest first and separates the same folder and unassigned sessions under each source', () => {
    const codex = observed('codex-row', '/work/shared', 4, 'codex'); codex.running = true;
    const claude = observed('claude-row', '/work/shared', 5, 'claude-code'); claude.pendingApprovalId = 'approval-example';
    const rows = [codex, claude, observed('codex-no-project', undefined, 2, 'codex'), observed('agy-no-project', undefined, 3, 'antigravity')];
    const { service, reads } = browser(rows);
    const first = service.groups({ collection: 'observed', section: 'harnesses', limit: 1 });
    expect(first.totalGroups).toBe(3); expect(first.totalSessions).toBe(4);
    expect(first.groups[0]).toMatchObject({ sourceId: 'claude-code', sourceIds: ['claude-code'], section: 'harnesses', count: 1, runningCount: 0, attentionCount: 1 });
    const second = service.groups({ collection: 'observed', section: 'harnesses', limit: 2, cursor: first.nextCursor });
    expect(second.groups.map(group => group.sourceId)).toEqual(['codex', 'antigravity']);
    expect(second.groups[0]).toMatchObject({ count: 2, runningCount: 1, attentionCount: 0 }); expect(reads()).toBe(1);
    const codexProjects = service.groups({ collection: 'observed', section: 'projects', harness: 'codex' });
    const claudeProjects = service.groups({ collection: 'observed', section: 'projects', harness: 'claude-code' });
    expect(codexProjects.groups[0]).toMatchObject({ sourceIds: ['codex'], count: 1, runningCount: 1 });
    expect(claudeProjects.groups[0]).toMatchObject({ sourceIds: ['claude-code'], count: 1, attentionCount: 1 });
    expect(codexProjects.groups[0]?.id).toBe(claudeProjects.groups[0]?.id);
    const groupId = codexProjects.groups[0]!.id;
    expect(service.sessions({ collection: 'observed', harness: 'codex', groupId }).sessions.map(row => row.id)).toEqual(['codex-row']);
    expect(service.sessions({ collection: 'observed', harness: 'claude-code', groupId }).sessions.map(row => row.id)).toEqual(['claude-row']);
    expect(service.sessions({ collection: 'observed', harness: 'antigravity', groupId: 'unassigned' }).sessions.map(row => row.id)).toEqual(['agy-no-project']);
    expect(service.groups({ collection: 'observed', section: 'harnesses', status: 'running' }).groups.map(group => group.sourceId)).toEqual(['codex']);
    expect(service.groups({ collection: 'observed', section: 'harnesses', status: 'attention', attentionIds: ['agy-no-project'] }).groups.map(group => group.sourceId)).toEqual(['claude-code', 'antigravity']);
  });
  it('bounds harness discovery pages and binds their cursors to source, query, section and profile', () => {
    const rows = Array.from({ length: 105 }, (_, i) => observed(`row-${i}`, '/work/shared', i, `source-${i}`));
    const control = browser(rows);
    const first = control.service.groups({ collection: 'observed', section: 'harnesses', limit: 100 });
    expect(first.groups).toHaveLength(100); expect(first.totalGroups).toBe(105);
    expect(first.groups[0]?.sourceId).toBe('source-104');
    expect(control.service.groups({ collection: 'observed', section: 'harnesses', limit: 100, cursor: first.nextCursor }).groups).toHaveLength(5);
    expect(() => control.service.groups({ collection: 'observed', section: 'harnesses', limit: 101 })).toThrow('invalid');
    for (const patch of [{ harness: 'codex' }, { query: 'different' }, { section: 'projects' as const }]) {
      expect(() => control.service.groups({ collection: 'observed', section: 'harnesses', cursor: first.nextCursor, ...patch })).toThrow('Refresh');
    }
    control.profile('different-profile');
    expect(() => control.service.groups({ collection: 'observed', section: 'harnesses', cursor: first.nextCursor })).toThrow('Refresh');
  });
  it('discovers saved library harnesses from metadata without labelling imported active sessions as running', () => {
    const saved = [imported('codex', '/work/shared', 3), { ...imported('claude', '/work/shared', 5), sourceId: 'claude-code' }, imported('unknown-folder')];
    const { service } = browser([], saved);
    const harnesses = service.groups({ collection: 'library', section: 'harnesses' });
    expect(harnesses.groups.map(group => group.sourceId)).toEqual(['claude-code', 'codex']);
    expect(harnesses.groups.map(group => group.count)).toEqual([1, 2]);
    expect(harnesses.groups.every(group => group.runningCount === undefined && group.attentionCount === undefined)).toBe(true);
    const projects = service.groups({ collection: 'library', section: 'projects', harness: 'claude-code' });
    expect(projects.groups[0]).toMatchObject({ count: 1, sourceIds: ['claude-code'] });
    expect(projects.groups[0]?.runningCount).toBeUndefined();
    expect(service.sessions({ collection: 'library', groupId: projects.groups[0]!.id, harness: 'claude-code' }).sessions.map(row => row.id)).toEqual(['claude']);
  });
  it('holds cursor snapshots stable across new source activity and safely refreshes on a new request', () => {
    const rows = [observed('first', '/work/first', 3), observed('second', '/work/second', 2), observed('third', '/work/third', 1)];
    const { service } = browser(rows);
    const first = service.groups({ collection: 'observed', section: 'projects', limit: 1 });
    rows.push(observed('new', '/work/new', 5)); rows[2] = observed('third', '/work/third', 6);
    const second = service.groups({ collection: 'observed', section: 'projects', limit: 2, cursor: first.nextCursor });
    expect(second.groups.map(group => group.name)).toEqual(['second', 'third']); expect(second.totalGroups).toBe(3);
    expect(service.groups({ collection: 'observed', section: 'projects' }).groups.map(group => group.name)).toEqual(['third', 'new', 'first', 'second']);
  });
  it('keeps retained DTOs private and rejects mismatched query, section, collection, profile and forged cursors', () => {
    const control = browser([observed('a', '/work/a', 3), observed('b', '/work/b', 2)]);
    const first = control.service.groups({ collection: 'observed', section: 'projects', limit: 1 });
    first.groups[0]!.name = 'changed';
    const cursor = first.nextCursor!;
    for (const input of [
      { collection: 'observed' as const, section: 'projects' as const, query: 'different', cursor },
      { collection: 'observed' as const, section: 'unassigned' as const, cursor },
      { collection: 'library' as const, section: 'projects' as const, cursor },
      { collection: 'observed' as const, section: 'projects' as const, cursor: `${cursor}x` },
    ]) expect(() => control.service.groups(input)).toThrow('Refresh');
    expect(() => control.service.sessions({ collection: 'observed', groupId: 'unassigned', cursor })).toThrow('Refresh');
    control.profile('profile-b'); expect(() => control.service.groups({ collection: 'observed', section: 'projects', cursor })).toThrow('Refresh');
    control.profile('profile-a'); control.time(300_011); expect(() => control.service.groups({ collection: 'observed', section: 'projects', cursor })).toThrow('Refresh');
  });
  it('rejects invalid or unbounded inputs before reading any metadata', () => {
    const { service, reads } = browser();
    for (const change of [{ limit: NaN }, { limit: Infinity }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { query: 'x'.repeat(501) }, { harness: 1 }, { section: 'bad' }, { collection: 'bad' }, { state: 'deleted' }, { status: 'bad' }, { attentionIds: Array(1001).fill('a') }, { extra: true }]) {
      expect(() => service.groups({ collection: 'observed', section: 'projects', ...change } as never)).toThrow('invalid');
    }
    expect(reads()).toBe(0);
  });
  it('filters archived, source, search, attention and unassigned groups on metadata only', () => {
    const active = imported('a', '/work/site', 3), archived = { ...imported('b', '/other/site', 4), state: 'archived' as const };
    const question = observed('question'); const paused = observed('paused'); paused.observation!.watching = false;
    const { service } = browser([question, paused], [active, archived, imported('none')]);
    expect(service.groups({ collection: 'library', section: 'projects' }).groups[0]?.projectPath).toBe('/work/site');
    expect(service.groups({ collection: 'library', section: 'projects', state: 'archived' }).groups[0]?.projectPath).toBe('/other/site');
    expect(service.groups({ collection: 'library', section: 'projects', query: 'other', state: 'archived', harness: 'codex' }).totalGroups).toBe(1);
    expect(service.sessions({ collection: 'observed', groupId: 'unassigned', status: 'attention', attentionIds: ['question'] }).sessions.map(row => row.id)).toEqual(['question']);
    expect(service.sessions({ collection: 'observed', groupId: 'unassigned', status: 'paused' }).sessions.map(row => row.id)).toEqual(['paused']);
    expect(service.groups({ collection: 'library', section: 'unassigned' }).totalSessions).toBe(1);
  });
});
