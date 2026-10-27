import type { KnowledgeEdgeType, KnowledgeOverview } from '@extalia/platform';

/**
 * A synthetic vault overview for tests and the dev-only stress flag (`?graphnodes=N`, Vite dev
 * server only): clustered folders, preferential attachment (a few hubs, many leaves, like real
 * vaults), tags, kinds and modification times over two years. Deterministic for a seed.
 */
export function synthOverview(count: number, options: { edgesPerNode?: number; seed?: number; now?: number } = {}): KnowledgeOverview {
  let state = (options.seed ?? 7) >>> 0 || 1;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const now = options.now ?? Date.parse('2026-10-24T00:00:00Z');
  const folders = ['Knowledge', 'Projects', 'Daily', 'People', 'Experiences', 'Areas/Engineering', 'Areas/Design', 'Archive', 'Inbox', 'Reading', 'Meetings', 'Ideas', 'Snippets', ''];
  const kinds = ['knowledge', 'experience', 'project', 'person', 'daily', undefined];
  const tags = ['laravel', 'mysql', 'performance', 'react', 'three', 'design', 'ops', 'security', 'rust', 'writing'];
  const types: KnowledgeEdgeType[] = ['links_to', 'links_to', 'links_to', 'related_to', 'learned_from', 'depends_on'];
  const edgesPerNode = options.edgesPerNode ?? 2;
  const ends: number[] = [];
  const pairs = new Set<string>();
  const edges: KnowledgeOverview['edges'] = [];
  const folderOf = Array.from({ length: count }, () => Math.min(folders.length - 1, Math.floor(random() ** 1.6 * folders.length)));
  for (let i = 0; i < count; i++) {
    const links = i === 0 ? 0 : 1 + Math.floor(random() * edgesPerNode * 1.5);
    for (let k = 0; k < links; k++) {
      // Mostly preferential attachment, sometimes a note of the same folder.
      let target = ends.length && random() < 0.75 ? ends[Math.floor(random() * ends.length)]! : Math.floor(random() * i);
      if (random() < 0.3) { for (let tries = 0; tries < 6; tries++) { const pick = Math.floor(random() * i); if (folderOf[pick] === folderOf[i]) { target = pick; break; } } }
      if (target === i || target === undefined) continue;
      const key = `${Math.min(i, target)}:${Math.max(i, target)}`;
      if (pairs.has(key)) continue;
      pairs.add(key);
      edges.push({ source: `synth.${i}`, target: `synth.${target}`, type: types[Math.floor(random() * types.length)]! });
      ends.push(i, target);
    }
  }
  const inDegree = new Array<number>(count).fill(0), outDegree = new Array<number>(count).fill(0);
  for (const edge of edges) { outDegree[Number(edge.source.slice(6))]! += 1; inDegree[Number(edge.target.slice(6))]! += 1; }
  const nodes = Array.from({ length: count }, (_, i) => {
    const folder = folders[folderOf[i]!]!;
    const title = `Note ${i} ${['Query plans', 'Caching', 'Render budget', 'Team sync', 'Reading list', 'Ideas', 'Postmortem', 'Design review'][i % 8]}`;
    const kind = kinds[i % kinds.length];
    const tagCount = Math.floor(random() * 3);
    return {
      nodeId: `synth.${i}`, title, path: `${folder ? `${folder}/` : ''}${title}.md`, ...(kind ? { kind } : {}), folder,
      tags: Array.from(new Set(Array.from({ length: tagCount }, () => tags[Math.floor(random() * tags.length)]!))),
      degree: inDegree[i]! + outDegree[i]!, inDegree: inDegree[i]!, outDegree: outDegree[i]!,
      modifiedAt: new Date(now - Math.floor(random() ** 2.2 * 730 * 86_400_000)).toISOString(),
    };
  });
  return { generation: 1, totalNodes: count, totalEdges: edges.length, truncated: false, nodes, edges };
}
