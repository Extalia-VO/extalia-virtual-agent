/** Transactional mission checkpoints; this is not a replayable execution journal. */
import { isHostMissionRecoveryMetadata, type HostMissionRun } from '@extalia/platform';
import { missionJournalRole, parseOrchestration, type AgentEvent } from '@extalia/protocol';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, lstatSync, openSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensurePrivateDirectory, PRIVATE_FILE_MODE } from './paths.js';

export interface MissionCheckpointChange {
  readonly sequence: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly state: HostMissionRun['state'];
  readonly at: string;
  readonly digest: string;
}

const VERSION = 3;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CHANGES = 8192;
const MAX_EVENTS = 8192;
const MAX_EVENT_BYTES = 4096;
const STATES = ['running', 'completed', 'failed', 'cancelled', 'recovering'];
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TURN_FAILURE_CODES = ['provider-failed', 'turn-incomplete', 'cancelled', 'timeout', 'execution-unknown', 'dependency-failed', 'capacity-unknown', 'persistence-failed', 'budget-exhausted', 'usage-unknown', 'mission-deadline'];
const unresolved = (state: string) => state === 'running' || state === 'recovering';
const failure = () => new Error('Native mission checkpoint storage is unavailable.');

// Keep SQL compatible with Node 22.13's built-in SQLite API. There is no JSON
// fallback: an unsupported runtime or invalid database must fail closed.
const SCHEMA_V1 = [
  `CREATE TABLE checkpoint_sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    legacy_digest TEXT CHECK (legacy_digest IS NULL OR length(legacy_digest) = 64),
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE mission_checkpoints (
    run_id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES checkpoint_sessions(session_id),
    position INTEGER NOT NULL CHECK (position >= 0 AND position < 16),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'cancelled', 'recovering')),
    updated_at TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    payload TEXT NOT NULL,
    UNIQUE (session_id, run_id)
  ) STRICT`,
  `CREATE TABLE mission_changes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'cancelled', 'recovering')),
    at TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    FOREIGN KEY (session_id, run_id) REFERENCES mission_checkpoints(session_id, run_id) ON DELETE CASCADE,
    UNIQUE (run_id, revision)
  ) STRICT`,
  'CREATE INDEX mission_checkpoints_session ON mission_checkpoints(session_id, position)',
  'CREATE INDEX mission_changes_session ON mission_changes(session_id, sequence)',
] as const;
const EVENT_SCHEMA = [
  `CREATE TABLE mission_events (
    event_id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    event_type TEXT NOT NULL CHECK (event_type IN ('mission.state', 'task.state', 'task.assigned', 'agent.state', 'tool.started', 'tool.completed', 'turn.completed', 'turn.failed')),
    checkpoint_revision INTEGER NOT NULL CHECK (checkpoint_revision >= 1),
    checkpoint_digest TEXT NOT NULL CHECK (length(checkpoint_digest) = 64),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    encoded_bytes INTEGER NOT NULL CHECK (encoded_bytes >= 1 AND encoded_bytes <= 4096),
    payload TEXT NOT NULL,
    UNIQUE (run_id, sequence),
    FOREIGN KEY (session_id, run_id) REFERENCES mission_checkpoints(session_id, run_id) ON DELETE CASCADE,
    FOREIGN KEY (run_id, checkpoint_revision) REFERENCES mission_changes(run_id, revision) ON DELETE CASCADE
  ) STRICT`,
  'CREATE INDEX mission_events_session ON mission_events(session_id, run_id, sequence)',
] as const;
const SCHEMA_V2 = [...SCHEMA_V1, ...EVENT_SCHEMA];
// Schema 3: running totals for the per-session change/byte caps and the per-mission
// event cap and sequence, so a commit reads one row instead of scanning the journal.
// Triggers keep them equal to the aggregates in the same transaction as any write,
// whoever writes (cascades included); open verifies them against the aggregates.
const TOTALS_SCHEMA = [
  `CREATE TABLE checkpoint_session_totals (
    session_id TEXT PRIMARY KEY NOT NULL REFERENCES checkpoint_sessions(session_id),
    change_count INTEGER NOT NULL CHECK (change_count >= 0),
    event_bytes INTEGER NOT NULL CHECK (event_bytes >= 0)
  ) STRICT`,
  `CREATE TABLE mission_event_totals (
    run_id TEXT PRIMARY KEY NOT NULL REFERENCES mission_checkpoints(run_id) ON DELETE CASCADE,
    event_count INTEGER NOT NULL CHECK (event_count >= 0),
    last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
  ) STRICT`,
  `CREATE TRIGGER checkpoint_session_totals_insert AFTER INSERT ON checkpoint_sessions BEGIN
    INSERT OR IGNORE INTO checkpoint_session_totals(session_id, change_count, event_bytes) VALUES (NEW.session_id, 0, 0);
  END`,
  `CREATE TRIGGER mission_event_totals_insert AFTER INSERT ON mission_checkpoints BEGIN
    INSERT OR IGNORE INTO mission_event_totals(run_id, event_count, last_sequence) VALUES (NEW.run_id, 0, 0);
  END`,
  `CREATE TRIGGER mission_changes_totals_insert AFTER INSERT ON mission_changes BEGIN
    UPDATE checkpoint_session_totals SET change_count = change_count + 1 WHERE session_id = NEW.session_id;
  END`,
  `CREATE TRIGGER mission_changes_totals_delete AFTER DELETE ON mission_changes BEGIN
    UPDATE checkpoint_session_totals SET change_count = change_count - 1 WHERE session_id = OLD.session_id;
  END`,
  `CREATE TRIGGER mission_changes_totals_update AFTER UPDATE OF session_id ON mission_changes BEGIN
    UPDATE checkpoint_session_totals SET change_count = change_count - 1 WHERE session_id = OLD.session_id;
    UPDATE checkpoint_session_totals SET change_count = change_count + 1 WHERE session_id = NEW.session_id;
  END`,
  `CREATE TRIGGER mission_events_totals_insert AFTER INSERT ON mission_events BEGIN
    UPDATE mission_event_totals SET event_count = event_count + 1, last_sequence = max(last_sequence, NEW.sequence) WHERE run_id = NEW.run_id;
    UPDATE checkpoint_session_totals SET event_bytes = event_bytes + NEW.encoded_bytes WHERE session_id = NEW.session_id;
  END`,
  `CREATE TRIGGER mission_events_totals_delete AFTER DELETE ON mission_events BEGIN
    UPDATE mission_event_totals SET event_count = event_count - 1,
      last_sequence = (SELECT coalesce(max(sequence), 0) FROM mission_events WHERE run_id = OLD.run_id) WHERE run_id = OLD.run_id;
    UPDATE checkpoint_session_totals SET event_bytes = event_bytes - OLD.encoded_bytes WHERE session_id = OLD.session_id;
  END`,
  `CREATE TRIGGER mission_events_totals_update AFTER UPDATE OF session_id, run_id, sequence, encoded_bytes ON mission_events BEGIN
    UPDATE mission_event_totals SET event_count = event_count - 1,
      last_sequence = (SELECT coalesce(max(sequence), 0) FROM mission_events WHERE run_id = OLD.run_id) WHERE run_id = OLD.run_id;
    UPDATE checkpoint_session_totals SET event_bytes = event_bytes - OLD.encoded_bytes WHERE session_id = OLD.session_id;
    UPDATE mission_event_totals SET event_count = event_count + 1,
      last_sequence = (SELECT coalesce(max(sequence), 0) FROM mission_events WHERE run_id = NEW.run_id) WHERE run_id = NEW.run_id;
    UPDATE checkpoint_session_totals SET event_bytes = event_bytes + NEW.encoded_bytes WHERE session_id = NEW.session_id;
  END`,
] as const;
// One-time backfill when migrating schema 1 or 2; not a schema object.
const TOTALS_BACKFILL = [
  `INSERT INTO checkpoint_session_totals(session_id, change_count, event_bytes)
    SELECT s.session_id,
      (SELECT count(*) FROM mission_changes AS c WHERE c.session_id = s.session_id),
      (SELECT coalesce(sum(e.encoded_bytes), 0) FROM mission_events AS e WHERE e.session_id = s.session_id)
    FROM checkpoint_sessions AS s`,
  `INSERT INTO mission_event_totals(run_id, event_count, last_sequence)
    SELECT m.run_id,
      (SELECT count(*) FROM mission_events AS e WHERE e.run_id = m.run_id),
      (SELECT coalesce(max(e.sequence), 0) FROM mission_events AS e WHERE e.run_id = m.run_id)
    FROM mission_checkpoints AS m`,
] as const;
const SCHEMA = [...SCHEMA_V2, ...TOTALS_SCHEMA];
const normalizeSql = (sql: string) => sql.replace(/\s+/g, ' ').trim();

