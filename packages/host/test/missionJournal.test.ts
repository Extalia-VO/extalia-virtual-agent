import type { HostMissionRun } from '@extalia/platform';
import { parseOrchestration, type AgentEvent, type AgentEventBody } from '@extalia/protocol';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MissionCheckpointStore, validateMissionJournalEvent } from '../src/missionCheckpoints.js';

const directories: string[] = [];
const stores = new Set<MissionCheckpointStore>();
const at = '2026-01-01T00:00:00.000Z';
const MAX_BYTES = 8 * 1024 * 1024;
afterEach(async () => {
  for (const store of stores) store.close(); stores.clear();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'extalia-journal-')); directories.push(directory);
  const file = path.join(directory, 'missions.sqlite');
  const store = await MissionCheckpointStore.open(file); stores.add(store);
  return { store, file };
}
async function reopen(file: string, store: MissionCheckpointStore) {
  store.close(); stores.delete(store);
  const next = await MissionCheckpointStore.open(file); stores.add(next); return next;
}
function context(state: HostMissionRun['state'] = 'running', sessionId = 's_journal123') {
  const run: HostMissionRun = {
    id: randomUUID(), sessionId, workspaceId: 'workspace', title: 'Read-only mission', state, createdAt: at, updatedAt: at, transient: false,
    tasks: [{ id: 'survey', taskId: randomUUID(), agentId: randomUUID(), title: 'Survey', connectionId: 'connection', model: 'model-a', state: 'queued', evidenceIds: [] }],
  };
  const identity = { workspaceId: randomUUID(), sessionId: randomUUID(), leadId: randomUUID() };
  const event = (body: AgentEventBody, patch: Partial<AgentEvent> = {}): AgentEvent => ({
    schemaVersion: 1, id: randomUUID(), workspaceId: identity.workspaceId, sessionId: identity.sessionId, missionId: run.id,
    ...(body.type === 'mission.state' ? { agentId: identity.leadId } : { agentId: run.tasks[0]!.agentId, taskId: run.tasks[0]!.taskId }),
    source: { runtime: 'extalia-native', channel: 'system' }, observedAt: at, confidence: 'reported', body, ...patch,
  });
  return { run, event, identity };
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => !item || typeof item !== 'object' || Array.isArray(item) ? item
    : Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}

/** Rewrite a current store as a released older schema: drop schema 3 totals (and, for 1, the event journal). */
function downgrade(db: DatabaseSync, version: 1 | 2): void {
  const totals = db.prepare("SELECT type, name FROM sqlite_schema WHERE type IN ('table', 'trigger') AND name LIKE '%\\_totals%' ESCAPE '\\' ORDER BY type = 'table'").all() as { type: string; name: string }[];
  for (const object of totals) db.exec(`DROP ${object.type === 'table' ? 'TABLE' : 'TRIGGER'} ${object.name}`);
  if (version === 1) db.exec('DROP TABLE mission_events');
  db.exec(`PRAGMA user_version = ${version}`);
}

