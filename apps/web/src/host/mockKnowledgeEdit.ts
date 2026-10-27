import {
  KNOWLEDGE_EDIT_LIMITS, normalizeKnowledgeMemoryImportRequest, normalizeKnowledgeNotePath, normalizeKnowledgeRollbackRequest, normalizeKnowledgeWriteRequest,
  type AgentHostApi, type KnowledgeEditMethod, type KnowledgeHistoryEntry, type KnowledgeImportCounts, type KnowledgeImportedNote, type KnowledgeWriteResult,
} from '@extalia/platform';
import type { SampleNote } from './mockKnowledge';

/**
 * Note editing for the mock host's Knowledge index (W5 slice 2b), with the daemon's rules: whole-file
 * reads with a real SHA-256, compare-and-swap writes that turn a mismatch into a conflict copy (its `id`,
 * `aliases` and `managed_by` renamed `conflict_*`), a per-note journal (`write`, `rollback`, `conflict`,
 * `external`) with content-addressed versions, rollback through the same compare-and-swap, and the
 * legacy memory import (`Projects/<workspace>/Memory/<name>.md`, managed, credentials masked; a dry run
 * writes nothing; a rerun reports `unchanged`).
 *
 * `conflict: true` (`?knowledge=conflict`): the next save first gets an outside edit (as if the note had
 * been changed in Obsidian), so it conflicts with `hash_mismatch` like a real stale write would.
 */
export interface MockKnowledgeEditOptions { conflict?: boolean }

/** The mock index's notes: `put` replaces or adds a note and re-indexes (a new generation). */
export interface MockVault {
  notes(): readonly SampleNote[];
  put(sample: SampleNote): void;
}

const DAY_MS = 86_400_000;
/** Notes the sample vault marks `managed_by: extalia`. */
const MANAGED = new Set(['Experiences/Example-Query-Optimization.md']);
/** A note with recorded history: an earlier version by the user, then the current one from an outside editor. */
const WITH_HISTORY = 'Knowledge/N+1 Query Optimization.md';

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const list = (items: readonly string[]) => `[${items.map(item => (/^[\w .+-]+$/.test(item) ? item : JSON.stringify(item))).join(', ')}]`;