type Row = Record<string, unknown>;
interface CheckpointRow { run_id: string; session_id: string; position: number; revision: number; state: string; updated_at: string; digest: string; payload: string }
interface EventRow { event_id: string; session_id: string; run_id: string; sequence: number; event_type: string; checkpoint_revision: number; checkpoint_digest: string; digest: string; encoded_bytes: number; payload: string }

function sessionKey(sessionId: string): void {
  if (typeof sessionId !== 'string' || !sessionId.length || sessionId.length > 200 || [...sessionId].some(character => character.charCodeAt(0) < 32)) throw failure();
}
function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
}
/** Canonical object ordering makes equivalent snapshots idempotent. Arrays retain order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** The durable slice stores control metadata, never model/tool text or action parameters. */
function nativeEvent(raw: AgentEvent, run: HostMissionRun, checkState = true): AgentEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw failure();
  const properties = Object.getOwnPropertyDescriptors(raw);
  delete properties.sequence;
  const input = Object.defineProperties({}, properties);
  const parsed = parseOrchestration('agentEvent', input);
  if (!parsed.ok) throw failure();
  const event = parsed.value, body = event.body;
  if (event.missionId !== run.id || !event.agentId || event.confidence !== 'reported'
    || event.source.runtime !== 'extalia-native' || event.source.channel !== 'system'
    || Object.keys(event.source).some(key => !['runtime', 'channel'].includes(key))) throw failure();
  const fields: Record<string, readonly string[]> = {
    'mission.state': ['type', 'state'], 'task.state': ['type', 'state'], 'task.assigned': ['type', 'assigneeAgentId'],
    'agent.state': ['type', 'state', 'activity'], 'tool.started': ['type', 'tool', 'kind', 'label', 'target'],
    'tool.completed': ['type', 'tool', 'kind', 'label', 'ok', 'target'], 'turn.completed': ['type', 'usage'], 'turn.failed': ['type', 'error'],
  };
  const allowed = fields[body.type];
  if (!allowed || ![Object.prototype, null].includes(Object.getPrototypeOf(body))
    || Reflect.ownKeys(body).some(key => typeof key !== 'string' || !allowed.includes(key))) throw failure();
  if (body.type === 'mission.state') {
    if (event.taskId || !STATES.includes(body.state) || checkState && body.state !== run.state) throw failure();
  } else {
    const task = run.tasks.find(task => task.taskId === event.taskId);
    if (!task || event.agentId !== task.agentId) throw failure();
    if (body.type === 'task.state' && checkState && body.state !== task.state) throw failure();
    if (body.type === 'task.assigned' && body.assigneeAgentId !== task.agentId) throw failure();
  }
  // Worker activity follows the shared journal table (ADR 0028): edits only from a task with write access.
  if (body.type === 'agent.state' || body.type === 'tool.started' || body.type === 'tool.completed') {
    const role = missionJournalRole(body);
    if (!role || role === 'write-worker' && run.tasks.find(task => task.taskId === event.taskId)?.access !== 'write') throw failure();
  }
  if (body.type === 'turn.failed' && !TURN_FAILURE_CODES.includes(body.error)) throw failure();
  // Reported token counts are control metadata (ADR 0015); no other usage keys or estimates.
  if (body.type === 'turn.completed' && body.usage !== undefined) {
    const usage = body.usage as Record<string, unknown>;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage) || ![Object.prototype, null].includes(Object.getPrototypeOf(usage))
      || Reflect.ownKeys(usage).some(key => key !== 'inputTokens' && key !== 'outputTokens') || !Reflect.ownKeys(usage).length
      || Object.values(usage).some(value => !integer(value, 0) || value > 1_000_000_000_000)) throw failure();
  }
  if (Buffer.byteLength(canonical(event)) > MAX_EVENT_BYTES) throw failure();
  return JSON.parse(canonical(event)) as AgentEvent;
}

