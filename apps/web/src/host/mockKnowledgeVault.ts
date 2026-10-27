/**
 * A generated sample vault for the mock host's Knowledge index (W5): about 390 notes in several
 * folders that, with the hand-written notes of `mockKnowledge.ts`, give a vault graph of about 400
 * notes and 900 resolved links. A few map-of-content notes are hubs; other links follow
 * preferential attachment, so degrees are skewed like a real vault. Tags follow the topic, and
 * modification times spread over the last three months (more recent edits than old ones).
 * Deterministic: the same seed always gives the same notes.
 */

/** One generated note in the shape the mock indexes. `ageMs`: how long before "now" it was modified. */
export interface GeneratedNote {
  path: string;
  kind?: string;
  tags?: string[];
  body: string;
  ageMs: number;
}

export const MOCK_VAULT_SEED = 0x5eed_2026;
const DAY_MS = 86_400_000;
/** Modification times spread over this many days. */
export const MOCK_VAULT_SPAN_DAYS = 90;

/** Mulberry32: small, fast and deterministic. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Domain { name: string; hub: string; folder: string; tags: string[]; topics: string[] }

const DOMAINS: Domain[] = [
  {
    name: 'Backend', hub: 'Backend MOC', folder: 'Knowledge/Backend', tags: ['php', 'api', 'performance', 'testing', 'security'],
    topics: ['Queue Workers', 'Rate Limiting', 'Job Batching', 'Service Containers', 'Middleware', 'Validation Rules', 'API Versioning', 'Webhooks', 'Session Storage',
      'Feature Flags', 'Background Jobs', 'Retry Policies', 'Idempotency Keys', 'Pagination', 'Soft Deletes', 'Database Migrations', 'Connection Pooling', 'Read Replicas',
      'Transactions', 'Deadlocks'],
  },
  {
    name: 'Frontend', hub: 'Frontend MOC', folder: 'Knowledge/Frontend', tags: ['react', 'typescript', 'design', 'accessibility', 'performance'],
    topics: ['React Suspense', 'Form State', 'Virtualized Lists', 'Design Tokens', 'Accessibility Audits', 'Keyboard Navigation', 'Code Splitting', 'Service Workers',
      'Hydration', 'CSS Containment', 'Focus Management', 'Error Boundaries', 'Optimistic Updates', 'Bundle Size', 'Responsive Images', 'Dark Mode', 'Internationalization',
      'Animation Timing'],
  },
  {
    name: 'Data', hub: 'Data MOC', folder: 'Knowledge/Data', tags: ['mysql', 'postgres', 'analytics', 'performance'],
    topics: ['Partitioning', 'Materialized Views', 'Window Functions', 'Change Data Capture', 'Backfills', 'Data Contracts', 'Schema Evolution', 'Time Series', 'Sharding',
      'Vacuuming', 'Replication Lag', 'Result Caching', 'Cardinality Estimates', 'Columnar Storage'],
  },
  {
    name: 'Operations', hub: 'Operations MOC', folder: 'Knowledge/Operations', tags: ['devops', 'security', 'observability', 'redis'],
    topics: ['Blue-Green Deploys', 'Canary Releases', 'Log Retention', 'Alert Fatigue', 'Incident Reviews', 'Runbooks', 'Secrets Rotation', 'Container Limits', 'Health Checks',
      'Backups', 'Disaster Recovery', 'Cost Budgets', 'Distributed Tracing', 'Metrics Cardinality'],
  },
];
const FACETS = ['', 'Basics', 'Pitfalls', 'Checklist', 'Patterns', 'in Practice', 'Trade-offs', 'Notes', 'Cheatsheet', 'Deep Dive'];
const PROJECTS = ['Atlas', 'Harbor', 'Shop'];
const FEATURES = ['Search Indexer', 'Billing Sync', 'Export Service', 'Onboarding Flow', 'Audit Log', 'Admin Console', 'Notification Center', 'Report Builder', 'Import Wizard', 'Mobile API'];
const SENTENCES = [
  'Measure before and after the change, then write down what moved.',
  'The trade-off is more moving parts in exchange for predictable latency.',
  'Start with the simplest version and keep the rollback path obvious.',
  'Most surprises came from defaults nobody had looked at in a while.',
  'Document the failure mode next to the fix so the next person finds it.',
  'Keep the configuration in one place and review it with the change.',
  'A small reproduction made the problem obvious within minutes.',
  'This works well until the data no longer fits in memory.',
];
/** Hand-written notes generated notes may link to (by path, so the duplicate "Caching" titles stay unambiguous). */
const HAND_WRITTEN = ['Knowledge/Caching', 'Knowledge/MySQL Indexing', 'Knowledge/Query Plans', 'Knowledge/Laravel Eloquent', 'Decisions/ADR Use Redis', 'Skills/Laravel Debugging'];
/** Typed link labels and their weights (the rest are plain `links_to`). */
const LABELS: [string, number][] = [['Related', 0.24], ['Depends on', 0.1], ['Used by', 0.07], ['Learned from', 0.05]];

