import type { AgentHostApi, KnowledgeLinkPage, KnowledgeNoteResult, KnowledgeStatus } from '@extalia/platform';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { navigationGroups } from '../src/appMode';
import { parseMarkdown } from '../src/chat/markdownParser';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { GraphView, KnowledgeView, LinkList, NoteBody, NoteMeta, WikiLinkView, type KnowledgeViewProps } from '../src/knowledge/KnowledgePage';
import { isUnsupportedMessage, knowledgeMethodsPresent, layoutGraph, linkKey, linksByTarget, nodeLabel, pageNodes, type KnowledgeApi } from '../src/knowledge/knowledgeModel';

const t = MESSAGES.en;

function knowledgeHost(options: { knowledge?: 'empty' | 'off'; seed?: 'ready' | 'setup' } = {}): AgentHostApi {
  return createMockPlatform({ seed: options.seed ?? 'ready', host: 'bridge', ...(options.knowledge ? { knowledge: options.knowledge } : {}) }).capabilities.agents!;
}
const api = (agents: AgentHostApi) => agents as AgentHostApi & KnowledgeApi;

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
const loaded = <T,>(value: T) => ({ value, loading: false });

async function noteFixture(agents: AgentHostApi, nodeId: string): Promise<{ note: KnowledgeNoteResult; links: KnowledgeLinkPage; backlinks: KnowledgeLinkPage }> {
  const host = api(agents);
  return { note: (await host.knowledgeNode({ nodeId }))!, links: await host.knowledgeLinks(nodeId), backlinks: await host.knowledgeBacklinks(nodeId) };
}

function viewProps(status: KnowledgeStatus, patch: Partial<KnowledgeViewProps> = {}): KnowledgeViewProps {
  return {
    t, language: 'en', status: loaded(status), query: '', onQuery: vi.fn(), results: null, selectedId: null, onOpen: vi.fn(), onClose: vi.fn(),
    note: { loading: false }, links: { loading: false }, backlinks: { loading: false }, graphOpen: false, onGraphOpen: vi.fn(), depth: 1, onDepth: vi.fn(),
    graph: { loading: false }, syncing: false, onSync: vi.fn(), ...patch,
  };
}

describe('Knowledge support detection', () => {
  it('hides the page when the host lacks the knowledge methods', () => {
    expect(knowledgeMethodsPresent(knowledgeHost())).toBe(true);
    expect(knowledgeMethodsPresent(knowledgeHost({ knowledge: 'off' }))).toBe(false);
    expect(knowledgeMethodsPresent(knowledgeHost({ seed: 'setup' }))).toBe(false);
    expect(knowledgeMethodsPresent(undefined)).toBe(false);
    // Desktop IPC and the Bridge forward every method name; a host without the method answers with these messages.
    expect(isUnsupportedMessage('This host does not support this action.')).toBe(true);
    expect(isUnsupportedMessage('Unknown method.')).toBe(true);
    expect(isUnsupportedMessage('The knowledge index is busy.')).toBe(false);
  });

  it('lists Knowledge under Work only when supported, also without a workspace', () => {
    const pages = (knowledge: boolean, canChat = true, workflow: 'managed' | 'observe' = 'managed') =>
      navigationGroups({ agents: true, workflow, canChat, knowledge }).flatMap(group => group.section === 'work' ? group.pages : []);
    expect(pages(true)).toEqual(['office', 'chat', 'missions', 'observe', 'files', 'git', 'knowledge', 'history', 'import', 'logs']);
    expect(pages(false)).not.toContain('knowledge');
    expect(pages(true, false, 'observe')).toEqual(['office', 'observe', 'knowledge', 'history', 'import', 'logs']);
    expect(navigationGroups({ agents: false, workflow: 'managed', canChat: false, knowledge: true }).flatMap(group => group.pages)).not.toContain('knowledge');
  });
});

