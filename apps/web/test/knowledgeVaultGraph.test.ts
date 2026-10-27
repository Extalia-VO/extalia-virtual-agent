import type { AgentHostApi, KnowledgeOverview, KnowledgeOverviewNode, KnowledgeStatus } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { KnowledgeView, type KnowledgeViewProps } from '../src/knowledge/KnowledgePage';
import { knowledgeMethodsPresent, overviewMethodPresent } from '../src/knowledge/knowledgeModel';
import { createSimCore } from '../src/knowledge/vault/simCore';
import { decodeCommand, decodeFrame, encodeFrame, encodeInit, encodeMask, SIM_ALPHA_MIN, type SimFrame } from '../src/knowledge/vault/simProtocol';
import { synthOverview } from '../src/knowledge/vault/synthOverview';
import {
  assignColours, degreeWeight, edgeEndColour, GRAPH_OTHER_COLOUR, GRAPH_PALETTE, groupKey, hexToRgb, labelCandidates, neighbourSet, nodeLook, prepareVaultGraph,
  QUALITY_TIERS, rankSearch, timeCutoff, timeMask, updateQuality,
} from '../src/knowledge/vault/vaultGraphModel';

const t = MESSAGES.en;
const NOW = Date.parse('2026-10-24T12:00:00Z');
const DAY = 86_400_000;

function node(nodeId: string, patch: Partial<KnowledgeOverviewNode> = {}): KnowledgeOverviewNode {
  return { nodeId, title: nodeId, path: `${nodeId}.md`, folder: '', tags: [], degree: 0, inDegree: 0, outDegree: 0, modifiedAt: new Date(NOW).toISOString(), ...patch };
}
function overview(nodes: KnowledgeOverviewNode[], edges: [string, string][]): KnowledgeOverview {
  return { generation: 1, totalNodes: nodes.length, totalEdges: edges.length, truncated: false, nodes, edges: edges.map(([source, target]) => ({ source, target, type: 'links_to' })) };
}

describe('vault graph preparation', () => {
  it('drops self links, unknown ends and repeated pairs, and builds neighbour lists', () => {
    const graph = prepareVaultGraph(overview([node('a', { degree: 3 }), node('b', { degree: 1 }), node('c', { degree: 2 })],
      [['a', 'b'], ['b', 'a'], ['a', 'a'], ['a', 'c'], ['c', 'x']]));
    expect(Array.from(graph.edges)).toEqual([0, 1, 0, 2]);
    expect([...neighbourSet(graph, 0)].sort()).toEqual([0, 1, 2]);
    expect([...neighbourSet(graph, 1)].sort()).toEqual([0, 1]);
    expect(graph.hubs[0]).toBe(0);
    expect(graph.maxDegree).toBe(3);
    // The local degree is a floor when the host reports less.
    expect(prepareVaultGraph(overview([node('a'), node('b')], [['a', 'b']])).degree[0]).toBe(1);
  });

  it('caps at the overview limits, most connected notes first', () => {
    const big = synthOverview(300, { edgesPerNode: 3 });
    const graph = prepareVaultGraph(big, { nodes: 100, edges: 150 });
    expect(graph.nodes).toHaveLength(100);
    expect(graph.edges.length / 2).toBeLessThanOrEqual(150);
    expect(graph.truncated).toBe(true);
    const kept = Math.min(...graph.nodes.map(item => item.degree));
    const dropped = big.nodes.filter(item => !graph.indexById.has(item.nodeId)).map(item => item.degree);
    expect(Math.max(...dropped)).toBeLessThanOrEqual(kept);
    expect(graph.totalNodes).toBe(300);
  });

  it('prepares the shared mock overview (large vault)', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge', knowledge: 'large' }).capabilities.agents!;
    const result = await agents.knowledgeOverview!();
    const graph = prepareVaultGraph(result);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(300);
    expect(graph.edges.length / 2).toBeGreaterThan(graph.nodes.length);
    expect(graph.degree[graph.hubs[0]!]).toBeGreaterThan(10);
  });
});