/** Shared SQL/RAM admission policy. Returns an isolated event without caller sequence. */
export function validateMissionJournalEvent(event: AgentEvent, run: HostMissionRun): AgentEvent {
  return nativeEvent(event, run);
}

function snapshot(sessionId: string, runs: readonly HostMissionRun[]): { run: HostMissionRun; payload: string; digest: string }[] {
  sessionKey(sessionId);
  if (!Array.isArray(runs) || runs.length > 16) throw failure();
  // Host MissionRecords owns strict domain validation. These independent bounds
  // prevent accidental retention bypass at this lower storage boundary.
  const entries = runs.map(run => {
    if (!run || typeof run !== 'object' || !UUID.test(run.id) || run.sessionId !== sessionId || run.transient !== false
      || !STATES.includes(run.state) || !isHostMissionRecoveryMetadata(run) || !timestamp(run.createdAt) || !timestamp(run.updatedAt)
      || !Array.isArray(run.tasks) || !run.tasks.length || run.tasks.length > 16) throw failure();
    const payload = canonical(run);
    if (typeof payload !== 'string') throw failure();
    return { run: JSON.parse(payload) as HostMissionRun, payload, digest: digest(payload) };
  });
  if (new Set(entries.map(entry => entry.run.id)).size !== entries.length
    || Buffer.byteLength(`${JSON.stringify({ schema: 'extalia.native-missions.v1', runs: entries.map(entry => entry.run) }, null, 2)}\n`) > MAX_BYTES) throw failure();
  return entries;
}