describe('mock knowledge vault', () => {
  it('reports notes, unresolved links and skipped files with reasons, and a relative vault label', async () => {
    const status = await api(knowledgeHost()).knowledgeStatus();
    expect(status).toMatchObject({ state: 'ready', vaultRoot: 'vaults/default', vaultPresent: true, counts: { notes: 14, skipped: 5 } });
    expect(status.counts!.unresolvedLinks).toBeGreaterThanOrEqual(3);
    expect(status.skipped.map(item => item.reason)).toEqual(expect.arrayContaining(['too_large', 'invalid_front_matter', 'duplicate_id', 'profile_mismatch', 'symlink']));
    expect(JSON.stringify(status)).not.toMatch(/\/Users\//);
    const empty = await api(knowledgeHost({ knowledge: 'empty' })).knowledgeStatus();
    expect(empty).toMatchObject({ counts: { notes: 0 }, skipped: [] });
    expect(empty.lastSync).toBeUndefined();
  });

  it('resolves by path, title and alias; keeps ambiguous candidates; reports missing links; ignores code', async () => {
    const { links } = await noteFixture(knowledgeHost(), 'know.laravel.n-plus-one');
    const byTarget = linksByTarget(links.links);
    expect(byTarget.get(linkKey('Laravel Eloquent'))).toMatchObject({ edgeType: 'related_to', status: 'resolved', via: 'title', targetNodeId: 'know.laravel.eloquent' });
    expect(byTarget.get(linkKey('Experiences/Example-Query-Optimization'))).toMatchObject({ edgeType: 'learned_from', status: 'resolved', via: 'path' });
    expect(byTarget.get(linkKey('Query Plans'))).toMatchObject({ heading: 'Reading EXPLAIN', display: 'EXPLAIN', status: 'resolved' });
    const caching = byTarget.get(linkKey('Caching'))!;
    expect(caching).toMatchObject({ status: 'ambiguous', candidates: ['path:Knowledge/Caching.md', 'path:Projects/Shop/Caching.md'] });
    // The page names every visible endpoint, so candidates get titles and paths.
    expect(nodeLabel(pageNodes(links), 'path:Projects/Shop/Caching.md')).toEqual({ title: 'Caching (Shop)', path: 'Projects/Shop/Caching.md' });
    const missing = byTarget.get(linkKey('Redis Cluster'))!;
    expect(missing.status).toBe('missing');
    expect(missing.targetNodeId ?? missing.candidates ?? missing.via).toBeUndefined();
    expect(byTarget.has(linkKey('Not a link'))).toBe(false);
    const alias = (await noteFixture(knowledgeHost(), 'know.laravel.eloquent')).links.links.find(link => link.target === 'N+1');
    expect(alias).toMatchObject({ status: 'resolved', via: 'alias', targetNodeId: 'know.laravel.n-plus-one' });
  });

  it('reports a note only another profile could have exactly like any missing note', async () => {
    const review = await noteFixture(knowledgeHost(), 'path:Learning/Reviews/Weekly Review 2026-W43.md');
    const link = review.links.links.find(item => item.target === 'Client Alpha Roadmap')!;
    expect(link.status).toBe('missing');
    expect(Object.keys(link).sort()).toEqual(['edgeType', 'embed', 'line', 'ordinal', 'sourceNodeId', 'status', 'target']);
    expect(review.links.nodes.some(node => /client/i.test(node.title))).toBe(false);
  });

  it('keeps cycles, backlinks, embeds and non-links straight', async () => {
    const agents = knowledgeHost();
    const eloquent = await noteFixture(agents, 'know.laravel.eloquent');
    expect(eloquent.backlinks.links.map(link => link.sourceNodeId)).toEqual(expect.arrayContaining(['know.laravel.n-plus-one', 'proj.shop.checkout']));
    expect(eloquent.links.links.find(link => link.target === 'N+1')?.targetNodeId).toBe('know.laravel.n-plus-one');
    const inbox = await noteFixture(agents, 'path:Inbox.md');
    expect(inbox.links.links.map(link => [link.target, link.embed])).toEqual([['Query Plans', true]]);
    const search = await api(agents).searchKnowledge('eager loading');
    expect(search.hits[0]).toMatchObject({ nodeId: 'know.laravel.n-plus-one', path: 'Knowledge/N+1 Query Optimization.md' });
    expect(search.hits[0]!.snippet).toMatch(/eager loading/i);
    await expect(api(agents).searchKnowledge('  ')).rejects.toThrow(/Enter search text/);
    await expect(api(agents).knowledgeNode({ path: '../outside.md' })).rejects.toThrow(/Invalid note path/);
    expect(await api(agents).knowledgeNode({ path: 'Inbox.md' })).toMatchObject({ node: { nodeId: 'path:Inbox.md', trustStatus: 'untrusted', origin: 'vault' }, bodyStatus: 'current' });
    expect(await api(agents).knowledgeNode({ nodeId: 'gone.note' })).toBeNull();
  });

  it('serves bounded local graphs that grow with depth', async () => {
    const host = api(knowledgeHost());
    const one = await host.knowledgeGraph('know.laravel.n-plus-one', 1);
    const two = await host.knowledgeGraph('know.laravel.n-plus-one', 2);
    expect(one.nodes.length).toBeGreaterThan(3);
    expect(two.nodes.length).toBeGreaterThan(one.nodes.length);
    expect(two.nodes.length).toBeLessThanOrEqual(60);
    await expect(host.knowledgeGraph('know.laravel.n-plus-one', 9)).rejects.toThrow(/Invalid graph depth/);
    const layout = layoutGraph(two);
    expect(two).toMatchObject({ rootNodeId: 'know.laravel.n-plus-one', depth: 2 });
    expect(layout.points[0]).toMatchObject({ id: 'know.laravel.n-plus-one', depth: 0 });
    expect(new Set(layout.points.map(point => point.depth))).toEqual(new Set([0, 1, 2]));
    expect(layout.points.every(point => point.x >= 0 && point.y >= 0 && point.x <= layout.size && point.y <= layout.size)).toBe(true);
    expect(layoutGraph(two, 5)).toMatchObject({ hidden: two.nodes.length - 5 });
    const markup = renderToStaticMarkup(createElement(GraphView, { t, graph: one, title: 'N+1', onOpen: vi.fn() }));
    expect(markup).toContain('role="button"');
    expect(markup).toContain('tabindex="0"');
  });

  it('serves overview degrees from distinct resolved edges before applying limits', async () => {
    const host = api(knowledgeHost());
    const overview = await host.knowledgeOverview();
    expect(overview).toMatchObject({ generation: 7, totalNodes: 14, truncated: false });
    expect(overview.nodes).toHaveLength(14);
    const unique = new Map<string, { source: string; target: string; type: string }>();
    for (const node of overview.nodes) {
      const links = await host.knowledgeLinks(node.nodeId);
      for (const link of links.links) {
        if (link.status !== 'resolved' || !link.targetNodeId || link.sourceNodeId === link.targetNodeId) continue;
        const edge = { source: link.sourceNodeId, target: link.targetNodeId, type: link.edgeType };
        unique.set(JSON.stringify(edge), edge);
      }
      const note = await host.knowledgeNode({ nodeId: node.nodeId });
      expect(node).toMatchObject({ title: note!.node.title, path: note!.node.path, kind: note!.node.kind,
        tags: note!.node.tags, modifiedAt: note!.node.sourceModifiedAt,
        folder: node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '' });
    }
    expect(overview.totalEdges).toBe(unique.size);
    expect(new Set(overview.edges.map(edge => JSON.stringify(edge)))).toEqual(new Set(unique.keys()));
    for (const node of overview.nodes) {
      const inDegree = overview.edges.filter(edge => edge.target === node.nodeId).length;
      const outDegree = overview.edges.filter(edge => edge.source === node.nodeId).length;
      expect(node).toMatchObject({ inDegree, outDegree, degree: inDegree + outDegree });
    }
    const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    expect(overview.nodes).toEqual([...overview.nodes].sort((a, b) => b.degree - a.degree || compare(a.nodeId, b.nodeId)));
    const degrees = new Map(overview.nodes.map(node => [node.nodeId, node.degree]));
    const weight = (edge: typeof overview.edges[number]) => degrees.get(edge.source)! + degrees.get(edge.target)!;
    expect(overview.edges).toEqual([...overview.edges].sort((a, b) => weight(b) - weight(a)
      || compare(a.source, b.source) || compare(a.target, b.target) || compare(a.type, b.type)));
    const limited = await host.knowledgeOverview({ nodeLimit: 2, edgeLimit: 1 });
    expect(limited).toMatchObject({ totalNodes: 14, totalEdges: overview.totalEdges, truncated: true });
    expect(limited.nodes).toEqual(overview.nodes.slice(0, 2));
    const ids = new Set(limited.nodes.map(node => node.nodeId));
    expect(limited.edges).toEqual(overview.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).slice(0, 1));
    expect(limited.edges).toHaveLength(1);
    const edgeLimited = await host.knowledgeOverview({ edgeLimit: 1 });
    expect(edgeLimited.nodes).toEqual(overview.nodes);
    expect(edgeLimited).toMatchObject({ totalEdges: overview.totalEdges, truncated: true, edges: overview.edges.slice(0, 1) });
  });

  it('validates overview bounds and reports an empty vault without truncation', async () => {
    const host = api(knowledgeHost());
    for (const options of [{ nodeLimit: 0 }, { nodeLimit: 2001 }, { edgeLimit: 8001 }, { edgeLimit: 1.5 }, { nodeLimit: '2' }, []]) {
      await expect(host.knowledgeOverview(options as never)).rejects.toThrow(/graph overview/);
    }
    expect(await api(knowledgeHost({ knowledge: 'empty' })).knowledgeOverview()).toEqual({
      generation: 0, totalNodes: 0, totalEdges: 0, truncated: false, nodes: [], edges: [],
    });
  });

  it('syncs and reports the mode', async () => {
    const host = api(knowledgeHost());
    const before = await host.knowledgeStatus();
    const after = await host.syncKnowledge('rebuild');
    expect(after.status.generation).toBe(before.generation + 1);
    expect(after.report).toMatchObject({ mode: 'rebuild', notes: 14, skippedTotal: 5, vaultCreated: false });
    expect(after.status.lastSync).toMatchObject({ mode: 'rebuild', skipped: 5 });
    expect(after.status.skipped).toHaveLength(5);
  });
});