describe('vault graph look', () => {
  it('maps degree to size and glow on a log scale, hubs biggest and brightest', () => {
    expect(degreeWeight(0, 10)).toBe(0);
    expect(degreeWeight(10, 10)).toBe(1);
    expect(degreeWeight(5, 0)).toBe(0);
    const looks = [0, 1, 4, 20, 100].map(degree => nodeLook(degree, 100));
    for (let i = 1; i < looks.length; i++) {
      expect(looks[i]!.radius).toBeGreaterThan(looks[i - 1]!.radius);
      expect(looks[i]!.halo).toBeGreaterThan(looks[i - 1]!.halo);
      expect(looks[i]!.glow).toBeGreaterThan(looks[i - 1]!.glow);
    }
    expect(looks[0]!.glow).toBeGreaterThan(0);
    expect(looks[4]!.glow).toBeCloseTo(1);
    // Log scale: one link is already clearly visible next to none.
    expect(degreeWeight(1, 100)).toBeGreaterThan(0.1);
  });

  it('colours the largest groups first and folds the rest into a quiet slate', () => {
    const nodes = [
      ...Array.from({ length: 5 }, (_, i) => node(`k${i}`, { folder: 'Knowledge', kind: 'knowledge', tags: ['php', 'laravel'] })),
      ...Array.from({ length: 3 }, (_, i) => node(`p${i}`, { folder: 'Projects', tags: ['laravel'] })),
      ...Array.from({ length: 14 }, (_, i) => node(`s${i}`, { folder: `Single ${String(i).padStart(2, '0')}` })),
    ];
    const byFolder = assignColours(nodes, 'folder');
    expect(byFolder.colours[0]).toBe(GRAPH_PALETTE[0]);
    expect(byFolder.colours[5]).toBe(GRAPH_PALETTE[1]);
    expect(byFolder.legend).toHaveLength(GRAPH_PALETTE.length);
    expect(byFolder.legend[0]).toMatchObject({ key: 'Knowledge', count: 5 });
    expect(byFolder.other).toBe(4);
    expect(byFolder.colours.filter(colour => colour === GRAPH_OTHER_COLOUR)).toHaveLength(4);
    // Tag mode joins the most common tag; kind mode groups missing kinds under ''.
    expect(groupKey(nodes[0]!, 'tag', new Map([['php', 5], ['laravel', 8]]))).toBe('laravel');
    expect(assignColours(nodes, 'tag').legend.slice(0, 2)).toMatchObject([{ key: '', count: 14 }, { key: 'laravel', count: 8 }]);
    expect(assignColours(nodes, 'kind').legend[0]).toMatchObject({ key: '', count: 17 });
    expect(new Set(GRAPH_PALETTE).size).toBe(GRAPH_PALETTE.length);
  });

  it('mixes a faint edge colour from both ends', () => {
    const [r, g, b] = edgeEndColour(hexToRgb('#ff0000'), hexToRgb('#0000ff'), 0.5);
    expect(r).toBeCloseTo(0.35);
    expect(g).toBe(0);
    expect(b).toBeCloseTo(0.15);
    expect(hexToRgb('#7c9cff')).toEqual([124 / 255, 156 / 255, 1]);
  });
});