/** Bulk fixture uses real valid envelopes, matching digest/byte accounting and FKs. */
function seedEvents(db: DatabaseSync, run: HostMissionRun, template: AgentEvent, count: number, byteBudget = Infinity): { count: number; bytes: number } {
  const checkpoint = db.prepare('SELECT revision, digest FROM mission_checkpoints WHERE run_id = ?').all(run.id)[0]!;
  const insert = db.prepare('INSERT INTO mission_events(event_id,session_id,run_id,sequence,event_type,checkpoint_revision,checkpoint_digest,digest,encoded_bytes,payload) VALUES (?,?,?,?,?,?,?,?,?,?)');
  let bytes = 0, inserted = 0;
  db.exec('BEGIN');
  try {
    for (let sequence = 1; sequence <= count; sequence++) {
      const normalized = validateMissionJournalEvent({ ...template, id: randomUUID() }, run);
      const payload = canonical({ ...normalized, sequence }), encoded = Buffer.byteLength(payload);
      if (bytes + encoded > byteBudget) break;
      insert.run(normalized.id, run.sessionId, run.id, sequence, normalized.body.type, Number(checkpoint.revision), checkpoint.digest as string, hash(canonical(normalized)), encoded, payload);
      bytes += encoded; inserted++;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { count: inserted, bytes };
}

describe('canonical native mission event journal', () => {
  it('atomically commits task state/answer and assigns restart-stable per-mission sequences', async () => {
    const { store, file } = await fixture(); const { run, event } = context();
    const start = event({ type: 'mission.state', state: 'running' }, { sequence: 999 });
    const ack = store.writeSession(run.sessionId, [run], { event: start })!;
    expect(ack.sequence).toBe(1); expect(start.sequence).toBe(999);
    expect(store.writeSession(run.sessionId, [run], { event: event({ type: 'task.assigned', assigneeAgentId: run.tasks[0]!.agentId }) })?.sequence).toBe(2);
    const running = { ...run, tasks: [{ ...run.tasks[0]!, state: 'running' as const }] };
    expect(store.writeSession(run.sessionId, [running], { event: event({ type: 'task.state', state: 'running' }) })?.sequence).toBe(3);
    const completed = { ...run, tasks: [{ ...run.tasks[0]!, state: 'completed' as const, answer: 'Unverified answer', verification: 'unverified' as const }] };
    const completedEvent = store.writeSession(run.sessionId, [completed], { event: event({ type: 'task.state', state: 'completed' }) })!;
    expect(completedEvent.sequence).toBe(4);
    expect(store.readSession(run.sessionId)).toEqual([completed]);
    expect(JSON.stringify(store.readEvents(run.sessionId, run.id))).not.toContain('Unverified answer');
    const page = store.readEvents(run.sessionId, run.id, 1, 2);
    expect(page.map(value => value.sequence)).toEqual([2, 3]);
    expect(page.every(value => parseOrchestration('agentEvent', value).ok)).toBe(true);
    ack.source.runtime = 'caller-mutation';
    const next = await reopen(file, store);
    expect(next.readEvents(run.sessionId, run.id, 3)).toEqual([completedEvent]);
    expect(next.readEvents(run.sessionId, run.id, 0, 1)[0]?.source.runtime).toBe('extalia-native');
    const other = context('completed', run.sessionId);
    expect(next.writeSession(run.sessionId, [completed, other.run], { event: other.event({ type: 'mission.state', state: 'completed' }) })?.sequence).toBe(1);
  });

  it('acknowledges identical duplicate IDs without rewinding a newer checkpoint', async () => {
    const { store } = await fixture(); const { run, event } = context();
    const first = event({ type: 'mission.state', state: 'running' });
    const acknowledged = store.writeSession(run.sessionId, [run], { event: first });
    const newer = { ...run, title: 'Newer checkpoint', tasks: [{ ...run.tasks[0]!, state: 'running' as const }] };
    store.writeSession(run.sessionId, [newer], { event: event({ type: 'task.state', state: 'running' }) });
    const before = store.changes(run.sessionId);
    expect(store.writeSession(run.sessionId, [run], { event: { ...first, sequence: -Infinity } })).toEqual(acknowledged);
    expect(store.readSession(run.sessionId)).toEqual([newer]);
    expect(store.changes(run.sessionId)).toEqual(before);
    expect(store.readEvents(run.sessionId, run.id)).toHaveLength(2);
    expect(() => store.writeSession(run.sessionId, [newer], { event: first })).toThrow();
    expect(() => store.writeSession(run.sessionId, [newer], { event: event({ type: 'turn.failed', error: 'provider-failed' }, { id: first.id }) })).toThrow();
    expect(store.readSession(run.sessionId)).toEqual([newer]);
  });

  it('rolls back event, checkpoint, revision and import marker when the event insert fails', async () => {
    const { store, file } = await fixture(); const { run, event } = context(); store.writeSession(run.sessionId, [run]);
    const before = store.changes(run.sessionId), running = { ...run, tasks: [{ ...run.tasks[0]!, state: 'running' as const }] };
    const intent = event({ type: 'task.state', state: 'running' });
    const db = new DatabaseSync(file);
    try {
      db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON mission_events BEGIN SELECT RAISE(ABORT, 'injected event failure'); END");
      expect(() => store.writeSession(run.sessionId, [running], { event: intent, legacyDigest: hash('import') })).toThrow(/injected event failure/);
      expect(store.readSession(run.sessionId)).toEqual([run]);
      expect(store.readEvents(run.sessionId, run.id)).toEqual([]);
      expect(store.changes(run.sessionId)).toEqual(before);
      expect(db.prepare('SELECT legacy_digest FROM checkpoint_sessions WHERE session_id = ?').all(run.sessionId)[0]?.legacy_digest).toBeNull();
      db.exec('DROP TRIGGER fail_event');
      expect(store.writeSession(run.sessionId, [running], { event: intent })?.sequence).toBe(1);
      expect(db.prepare('SELECT checkpoint_revision FROM mission_events').all()[0]?.checkpoint_revision).toBe(2);
    } finally { db.close(); }
    const next = await reopen(file, store); expect(next.readSession(run.sessionId)).toEqual([running]);
  });

  it('rejects unsafe metadata, contradictory state, unsupported sources and wrong task ownership before mutation', async () => {
    const { store } = await fixture(); const { run, event } = context();
    const valid = event({ type: 'agent.state', state: 'thinking' });
    expect(validateMissionJournalEvent({ ...valid, sequence: 42 }, run).sequence).toBeUndefined();
    const unknown = { ...valid }; Object.defineProperty(unknown, 'privateField', { value: 'must reject', enumerable: false });
    const inherited = Object.assign(Object.create({ privateField: 'must reject' }), valid) as AgentEvent;
    const invalid: AgentEvent[] = [unknown, inherited,
      event({ type: 'model.completed', text: 'Must not enter the journal.' }),
      event({ type: 'turn.completed', summary: 'Raw answer' }),
      event({ type: 'agent.state', state: 'working', activity: 'command' }),
      event({ type: 'agent.state', state: 'thinking', summary: 'Raw summary' }),
      event({ type: 'tool.started', tool: 'read_file', kind: 'read', label: 'read_file', toolCallId: 'untrusted-provider-id' }),
      event({ type: 'tool.completed', tool: 'read_file', kind: 'read', label: 'read_file', ok: true, output: 'Raw file content' }),
      event({ type: 'tool.started', tool: 'write_file', kind: 'edit', label: 'write_file' }),
      event({ type: 'tool.started', tool: 'read_file', kind: 'read', label: 'A raw private path' }),
      event({ type: 'turn.failed', error: 'Raw provider response or credential' }),
      event({ type: 'task.state', state: 'running' }), event({ type: 'mission.state', state: 'failed' }),
      event({ type: 'task.assigned', assigneeAgentId: randomUUID() }),
      event({ type: 'agent.state', state: 'thinking' }, { agentId: randomUUID() }),
      event({ type: 'agent.state', state: 'thinking' }, { taskId: randomUUID() }),
      event({ type: 'agent.state', state: 'thinking' }, { missionId: randomUUID() }),
      { ...valid, source: { runtime: 'other-engine', channel: 'system' } },
      { ...valid, source: { runtime: 'extalia-native', channel: 'system', adapter: 'unbound-adapter' } },
      { ...valid, confidence: 'observed' },
    ];
    for (const value of invalid) {
      expect(() => validateMissionJournalEvent(value, run)).toThrow();
      expect(() => store.writeSession(run.sessionId, [run], { event: value })).toThrow();
    }
    expect(store.readSession(run.sessionId)).toBeUndefined();
    expect(store.changes(run.sessionId)).toEqual([]);
    for (const body of [
      { type: 'tool.started', tool: 'read_file', kind: 'read', label: 'read_file' },
      { type: 'tool.completed', tool: 'search_files', kind: 'search', label: 'search_files', ok: false },
      { type: 'turn.completed' }, { type: 'turn.failed', error: 'persistence-failed' },
    ] as AgentEventBody[]) expect(validateMissionJournalEvent(event(body), run).body).toEqual(body);
  });

  it('keeps mission native UUID/lead bindings stable and preserves historical task attribution', async () => {
    const { store } = await fixture(); const { run, event } = context();
    store.writeSession(run.sessionId, [run], { event: event({ type: 'mission.state', state: 'running' }) });
    for (const patch of [{ workspaceId: randomUUID() }, { sessionId: randomUUID() }, { agentId: randomUUID() }]) {
      expect(() => store.writeSession(run.sessionId, [run], { event: event({ type: 'mission.state', state: 'running' }, patch) })).toThrow();
    }
    const remapped = { ...run, tasks: [{ ...run.tasks[0]!, agentId: randomUUID() }] };
    expect(() => store.writeSession(run.sessionId, [remapped])).toThrow();
    expect(store.readEvents('s_absent123', run.id)).toEqual([]);
    expect(store.readEvents(run.sessionId, randomUUID())).toEqual([]);
    for (const [after, limit] of [[-1, 1], [Infinity, 1], [0, 0], [0, 1001], [0, 0.5]]) expect(() => store.readEvents(run.sessionId, run.id, after, limit)).toThrow();
    expect(() => store.readEvents(run.sessionId, 'not-a-uuid')).toThrow();
    expect(store.readEvents(run.sessionId, run.id)).toHaveLength(1);
  });

  it('migrates released schema1 without changing checkpoint revisions, import markers or global cursors', async () => {
    const { store, file } = await fixture(); const { run, event } = context('completed');
    store.writeSession(run.sessionId, [run], { legacyDigest: hash('preserved sidecar') });
    const updated = { ...run, title: 'Second revision' }; store.writeSession(run.sessionId, [updated]);
    const other = context('completed', 's_other123'); store.writeSession(other.run.sessionId, [other.run]);
    const changes = store.changes(run.sessionId), otherChanges = store.changes(other.run.sessionId);
    store.close(); stores.delete(store);
    const db = new DatabaseSync(file);
    try { downgrade(db, 1); } finally { db.close(); }
    const migrated = await MissionCheckpointStore.open(file); stores.add(migrated);
    expect(migrated.readSession(run.sessionId)).toEqual([updated]);
    expect(migrated.changes(run.sessionId)).toEqual(changes);
    expect(migrated.changes(other.run.sessionId)).toEqual(otherChanges);
    expect(migrated.readEvents(run.sessionId, run.id)).toEqual([]);
    expect(migrated.writeSession(run.sessionId, [updated], { event: event({ type: 'mission.state', state: 'completed' }) })?.sequence).toBe(1);
    expect(migrated.changes(run.sessionId)).toEqual(changes);
    migrated.writeSession(run.sessionId, [{ ...updated, title: 'Third revision' }]);
    expect(migrated.changes(run.sessionId).at(-1)?.sequence).toBe(4);
    expect(migrated.changes(run.sessionId).at(-1)?.revision).toBe(3);
    const check = new DatabaseSync(file);
    try {
      expect(check.prepare('PRAGMA user_version').all()[0]?.user_version).toBe(3);
      expect(check.prepare('SELECT legacy_digest FROM checkpoint_sessions WHERE session_id = ?').all(run.sessionId)[0]?.legacy_digest).toBe(hash('preserved sidecar'));
    } finally { check.close(); }
  });

  it.each(['schema', 'digest'] as const)('refuses malformed schema1 %s before migration changes bytes', async kind => {
    const { store, file } = await fixture(); const { run } = context(); store.writeSession(run.sessionId, [run]);
    store.close(); stores.delete(store);
    const db = new DatabaseSync(file);
    try {
      downgrade(db, 1);
      if (kind === 'schema') db.exec('DROP INDEX mission_changes_session');
      else db.exec("UPDATE mission_checkpoints SET digest = printf('%064d', 0)");
    } finally { db.close(); }
    const before = await readFile(file);
    await expect(MissionCheckpointStore.open(file)).rejects.toThrow(/unavailable/);
    expect(await readFile(file)).toEqual(before);
  });

  it('prunes terminal journals transactionally, refuses unresolved loss and leaves no events after deletion', async () => {
    const { store, file } = await fixture(); const first = context('completed'), active = context();
    store.writeSession(first.run.sessionId, [first.run], { event: first.event({ type: 'mission.state', state: 'completed' }) });
    store.writeSession(first.run.sessionId, [first.run, active.run], { event: active.event({ type: 'mission.state', state: 'running' }) });
    expect(() => store.writeSession(active.run.sessionId, [first.run])).toThrow(/Unresolved/);
    expect(() => store.removeSession(active.run.sessionId)).toThrow(/Unresolved/);
    store.writeSession(active.run.sessionId, [active.run]);
    expect(store.readEvents(first.run.sessionId, first.run.id)).toEqual([]);
    expect(store.readEvents(active.run.sessionId, active.run.id)).toHaveLength(1);
    store.writeSession(active.run.sessionId, [{ ...active.run, state: 'cancelled' }]);
    store.removeSession(active.run.sessionId);
    expect(store.readSession(active.run.sessionId)).toEqual([]);
    const db = new DatabaseSync(file);
    try { expect(db.prepare('SELECT count(*) AS count FROM mission_events').all()[0]?.count).toBe(0); } finally { db.close(); }
  });

  it('detects event payload tampering on paginated reads and startup', async () => {
    const { store, file } = await fixture(); const { run, event } = context();
    store.writeSession(run.sessionId, [run], { event: event({ type: 'mission.state', state: 'running' }) });
    const db = new DatabaseSync(file);
    try { db.exec("UPDATE mission_events SET digest = printf('%064d', 0)"); } finally { db.close(); }
    expect(() => store.readEvents(run.sessionId, run.id)).toThrow(/unavailable/);
    store.close(); stores.delete(store);
    await expect(MissionCheckpointStore.open(file)).rejects.toThrow(/unavailable/);
  });

  it('rejects a coherently rehashed mission event that contradicts its associated checkpoint revision', async () => {
    const { store, file } = await fixture(); const { run, event } = context();
    const acknowledged = store.writeSession(run.sessionId, [run], { event: event({ type: 'mission.state', state: 'running' }) })!;
    const { sequence: _sequence, ...normalized } = { ...acknowledged, body: { type: 'mission.state', state: 'completed' } };
    const payload = canonical({ ...normalized, sequence: acknowledged.sequence });
    const db = new DatabaseSync(file);
    try { db.prepare('UPDATE mission_events SET digest = ?, payload = ?, encoded_bytes = ?').run(hash(canonical(normalized)), payload, Buffer.byteLength(payload)); } finally { db.close(); }
    expect(() => store.readEvents(run.sessionId, run.id)).toThrow(/unavailable/);
  });

  it('refuses event8193 without changing snapshot or checkpoint revision', async () => {
    const { store, file } = await fixture(); const { run, event } = context(); store.writeSession(run.sessionId, [run]);
    const db = new DatabaseSync(file);
    try { expect(seedEvents(db, run, event({ type: 'mission.state', state: 'running' }), 8192).count).toBe(8192); } finally { db.close(); }
    const before = store.changes(run.sessionId);
    expect(() => store.writeSession(run.sessionId, [{ ...run, title: 'Would change' }], { event: event({ type: 'mission.state', state: 'running' }) })).toThrow(/unavailable/);
    expect(store.readSession(run.sessionId)).toEqual([run]);
    expect(store.changes(run.sessionId)).toEqual(before);
    expect(store.readEvents(run.sessionId, run.id, 8191, 1)[0]?.sequence).toBe(8192);
  }, 15_000);

  it('fails atomically at the actual encoded session event byte bound across multiple missions', async () => {
    const { store, file } = await fixture(); const first = context(), second = context();
    store.writeSession(first.run.sessionId, [first.run, second.run]);
    const extras = { parentId: randomUUID(), correlationId: randomUUID(), sourceTimestamp: at };
    const firstTemplate = first.event({ type: 'mission.state', state: 'running' }, extras);
    const secondTemplate = second.event({ type: 'mission.state', state: 'running' }, extras);
    const db = new DatabaseSync(file);
    let beforeBytes: number;
    try {
      const seeded = seedEvents(db, first.run, firstTemplate, 8192);
      const other = seedEvents(db, second.run, secondTemplate, 8192, MAX_BYTES - seeded.bytes);
      expect(other.count).toBeGreaterThan(0); expect(other.count).toBeLessThan(8192);
      beforeBytes = seeded.bytes + other.bytes;
      expect(beforeBytes).toBeLessThanOrEqual(MAX_BYTES);
      expect(beforeBytes + Buffer.byteLength(canonical({ ...secondTemplate, sequence: other.count + 1 }))).toBeGreaterThan(MAX_BYTES);
      const before = store.changes(first.run.sessionId);
      expect(() => store.writeSession(first.run.sessionId, [first.run, { ...second.run, title: 'Would change' }], { event: secondTemplate })).toThrow(/unavailable/);
      expect(store.readSession(first.run.sessionId)).toEqual([first.run, second.run]);
      expect(store.changes(first.run.sessionId)).toEqual(before);
      expect(db.prepare('SELECT sum(encoded_bytes) AS bytes FROM mission_events').all()[0]?.bytes).toBe(beforeBytes);
    } finally { db.close(); }
    const next = await reopen(file, store);
    expect(next.readEvents(second.run.sessionId, second.run.id, 0, 1)[0]?.sequence).toBe(1);
  }, 15_000);
});

/** Totals rows next to the aggregates they replace, as `[key, totals, aggregates]`. */
function totalsReport(db: DatabaseSync) {
  const sessions = db.prepare(`SELECT s.session_id AS key, t.change_count AS a, t.event_bytes AS b,
    (SELECT count(*) FROM mission_changes AS c WHERE c.session_id = s.session_id) AS x,
    (SELECT coalesce(sum(e.encoded_bytes), 0) FROM mission_events AS e WHERE e.session_id = s.session_id) AS y
    FROM checkpoint_sessions AS s LEFT JOIN checkpoint_session_totals AS t USING (session_id) ORDER BY s.session_id`).all();
  const runs = db.prepare(`SELECT m.run_id AS key, t.event_count AS a, t.last_sequence AS b,
    (SELECT count(*) FROM mission_events AS e WHERE e.run_id = m.run_id) AS x,
    (SELECT coalesce(max(e.sequence), 0) FROM mission_events AS e WHERE e.run_id = m.run_id) AS y
    FROM mission_checkpoints AS m LEFT JOIN mission_event_totals AS t USING (run_id) ORDER BY m.run_id`).all();
  const rows = db.prepare('SELECT (SELECT count(*) FROM checkpoint_session_totals) AS sessions, (SELECT count(*) FROM mission_event_totals) AS runs').get()!;
  const pairs = [...sessions, ...runs].map(row => [row.key, [row.a, row.b], [row.x, row.y]] as const);
  return { pairs, rows: [rows.sessions, rows.runs], expectedRows: [sessions.length, runs.length] };
}
function expectTotalsExact(db: DatabaseSync, step: string): void {
  const report = totalsReport(db);
  for (const [key, totals, aggregates] of report.pairs) expect(totals, `${step}: ${String(key)}`).toEqual(aggregates);
  expect(report.rows, step).toEqual(report.expectedRows);
}
/** Deterministic PRNG (mulberry32), so a failing seed reproduces. */
function random(seed: number): (bound: number) => number {
  let state = seed >>> 0;
  return bound => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % bound);
  };
}

