import type { AgentHostApi, ObservedMemoryEpisode, ObservedMemoryPage, ObservedMemorySearchResult, SessionSummary } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { ObservedMemoryController, ObservedMemoryPanelView, type ObservedMemoryViewState } from '../src/observe/ObservedMemoryPanel';

const session = { id: 'current-source', workspaceId: 'workspace-a', connectionId: 'observed', control: 'observed', observation: { sourceId: 'codex', nativeSessionId: 'native-current', projectPath: '/projects/example' } } as SessionSummary;
const episode = (): ObservedMemoryEpisode => ({ id: 'memory-artifact-id', episodeId: 'capture-episode-key', scope: { profileId: 'profile-a', workspaceId: session.workspaceId, sessionId: 'earlier-observed-session', sourceId: 'antigravity', nativeSessionId: 'native-earlier-not-prominent', boundary: 'reviewed-boundary' }, revision: 'exact-revision', sourceRevision: 'source-revision', capturedAt: '2030-01-01T00:00:00Z', entries: 2, trust: 'untrusted-observed', coverage: { mode: 'partial', omittedEntries: 4, truncated: true, limits: ['Captured observations only.'] } });
const result = (): ObservedMemorySearchResult => ({ hits: [{ sessionId: 'current-host-session-alias', episode: episode(), excerpt: 'Reported parser decision' }], omitted: 2, incomplete: true });
const page = (offset = 0): ObservedMemoryPage => ({ episode: episode(), entries: [{ id: `entry-${offset}`, kind: 'assistant', text: offset ? 'Second source observation' : '<script>example()</script> is an unverified report.' }], offset, total: 2, ...(offset === 0 ? { nextOffset: 1 } : {}) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function harness() {
  const api = { observedMemorySearch: vi.fn(async (_workspace: string, _input: { query: string; limit?: number }): Promise<ObservedMemorySearchResult> => result()), observedMemoryRead: vi.fn(async (_workspace: string, _input: unknown): Promise<ObservedMemoryPage> => page()) };
  const agents = api as unknown as AgentHostApi, owner = new ObservedMemoryController(); owner.bind(agents, session); return { api, agents, owner };
}
function render(value: ObservedMemoryViewState, language: 'en' | 'id' = 'en', supported = true) {
  return renderToStaticMarkup(createElement(ObservedMemoryPanelView, { t: MESSAGES[language].observedMemory, value, supported, onQuery: vi.fn(), onSearch: vi.fn(), onRead: vi.fn() }));
}

describe('explicit observed work memory UI', () => {
  it('does no I/O on bind or query editing and searches only on an explicit valid query', async () => {
    const h = harness(); await h.owner.search(); h.owner.edit('   '); await h.owner.search();
    expect(h.api.observedMemorySearch).not.toHaveBeenCalled(); h.owner.edit('  parser decision  ');
    expect(h.api.observedMemorySearch).not.toHaveBeenCalled(); await h.owner.search();
    expect(h.api.observedMemorySearch).toHaveBeenCalledExactlyOnceWith('workspace-a', { query: 'parser decision', limit: 8 }); expect(h.api.observedMemoryRead).not.toHaveBeenCalled();
    expect(h.owner.value.result?.hits[0]?.episode.scope.sessionId).toBe('earlier-observed-session');
  });
  it('reads the host-authorized alias with the exact artifact ID and revision and bounds evidence to one page', async () => {
    const h = harness(); await h.owner.read('memory-artifact-id'); expect(h.api.observedMemoryRead).not.toHaveBeenCalled();
    h.owner.edit('parser'); await h.owner.search(); await h.owner.read('memory-artifact-id');
    expect(h.api.observedMemoryRead).toHaveBeenCalledExactlyOnceWith('workspace-a', { sessionId: 'current-host-session-alias', episodeId: 'memory-artifact-id', revision: 'exact-revision', offset: 0, limit: 20 });
    h.api.observedMemoryRead.mockResolvedValueOnce(page(1)); await h.owner.read('memory-artifact-id', true);
    expect(h.api.observedMemoryRead).toHaveBeenLastCalledWith('workspace-a', expect.objectContaining({ offset: 1, revision: 'exact-revision' }));
    expect(h.owner.value.page?.entries).toHaveLength(1); expect(h.owner.value.page?.entries[0]?.text).toBe('Second source observation');
  });
  it('does not publish an old query after editing or admit duplicate in-flight reads', async () => {
    const h = harness(), pending = deferred<ObservedMemorySearchResult>(); h.owner.edit('first'); h.api.observedMemorySearch.mockReturnValueOnce(pending.promise);
    const searching = h.owner.search(); await h.owner.search(); h.owner.edit('new query'); await h.owner.search(); expect(h.api.observedMemorySearch).toHaveBeenCalledOnce();
    pending.resolve(result()); await searching; expect(h.owner.value.query).toBe('new query'); expect(h.owner.value.result).toBeUndefined();
    await h.owner.search(); const reading = deferred<ObservedMemoryPage>(); h.api.observedMemoryRead.mockReturnValueOnce(reading.promise);
    const first = h.owner.read('memory-artifact-id'); await h.owner.read('memory-artifact-id'); expect(h.api.observedMemoryRead).toHaveBeenCalledOnce();
    reading.resolve(page()); await first;
  });
  it('hides stale search/read results across workspace, source and API changes', async () => {
    const h = harness(), pending = deferred<ObservedMemorySearchResult>(); h.owner.edit('parser'); h.api.observedMemorySearch.mockReturnValueOnce(pending.promise);
    const searching = h.owner.search(); h.owner.bind(h.agents, { ...session, workspaceId: 'workspace-b' }); pending.resolve(result()); await searching;
    expect(h.owner.value.result).toBeUndefined(); expect(h.owner.value.query).toBe('');
    h.owner.bind(h.agents, session); h.owner.edit('parser'); await h.owner.search(); const reading = deferred<ObservedMemoryPage>(); h.api.observedMemoryRead.mockReturnValueOnce(reading.promise);
    const read = h.owner.read('memory-artifact-id'), other = harness(); h.owner.bind(other.agents, { ...session, id: 'another-source' }); reading.resolve(page()); await read;
    expect(h.owner.value.page).toBeUndefined(); expect(h.owner.value.result).toBeUndefined(); expect(h.owner.value.error).toBeUndefined(); expect(other.api.observedMemorySearch).not.toHaveBeenCalled();
  });
  it('discards a pending result when profile or workspace access scope changes without changing session IDs', async () => {
    const h = harness(), pending = deferred<ObservedMemorySearchResult>(); h.owner.bind(h.agents, session, 'profile-boundary-a'); h.owner.edit('parser'); h.api.observedMemorySearch.mockReturnValueOnce(pending.promise);
    const searching = h.owner.search(); h.owner.bind(h.agents, session, 'profile-boundary-b'); pending.resolve(result()); await searching;
    expect(h.owner.value.result).toBeUndefined(); expect(h.owner.value.query).toBe('');
  });
  it('drops unmounted requests and never exposes raw provider failures', async () => {
    const h = harness(), pending = deferred<ObservedMemorySearchResult>(); h.owner.edit('parser'); h.api.observedMemorySearch.mockReturnValueOnce(pending.promise);
    const searching = h.owner.search(); h.owner.invalidate(); pending.resolve(result()); await searching; expect(h.owner.value.result).toBeUndefined();
    h.owner.bind(h.agents, session); h.owner.edit('parser'); h.api.observedMemorySearch.mockRejectedValueOnce(new Error('private endpoint details')); await h.owner.search();
    expect(h.owner.value.error).toBe('search'); expect(JSON.stringify(h.owner.value)).not.toContain('private endpoint');
  });
  it('disables a forwarded capability when an older host reports the method is unsupported', async () => {
    const h = harness(); h.owner.edit('parser'); h.api.observedMemorySearch.mockRejectedValueOnce(new Error('Unknown agent host method.'));
    await h.owner.search(); await h.owner.search(); expect(h.api.observedMemorySearch).toHaveBeenCalledOnce(); expect(h.owner.value.unsupported).toBe(true);
    const html = render(h.owner.value); expect(html).toContain(MESSAGES.en.observedMemory.unsupported); expect(html).not.toContain('<form');
  });
  it('rejects cross-workspace hits and mismatched evidence revisions or scopes', async () => {
    const h = harness(); h.owner.edit('parser'); h.api.observedMemorySearch.mockResolvedValueOnce({ ...result(), hits: [{ sessionId: 'foreign-session', episode: { ...episode(), scope: { ...episode().scope, workspaceId: 'foreign-workspace' } }, excerpt: 'private source' }] });
    await h.owner.search(); expect(h.owner.value.result).toBeUndefined(); expect(h.owner.value.error).toBe('search');
    await h.owner.search(); h.api.observedMemoryRead.mockResolvedValueOnce({ ...page(), episode: { ...episode(), revision: 'different-revision' } }); await h.owner.read('memory-artifact-id');
    expect(h.owner.value.page).toBeUndefined(); expect(h.owner.value.error).toBe('read');
    h.api.observedMemoryRead.mockResolvedValueOnce({ ...page(), episode: { ...episode(), scope: { ...episode().scope, boundary: 'different-boundary' } } }); await h.owner.read('memory-artifact-id'); expect(h.owner.value.page).toBeUndefined();
  });
  it.each(['en', 'id'] as const)('renders literal attributed evidence and partial coverage in %s', language => {
    const t = MESSAGES[language].observedMemory, html = render({ query: 'parser', result: result(), page: page() }, language);
    expect(html).toContain(t.claims); expect(html).toContain(t.coverage.partial); expect(html).toContain(t.incomplete); expect(html).toContain(t.truncated); expect(html).toContain(t.omittedEntries);
    expect(html).toContain('Antigravity'); expect(html).toContain('Reported parser decision'); expect(html).toContain('&lt;script&gt;example()&lt;/script&gt;');
    expect(html).not.toContain('<script>'); expect(html).not.toContain('native-earlier-not-prominent'); expect(html).not.toContain('href='); expect(html).toContain(t.more);
  });
  it('explains empty/off collection and old-host support without offering unsupported searches', () => {
    const t = MESSAGES.en.observedMemory, empty = render({ query: 'parser', result: { hits: [], omitted: 0, incomplete: false } });
    expect(empty).toContain(t.empty); expect(empty).toContain(t.consent);
    const oldHost = render({ query: '' }, 'en', false); expect(oldHost).toContain(t.unsupported); expect(oldHost).not.toContain('<form');
  });
});