describe('Knowledge page rendering', () => {
  it('shows loading, unavailable and empty states', async () => {
    expect(renderToStaticMarkup(createElement(KnowledgeView, { ...viewProps(await api(knowledgeHost()).knowledgeStatus()), status: { loading: true } }))).toContain(t.common.loading);
    const unavailable = renderToStaticMarkup(createElement(KnowledgeView, viewProps({ state: 'unavailable', reason: 'index_locked', vaultRoot: 'vaults/default', vaultPresent: true, generation: 0, skipped: [] })));
    expect(unavailable).toContain('data-state="unavailable"');
    expect(unavailable).toContain('index_locked');
    const absent = renderToStaticMarkup(createElement(KnowledgeView, viewProps({ state: 'ready', vaultRoot: 'vaults/work', vaultPresent: false, generation: 0, counts: { notes: 0, edges: 0, unresolvedLinks: 0, skipped: 0 }, skipped: [] })));
    expect(absent).toContain(t.knowledge.vaultMissing);
    const empty = renderToStaticMarkup(createElement(KnowledgeView, viewProps(await api(knowledgeHost({ knowledge: 'empty' })).knowledgeStatus())));
    expect(empty).toContain('data-state="empty"');
    expect(empty).toContain('<code>vaults/default</code>');
    expect(empty).toContain(t.knowledge.neverSynced);
    expect(empty).not.toContain('/Users/');
  });

  it('lists skipped files with reasons and search results with path and snippet; a hit opens the note', async () => {
    const host = api(knowledgeHost());
    const status = await host.knowledgeStatus();
    const results = await host.searchKnowledge('caching');
    const onOpen = vi.fn();
    const props = viewProps(status, { query: 'caching', results: loaded(results), onOpen });
    const markup = renderToStaticMarkup(createElement(KnowledgeView, props));
    expect(markup).toContain(t.knowledge.skipped(5));
    expect(markup).toContain(t.knowledge.skipReasons.profile_mismatch);
    expect(markup).toContain('Projects/Shop/Caching.md');
    const hit = elements(KnowledgeView(props)).find(element => element.props.className === 'session-select knowledge-hit')!;
    (hit.props.onClick as () => void)();
    expect(onOpen).toHaveBeenCalledWith(results.hits[0]!.nodeId);
    expect(renderToStaticMarkup(createElement(KnowledgeView, viewProps(status, { query: 'zzz', results: loaded({ generation: 7, hits: [] }) })))).toContain(t.knowledge.noResults('zzz'));
    // After a host restart the status knows the total but not the list.
    const restarted = renderToStaticMarkup(createElement(KnowledgeView, viewProps({ ...status, skipped: [] })));
    expect(restarted).toContain(t.knowledge.skipped(5));
    expect(restarted).toContain(t.knowledge.skippedListHint);
  });

  it('renders the note body with resolved, ambiguous and missing wikilinks, and leaves code alone', async () => {
    const { note, links } = await noteFixture(knowledgeHost(), 'know.laravel.n-plus-one');
    const markup = renderToStaticMarkup(createElement(NoteBody, { t, body: note.body!, links, onOpen: vi.fn() }));
    expect(markup).toContain('data-link="resolved"');
    expect(markup).toContain('data-link="ambiguous"');
    expect(markup).toContain('data-link="missing"');
    expect(markup).toContain('[[Not a link]]');
    // The table cell keeps its `\|` display text.
    expect(markup).toMatch(/data-link="resolved"[^>]*>Eloquent</);
    expect(markup).not.toMatch(/<script/i);
  });

  it('navigates on a resolved link, and opens a candidate picker for an ambiguous one', async () => {
    const { links } = await noteFixture(knowledgeHost(), 'know.laravel.n-plus-one');
    const byTarget = linksByTarget(links.links);
    const nodes = pageNodes(links);
    const onOpen = vi.fn(), onToggle = vi.fn();
    const resolved = WikiLinkView({ t, link: { type: 'wikilink', target: 'Laravel Eloquent', embed: false }, edge: byTarget.get(linkKey('Laravel Eloquent')), nodes, open: false, pickerId: 'p1', onToggle, onOpen })!;
    (resolved.props as { onClick: () => void }).onClick();
    expect(onOpen).toHaveBeenCalledWith('know.laravel.eloquent');

    const ambiguousLink = { type: 'wikilink' as const, target: 'Caching', embed: false };
    const closed = elements(WikiLinkView({ t, link: ambiguousLink, edge: byTarget.get(linkKey('Caching')), nodes, open: false, pickerId: 'p2', onToggle, onOpen }));
    const toggle = closed.find(element => element.props['data-link'] === 'ambiguous')!;
    expect(toggle.props['aria-expanded']).toBe(false);
    (toggle.props.onClick as () => void)();
    expect(onToggle).toHaveBeenLastCalledWith(true);
    expect(closed.some(element => element.props['data-candidate'])).toBe(false);

    const open = elements(WikiLinkView({ t, link: ambiguousLink, edge: byTarget.get(linkKey('Caching')), nodes, open: true, pickerId: 'p2', onToggle, onOpen }));
    const candidates = open.filter(element => element.props['data-candidate']);
    expect(candidates.map(element => text(element.props.children as ReactNode))).toEqual(['CachingKnowledge/Caching.md', 'Caching (Shop)Projects/Shop/Caching.md']);
    (candidates[1]!.props.onClick as () => void)();
    expect(onToggle).toHaveBeenLastCalledWith(false);
    expect(onOpen).toHaveBeenLastCalledWith('path:Projects/Shop/Caching.md');
    // Escape closes the picker.
    const wrapper = WikiLinkView({ t, link: ambiguousLink, edge: byTarget.get(linkKey('Caching')), nodes, open: true, pickerId: 'p2', onToggle, onOpen })!;
    (wrapper.props as { onKeyDown: (event: unknown) => void }).onKeyDown({ key: 'Escape', stopPropagation: vi.fn() });
    expect(onToggle).toHaveBeenLastCalledWith(false);

    const missing = renderToStaticMarkup(WikiLinkView({ t, link: { type: 'wikilink', target: 'Redis Cluster', embed: false }, edge: byTarget.get(linkKey('Redis Cluster')), nodes, open: false, pickerId: 'p3', onToggle, onOpen })!);
    expect(missing).toContain('class="wikilink missing"');
    expect(missing).toContain(t.knowledge.missingTitle);
    expect(missing).not.toContain('<button');
  });

  it('shows front matter as declared and never as trusted, and lists links with their status', async () => {
    const { note, links, backlinks } = await noteFixture(knowledgeHost(), 'know.laravel.n-plus-one');
    const meta = renderToStaticMarkup(createElement(NoteMeta, { t, language: 'en', node: note.node }));
    expect(meta).toContain(t.knowledge.declared('verified'));
    expect(meta).toContain(t.knowledge.untrusted);
    expect(meta).toContain(t.knowledge.revision(3));
    expect(meta).toContain('task-123');
    const outgoing = renderToStaticMarkup(createElement(LinkList, { t, title: t.knowledge.links, empty: t.knowledge.noLinks, page: loaded(links), onOpen: vi.fn() }));
    expect(outgoing).toContain(t.knowledge.edgeTypes.learned_from);
    expect(outgoing).toContain(t.knowledge.missing);
    expect(outgoing).toContain(t.knowledge.ambiguous(2));
    const incoming = renderToStaticMarkup(createElement(LinkList, { t, title: t.knowledge.backlinks, empty: t.knowledge.noBacklinks, page: loaded(backlinks), backlinks: true, onOpen: vi.fn() }));
    expect(incoming).toContain('Laravel Eloquent');
    expect(MESSAGES.id.knowledge.declared('verified')).toContain('belum diverifikasi');
  });
});

describe('wikilink parsing', () => {
  it('parses wikilinks only when asked, with headings, display text, embeds and escapes', () => {
    expect(JSON.stringify(parseMarkdown('See [[Note]].'))).not.toContain('wikilink');
    const [paragraph] = parseMarkdown('A [[Folder/Note#Part|shown]] and ![[Pic]] but not \\[[x]] or [[#Heading]] or `[[code]]`.', { wikilinks: true });
    const inline = paragraph!.type === 'paragraph' ? paragraph!.children : [];
    expect(inline.filter(node => node.type === 'wikilink')).toEqual([
      { type: 'wikilink', target: 'Folder/Note', heading: 'Part', display: 'shown', embed: false },
      { type: 'wikilink', target: 'Pic', embed: true },
    ]);
    const [table] = parseMarkdown('| a |\n| --- |\n| [[T\\|disp]] |', { wikilinks: true });
    expect(table!.type === 'table' && table!.rows[0]![0]).toEqual([{ type: 'wikilink', target: 'T', display: 'disp', embed: false }]);
  });
});