/** Make DB and SQLite sidecars private; the enclosing directory is also 0700. */
function privateFiles(file: string): void {
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      const info = lstatSync(candidate);
      if (!info.isFile() || info.isSymbolicLink()) throw failure();
      if (process.platform !== 'win32') chmodSync(candidate, PRIVATE_FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export class MissionCheckpointStore {
  private closed = false;
  private constructor(private readonly db: DatabaseSync, private readonly file: string) {}

  static async open(file: string): Promise<MissionCheckpointStore> {
    if (typeof file !== 'string' || !file.trim() || file.includes('\0') || file === ':memory:') throw failure();
    const location = path.resolve(file);
    await ensurePrivateDirectory(path.dirname(location));
    let db: DatabaseSync | undefined;
    try {
      privateFiles(location);
      const descriptor = openSync(location, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), PRIVATE_FILE_MODE);
      closeSync(descriptor);
      db = new DatabaseSync(location);
      const store = new MissionCheckpointStore(db, location);
      store.initialize();
      return store;
    } catch {
      try { db?.close(); } catch { /* Preserve the opening failure. */ }
      throw failure();
    }
  }

  private initialize(): void {
    this.db.exec('PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON;');
    const version = this.db.prepare('PRAGMA user_version').all()[0]?.user_version;
    const objects = this.db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    if (version === 0 && objects.length === 0) {
      this.transaction(() => {
        for (const sql of SCHEMA) this.db.exec(sql);
        this.db.exec(`PRAGMA user_version = ${VERSION}`);
      });
    } else if (version === 1 || version === 2) {
      // Verify the released schema and its contents before changing any schema
      // bytes. A failed migration rolls back without advancing user_version.
      this.verifySchema(version === 1 ? SCHEMA_V1 : SCHEMA_V2);
      this.verifyIntegrity();
      this.verifyContents(version === 2, false);
      this.transaction(() => {
        for (const sql of [...version === 1 ? EVENT_SCHEMA : [], ...TOTALS_SCHEMA, ...TOTALS_BACKFILL]) this.db.exec(sql);
        this.db.exec(`PRAGMA user_version = ${VERSION}`);
      });
    } else if (version !== VERSION) throw failure();
    this.verifySchema();
    this.verifyIntegrity();
    this.verifyContents();
    if (this.db.prepare('PRAGMA journal_mode = WAL').all()[0]?.journal_mode !== 'wal') throw failure();
    this.db.exec('PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 1000;');
    privateFiles(this.file);
  }

  private verifyIntegrity(): void {
    const integrity = this.db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok' || this.db.prepare('PRAGMA foreign_key_check').all().length) throw failure();
  }

  private verifySchema(schema: readonly string[] = SCHEMA): void {
    const schemaSql = new Set(schema.map(normalizeSql));
    const objects = this.db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    if (objects.length !== schema.length || objects.some(row => typeof row.sql !== 'string' || !schemaSql.has(normalizeSql(row.sql)))) throw failure();
  }

  private rows(sessionId: string): CheckpointRow[] {
    return this.db.prepare('SELECT * FROM mission_checkpoints WHERE session_id = ? ORDER BY position, run_id').all(sessionId) as unknown as CheckpointRow[];
  }

  private decodeRows(sessionId: string, rows: CheckpointRow[]): HostMissionRun[] {
    if (rows.length > 16) throw failure();
    const runs = rows.map((row, position) => {
      if (row.session_id !== sessionId || row.position !== position || !integer(row.revision, 1)
        || typeof row.payload !== 'string' || Buffer.byteLength(row.payload) > MAX_BYTES
        || !HEX.test(row.digest) || digest(row.payload) !== row.digest) throw failure();
      const run = JSON.parse(row.payload) as HostMissionRun;
      if (run.id !== row.run_id || run.sessionId !== row.session_id || run.state !== row.state
        || run.updatedAt !== row.updated_at || canonical(run) !== row.payload) throw failure();
      return run;
    });
    snapshot(sessionId, runs);
    return runs;
  }

  private eventRows(sessionId: string, missionId: string, after = 0, limit = MAX_EVENTS + 1): EventRow[] {
    return this.db.prepare('SELECT * FROM mission_events WHERE session_id = ? AND run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
      .all(sessionId, missionId, after, limit) as unknown as EventRow[];
  }

  private eventBytes(sessionId: string): number {
    const bytes = this.db.prepare('SELECT COALESCE(sum(encoded_bytes), 0) AS bytes FROM mission_events WHERE session_id = ?').all(sessionId)[0]?.bytes;
    if (!integer(bytes, 0) || bytes > MAX_BYTES) throw failure();
    return bytes;
  }

  /** Running per-session totals (schema 3): the change count and encoded event bytes. */
  private sessionTotals(sessionId: string): { changes: unknown; bytes: unknown } {
    const totals = this.db.prepare('SELECT change_count, event_bytes FROM checkpoint_session_totals WHERE session_id = ?').all(sessionId)[0];
    if (!totals) throw failure();
    return { changes: totals.change_count, bytes: totals.event_bytes };
  }

  private decodeEvent(row: EventRow, run: HostMissionRun): AgentEvent {
    if (row.session_id !== run.sessionId || row.run_id !== run.id || !integer(row.sequence, 1)
      || !integer(row.checkpoint_revision, 1) || !HEX.test(row.checkpoint_digest) || !HEX.test(row.digest)
      || typeof row.payload !== 'string' || !integer(row.encoded_bytes, 1) || row.encoded_bytes > MAX_EVENT_BYTES
      || Buffer.byteLength(row.payload) !== row.encoded_bytes) throw failure();
    const input = JSON.parse(row.payload) as AgentEvent;
    const normalized = nativeEvent(input, run, false);
    if (input.sequence !== row.sequence || normalized.id !== row.event_id || normalized.body.type !== row.event_type || digest(canonical(normalized)) !== row.digest
      || canonical({ ...normalized, sequence: row.sequence }) !== row.payload) throw failure();
    const change = this.db.prepare('SELECT digest, state FROM mission_changes WHERE run_id = ? AND revision = ?').all(run.id, row.checkpoint_revision)[0];
    if (change?.digest !== row.checkpoint_digest || normalized.body.type === 'mission.state' && normalized.body.state !== change.state) throw failure();
    return { ...normalized, sequence: row.sequence };
  }

  private verifyContents(withEvents = true, withTotals = withEvents): void {
    const sessions = this.db.prepare('SELECT * FROM checkpoint_sessions').all();
    if (withTotals) {
      // Exactly one totals row per session and per checkpoint; values are compared below.
      const counts = this.db.prepare(`SELECT (SELECT count(*) FROM checkpoint_session_totals) AS sessions,
        (SELECT count(*) FROM mission_event_totals) AS runs, (SELECT count(*) FROM mission_checkpoints) AS checkpoints`).all()[0];
      if (counts?.sessions !== sessions.length || counts.runs !== counts.checkpoints) throw failure();
    }
    for (const session of sessions) {
      if (typeof session.session_id !== 'string' || ![0, 1].includes(session.deleted as number) || !timestamp(session.updated_at)
        || session.legacy_digest !== null && (typeof session.legacy_digest !== 'string' || !HEX.test(session.legacy_digest))) throw failure();
      sessionKey(session.session_id);
      const rows = this.rows(session.session_id);
      if (session.deleted === 1 && rows.length) throw failure();
      this.decodeRows(session.session_id, rows);
      const count = this.db.prepare('SELECT count(*) AS count FROM mission_changes WHERE session_id = ?').all(session.session_id)[0]?.count;
      if (!integer(count, 0) || count > MAX_CHANGES) throw failure();
      const bytes = withEvents ? this.eventBytes(session.session_id) : 0;
      if (withTotals) {
        const totals = this.sessionTotals(session.session_id);
        if (totals.changes !== count || totals.bytes !== bytes) throw failure();
      }
      for (const row of rows) {
        const changes = this.db.prepare('SELECT * FROM mission_changes WHERE run_id = ? ORDER BY revision').all(row.run_id);
        if (changes.length !== row.revision) throw failure();
        for (const [index, change] of changes.entries()) {
          if (change.session_id !== row.session_id || change.revision !== index + 1 || !integer(change.sequence, 1)
            || !STATES.includes(change.state as string) || typeof change.digest !== 'string' || !HEX.test(change.digest) || !timestamp(change.at)) throw failure();
        }
        const last = changes.at(-1);
        if (!last || last.digest !== row.digest || last.state !== row.state) throw failure();
        if (withEvents) {
          const events = this.eventRows(row.session_id, row.run_id);
          if (events.length > MAX_EVENTS) throw failure();
          if (withTotals) {
            const totals = this.db.prepare('SELECT event_count, last_sequence FROM mission_event_totals WHERE run_id = ?').all(row.run_id)[0];
            if (totals?.event_count !== events.length || totals.last_sequence !== (events.at(-1)?.sequence ?? 0)) throw failure();
          }
          const run = JSON.parse(row.payload) as HostMissionRun;
          let first: AgentEvent | undefined, lead: string | undefined;
          for (const [index, eventRow] of events.entries()) {
            if (eventRow.sequence !== index + 1) throw failure();
            const event = this.decodeEvent(eventRow, run);
            if (first && (event.workspaceId !== first.workspaceId || event.sessionId !== first.sessionId)) throw failure();
            first ??= event;
            if (event.body.type === 'mission.state') {
              if (lead && lead !== event.agentId) throw failure();
              lead = event.agentId;
            }
          }
        }
      }
    }
  }

  private assertOpen(): void { if (this.closed) throw failure(); }
  private transaction<T>(operation: () => T): T {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      privateFiles(this.file);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Do not replace the original failure. */ }
      throw error;
    }
  }

  readSession(sessionId: string): HostMissionRun[] | undefined {
    this.assertOpen(); sessionKey(sessionId);
    const session = this.db.prepare('SELECT deleted FROM checkpoint_sessions WHERE session_id = ?').all(sessionId)[0];
    if (!session) return undefined;
    const rows = this.rows(sessionId);
    if (session.deleted === 1 && rows.length) throw failure();
    return this.decodeRows(sessionId, rows);
  }

  /** Includes empty live checkpoints; deletion tombstones remain excluded. */
  sessionIds(): readonly string[] {
    this.assertOpen();
    return this.db.prepare('SELECT session_id FROM checkpoint_sessions WHERE deleted = 0 ORDER BY session_id').all().map(row => {
      if (typeof row.session_id !== 'string') throw failure();
      sessionKey(row.session_id);
      return row.session_id;
    });
  }

  writeSession(sessionId: string, runs: readonly HostMissionRun[], options?: { legacyDigest?: string; event?: AgentEvent }): AgentEvent | undefined {
    this.assertOpen();
    const entries = snapshot(sessionId, runs);
    const legacyDigest = options?.legacyDigest;
    if (legacyDigest !== undefined && (typeof legacyDigest !== 'string' || !HEX.test(legacyDigest))) throw failure();
    const hasEvent = options?.event !== undefined;
    const eventEntry = hasEvent ? entries.find(entry => entry.run.id === options!.event!.missionId) : undefined;
    if (hasEvent && !eventEntry) throw failure();
    const event = hasEvent ? validateMissionJournalEvent(options!.event!, eventEntry!.run) : undefined;
    return this.transaction(() => {
      const session = this.db.prepare('SELECT * FROM checkpoint_sessions WHERE session_id = ?').all(sessionId)[0];
      if (legacyDigest !== undefined && (session?.deleted === 1 || session?.legacy_digest != null && session.legacy_digest !== legacyDigest)) throw failure();
      const previous = this.rows(sessionId);
      const previousRuns = this.decodeRows(sessionId, previous);
      if (event) {
        const duplicate = this.db.prepare('SELECT * FROM mission_events WHERE event_id = ?').all(event.id)[0] as unknown as EventRow | undefined;
        if (duplicate) {
          if (duplicate.session_id !== sessionId || duplicate.run_id !== event.missionId || duplicate.digest !== digest(canonical(event))
            || duplicate.checkpoint_digest !== eventEntry!.digest) throw failure();
          const current = previousRuns.find(run => run.id === event.missionId);
          if (!current) throw failure();
          // A retry of an older acknowledged event never rewinds a newer snapshot.
          return this.decodeEvent(duplicate, current);
        }
      }
      // Historical event attribution must survive subsequent checkpoint-only saves.
      for (const entry of entries) {
        const old = previousRuns.find(run => run.id === entry.run.id);
        if (!old) continue;
        const hasEvents = this.db.prepare('SELECT event_id FROM mission_events WHERE run_id = ? LIMIT 1').all(old.id).length > 0;
        if (hasEvents && canonical(old.tasks.map(task => [task.taskId, task.agentId]).sort()) !== canonical(entry.run.tasks.map(task => [task.taskId, task.agentId]).sort())) throw failure();
      }
      const ids = new Set(entries.map(entry => entry.run.id));
      if (previous.some(row => !ids.has(row.run_id) && unresolved(row.state))) throw new Error('Unresolved mission checkpoints cannot be removed.');
      const at = new Date().toISOString();
      this.db.prepare(`INSERT INTO checkpoint_sessions(session_id, deleted, legacy_digest, updated_at) VALUES (?, 0, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET deleted = 0, legacy_digest = COALESCE(excluded.legacy_digest, checkpoint_sessions.legacy_digest), updated_at = excluded.updated_at`).run(sessionId, legacyDigest ?? null, at);
      for (const row of previous) if (!ids.has(row.run_id)) this.db.prepare('DELETE FROM mission_checkpoints WHERE run_id = ?').run(row.run_id);
      for (const [position, entry] of entries.entries()) {
        const old = this.db.prepare('SELECT * FROM mission_checkpoints WHERE run_id = ?').all(entry.run.id)[0];
        if (old && old.session_id !== sessionId) throw failure();
        if (old?.digest === entry.digest) {
          this.db.prepare('UPDATE mission_checkpoints SET position = ? WHERE run_id = ?').run(position, entry.run.id);
          continue;
        }
        const revision = old ? Number(old.revision) + 1 : 1;
        if (!integer(revision, 1)) throw failure();
        this.db.prepare(`INSERT INTO mission_checkpoints(run_id, session_id, position, revision, state, updated_at, digest, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET position = excluded.position, revision = excluded.revision, state = excluded.state,
            updated_at = excluded.updated_at, digest = excluded.digest, payload = excluded.payload`).run(entry.run.id, sessionId, position, revision, entry.run.state, entry.run.updatedAt, entry.digest, entry.payload);
        this.db.prepare('INSERT INTO mission_changes(session_id, run_id, revision, state, at, digest) VALUES (?, ?, ?, ?, ?, ?)').run(sessionId, entry.run.id, revision, entry.run.state, at, entry.digest);
      }
      // Caps and sequence come from the running totals (schema 3), not journal scans.
      const count = this.sessionTotals(sessionId).changes;
      if (!integer(count, 0) || count > MAX_CHANGES) throw failure();
      if (!event) return undefined;
      const totals = this.db.prepare('SELECT event_count AS count, last_sequence AS last FROM mission_event_totals WHERE run_id = ?').all(event.missionId!)[0];
      // Distinct sequences >= 1 whose maximum equals their count are exactly 1..count.
      if (!totals || !integer(totals.count, 0) || totals.count >= MAX_EVENTS || totals.last !== totals.count) throw failure();
      const firstRow = this.eventRows(sessionId, event.missionId!, 0, 1)[0];
      const first = firstRow ? this.decodeEvent(firstRow, eventEntry!.run) : undefined;
      if (first && (first.workspaceId !== event.workspaceId || first.sessionId !== event.sessionId)) throw failure();
      if (event.body.type === 'mission.state') {
        const leaderRow = this.db.prepare("SELECT * FROM mission_events WHERE run_id = ? AND event_type = 'mission.state' ORDER BY sequence LIMIT 1").all(event.missionId!)[0] as unknown as EventRow | undefined;
        if (leaderRow && this.decodeEvent(leaderRow, eventEntry!.run).agentId !== event.agentId) throw failure();
      }
      const sequence = totals.count + 1;
      const acknowledged = { ...event, sequence };
      const payload = canonical(acknowledged), bytes = Buffer.byteLength(payload);
      if (bytes > MAX_EVENT_BYTES) throw failure();
      const checkpoint = this.db.prepare('SELECT revision, digest FROM mission_checkpoints WHERE run_id = ?').all(event.missionId!)[0];
      if (!checkpoint) throw failure();
      this.db.prepare(`INSERT INTO mission_events(event_id, session_id, run_id, sequence, event_type, checkpoint_revision, checkpoint_digest, digest, encoded_bytes, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(event.id, sessionId, event.missionId!, sequence, event.body.type, Number(checkpoint.revision), checkpoint.digest as string, digest(canonical(event)), bytes, payload);
      const sessionBytes = this.sessionTotals(sessionId).bytes;
      if (!integer(sessionBytes, 0) || sessionBytes > MAX_BYTES) throw failure();
      return acknowledged;
    });
  }

  readEvents(sessionId: string, missionId: string, afterSequence = 0, limit = 100): readonly AgentEvent[] {
    this.assertOpen(); sessionKey(sessionId);
    if (!UUID.test(missionId) || !integer(afterSequence, 0) || !integer(limit, 1) || limit > 1000) throw failure();
    const run = this.readSession(sessionId)?.find(run => run.id === missionId);
    if (!run) return [];
    this.eventBytes(sessionId);
    const stats = this.db.prepare('SELECT count(*) AS count, min(sequence) AS first, max(sequence) AS last FROM mission_events WHERE run_id = ?').all(missionId)[0]!;
    if (!integer(stats.count, 0) || stats.count > MAX_EVENTS || stats.count > 0 && (stats.first !== 1 || stats.last !== stats.count)) throw failure();
    const firstRow = this.eventRows(sessionId, missionId, 0, 1)[0];
    const first = firstRow ? this.decodeEvent(firstRow, run) : undefined;
    const leaderRow = this.db.prepare("SELECT * FROM mission_events WHERE run_id = ? AND event_type = 'mission.state' ORDER BY sequence LIMIT 1").all(missionId)[0] as unknown as EventRow | undefined;
    const leader = leaderRow ? this.decodeEvent(leaderRow, run).agentId : undefined;
    return this.eventRows(sessionId, missionId, afterSequence, limit).map(row => {
      const event = this.decodeEvent(row, run);
      if (first && (event.workspaceId !== first.workspaceId || event.sessionId !== first.sessionId)) throw failure();
      if (event.body.type === 'mission.state' && leader !== event.agentId) throw failure();
      return event;
    });
  }

  removeSession(sessionId: string): void {
    this.assertOpen(); sessionKey(sessionId);
    this.transaction(() => {
      const previous = this.rows(sessionId);
      this.decodeRows(sessionId, previous);
      if (previous.some(row => unresolved(row.state))) throw new Error('Unresolved mission checkpoints cannot be removed.');
      this.db.prepare('DELETE FROM mission_checkpoints WHERE session_id = ?').run(sessionId);
      this.db.prepare(`INSERT INTO checkpoint_sessions(session_id, deleted, legacy_digest, updated_at) VALUES (?, 1, NULL, ?)
        ON CONFLICT(session_id) DO UPDATE SET deleted = 1, updated_at = excluded.updated_at`).run(sessionId, new Date().toISOString());
    });
  }

  changes(sessionId: string, afterSequence = 0, limit = 100): readonly MissionCheckpointChange[] {
    this.assertOpen(); sessionKey(sessionId);
    if (!integer(afterSequence, 0) || !integer(limit, 1) || limit > 1000) throw failure();
    return this.db.prepare('SELECT * FROM mission_changes WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?').all(sessionId, afterSequence, limit).map((row: Row) => ({
      sequence: row.sequence as number, sessionId: row.session_id as string, runId: row.run_id as string,
      revision: row.revision as number, state: row.state as HostMissionRun['state'], at: row.at as string, digest: row.digest as string,
    }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      // A busy reader can prevent truncation. SQLite's committed WAL remains
      // authoritative; never remove it manually or claim the checkpoint succeeded.
      this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
    } catch (error) {
      const sqliteCode = (error as { errcode?: number }).errcode;
      if (sqliteCode !== 5 && sqliteCode !== 6) throw error;
    } finally {
      try { this.db.close(); } finally { privateFiles(this.file); }
    }
  }
}
