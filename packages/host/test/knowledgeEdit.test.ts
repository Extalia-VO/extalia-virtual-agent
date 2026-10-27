import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KNOWLEDGE_EDIT_METHODS, KNOWLEDGE_EDIT_UNSUPPORTED, KNOWLEDGE_IMPORT_UNSUPPORTED, type AgentHostApi } from '@extalia/platform';
import { DAEMON_KNOWLEDGE_OPS } from '@extalia/protocol';
import { DaemonRequestError, type DaemonClient, type DaemonSidecar } from '../src/daemon/index.js';
import { KnowledgeService } from '../src/knowledge.js';
import { KNOWLEDGE_EDIT_OPS, KNOWLEDGE_IMPORT_OP, KnowledgeEditService, editingOf, knowledgeEditHostMethods } from '../src/knowledgeEdit.js';
import { createAgentHost } from '../src/service.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';

// W5 slice 2b: note editing over the Rust core daemon. The host checks what the daemon advertises, runs writes in the
// sync queue, writes as the user only and reshapes answers; the real binary runs the end-to-end case when it serves editing.

const HASH = 'a'.repeat(64), NEXT = 'b'.repeat(64);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
type Call = { op: string; params: Record<string, unknown> };

/** A KnowledgeService over a scripted daemon client. */
function scripted(capabilities: readonly string[], answer: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  const client = {
    capabilities,
    async request(op: string, params: Record<string, unknown>) {
      calls.push({ op, params });
      return answer({ op, params });
    },
  } as unknown as DaemonClient;
  const daemon = { connect: async () => client } as unknown as DaemonSidecar;
  const knowledge = new KnowledgeService({ daemon, autoSyncAfterMs: Number.POSITIVE_INFINITY });
  const edit = new KnowledgeEditService(knowledge, { workspaces: () => ['w_mabc12345678'] });
  return { calls, knowledge, host: knowledgeEditHostMethods(edit) };
}
const STATUS = { state: 'ready', vaultRoot: 'vaults/default', vaultPresent: true, generation: 3, counts: { notes: 1, edges: 0, unresolvedLinks: 0, skipped: 0 } };
const SYNC = { mode: 'incremental', at: '2026-10-24T00:00:00Z', generation: 4, notes: 1, added: 0, updated: 1, removed: 0, unchanged: 0, unresolvedLinks: 0, renamed: [], renamedTotal: 0, skipped: [], skippedTotal: 0, vaultCreated: false };
const ALL = [...DAEMON_KNOWLEDGE_OPS];
/** What a daemon from before note editing advertises. */
const READ_ONLY = DAEMON_KNOWLEDGE_OPS.filter(op => !(KNOWLEDGE_EDIT_OPS as readonly string[]).includes(op) && op !== KNOWLEDGE_IMPORT_OP);