describe('running journal totals (schema 3)', () => {
  it.each([1, 7, 42])('equal the recomputed aggregates after random workloads, failures and reopening (seed %i)', async seed => {
    const { store: opened, file } = await fixture(); let store = opened;
    const next = random(seed);
    const missions = [context('running', 's_totals_a1'), context('running', 's_totals_a1'), context('running', 's_totals_b2')];
    const runs = missions.map(mission => mission.run);
    const sessionRuns = (sessionId: string) => runs.filter(run => run.sessionId === sessionId);
    let tick = Date.parse(at);
    const touch = (index: number, patch: Partial<HostMissionRun> = {}) => {
      tick += 1000; runs[index] = { ...runs[index]!, updatedAt: new Date(tick).toISOString(), ...patch };
    };
    const committed: { sessionId: string; snapshot: HostMissionRun[]; event: AgentEvent; ack: AgentEvent }[] = [];
    const bodies: AgentEventBody[] = [
      { type: 'agent.state', state: 'working', activity: 'read' },
      { type: 'tool.started', tool: 'read_file', kind: 'read', label: 'read_file' },
      { type: 'agent.state', state: 'working', activity: 'search' },
    ];
    const db = new DatabaseSync(file);
    try {
      for (const mission of missions) {
        store.writeSession(mission.run.sessionId, sessionRuns(mission.run.sessionId), { event: mission.event({ type: 'mission.state', state: 'running' }) });
      }
      expectTotalsExact(db, 'setup');
      for (let step = 0; step < 120; step++) {
        const index = next(missions.length), mission = missions[index]!, sessionId = mission.run.sessionId;
        const body = bodies[next(bodies.length)]!;
        const choice = next(10);
        if (choice <= 3) {
          // A new event with a moved checkpoint: one change and one event.
          touch(index);
          const event = mission.event(body), snapshot = sessionRuns(sessionId);
          const ack = store.writeSession(sessionId, snapshot, { event })!;
          const totals = db.prepare('SELECT event_count FROM mission_event_totals WHERE run_id = ?').get(mission.run.id)!;
          expect(ack.sequence, `seed ${seed} step ${step}`).toBe(totals.event_count);
          committed.push({ sessionId, snapshot, event, ack });
        } else if (choice === 4 && committed.length) {
          // Identical retry with its original snapshot: the original acknowledgement, no write.
          const old = committed[next(committed.length)]!, before = totalsReport(db);
          expect(store.writeSession(old.sessionId, old.snapshot, { event: old.event })).toEqual(old.ack);
          expect(totalsReport(db)).toEqual(before);
        } else if (choice === 5 && committed.length) {
          // Reused ID with another body: refused, nothing written.
          const old = committed[next(committed.length)]!, before = totalsReport(db);
          const other = bodies.find(candidate => canonical(candidate) !== canonical(old.event.body))!;
          expect(() => store.writeSession(old.sessionId, sessionRuns(old.sessionId), { event: { ...old.event, body: other } })).toThrow(/unavailable/);
          expect(totalsReport(db)).toEqual(before);
        } else if (choice === 6 || choice === 7) {
          // Injected failure on the change or the event insert: the whole write rolls back.
          const table = choice === 6 ? 'mission_changes' : 'mission_events', before = totalsReport(db);
          db.exec(`CREATE TRIGGER fail_totals BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected totals failure'); END`);
          try {
            touch(index);
            expect(() => store.writeSession(sessionId, sessionRuns(sessionId), { event: mission.event(body) })).toThrow(/injected totals failure/);
          } finally { db.exec('DROP TRIGGER fail_totals'); }
          expect(totalsReport(db)).toEqual(before);
        } else {
          // Checkpoint-only save: a change without an event.
          touch(index, { title: `Revision ${step}` });
          store.writeSession(sessionId, sessionRuns(sessionId));
        }
        expectTotalsExact(db, `seed ${seed} step ${step} choice ${choice}`);
      }
      const before = totalsReport(db);
      store = await reopen(file, store);
      expect(totalsReport(db)).toEqual(before);
      expectTotalsExact(db, 'reopen');
      // The next sequence continues from the totals after reopening.
      const last = db.prepare('SELECT event_count FROM mission_event_totals WHERE run_id = ?').get(runs[0]!.id)!;
      touch(0);
      expect(store.writeSession(runs[0]!.sessionId, sessionRuns(runs[0]!.sessionId), { event: missions[0]!.event(bodies[0]!) })?.sequence).toBe(Number(last.event_count) + 1);
      // Pruning a finished run and removing a session cascade through the totals.
      touch(1, { state: 'completed' });
      store.writeSession(runs[1]!.sessionId, [runs[0]!, runs[1]!]);
      expectTotalsExact(db, 'checkpoint-only completion');
      const prunedEvents = db.prepare('SELECT count(*) AS count FROM mission_events WHERE run_id = ?').get(runs[1]!.id)!.count;
      store.writeSession(runs[0]!.sessionId, [runs[0]!]);
      expectTotalsExact(db, 'pruned run');
      expect(db.prepare('SELECT count(*) AS count FROM mission_event_totals WHERE run_id = ?').get(runs[1]!.id)?.count).toBe(0);
      expect(Number(prunedEvents)).toBeGreaterThan(0);
      touch(2, { state: 'cancelled' });
      store.writeSession(runs[2]!.sessionId, [runs[2]!]);
      store.removeSession(runs[2]!.sessionId);
      expectTotalsExact(db, 'removed session');
      expect(db.prepare('SELECT change_count, event_bytes FROM checkpoint_session_totals WHERE session_id = ?').get(runs[2]!.sessionId)).toEqual({ change_count: 0, event_bytes: 0 });
    } finally { db.close(); }
  }, 30_000);

  it('keep the event and change caps at the same thresholds', async () => {
    const { store, file } = await fixture(); const { run, event } = context(); store.writeSession(run.sessionId, [run]);
    const db = new DatabaseSync(file);
    try {
      // Events: 8,191 stored, the 8,192nd commits, the 8,193rd is refused.
      expect(seedEvents(db, run, event({ type: 'mission.state', state: 'running' }), 8191).count).toBe(8191);
      expect(store.writeSession(run.sessionId, [run], { event: event({ type: 'mission.state', state: 'running' }) })?.sequence).toBe(8192);
      const before = totalsReport(db);
      expect(() => store.writeSession(run.sessionId, [run], { event: event({ type: 'mission.state', state: 'running' }) })).toThrow(/unavailable/);
      expect(totalsReport(db)).toEqual(before);
      expectTotalsExact(db, 'event cap');
    } finally { db.close(); }

    const second = await fixture(); const other = context('completed'); second.store.writeSession(other.run.sessionId, [other.run]);
    const changes = new DatabaseSync(second.file);
    try {
      // Changes: 8,191 stored, the 8,192nd commits, the 8,193rd is refused.
      changes.exec(`WITH RECURSIVE revisions(n) AS (SELECT 2 UNION ALL SELECT n + 1 FROM revisions WHERE n < 8191)
        INSERT INTO mission_changes(session_id, run_id, revision, state, at, digest)
        SELECT session_id, run_id, n, state, updated_at, digest FROM mission_checkpoints CROSS JOIN revisions`);
      changes.prepare('UPDATE mission_checkpoints SET revision = 8191 WHERE run_id = ?').run(other.run.id);
      second.store.writeSession(other.run.sessionId, [{ ...other.run, title: 'Last revision' }]);
      expect(second.store.changes(other.run.sessionId, 8191).map(change => change.revision)).toEqual([8192]);
      expect(() => second.store.writeSession(other.run.sessionId, [{ ...other.run, title: 'One too many' }])).toThrow(/unavailable/);
      expectTotalsExact(changes, 'change cap');
    } finally { changes.close(); }
  }, 15_000);

  it('migrates schema2 with a backfill, keeps acknowledged sequences and fails closed on tampered totals', async () => {
    const { store, file } = await fixture(); const first = context('running', 's_migrate_a1'), second = context('running', 's_migrate_a1'), third = context('completed', 's_migrate_b2');
    store.writeSession(first.run.sessionId, [first.run, second.run], { event: first.event({ type: 'mission.state', state: 'running' }), legacyDigest: hash('sidecar import') });
    for (let n = 0; n < 5; n++) store.writeSession(first.run.sessionId, [first.run, second.run], { event: first.event({ type: 'agent.state', state: 'working', activity: 'read' }) });
    store.writeSession(first.run.sessionId, [first.run, second.run], { event: second.event({ type: 'mission.state', state: 'running' }) });
    store.writeSession(third.run.sessionId, [third.run]);
    store.close(); stores.delete(store);
    const db = new DatabaseSync(file);
    try {
      const expected = totalsReport(db);
      downgrade(db, 2);
      expect(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name LIKE '%totals%'").get()?.count).toBe(0);
      const migrated = await MissionCheckpointStore.open(file); stores.add(migrated);
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
      expect(totalsReport(db)).toEqual(expected);
      expectTotalsExact(db, 'backfill');
      expect(db.prepare('SELECT legacy_digest FROM checkpoint_sessions WHERE session_id = ?').get(first.run.sessionId)?.legacy_digest).toBe(hash('sidecar import'));
      expect(migrated.writeSession(first.run.sessionId, [first.run, second.run], { event: first.event({ type: 'agent.state', state: 'working', activity: 'search' }) })?.sequence).toBe(7);
      expect(migrated.readEvents(first.run.sessionId, first.run.id).map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      const reopened = await reopen(file, migrated);
      expectTotalsExact(db, 'reopen after migration');
      expect(reopened.writeSession(first.run.sessionId, [first.run, second.run], { event: second.event({ type: 'agent.state', state: 'working', activity: 'read' }) })?.sequence).toBe(2);
      reopened.close(); stores.delete(reopened);
      // Totals are verified on open: a desynchronized row fails closed without writes.
      db.prepare('UPDATE mission_event_totals SET event_count = event_count + 1, last_sequence = last_sequence + 1 WHERE run_id = ?').run(first.run.id);
    } finally { db.close(); }
    const before = await readFile(file);
    await expect(MissionCheckpointStore.open(file)).rejects.toThrow(/unavailable/);
    expect(await readFile(file)).toEqual(before);
  });
});

describe('worker activity admission parity (ADR 0028)', () => {
  // The shared fixture of @extalia/protocol, also checked by `cargo test` against the Rust store policy.
  it('admits edit activity only for a write-capable task and keeps refusing it for read-only tasks', async () => {
    const fixture = JSON.parse(await readFile(path.join(import.meta.dirname, '../../protocol/test/fixtures/journal/admission.json'), 'utf8')) as { cases: { name: string; body: AgentEventBody; role: string | null }[] };
    expect(fixture.cases.length).toBeGreaterThan(20);
    for (const access of [undefined, 'write'] as const) {
      const { run, event } = context();
      run.tasks[0] = { ...run.tasks[0]!, ...(access ? { access } : {}) };
      for (const item of fixture.cases) {
        const admitted = (() => { try { validateMissionJournalEvent(event(item.body), run); return true; } catch { return false; } })();
        expect(admitted, `${item.name} (${access ?? 'read'})`).toBe(item.role === 'read-only-worker' || (item.role === 'write-worker' && access === 'write'));
      }
    }
  });

  it('never journals edit contents, outputs or summaries even for a write-capable task', () => {
    const { run, event } = context();
    run.tasks[0] = { ...run.tasks[0]!, access: 'write' };
    for (const body of [
      { type: 'tool.completed', tool: 'write_file', kind: 'edit', label: 'write_file', ok: true, output: 'file contents' },
      { type: 'tool.started', tool: 'write_file', kind: 'edit', label: 'write_file', toolCallId: 'provider-id' },
      { type: 'agent.state', state: 'working', activity: 'edit', target: 'src/a.ts' },
      { type: 'agent.state', state: 'working', activity: 'edit', summary: 'Writing src/a.ts' },
      { type: 'file.written', path: 'src/a.ts', change: 'update' },
    ] as AgentEventBody[]) expect(() => validateMissionJournalEvent(event(body), run), body.type).toThrow();
    const edit = { type: 'tool.started', tool: 'edit_file', kind: 'edit', label: 'edit_file', target: 'src/a.ts' } as AgentEventBody;
    expect(validateMissionJournalEvent(event(edit), run).body).toEqual(edit);
  });
});
