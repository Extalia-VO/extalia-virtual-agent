import type { HostMissionRun } from '@extalia/platform';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MissionCheckpointStore } from '../src/missionCheckpoints.js';

const directories: string[] = [];
const stores = new Set<MissionCheckpointStore>();
afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'extalia-checkpoints-')); directories.push(directory);
  const file = path.join(directory, 'state', 'missions.sqlite');
  const store = await MissionCheckpointStore.open(file); stores.add(store);
  return { directory, file, store };
}
async function reopen(file: string, store: MissionCheckpointStore) {
  store.close(); stores.delete(store);
  const next = await MissionCheckpointStore.open(file); stores.add(next); return next;
}
const at = '2026-01-01T00:00:00.000Z';
function mission(state: HostMissionRun['state'] = 'completed', sessionId = 's_checkpoint123'): HostMissionRun {
  return {
    id: randomUUID(), sessionId, workspaceId: 'workspace', title: 'Checkpoint mission', state,
    createdAt: at, updatedAt: at, transient: false,
    tasks: [{ id: 'survey', taskId: randomUUID(), agentId: randomUUID(), title: 'Read-only survey', dependsOn: [], connectionId: 'connection', model: 'model-a',
      state: state === 'recovering' ? 'unknown' : state === 'running' ? 'running' : 'completed', answer: 'Unverified answer \u0001界\\"', verification: 'unverified', evidenceIds: [] }],
  };
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('native mission SQLite checkpoints', () => {
  it('persists canonical idempotent snapshots, global sequence and per-mission revision', async () => {
    const { file, store } = await fixture();
    const first = mission('running');
    expect(store.readSession(first.sessionId)).toBeUndefined();
    store.writeSession(first.sessionId, [first], { legacyDigest: hash('legacy sidecar') });
    const firstChange = store.changes(first.sessionId)[0]!;
    expect(firstChange).toMatchObject({ sequence: 1, runId: first.id, sessionId: first.sessionId, revision: 1, state: 'running' });
    expect(firstChange.digest).toMatch(/^[a-f0-9]{64}$/);
    // Key ordering is irrelevant, while caller mutations never reach storage.
    const reordered = Object.fromEntries(Object.entries(first).reverse()) as unknown as HostMissionRun;
    store.writeSession(first.sessionId, [reordered]);
    reordered.title = 'Caller mutation';
    expect(store.readSession(first.sessionId)).toEqual([first]);
    expect(store.changes(first.sessionId)).toHaveLength(1);
    const other = mission('completed', 's_other123'); store.writeSession(other.sessionId, [other]);
    const completed = { ...first, state: 'completed' as const, updatedAt: '2026-01-01T00:01:00.000Z' };
    store.writeSession(first.sessionId, [completed]);
    expect(store.changes(first.sessionId).map(change => [change.sequence, change.revision])).toEqual([[1, 1], [3, 2]]);
    const expectedChanges = store.changes(first.sessionId);
    const next = await reopen(file, store);
    expect(next.readSession(first.sessionId)).toEqual([completed]);
    expect(next.changes(first.sessionId)).toEqual(expectedChanges);
    const db = new DatabaseSync(file);
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
      expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      expect(db.prepare('SELECT legacy_digest FROM checkpoint_sessions WHERE session_id = ?').get(first.sessionId)?.legacy_digest).toBe(hash('legacy sidecar'));
      const payload = db.prepare('SELECT payload FROM mission_checkpoints WHERE run_id = ?').get(first.id)?.payload;
      expect(typeof payload).toBe('string');
      expect(expectedChanges[1]?.digest).toBe(hash(payload as string));
      // The journal contains attribution/digests only, never a second prompt/result body.
      expect(db.prepare('PRAGMA table_info(mission_changes)').all().map(column => column.name)).toEqual(['sequence', 'session_id', 'run_id', 'revision', 'state', 'at', 'digest']);
    } finally { db.close(); }
  });

  it('rolls back checkpoint, revision, retention and import marker together on SQL failure', async () => {
    const { file, store } = await fixture();
    const first = mission(); const retained = mission();
    store.writeSession(first.sessionId, [first, retained]);
    const before = store.changes(first.sessionId);
    const db = new DatabaseSync(file);
    try {
      db.exec("CREATE TRIGGER fail_change BEFORE INSERT ON mission_changes BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END");
      expect(() => store.writeSession(first.sessionId, [{ ...first, title: 'Changed' }], { legacyDigest: hash('import') })).toThrow(/injected storage failure/);
      expect(store.readSession(first.sessionId)).toEqual([first, retained]);
      expect(store.changes(first.sessionId)).toEqual(before);
      expect(db.prepare('SELECT legacy_digest FROM checkpoint_sessions WHERE session_id = ?').get(first.sessionId)?.legacy_digest).toBeNull();
      db.exec('DROP TRIGGER fail_change');
    } finally { db.close(); }
    const next = await reopen(file, store);
    expect(next.readSession(first.sessionId)).toEqual([first, retained]);
    expect(next.changes(first.sessionId)).toEqual(before);
  });

  it('prunes removed terminal checkpoints and changes while preserving unresolved ownership', async () => {
    const { file, store } = await fixture();
    const terminal = mission(); const active = mission('running'); const recovering = mission('recovering');
    store.writeSession(active.sessionId, [terminal, active, recovering]);
    expect(() => store.writeSession(active.sessionId, [terminal, recovering])).toThrow(/Unresolved/);
    expect(() => store.removeSession(active.sessionId)).toThrow(/Unresolved/);
    store.writeSession(active.sessionId, [recovering, active]);
    expect(store.readSession(active.sessionId)).toEqual([recovering, active]);
    expect(store.changes(active.sessionId).map(change => change.runId)).toEqual([active.id, recovering.id]);
    expect(() => store.writeSession('s_other123', [{ ...active, sessionId: 's_other123' }])).toThrow();
    expect(store.readSession('s_other123')).toBeUndefined();
    const next = await reopen(file, store);
    expect(next.readSession(active.sessionId)).toEqual([recovering, active]);
  });

  it('keeps durable empty-session tombstones and refuses legacy reimport or changed import digest', async () => {
    const { file, store } = await fixture();
    const first = mission(); const legacyDigest = hash('original');
    store.writeSession(first.sessionId, [first], { legacyDigest });
    expect(() => store.writeSession(first.sessionId, [first], { legacyDigest: hash('changed') })).toThrow();
    store.removeSession(first.sessionId);
    store.removeSession('s_empty123');
    expect(store.readSession(first.sessionId)).toEqual([]);
    expect(store.changes(first.sessionId)).toEqual([]);
    expect(() => store.writeSession(first.sessionId, [first], { legacyDigest })).toThrow();
    const next = await reopen(file, store);
    expect(next.readSession(first.sessionId)).toEqual([]);
    expect(next.readSession('s_empty123')).toEqual([]);
    expect(next.readSession('s_absent123')).toBeUndefined();
    // An explicit new save can reactivate a session; an imported sidecar cannot.
    next.writeSession(first.sessionId, [first]);
    expect(next.readSession(first.sessionId)).toEqual([first]);
  });

  it('enumerates live checkpoint sessions for orphan reconciliation, including empty snapshots', async () => {
    const { file, store } = await fixture();
    const orphan = mission('recovering', 's_orphan123');
    store.writeSession(orphan.sessionId, [orphan]);
    store.writeSession('s_empty123', []);
    store.removeSession('s_deleted123');
    const ids = store.sessionIds();
    expect(ids).toEqual(['s_empty123', 's_orphan123']);
    expect(store.readSession(ids[1]!)).toEqual([orphan]);
    const next = await reopen(file, store);
    expect(next.sessionIds()).toEqual(ids);
    expect(next.readSession('s_deleted123')).toEqual([]);
    expect(() => store.sessionIds()).toThrow(/unavailable/);
  });

  it('paginates bounded changes and validates bounds without weakening snapshot limits', async () => {
    const { store } = await fixture(); const first = mission();
    for (let index = 0; index < 5; index++) store.writeSession(first.sessionId, [{ ...first, title: `Revision ${index}` }]);
    const page = store.changes(first.sessionId, 0, 2);
    expect(page.map(change => change.revision)).toEqual([1, 2]);
    expect(store.changes(first.sessionId, page[1]!.sequence, 2).map(change => change.revision)).toEqual([3, 4]);
    expect(store.changes(first.sessionId, 5, 1000)).toEqual([]);
    for (const [after, limit] of [[-1, 1], [0.5, 1], [Infinity, 1], [0, 0], [0, 1001], [0, NaN]]) expect(() => store.changes(first.sessionId, after, limit)).toThrow();
    for (const invalid of [[...Array.from({ length: 17 }, () => mission())], [first, first], [{ ...first, transient: true }], [{ ...first, sessionId: 'wrong' }]]) {
      expect(() => store.writeSession(first.sessionId, invalid)).toThrow();
    }
    const oversized = { ...first, tasks: [{ ...first.tasks[0]!, answer: '\u0001'.repeat(1_500_000) }] };
    expect(() => store.writeSession(first.sessionId, [oversized])).toThrow();
    expect(store.changes(first.sessionId)).toHaveLength(5);
    expect(store.readSession(first.sessionId)?.[0]?.title).toBe('Revision 4');
  });

  it('fails atomically at the per-session journal cap instead of silently discarding revisions', async () => {
    const { file, store } = await fixture(); const first = mission(); store.writeSession(first.sessionId, [first]);
    const db = new DatabaseSync(file);
    try {
      // Seed a valid bounded history cheaply in one transaction, then exercise
      // the production admission path at its final available revision.
      db.exec(`WITH RECURSIVE revisions(n) AS (SELECT 2 UNION ALL SELECT n + 1 FROM revisions WHERE n < 8192)
        INSERT INTO mission_changes(session_id, run_id, revision, state, at, digest)
        SELECT session_id, run_id, n, state, updated_at, digest FROM mission_checkpoints CROSS JOIN revisions`);
      db.prepare('UPDATE mission_checkpoints SET revision = 8192 WHERE run_id = ?').run(first.id);
    } finally { db.close(); }
    expect(() => store.writeSession(first.sessionId, [{ ...first, title: 'One too many' }])).toThrow(/unavailable/);
    expect(store.readSession(first.sessionId)).toEqual([first]);
    expect(store.changes(first.sessionId, 8190).map(change => change.revision)).toEqual([8191, 8192]);
    const next = await reopen(file, store);
    expect(next.readSession(first.sessionId)).toEqual([first]);
  });

  it.each(['newer', 'malformed', 'corrupt'] as const)('rejects %s storage without fallback or schema mutation', async kind => {
    const { file, store } = await fixture(); store.close(); stores.delete(store);
    if (kind === 'corrupt') await writeFile(file, 'This is not a SQLite database.');
    else {
      const db = new DatabaseSync(file);
      try { db.exec(kind === 'newer' ? 'PRAGMA user_version = 999' : 'DROP INDEX mission_changes_session'); } finally { db.close(); }
    }
    const before = await readFile(file);
    await expect(MissionCheckpointStore.open(file)).rejects.toThrow(/unavailable/);
    expect(await readFile(file)).toEqual(before);
  });

  it('rejects an unversioned populated database rather than adopting an unrelated schema', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'extalia-checkpoints-')); directories.push(directory);
    const file = path.join(directory, 'unrelated.sqlite');
    const db = new DatabaseSync(file);
    try { db.exec('CREATE TABLE unrelated (value TEXT)'); } finally { db.close(); }
    await expect(MissionCheckpointStore.open(file)).rejects.toThrow(/unavailable/);
    const reopened = new DatabaseSync(file);
    try { expect(reopened.prepare('PRAGMA user_version').get()?.user_version).toBe(0); } finally { reopened.close(); }
  });

  it('detects payload digest and state corruption on reads and after reopening', async () => {
    const { file, store } = await fixture(); const first = mission(); store.writeSession(first.sessionId, [first]);
    const db = new DatabaseSync(file);
    try {
      db.prepare('UPDATE mission_checkpoints SET state = ? WHERE run_id = ?').run('running', first.id);
      expect(() => store.readSession(first.sessionId)).toThrow(/unavailable/);
      db.prepare('UPDATE mission_checkpoints SET state = ?, payload = ? WHERE run_id = ?').run(first.state, JSON.stringify({ ...first, title: 'Tampered' }), first.id);
      expect(() => store.readSession(first.sessionId)).toThrow(/unavailable/);
    } finally { db.close(); }
    store.close(); stores.delete(store);
    await expect(MissionCheckpointStore.open(file)).rejects.toThrow(/unavailable/);
  });

  it('creates private DB/WAL files, rejects symlinks and closes idempotently', async () => {
    const { file, store } = await fixture(); const first = mission(); store.writeSession(first.sessionId, [first]);
    if (process.platform !== 'win32') {
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
      for (const candidate of [file, `${file}-wal`, `${file}-shm`]) expect((await stat(candidate)).mode & 0o777).toBe(0o600);
      const alias = path.join(path.dirname(file), 'alias.sqlite'); await symlink(file, alias);
      await expect(MissionCheckpointStore.open(alias)).rejects.toThrow(/unavailable/);
    }
    store.close(); store.close(); stores.delete(store);
    expect(() => store.readSession(first.sessionId)).toThrow(/unavailable/);
    expect(() => store.writeSession(first.sessionId, [first])).toThrow(/unavailable/);
    expect(() => store.changes(first.sessionId)).toThrow(/unavailable/);
  });
});