interface Draft { path: string; target: string; title: string; kind?: string; tags: string[]; hub?: string; domain?: Domain; links: { label: string; target: string }[]; ageMs: number }

/** The generated notes; `seed` picks titles, links, tags and ages. */
export function generateMockVault(seed: number = MOCK_VAULT_SEED): GeneratedNote[] {
  const rand = random(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const age = () => Math.floor(rand() ** 1.7 * MOCK_VAULT_SPAN_DAYS * DAY_MS);
  const label = () => { let roll = rand(); for (const [name, weight] of LABELS) { if (roll < weight) return name; roll -= weight; } return ''; };
  const drafts: Draft[] = [];
  const add = (folder: string, title: string, extra: Partial<Draft> = {}): Draft => {
    const draft: Draft = { path: `${folder}/${title}.md`, target: title, title, tags: [], links: [], ageMs: age(), ...extra };
    drafts.push(draft);
    return draft;
  };

  // Hubs first: maps of content per domain, plus projects and learning.
  const hubs = new Map<string, Draft>();
  for (const name of [...DOMAINS.map(domain => domain.hub), 'Projects MOC', 'Learning MOC']) hubs.set(name, add('Maps', name, { kind: 'map', tags: ['moc'], ageMs: Math.floor(rand() * 5 * DAY_MS) }));

  // Topic notes: shuffled (topic, facet) pairs, 230 in all.
  const pairs = DOMAINS.flatMap(domain => domain.topics.flatMap(topic => FACETS.map(facet => ({ domain, title: facet ? `${topic} ${facet}` : topic }))));
  for (let index = pairs.length - 1; index > 0; index--) { const other = Math.floor(rand() * (index + 1)); [pairs[index], pairs[other]] = [pairs[other]!, pairs[index]!]; }
  for (const { domain, title } of pairs.slice(0, 230)) {
    const tags = [...new Set(Array.from({ length: Math.floor(rand() * 3) }, () => pick(domain.tags)))];
    add(domain.folder, title, { kind: 'knowledge', tags, domain, hub: rand() < 0.8 ? domain.hub : undefined });
  }
  for (const project of PROJECTS) for (const feature of FEATURES) add(`Projects/${project}`, `${project} ${feature}`, { kind: 'project', tags: ['project'], hub: rand() < 0.9 ? 'Projects MOC' : undefined });
  const topics = pairs.slice(0, 230);
  for (let index = 0; index < 40; index++) {
    const { domain, title } = topics[index * 5]!;
    add('Experiences', `Lesson ${String(index + 1).padStart(2, '0')} - ${title}`, { kind: 'experience', tags: [pick(domain.tags)], domain, hub: rand() < 0.6 ? 'Learning MOC' : undefined });
  }
  for (let index = 0; index < 25; index++) {
    const domain = pick(DOMAINS);
    add('Decisions', `ADR-${String(index + 10).padStart(3, '0')} ${pick(domain.topics)}`, { kind: 'decision', tags: ['decision'], domain, hub: rand() < 0.5 ? domain.hub : undefined });
  }
  for (let week = 30; week <= 42; week++) add('Learning/Reviews', `Weekly Review 2026-W${week}`, { kind: 'review', tags: ['review'], hub: 'Learning MOC', ageMs: (42 - week) * 7 * DAY_MS + Math.floor(rand() * DAY_MS) });
  for (let day = 0; day < 42; day++) {
    const ageMs = Math.floor((day * MOCK_VAULT_SPAN_DAYS) / 42 * DAY_MS + rand() * DAY_MS);
    add('Daily', new Date(Date.UTC(2026, 9, 23) - ageMs).toISOString().slice(0, 10), { tags: ['daily'], ageMs });
  }

  // Links: the hub, then preferential attachment among the notes before (degree + 1), sometimes a hand-written note.
  const degree = new Map<Draft, number>(drafts.map(draft => [draft, 0]));
  const link = (from: Draft, to: Draft | string, name = label()) => {
    const target = typeof to === 'string' ? to : to.target;
    if (typeof to !== 'string') {
      if (to === from || from.links.some(item => item.target === target && item.label === name)) return;
      degree.set(to, degree.get(to)! + 1); degree.set(from, degree.get(from)! + 1);
    }
    from.links.push({ label: name, target });
  };
  const attach = (pool: readonly Draft[]): Draft => {
    let roll = rand() * pool.reduce((sum, item) => sum + degree.get(item)! + 1, 0);
    for (const item of pool) { roll -= degree.get(item)! + 1; if (roll < 0) return item; }
    return pool[pool.length - 1]!;
  };
  const regular = drafts.filter(draft => draft.kind !== 'map');
  regular.forEach((draft, position) => {
    if (draft.hub) link(draft, hubs.get(draft.hub)!, '');
    const earlier = regular.slice(0, position);
    const same = draft.domain ? earlier.filter(item => item.domain === draft.domain) : earlier;
    const extra = draft.path.startsWith('Daily/') ? 1 + Math.floor(rand() * 3) : draft.kind === 'review' ? 3 : 1 + Number(rand() < 0.35);
    for (let count = 0; count < extra && earlier.length; count++) link(draft, attach(same.length && rand() < 0.75 ? same : earlier));
    if (draft.kind === 'decision' && rand() < 0.3) { const older = earlier.filter(item => item.kind === 'decision'); if (older.length) link(draft, pick(older), 'Supersedes'); }
    if (rand() < 0.05) link(draft, pick(HAND_WRITTEN));
    // A few links to notes that do not exist (yet): unresolved, so not in the graph.
    if (rand() < 0.04) link(draft, `${pick(DOMAINS).topics[0]} Draft`);
  });
  for (const [name, hub] of hubs) {
    const members = regular.filter(draft => draft.hub === name);
    for (let count = 0; count < 12 && members.length; count++) link(hub, pick(members), '');
    for (const other of hubs.values()) if (other !== hub && rand() < 0.5) link(hub, other, 'Related');
  }

  return drafts.map(draft => {
    const lines = [`# ${draft.title}`];
    const byLabel = new Map<string, string[]>();
    for (const item of draft.links) byLabel.set(item.label, [...(byLabel.get(item.label) ?? []), `[[${item.target}]]`]);
    for (const [name, targets] of byLabel) if (name) lines.push(`${name}: ${targets.join(', ')}`);
    lines.push('', `${pick(SENTENCES)} ${pick(SENTENCES)}`);
    const plain = byLabel.get('');
    if (plain) lines.push('', ...plain.map(target => `- See ${target}`));
    return { path: draft.path, ...(draft.kind ? { kind: draft.kind } : {}), ...(draft.tags.length ? { tags: draft.tags } : {}), body: lines.join('\n'), ageMs: draft.ageMs };
  });
}