describe('Knowledge edit host methods (scripted daemon)', () => {
  it('report what the daemon serves with the status, and refuse operations it does not advertise', async () => {
    expect(editingOf(ALL)).toEqual({ notes: true, memoryImport: true });
    expect(editingOf([...READ_ONLY, 'knowledge.read'])).toEqual({ notes: false, memoryImport: false });
    expect(editingOf([...READ_ONLY, KNOWLEDGE_IMPORT_OP])).toEqual({ notes: false, memoryImport: true });
    const older = scripted(READ_ONLY, ({ op }) => op === 'knowledge.status' ? STATUS : undefined);
    expect((await older.knowledge.status()).editing).toEqual({ notes: false, memoryImport: false });
    await expect(older.host.readKnowledgeNote('A.md')).rejects.toThrow(KNOWLEDGE_EDIT_UNSUPPORTED);
    await expect(older.host.writeKnowledgeNote({ path: 'A.md', content: 'x', expectedSha256: null })).rejects.toThrow(KNOWLEDGE_EDIT_UNSUPPORTED);
    await expect(older.host.importMemoryNotes({ workspaceId: 'w_mabc12345678', dryRun: true })).rejects.toThrow(KNOWLEDGE_IMPORT_UNSUPPORTED);
    expect(older.calls.map(call => call.op)).toEqual(['knowledge.status']);
    const current = scripted(ALL, ({ op }) => op === 'knowledge.status' ? STATUS : undefined);
    expect((await current.knowledge.status()).editing).toEqual({ notes: true, memoryImport: true });
  });

  it('validates before sending, writes as the user with the expected hash, and reshapes the answers', async () => {
    const { calls, host } = scripted(ALL, ({ op, params }) => {
      if (op === 'knowledge.read') return params.path === 'Gone.md' ? Promise.reject(new DaemonRequestError('not_found', 'note_not_found')) : { path: params.path, sha256: HASH, managed: true, body: '---\nmanaged_by: extalia\n---\n# A\n', truncated: false };
      if (op === 'knowledge.write') return { outcome: 'conflict', path: params.path, previousSha256: NEXT, conflictPath: 'A (conflict 20261024T000000Z 12345678).md', conflictReason: 'hash_mismatch' };
      if (op === 'knowledge.history') return { path: params.path, entries: [{ sha256: NEXT, at: '2026-10-24T00:00:00Z', kind: 'external', author: 'external' }, { sha256: HASH, at: '2026-10-23T00:00:00Z', kind: 'write', author: 'user' }] };
      if (op === 'knowledge.rollback') return { outcome: 'written', path: params.path, sha256: HASH, previousSha256: NEXT };
      if (op === 'knowledge.importMemory') return { notes: [{ name: 'deploy', vaultPath: 'Projects/w_mabc12345678/Memory/deploy.md', outcome: 'created', masked: 2 }, { name: 'Bad Name.md', outcome: 'skipped', masked: 0, reason: 'invalid_name' }], counts: { total: 2, created: 1, updated: 0, unchanged: 0, conflict: 0, pendingConflict: 0, missingInVault: 0, skipped: 1, masked: 2 } };
      return undefined;
    });
    expect(await host.readKnowledgeNote('A.md')).toEqual({ path: 'A.md', sha256: HASH, managed: true, body: '---\nmanaged_by: extalia\n---\n# A\n', truncated: false });
    expect(await host.readKnowledgeNote('Gone.md')).toBeNull();
    await expect(host.readKnowledgeNote('../A.md')).rejects.toThrow(/note path/i);
    await expect(host.writeKnowledgeNote({ path: 'A.md', content: 'x' } as never)).rejects.toThrow(/name the version/);
    const written = await host.writeKnowledgeNote({ path: 'A.md', content: '# A\n', expectedSha256: HASH });
    expect(written).toEqual({ outcome: 'conflict', path: 'A.md', previousSha256: NEXT, conflictPath: 'A (conflict 20261024T000000Z 12345678).md', conflictReason: 'hash_mismatch' });
    expect(calls.find(call => call.op === 'knowledge.write')!.params).toEqual({ path: 'A.md', content: '# A\n', expectedSha256: HASH, author: 'user' });
    expect((await host.knowledgeHistory('A.md')).entries.map(entry => entry.kind)).toEqual(['external', 'write']);
    expect(calls.find(call => call.op === 'knowledge.history')!.params).toEqual({ path: 'A.md', limit: 50 });
    expect(await host.rollbackKnowledgeNote({ path: 'A.md', toSha256: HASH, expectedSha256: NEXT })).toMatchObject({ outcome: 'written', sha256: HASH });
    const preview = await host.importMemoryNotes({ workspaceId: 'w_mabc12345678', dryRun: true });
    expect(preview.counts).toMatchObject({ total: 2, created: 1, skipped: 1, masked: 2 });
    expect(preview.notes[1]).toEqual({ name: 'Bad Name.md', outcome: 'skipped', masked: 0, reason: 'invalid_name' });
    expect(calls.find(call => call.op === 'knowledge.importMemory')!.params).toEqual({ workspaceId: 'w_mabc12345678', dryRun: true });
    await expect(host.importMemoryNotes({ workspaceId: 'w_other1234567', dryRun: true })).rejects.toThrow(/Unknown workspace/);
  });

  it('turns refusals into user-safe messages and a missing history into an empty one', async () => {
    const { host } = scripted(ALL, ({ op }) => {
      if (op === 'knowledge.write') return Promise.reject(new DaemonRequestError('denied', 'unsafe_path'));
      if (op === 'knowledge.rollback') return Promise.reject(new DaemonRequestError('not_found', 'unknown_version'));
      if (op === 'knowledge.history') return Promise.reject(new DaemonRequestError('not_found', 'note_not_found'));
      return Promise.reject(new DaemonRequestError('storage_failure', 'io_failure'));
    });
    await expect(host.writeKnowledgeNote({ path: 'A.md', content: 'x', expectedSha256: null })).rejects.toThrow(/symbolic link.*\(denied: unsafe_path\)/);
    await expect(host.rollbackKnowledgeNote({ path: 'A.md', toSha256: HASH, expectedSha256: NEXT })).rejects.toThrow(/not in this note’s history/);
    expect(await host.knowledgeHistory('A.md')).toEqual({ path: 'A.md', entries: [] });
    const read = await host.readKnowledgeNote('A.md').then(() => undefined, (error: Error) => error);
    expect(read?.name).toBe('UserError');
    expect(read?.message).toMatch(/could not be read\. \(storage_failure: io_failure\)/);
  });

  it('runs writes in the sync queue: after a running sync, and a later sync after them', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { calls, knowledge, host } = scripted(ALL, async ({ op }) => {
      if (op === 'knowledge.sync') { if (calls.filter(call => call.op === 'knowledge.sync').length === 1) await gate; return SYNC; }
      if (op === 'knowledge.status') return STATUS;
      return { outcome: 'written', path: 'A.md', sha256: NEXT, previousSha256: HASH };
    });
    const first = knowledge.sync('incremental');
    await new Promise(resolve => setTimeout(resolve, 5));
    const write = host.writeKnowledgeNote({ path: 'A.md', content: 'x', expectedSha256: HASH });
    const second = knowledge.sync('incremental');
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(calls.map(call => call.op)).toEqual(['knowledge.sync']);
    release();
    await Promise.all([first, write, second]);
    expect(calls.map(call => call.op).filter(op => op !== 'knowledge.status')).toEqual(['knowledge.sync', 'knowledge.write', 'knowledge.sync']);
  });
});

