import { describe, expect, it } from 'vitest';
import { createMockKnowledge, MOCK_LARGE_VAULT_NOTES } from '../src/host/mockKnowledge';
import { generateMockVault, MOCK_VAULT_SEED, MOCK_VAULT_SPAN_DAYS } from '../src/host/mockKnowledgeVault';

const NOW = Date.parse('2026-10-24T09:00:00Z');
const DAY_MS = 86_400_000;
const instant = () => Promise.resolve();

describe('mock knowledge overview (W5, `knowledge=large`)', () => {
  it('generates the same vault for the same seed, and another for another seed', () => {
    expect(generateMockVault()).toEqual(generateMockVault(MOCK_VAULT_SEED));
    expect(generateMockVault(1)).not.toEqual(generateMockVault(2));
    const paths = MOCK_LARGE_VAULT_NOTES.map(note => note.path);
    expect(new Set(paths).size).toBe(paths.length);
    // Generated titles never collide with each other (they resolve by title).
    const stems = generateMockVault().map(note => note.path.replace(/\.md$/, '').split('/').pop()!.toLowerCase());
    expect(new Set(stems).size).toBe(stems.length);
  });

  it('serves a deterministic vault graph of about 400 notes and 900 links with hubs, folders, tags and three months of edits', async () => {
    const first = await createMockKnowledge('large', instant, NOW).knowledgeOverview();
    expect(await createMockKnowledge('large', instant, NOW).knowledgeOverview()).toEqual(first);
    expect(first.totalNodes).toBeGreaterThanOrEqual(380);
    expect(first.totalNodes).toBeLessThanOrEqual(420);
    expect(first.totalEdges).toBeGreaterThanOrEqual(800);
    expect(first.totalEdges).toBeLessThanOrEqual(1_000);
    expect(first).toMatchObject({ truncated: false, generation: 7 });
    expect(first.nodes).toHaveLength(first.totalNodes);
    expect(first.edges).toHaveLength(first.totalEdges);
    // A few highly connected hubs, many leaves.
    const degrees = first.nodes.map(node => node.degree);
    expect(degrees.slice(0, 3).every(degree => degree >= 40)).toBe(true);
    expect(degrees.filter(degree => degree <= 3).length).toBeGreaterThan(first.totalNodes / 2);
    expect(new Set(first.nodes.map(node => node.folder)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(first.nodes.flatMap(node => node.tags)).size).toBeGreaterThanOrEqual(10);
    const ages = first.nodes.map(node => (NOW - Date.parse(node.modifiedAt)) / DAY_MS);
    expect(Math.min(...ages)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ages)).toBeGreaterThan(MOCK_VAULT_SPAN_DAYS - 10);
    expect(Math.max(...ages)).toBeLessThanOrEqual(MOCK_VAULT_SPAN_DAYS + 1);
    // Degrees count the edge set; every edge joins two different listed notes.
    const ids = new Set(first.nodes.map(node => node.nodeId));
    for (const edge of first.edges) expect(ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target).toBe(true);
    for (const node of first.nodes) {
      expect(node.inDegree).toBe(first.edges.filter(edge => edge.target === node.nodeId).length);
      expect(node.degree).toBe(node.inDegree + node.outDegree);
    }
  });

  it('keeps the most connected notes and the edges among them when bounded, and validates the bounds', async () => {
    const knowledge = createMockKnowledge('large', instant, NOW);
    const full = await knowledge.knowledgeOverview();
    const top = await knowledge.knowledgeOverview({ nodeLimit: 50, edgeLimit: 2_000 });
    expect(top).toMatchObject({ truncated: true, totalNodes: full.totalNodes, totalEdges: full.totalEdges });
    expect(top.nodes.map(node => node.nodeId)).toEqual(full.nodes.slice(0, 50).map(node => node.nodeId));
    const kept = new Set(top.nodes.map(node => node.nodeId));
    expect(top.edges.every(edge => kept.has(edge.source) && kept.has(edge.target))).toBe(true);
    expect((await knowledge.knowledgeOverview({ edgeLimit: 10 })).edges).toHaveLength(10);
    await expect(knowledge.knowledgeOverview({ nodeLimit: 0 })).rejects.toThrow(/from 1 to 2000/);
    await expect(knowledge.knowledgeOverview({ edgeLimit: 9_000 })).rejects.toThrow(/from 1 to 8000/);
    expect((await createMockKnowledge('sample', instant, NOW).knowledgeOverview()).totalNodes).toBe(14);
    expect(await createMockKnowledge('empty', instant, NOW).knowledgeOverview()).toMatchObject({ totalNodes: 0, totalEdges: 0, nodes: [], edges: [], truncated: false });
  });

  it('opens every note of the overview, so a click in the graph always shows a note', async () => {
    const knowledge = createMockKnowledge('large', instant, NOW);
    const overview = await knowledge.knowledgeOverview({ nodeLimit: 2_000 });
    const hub = overview.nodes[0]!;
    expect(hub.path).toMatch(/^Maps\//);
    for (const node of [hub, ...overview.nodes.slice(-5)]) {
      expect(await knowledge.knowledgeNode({ nodeId: node.nodeId })).toMatchObject({ node: { nodeId: node.nodeId, path: node.path, title: node.title } });
    }
    const backlinks = await knowledge.knowledgeBacklinks(hub.nodeId);
    expect(backlinks.links.length).toBeGreaterThanOrEqual(Math.min(hub.inDegree, 100));
  });
});