/** A sample note as a file: front matter with what the index declares, then the body. */
function render(sample: SampleNote): string {
  const lines: string[] = [];
  if (sample.id) lines.push(`id: ${sample.id}`);
  if (sample.kind) lines.push(`kind: ${sample.kind}`);
  if (sample.verification) lines.push(`verification: ${sample.verification}`);
  if (sample.revision) lines.push(`revision: ${sample.revision}`);
  if (sample.aliases?.length) lines.push(`aliases: ${list(sample.aliases)}`);
  if (sample.tags?.length) lines.push(`tags: ${list(sample.tags)}`);
  if (sample.sourceTaskIds?.length) lines.push(`source_task_ids: ${list(sample.sourceTaskIds)}`);
  if (MANAGED.has(sample.path)) lines.push('managed_by: extalia');
  return `${lines.length ? `---\n${lines.join('\n')}\n---\n` : ''}${sample.body}\n`;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const unquote = (value: string) => value.trim().replace(/^(["'])(.*)\1$/, '$2');
const parseList = (value: string): string[] => {
  const text = value.trim();
  if (!text.startsWith('[')) return text ? [unquote(text)] : [];
  return text.slice(1, text.endsWith(']') ? -1 : undefined).split(',').map(unquote).filter(Boolean);
};

/** The fields the index reads from a written file (a small subset of YAML: `key: value` and `[a, b]` lists). */
function parse(path: string, text: string): SampleNote {
  const match = FRONT_MATTER.exec(text);
  const fields = new Map<string, string>();
  for (const line of match?.[1]?.split(/\r?\n/) ?? []) {
    const pair = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (pair) fields.set(pair[1]!, pair[2]!);
  }
  const body = (match ? text.slice(match[0].length) : text).replace(/\n$/, '');
  const id = fields.has('id') ? unquote(fields.get('id')!) : '';
  const revision = Number(unquote(fields.get('revision') ?? ''));
  return {
    path, body,
    ...(/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id) ? { id } : {}),
    ...(fields.get('kind') ? { kind: unquote(fields.get('kind')!) } : {}),
    ...(fields.get('verification') ? { verification: unquote(fields.get('verification')!) } : {}),
    ...(Number.isInteger(revision) && revision > 0 ? { revision } : {}),
    ...(fields.has('aliases') ? { aliases: parseList(fields.get('aliases')!) } : {}),
    ...(fields.has('tags') ? { tags: parseList(fields.get('tags')!) } : {}),
    ...(fields.has('source_task_ids') ? { sourceTaskIds: parseList(fields.get('source_task_ids')!) } : {}),
  };
}

const isManaged = (text: string): boolean => /^managed_by:[ \t]*(["']?)extalia\1[ \t]*$/m.test(FRONT_MATTER.exec(text)?.[1] ?? '');

/** The conflict copy's text: it never takes the original's identity nor becomes auto-updatable. */
function conflictText(text: string, original: string, baseSha: string | null): string {
  const match = FRONT_MATTER.exec(text);
  const renamed = (match?.[1] ?? '').split(/\r?\n/).filter(Boolean).map(line => line.replace(/^(id|aliases|managed_by):/, 'conflict_$1:'));
  const head = [...renamed, `conflict_of: ${JSON.stringify(original)}`, ...(baseSha ? [`conflict_base_sha256: ${baseSha}`] : [])];
  return `---\n${head.join('\n')}\n---\n${match ? text.slice(match[0].length) : text}`;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

interface MemoryNote { file: string; body: string; masked: number }
/** The legacy memory notes every mock workspace has (one with an invalid name, one with credentials to mask). */
const MEMORY: MemoryNote[] = [
  { file: 'api-integrations.md', body: '# API integrations\n\nThe payment sandbox uses token: [redacted]; rotate it monthly.\nWebhook secret: [redacted]\n', masked: 2 },
  { file: 'deploy-checklist.md', body: '# Deploy checklist\n\n- Run migrations before switching traffic.\n- Keep the previous release for one hour.\n', masked: 0 },
  { file: 'team-conventions.md', body: '# Team conventions\n\nSmall pull requests, one reviewer, tests next to the code.\n', masked: 0 },
  { file: 'Meeting Notes.md', body: '# Meeting notes\n', masked: 0 },
];

export function createMockKnowledgeEdit(vault: MockVault, latency: () => Promise<void>, now: number, options: MockKnowledgeEditOptions = {}): Pick<Required<AgentHostApi>, KnowledgeEditMethod> {
  /** Files written through this mock (sample notes render from their fields until then). */
  const files = new Map<string, string>();
  const objects = new Map<string, string>();
  const journal = new Map<string, KnowledgeHistoryEntry[]>();
  const imported = new Map<string, string>();
  let conflictNext = options.conflict === true;
  let seeded: Promise<void> | undefined;

  const textOf = (path: string): string | undefined => {
    const written = files.get(path);
    if (written !== undefined) return written;
    const sample = vault.notes().find(item => item.path === path);
    return sample ? render(sample) : undefined;
  };
  const record = (path: string, entry: KnowledgeHistoryEntry) => journal.set(path, [entry, ...(journal.get(path) ?? [])]);
  const store = async (text: string) => { const hash = await sha256(text); objects.set(hash, text); return hash; };
  const put = (path: string, text: string) => { files.set(path, text); vault.put(parse(path, text)); };

  /** Seed one note's history: an earlier version by the user, then the current text written in another app. */
  const seed = () => seeded ??= (async () => {
    const current = textOf(WITH_HISTORY);
    if (current === undefined) return;
    const earlier = current.replace(/\n## Checklist[\s\S]*?(?=\n\| Tool)/, '\n');
    const [earlierSha, currentSha] = [await store(earlier), await store(current)];
    journal.set(WITH_HISTORY, [
      { sha256: currentSha, at: new Date(now - 2 * DAY_MS).toISOString(), kind: 'external', author: 'external', previousSha256: earlierSha },
      { sha256: earlierSha, at: new Date(now - 5 * DAY_MS).toISOString(), kind: 'write', author: 'user' },
    ]);
  })();

  /** Compare-and-swap like the daemon: a mismatch writes the proposal as a conflict copy and replaces nothing. */
  async function swap(path: string, content: string, expected: string | null, kind: 'write' | 'rollback', author: string): Promise<KnowledgeWriteResult> {
    await seed();
    if (conflictNext && kind === 'write' && expected !== null && textOf(path) !== undefined) {
      // `?knowledge=conflict`: the note changes in another app between the read and this save.
      conflictNext = false;
      const before = textOf(path)!;
      const outside = `${before.replace(/\n*$/, '')}\n\n_Edited in another app at ${new Date().toISOString().slice(11, 16)} UTC._\n`;
      const [beforeSha, outsideSha] = [await store(before), await store(outside)];
      put(path, outside);
      record(path, { sha256: outsideSha, at: new Date().toISOString(), kind: 'external', author: 'external', previousSha256: beforeSha });
    }
    const current = textOf(path);
    const currentSha = current === undefined ? null : await sha256(current);
    if (currentSha !== expected) {
      const proposal = await sha256(content);
      const folder = path.includes('/') ? `${path.slice(0, path.lastIndexOf('/'))}/` : '';
      const name = path.slice(folder.length).replace(/\.md$/i, '');
      const conflictPath = `${folder}${name} (conflict ${stamp(new Date())} ${proposal.slice(0, 8)}).md`;
      const copy = conflictText(content, path, expected);
      put(conflictPath, copy);
      record(path, { sha256: await store(copy), at: new Date().toISOString(), kind: 'conflict', author, ...(currentSha ? { previousSha256: currentSha } : {}), conflictPath });
      return { outcome: 'conflict', path, ...(currentSha ? { sha256: currentSha } : {}), conflictPath, conflictReason: 'hash_mismatch' };
    }
    const next = await store(content);
    if (next === currentSha) return { outcome: 'unchanged', path, sha256: next };
    if (current !== undefined) objects.set(currentSha!, current);
    put(path, content);
    record(path, { sha256: next, at: new Date().toISOString(), kind, author, ...(currentSha ? { previousSha256: currentSha } : {}) });
    return { outcome: 'written', path, sha256: next, ...(currentSha ? { previousSha256: currentSha } : {}) };
  }

  return {
    async readKnowledgeNote(rawPath) {
      const path = normalizeKnowledgeNotePath(rawPath);
      await latency();
      await seed();
      const text = textOf(path);
      if (text === undefined) return null;
      const bytes = new TextEncoder().encode(text);
      const truncated = bytes.length > KNOWLEDGE_EDIT_LIMITS.contentBytes;
      return { path, sha256: await sha256(text), managed: isManaged(text), body: truncated ? new TextDecoder().decode(bytes.slice(0, KNOWLEDGE_EDIT_LIMITS.contentBytes)) : text, truncated };
    },
    async writeKnowledgeNote(request) {
      const { path, content, expectedSha256 } = normalizeKnowledgeWriteRequest(request);
      await latency();
      return swap(path, content, expectedSha256, 'write', 'user');
    },
    async knowledgeHistory(rawPath) {
      const path = normalizeKnowledgeNotePath(rawPath);
      await latency();
      await seed();
      return { path, entries: structuredClone((journal.get(path) ?? []).slice(0, KNOWLEDGE_EDIT_LIMITS.history)) };
    },
    async rollbackKnowledgeNote(request) {
      const { path, toSha256, expectedSha256 } = normalizeKnowledgeRollbackRequest(request);
      await latency();
      await seed();
      const entries = journal.get(path) ?? [];
      const known = entries.some(entry => (entry.kind !== 'conflict' && entry.sha256 === toSha256) || entry.previousSha256 === toSha256);
      const text = objects.get(toSha256);
      if (!known || text === undefined) throw new Error('That version is not in this note’s history any more. (not_found: unknown_version)');
      return swap(path, text, expectedSha256, 'rollback', 'user');
    },
    async importMemoryNotes(request) {
      const { workspaceId, dryRun } = normalizeKnowledgeMemoryImportRequest(request);
      await latency(); await latency();
      await seed();
      const notes: KnowledgeImportedNote[] = [];
      for (const source of MEMORY) {
        const name = source.file.replace(/\.md$/, '');
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) { notes.push({ name: source.file, outcome: 'skipped', masked: 0, reason: 'invalid_name' }); continue; }
        const vaultPath = `Projects/${workspaceId}/Memory/${name}.md`;
        const key = `${workspaceId}\n${name}`;
        const sourceSha = await sha256(source.body);
        if (imported.get(key) === sourceSha) { notes.push({ name, vaultPath, outcome: imported.has(`${key}\nwritten`) && textOf(vaultPath) === undefined ? 'missing_in_vault' : 'unchanged', masked: 0 }); continue; }
        if (textOf(vaultPath) !== undefined) { notes.push({ name, vaultPath, outcome: 'conflict', masked: source.masked }); continue; }
        notes.push({ name, vaultPath, outcome: 'created', masked: source.masked });
        if (dryRun) continue;
        const text = [
          '---', `id: mem.${workspaceId.toLowerCase()}.${name}`, 'kind: knowledge', 'profile: default', 'scope: workspace', `workspace_id: ${workspaceId}`, 'verification: unverified',
          'managed_by: extalia', 'source: legacy-memory', `source_path: workspaces/${workspaceId}/memory/${source.file}`, `source_sha256: ${sourceSha}`,
          `imported_at: ${new Date().toISOString()}`, `masked_credentials: ${source.masked}`, '---', source.body,
        ].join('\n');
        put(vaultPath, text);
        record(vaultPath, { sha256: await store(text), at: new Date().toISOString(), kind: 'write', author: 'extalia:memory-import' });
        imported.set(key, sourceSha); imported.set(`${key}\nwritten`, sourceSha);
      }
      const count = (outcome: KnowledgeImportedNote['outcome']) => notes.filter(note => note.outcome === outcome).length;
      const counts: KnowledgeImportCounts = {
        total: notes.length, created: count('created'), updated: count('updated'), unchanged: count('unchanged'), conflict: count('conflict'),
        pendingConflict: count('pending_conflict'), missingInVault: count('missing_in_vault'), skipped: count('skipped'), masked: notes.reduce((sum, note) => sum + note.masked, 0),
      };
      return { notes, counts };
    },
  };
}
