import { describe, expect, it, vi } from 'vitest';
import { readSessionBrowserWindow, SessionBrowserExpansion, sessionBrowserFilterKey, sessionBrowserNodeKey } from '../src/sessions/sessionBrowserState';

describe('live session browser navigation identity', () => {
  it.each(['all', 'attention'] as const)('refreshes live attention without remounting the %s tree', status => {
    const filters = { collection: 'observed' as const, query: '', status };
    expect(sessionBrowserFilterKey({ ...filters, attentionIds: ['session-a'] })).toBe(sessionBrowserFilterKey({ ...filters, attentionIds: ['session-b', 'session-c'] }));
    expect(sessionBrowserFilterKey({ ...filters, query: 'title' })).not.toBe(sessionBrowserFilterKey(filters));
    expect(sessionBrowserFilterKey({ ...filters, status: 'running' })).not.toBe(sessionBrowserFilterKey(filters));
    expect(sessionBrowserFilterKey({ collection: 'library', state: 'active' })).not.toBe(sessionBrowserFilterKey({ collection: 'library', state: 'archived' }));
  });

  it('restores explicit collapsed and expanded choices after parent folds or nodes disappear', () => {
    const memory = new SessionBrowserExpansion();
    const folder = sessionBrowserNodeKey('folder', 'codex', 'projects', 'project-a');
    const slot = sessionBrowserNodeKey('initial-folder', 'codex', 'projects');
    expect(memory.read(folder, true, slot)).toBe(true);
    memory.set(folder, false);
    expect(memory.read(folder, true, slot)).toBe(false);
    memory.set(folder, true);
    expect(memory.read(folder, false, slot)).toBe(true);
  });

  it('does not reopen a newly promoted first sibling after the first-open default has been used', () => {
    const memory = new SessionBrowserExpansion();
    expect(memory.read('first-folder', true, 'initial-folder')).toBe(true);
    memory.set('first-folder', false);
    expect(memory.read('new-first-folder', true, 'initial-folder')).toBe(false);
    expect(memory.read('first-folder', true, 'initial-folder')).toBe(false);
    expect(memory.read('other-harness-folder', true, 'other-harness-initial-folder')).toBe(true);
  });

  it('scopes same-path folders to their source and keeps host/profile memories independent', () => {
    const memory = new SessionBrowserExpansion();
    const codex = sessionBrowserNodeKey('folder', 'codex', 'projects', 'project-a');
    const claude = sessionBrowserNodeKey('folder', 'claude-code', 'projects', 'project-a');
    memory.set(codex, false);
    expect(memory.read(claude, true)).toBe(true);
    expect(new SessionBrowserExpansion().read(codex, true)).toBe(true);
    expect(sessionBrowserNodeKey('folder', 'a,b', 'c')).not.toBe(sessionBrowserNodeKey('folder', 'a', 'b,c'));
  });

  it('bounds retained navigation state and keeps recently reused choices', () => {
    const memory = new SessionBrowserExpansion(3);
    memory.set('old', false); memory.set('recent', false); memory.set('third', false);
    expect(memory.read('recent', true)).toBe(false);
    memory.set('fourth', false);
    expect(memory.read('recent', true)).toBe(false);
    expect(memory.read('old', true)).toBe(true);
  });
});

describe('atomic session browser window refresh', () => {
  const rows = Array.from({ length: 240 }, (_, id) => ({ id: String(id) }));
  const fetch = () => vi.fn(async (limit: number, cursor?: string) => {
    const offset = Number(cursor ?? 0), end = offset + limit;
    return { items: rows.slice(offset, end), total: rows.length, nextCursor: end < rows.length ? String(end) : undefined };
  });

  it('retains the whole previously loaded window without exceeding the host page limit', async () => {
    const fetchPage = fetch();
    const result = await readSessionBrowserWindow({ count: 132, pageSize: 12, current: () => true, fetchPage });
    expect(result?.items).toEqual(rows.slice(0, 132));
    expect(result?.cursor).toBe('132');
    expect(result?.total).toBe(240);
    expect(fetchPage.mock.calls).toEqual([[100, undefined], [32, '100']]);
  });

  it('loads only the next requested page when the user selects more', async () => {
    const fetchPage = fetch();
    const result = await readSessionBrowserWindow({ cursor: '132', count: 132, pageSize: 12, current: () => true, fetchPage });
    expect(result?.items).toEqual(rows.slice(132, 144));
    expect(fetchPage.mock.calls).toEqual([[12, '132']]);
  });

  it('does not publish a partial replacement while a later page is still pending', async () => {
    let finish!: (page: { items: { id: string }[] }) => void;
    const pending = new Promise<{ items: { id: string }[] }>(resolve => { finish = resolve; });
    const fetchPage = vi.fn().mockResolvedValueOnce({ items: rows.slice(0, 100), nextCursor: '100' }).mockReturnValueOnce(pending);
    const published = vi.fn();
    const refresh = readSessionBrowserWindow({ count: 120, pageSize: 12, current: () => true, fetchPage }).then(published);
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(published).not.toHaveBeenCalled();
    finish({ items: rows.slice(100, 120) });
    await refresh;
    expect(published.mock.calls[0]![0].items).toHaveLength(120);
  });

  it('discards obsolete partial responses without requesting more pages', async () => {
    let current = true;
    const fetchPage = vi.fn(async () => { current = false; return { items: rows.slice(0, 100), nextCursor: '100' }; });
    const result = await readSessionBrowserWindow({ count: 120, pageSize: 12, current: () => current, fetchPage });
    expect(result).toBeUndefined();
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it('rejects a failed refresh as a whole so the caller retains its current rows', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({ items: rows.slice(0, 100), nextCursor: '100' }).mockRejectedValueOnce(new Error('Offline'));
    await expect(readSessionBrowserWindow({ count: 120, pageSize: 12, current: () => true, fetchPage })).rejects.toThrow('Offline');
  });

  it('discards an obsolete response even after earlier pages of the refresh have completed', async () => {
    let current = true;
    const fetchPage = vi.fn().mockResolvedValueOnce({ items: rows.slice(0, 100), nextCursor: '100' }).mockImplementationOnce(async () => {
      current = false;
      return { items: rows.slice(100, 120) };
    });
    expect(await readSessionBrowserWindow({ count: 120, pageSize: 12, current: () => current, fetchPage })).toBeUndefined();
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('finishes cleanly when rows disappear rather than retaining stale folders', async () => {
    const result = await readSessionBrowserWindow({ count: 24, pageSize: 12, current: () => true, fetchPage: async () => ({ items: rows.slice(0, 3) }) });
    expect(result?.items).toHaveLength(3);
    expect(result?.cursor).toBeUndefined();
  });
});