describe('vault graph filters and search', () => {
  const nodes = [
    node('today', { title: 'Query Plans', modifiedAt: new Date(NOW - 2 * 3_600_000).toISOString(), tags: ['mysql'], degree: 4 }),
    node('week', { title: 'Caching layers', modifiedAt: new Date(NOW - 3 * DAY).toISOString(), tags: ['performance'], degree: 1, path: 'Knowledge/Café notes.md' }),
    node('month', { title: 'Plan review', modifiedAt: new Date(NOW - 20 * DAY).toISOString(), degree: 9 }),
    node('year', { title: 'Old query ideas', modifiedAt: new Date(NOW - 200 * DAY).toISOString(), degree: 2 }),
    node('ancient', { title: 'Résumé', modifiedAt: new Date(NOW - 900 * DAY).toISOString() }),
    node('unknown', { title: 'No date', modifiedAt: 'not a date' }),
  ];
  const graph = prepareVaultGraph(overview(nodes, []));

  it('keeps notes modified inside the time window', () => {
    expect(timeCutoff('all', NOW)).toBeNull();
    expect(timeCutoff('1w', NOW)).toBe(NOW - 7 * DAY);
    expect(Array.from(timeMask(nodes, '1d', NOW))).toEqual([1, 0, 0, 0, 0, 0]);
    expect(Array.from(timeMask(nodes, '1w', NOW))).toEqual([1, 1, 0, 0, 0, 0]);
    expect(Array.from(timeMask(nodes, '1m', NOW))).toEqual([1, 1, 1, 0, 0, 0]);
    expect(Array.from(timeMask(nodes, '1y', NOW))).toEqual([1, 1, 1, 1, 0, 0]);
    expect(Array.from(timeMask(nodes, 'all', NOW))).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('ranks title prefixes over word starts over paths, every term must match', () => {
    expect(rankSearch(graph, 'query')).toEqual([0, 3]);
    expect(rankSearch(graph, 'plan')).toEqual([2, 0]);
    expect(rankSearch(graph, 'query plans')[0]).toBe(0);
    expect(rankSearch(graph, 'query nothing')).toEqual([]);
    expect(rankSearch(graph, '  ')).toEqual([]);
    // Diacritics fold; tags and paths match too.
    expect(rankSearch(graph, 'resume')).toEqual([4]);
    expect(rankSearch(graph, 'cafe')).toEqual([1]);
    expect(rankSearch(graph, 'mysql')).toEqual([0]);
    // The time filter limits matches; the limit caps them.
    expect(rankSearch(graph, 'query', 20, timeMask(nodes, '1d', NOW))).toEqual([0]);
    expect(rankSearch(graph, 'e', 2)).toHaveLength(2);
  });

  it('labels focus notes first, then the top hubs still shown', () => {
    const mask = timeMask(nodes, 'all', NOW);
    expect(labelCandidates(graph, mask, [4, null, 4], 2)).toEqual([4, 2, 0]);
    expect(labelCandidates(graph, mask, [null, null, null], 0)).toEqual([]);
    expect(labelCandidates(graph, timeMask(nodes, '1w', NOW), [3], 3)).toEqual([0, 1]);
  });

  it('steps quality down on slow windows and back up on smooth ones', () => {
    let state = { tier: 0, slow: 0, fast: 0 };
    state = updateQuality(state, 30);
    expect(state.tier).toBe(0);
    state = updateQuality(state, 30);
    expect(state.tier).toBe(1);
    for (let i = 0; i < 5; i++) state = updateQuality(state, 60);
    expect(state.tier).toBe(0);
    for (let i = 0; i < 10; i++) state = updateQuality(state, 20);
    expect(state.tier).toBe(QUALITY_TIERS.length - 1);
    expect(QUALITY_TIERS.at(-1)!.haloScale).toBeLessThan(QUALITY_TIERS[0].haloScale);
  });
});

describe('vault graph simulation protocol', () => {
  it('encodes commands with transferable copies and validates what it receives', () => {
    const edges = Uint32Array.from([0, 1, 1, 2]);
    const degree = Uint32Array.from([1, 2, 1]);
    const init = encodeInit(3, edges, degree);
    expect(init.transfer).toHaveLength(2);
    expect(init.message).toMatchObject({ type: 'init', count: 3 });
    expect((init.message as { edges: Uint32Array }).edges).not.toBe(edges);
    expect(decodeCommand(init.message)).toEqual(init.message);
    expect(decodeCommand(encodeInit(3, edges, degree, new Float32Array(9)).message)).toMatchObject({ seed: expect.any(Float32Array) });
    const mask = encodeMask(Uint8Array.from([1, 0, 1]));
    expect(decodeCommand(mask.message)).toEqual({ type: 'mask', active: Uint8Array.from([1, 0, 1]) });
    expect(decodeCommand({ type: 'drag', index: 2, x: 1, y: 2, z: 3 })).toEqual({ type: 'drag', index: 2, x: 1, y: 2, z: 3 });
    expect(decodeCommand({ type: 'release', index: 1 })).toEqual({ type: 'release', index: 1 });
    expect(decodeCommand({ type: 'reheat', alpha: 0.3 })).toEqual({ type: 'reheat', alpha: 0.3 });
    expect(decodeCommand({ type: 'pause' })).toEqual({ type: 'pause' });
    // Malformed commands are ignored.
    expect(decodeCommand({ type: 'init', count: 2, edges: Uint32Array.from([0, 5]), degree: new Uint32Array(2) })).toBeNull();
    expect(decodeCommand({ type: 'init', count: 2, edges: Uint32Array.from([0]), degree: new Uint32Array(2) })).toBeNull();
    expect(decodeCommand({ type: 'init', count: 2, edges: [0, 1], degree: new Uint32Array(2) })).toBeNull();
    expect(decodeCommand({ type: 'drag', index: -1, x: 0, y: 0, z: 0 })).toBeNull();
    expect(decodeCommand({ type: 'drag', index: 1, x: Number.NaN, y: 0, z: 0 })).toBeNull();
    expect(decodeCommand({ type: 'reheat', alpha: 4 })).toBeNull();
    expect(decodeCommand({ type: 'evil' })).toBeNull();
    expect(decodeCommand(null)).toBeNull();
  });

  it('round-trips position frames and rejects a frame of the wrong size', () => {
    const positions = Float32Array.from([1, 2, 3, 4, 5, 6]);
    const frame = encodeFrame(positions, 0.2, true);
    expect(frame.transfer).toEqual([positions.buffer]);
    expect(decodeFrame(frame.message, 2)).toEqual({ type: 'positions', positions, alpha: 0.2, running: true });
    expect(decodeFrame(frame.message, 3)).toBeNull();
    expect(decodeFrame({ type: 'positions', positions: [1, 2, 3], alpha: 0, running: false }, 1)).toBeNull();
  });

  it('lays out, posts frames at a capped rate, cools to a stop and settles again after a filter change', () => {
    const graph = prepareVaultGraph(synthOverview(200));
    const frames: SimFrame[] = [];
    const queue: (() => void)[] = [];
    let clock = 0;
    const core = createSimCore({ post: ({ message }) => frames.push(message), schedule: run => queue.push(run), now: () => (clock += 0.5) });
    core.handle(encodeInit(graph.nodes.length, graph.edges, graph.degree).message);
    let slices = 0;
    while (queue.length && slices++ < 5_000) queue.shift()!();
    expect(core.running).toBe(false);
    expect(core.alpha).toBeLessThan(SIM_ALPHA_MIN);
    const last = frames.at(-1)!;
    expect(last.running).toBe(false);
    expect(last.positions).toHaveLength(graph.nodes.length * 3);
    expect(last.positions.every(Number.isFinite)).toBe(true);
    // Capped: far fewer frames than ticks; the clock advanced 0.5 ms per reading.
    expect(frames.length).toBeLessThan(clock / (1000 / 30) + 3);
    // Linked notes end up nearer each other than the layout's average spread.
    const at = (i: number) => last.positions.subarray(i * 3, i * 3 + 3);
    const dist = (a: number, b: number) => Math.hypot(at(a)[0]! - at(b)[0]!, at(a)[1]! - at(b)[1]!, at(a)[2]! - at(b)[2]!);
    let linked = 0;
    for (let e = 0; e < graph.edges.length; e += 2) linked += dist(graph.edges[e]!, graph.edges[e + 1]!);
    linked /= graph.edges.length / 2;
    let random = 0;
    for (let i = 0; i < 100; i++) random += dist(i, 199 - i);
    expect(linked).toBeLessThan(random / 100);
    // A filter change restarts briefly.
    const mask = new Uint8Array(graph.nodes.length).fill(1);
    mask.fill(0, 0, 50);
    core.handle(encodeMask(mask).message);
    expect(core.running).toBe(true);
    slices = 0;
    while (queue.length && slices++ < 5_000) queue.shift()!();
    expect(core.running).toBe(false);
    // Pause stops scheduling until resumed.
    core.handle({ type: 'reheat', alpha: 0.3 });
    core.handle({ type: 'pause' });
    queue.splice(0).forEach(run => run());
    expect(queue).toHaveLength(0);
    core.handle({ type: 'resume' });
    expect(queue.length).toBeGreaterThan(0);
  });
});

describe('vault graph page shell', () => {
  const status: KnowledgeStatus = {
    state: 'ready', vaultRoot: 'vaults/default', vaultPresent: true, schemaVersion: 1, generation: 1,
    counts: { notes: 3, edges: 2, unresolvedLinks: 0, skipped: 0 }, skipped: [],
  } as unknown as KnowledgeStatus;
  const props = (patch: Partial<KnowledgeViewProps> = {}): KnowledgeViewProps => ({
    t, language: 'en', status: { value: status, loading: false }, query: '', onQuery: vi.fn(), results: null, selectedId: null, onOpen: vi.fn(), onClose: vi.fn(),
    note: { loading: false }, links: { loading: false }, backlinks: { loading: false }, graphOpen: false, onGraphOpen: vi.fn(), depth: 1, onDepth: vi.fn(),
    graph: { loading: false }, syncing: false, onSync: vi.fn(), ...patch,
  });
  const render = (patch: Partial<KnowledgeViewProps> = {}) => renderToStaticMarkup(createElement(KnowledgeView, props(patch)));
  const vault = overview([
    node('hub', { title: 'Hub note', folder: 'Knowledge', degree: 2 }), node('leaf', { title: 'Leaf note', folder: 'Projects', degree: 1 }),
    node('other', { title: 'Other note', degree: 1 }),
  ], [['hub', 'leaf'], ['hub', 'other']]);

  it('offers the whole-vault graph only when the host serves the overview', async () => {
    const full = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    expect(overviewMethodPresent(full)).toBe(true);
    const { knowledgeOverview: _omitted, ...withoutOverview } = full;
    expect(knowledgeMethodsPresent(withoutOverview as AgentHostApi)).toBe(true);
    expect(overviewMethodPresent(withoutOverview as AgentHostApi)).toBe(false);
    expect(overviewMethodPresent(undefined)).toBe(false);
    // Without `onScope` (no overview) there is no switch and the local view shows.
    const local = render();
    expect(local).not.toContain(t.knowledge.vaultGraph.whole);
    expect(local).toContain('knowledge-layout');
  });

  it('switches between the local view (default) and the whole vault', () => {
    const local = render({ onScope: vi.fn() });
    expect(local).toContain(t.knowledge.vaultGraph.whole);
    expect(local).toMatch(/aria-pressed="true"[^>]*>Local</);
    expect(local).toContain('knowledge-layout');
    const whole = render({ onScope: vi.fn(), scope: 'vault', overview: { value: vault, loading: false } });
    expect(whole).toMatch(/aria-pressed="true"[^>]*>Whole vault</);
    expect(whole).not.toContain('knowledge-layout');
    expect(whole).toContain('vault-graph-stage');
    expect(whole).toContain(t.knowledge.vaultGraph.counts(3, 2));
    // Scope without the switch falls back to local.
    expect(render({ scope: 'vault', overview: { value: vault, loading: false } })).not.toContain('vault-graph-stage');
  });

  it('has an accessible list fallback with the top hubs, the legend and the canvas description', () => {
    const whole = render({ onScope: vi.fn(), scope: 'vault', overview: { value: vault, loading: false } });
    expect(whole).toContain(t.knowledge.vaultGraph.listView);
    expect(whole).toContain(t.knowledge.vaultGraph.hubs);
    expect(whole.indexOf('Hub note')).toBeLessThan(whole.indexOf('Leaf note'));
    expect(whole).toContain(t.knowledge.vaultGraph.canvasLabel(3, 2));
    expect(whole).toContain('vault-graph-legend');
    expect(whole).toContain(t.knowledge.vaultGraph.root);
    expect(whole).toContain('role="combobox"');
  });

  it('shows loading, error and empty overview states, and the note panel for a selection', () => {
    expect(render({ onScope: vi.fn(), scope: 'vault', overview: { loading: true } })).toContain(t.knowledge.vaultGraph.loading);
    expect(render({ onScope: vi.fn(), scope: 'vault', overview: { error: 'Index busy.', loading: false } })).toContain('Index busy.');
    expect(render({ onScope: vi.fn(), scope: 'vault', overview: { value: overview([], []), loading: false } })).toContain(t.knowledge.vaultGraph.empty);
    const selected = render({ onScope: vi.fn(), scope: 'vault', overview: { value: vault, loading: false }, selectedId: 'hub' });
    expect(selected).toContain('vault-graph-panel');
    expect(selected).toContain('knowledge-note');
  });

  it('has every vault graph string in Indonesian too', () => {
    const keys = (value: object): string[] => Object.entries(value).flatMap(([key, item]) => typeof item === 'object' && item ? keys(item).map(sub => `${key}.${sub}`) : [key]);
    expect(keys(MESSAGES.id.knowledge.vaultGraph).sort()).toEqual(keys(MESSAGES.en.knowledge.vaultGraph).sort());
    expect(MESSAGES.id.knowledge.vaultGraph.whole).not.toBe(MESSAGES.en.knowledge.vaultGraph.whole);
  });
});