// The real binary: host-level checks, then the end-to-end flow once the daemon serves editing.
const roots: string[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

type Editing = AgentHostApi & Required<Pick<AgentHostApi, (typeof KNOWLEDGE_EDIT_METHODS)[number] | 'knowledgeStatus' | 'syncKnowledge'>>;

async function fixture(options: { core?: 'rust' | 'typescript'; binary?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-knowledge-edit-')); roots.push(root);
  const home = path.join(root, 'home'), data = path.join(root, 'data');
  await mkdir(home, { recursive: true });
  const runtime = await createAgentHost({
    kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000,
    env: { EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: '', EXTALIA_NATIVE_CORE: options.core ?? 'rust', EXTALIA_DAEMON_PATH: options.binary ?? DAEMON_BINARY },
    daemon: { log: () => undefined },
    knowledge: { autoSyncAfterMs: Number.POSITIVE_INFINITY, watcher: false },
  });
  closes.push(() => runtime.close());
  return { root, vault: path.join(data, 'vaults', 'default'), host: runtime.host as Editing };
}

describe('Knowledge edit host methods (host)', () => {
  it('are absent with the TypeScript core', async () => {
    const { host } = await fixture({ core: 'typescript' });
    for (const method of KNOWLEDGE_EDIT_METHODS) expect(host[method]).toBeUndefined();
  });

  it('fail with a user-safe message when the native core is unavailable, after validating', async () => {
    const { root, host } = await fixture({ binary: path.join(tmpdir(), 'extalia-no-such-daemon', 'extalia-daemon') });
    for (const method of KNOWLEDGE_EDIT_METHODS) expect(typeof host[method]).toBe('function');
    expect((await host.knowledgeStatus()).editing).toBeUndefined();
    const error = await host.writeKnowledgeNote({ path: 'A.md', content: 'x', expectedSha256: null }).then(() => undefined, (failure: Error) => failure);
    expect(error?.name).toBe('UserError');
    expect(error?.message).toMatch(/native core is unavailable \(binary_missing\)/);
    expect(error?.message).not.toContain(root);
    await expect(host.writeKnowledgeNote({ path: 'A.txt', content: 'x', expectedSha256: null })).rejects.toThrow(/ends in \.md/);
    await expect(host.rollbackKnowledgeNote({ path: 'A.md', toSha256: 'x', expectedSha256: HASH })).rejects.toThrow(/Invalid note version/);
    await expect(host.importMemoryNotes({ workspaceId: 'w_mabc12345678', dryRun: true })).rejects.toThrow(/Unknown workspace/);
  });
});

describe.skipIf(!HAS_DAEMON)('Knowledge editing over the Rust core daemon', () => {
  it('writes with compare-and-swap, keeps history, rolls back and refuses blind overwrites', async () => {
    const { vault, host, root } = await fixture();
    const status = await host.knowledgeStatus();
    if (status.state !== 'ready') {
      // A daemon binary built before the current wire contract: rebuild it (`cargo build -p extalia-daemon`).
      console.warn(`knowledgeEdit.test.ts: daemon case skipped (${status.reason ?? 'unavailable'}).`);
      return;
    }
    if (!status.editing?.notes) {
      // A daemon from before note editing: the page hides the edit actions.
      console.warn('knowledgeEdit.test.ts: the daemon does not serve note editing; only the refusal is checked.');
      await expect(host.readKnowledgeNote('A.md')).rejects.toThrow(KNOWLEDGE_EDIT_UNSUPPORTED);
      return;
    }
    await host.syncKnowledge();
    const first = '---\nmanaged_by: extalia\n---\n# A\nfirst\n';
    expect(await host.writeKnowledgeNote({ path: 'Notes/A.md', content: first, expectedSha256: null })).toMatchObject({ outcome: 'written', sha256: sha256(first) });
    const read = await host.readKnowledgeNote('Notes/A.md');
    expect(read).toMatchObject({ path: 'Notes/A.md', sha256: sha256(first), managed: true, body: first, truncated: false });
    expect(await host.writeKnowledgeNote({ path: 'Notes/A.md', content: first, expectedSha256: read!.sha256 })).toMatchObject({ outcome: 'unchanged' });
    // An outside editor changes the note: the stale write becomes a conflict copy and the note keeps the outside text.
    await writeFile(path.join(vault, 'Notes', 'A.md'), '# A\noutside\n');
    const conflict = await host.writeKnowledgeNote({ path: 'Notes/A.md', content: '# A\nmine\n', expectedSha256: read!.sha256 });
    expect(conflict).toMatchObject({ outcome: 'conflict', conflictReason: 'hash_mismatch' });
    expect(await readFile(path.join(vault, 'Notes', 'A.md'), 'utf8')).toBe('# A\noutside\n');
    expect(await readdir(path.join(vault, 'Notes'))).toContain(path.basename(conflict.conflictPath!));
    const history = await host.knowledgeHistory('Notes/A.md');
    expect(history.entries.map(entry => entry.kind)).toContain('conflict');
    const current = await host.readKnowledgeNote('Notes/A.md');
    expect(await host.rollbackKnowledgeNote({ path: 'Notes/A.md', toSha256: sha256(first), expectedSha256: current!.sha256 })).toMatchObject({ outcome: 'written' });
    expect(await readFile(path.join(vault, 'Notes', 'A.md'), 'utf8')).toBe(first);
    expect(await host.readKnowledgeNote('Notes/Missing.md')).toBeNull();
    expect(JSON.stringify([conflict, history, current])).not.toContain(root);
  });
});
