import { safeLabel, safeText, type ImportMode, type PortableSession } from '@extalia/core';
import {
  codexThreadSpawn, mergeSubagentSteps, parseAntigravity, parseClaude, parseCodex, parseGemini, parseHermes,
  type CodexThreadSpawn, type NativeParseResult, type NativeSourceId, type ParseContext, type SubagentTranscript, type TranscriptContext, type TranscriptStep,
} from '@extalia/importers';
import type { ImportCandidate, ImportDiagnostic, ImportLocation, ImportScan } from '@extalia/platform';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type * as Sqlite from 'node:sqlite';

/**
 * Read-only discovery of native agent histories in their known locations.
 * Scans index bounded metadata; previews parse only selected sessions and only
 * through opaque ids from a recent scan, so callers can never name a file.
 * Source files and databases are never modified.
 */

const HEADER_BYTES = 128 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/**
 * Live observation of a larger transcript reads its beginning (title, start) and its
 * latest activity only. Step positions stay absolute line numbers, so event ids do
 * not change while the window moves.
 */
const LIVE_FULL_BYTES = 4 * 1024 * 1024;
const LIVE_HEAD_BYTES = 512 * 1024;
const LIVE_TAIL_BYTES = 3 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_CANDIDATES = 500;
const MAX_SELECTION = 50;
const SCAN_TTL_MS = 15 * 60 * 1000;
/** Discovery stats files changed in this window on every poll and a slice of the others. */
const DISCOVERY_HOT_MS = 15 * 60 * 1000;
const DISCOVERY_COLD_PER_POLL = 400;
/** Sub-agent transcripts merged into one observed session (newest first beyond this). */
const MAX_SUBAGENTS = 100;
const MAX_SIDECAR_BYTES = 64 * 1024;
const MAX_THREAD_INDEX_BYTES = 4 * 1024 * 1024;
/** Codex rollout names carry local time; child threads are looked for from a day before their root started. */
const THREAD_SLACK_MS = 26 * 60 * 60 * 1000;

type Row = Record<string, unknown>;
type Kind = 'codex' | 'claude' | 'gemini' | 'antigravity' | 'hermes' | 'binary' | 'unavailable';
interface Location extends ImportLocation { root: string; kind: Kind; sourceId: NativeSourceId | 'antigravity-ide' | 'antigravity-cli' }
interface FileIdentity { size: number; mtime: number; ino: number }
/** `titled` is false when the candidate title is only a placeholder; imports then use the first prompt. */
interface Ref { location: Location; path: string; candidate: ImportCandidate; identity: FileIdentity; titled: boolean; rowFingerprint?: string; spawn?: CodexThreadSpawn }
/** First record of a Codex rollout: its thread id and, for sub-agent threads, how it was spawned. Immutable once written. */
interface ThreadHeader { ino: number; id: string; spawn?: CodexThreadSpawn; cwd?: string; startMs?: number }
interface ParsedSubagent { steps: TranscriptStep[]; model?: string; startedAt?: string }
interface Budget { files: number; limit: number; truncated: boolean }

type SqliteModule = typeof Sqlite;
type Database = InstanceType<SqliteModule['DatabaseSync']>;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, 4096) : undefined;
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

function isoDate(value: unknown, fallback: number): string {
  const n = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : typeof value === 'string' ? Date.parse(value) : NaN;
  return new Date(Number.isFinite(n) ? n : fallback).toISOString();
}

function identity(path: string): FileIdentity {
  const info = statSync(path);
  if (!info.isFile()) throw new Error('Source is not a regular file.');
  return { size: info.size, mtime: info.mtimeMs, ino: Number(info.ino) };
}

const same = (a: FileIdentity, b: FileIdentity) => a.size === b.size && a.mtime === b.mtime && a.ino === b.ino;

/** Start time a Codex rollout name states (`rollout-2026-10-16T17-10-25-<id>.jsonl`, local time). */
function rolloutTime(path: string): number | undefined {
  const match = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(basename(path));
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  const time = new Date(year, month - 1, day, hour, minute, second).getTime();
  return Number.isFinite(time) ? time : undefined;
}

/** Resolve symlinks and require the result to stay inside the history root. */
function contained(root: string, path: string): string {
  const canonicalRoot = realpathSync(root), canonical = realpathSync(path), rel = relative(canonicalRoot, canonical);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Source path escapes its history folder.');
  return canonical;
}

function readBounded(root: string, path: string, max: number): string {
  return readBoundedBuffer(root, path, max).toString('utf8');
}

function readBoundedBuffer(root: string, path: string, max: number): Buffer {
  const canonical = contained(root, path), before = identity(canonical);
  const fd = openSync(canonical, 'r');
  try {
    // Check the opened file too, so a path swapped between realpath and open is caught.
    const opened = fstatSync(fd);
    if (!opened.isFile() || !same(before, { size: opened.size, mtime: opened.mtimeMs, ino: Number(opened.ino) }) || !same(before, identity(contained(root, path)))) throw new Error('Source changed while opening; scan again.');
    const bytes = Buffer.alloc(Math.min(before.size, max));
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/** Read top-level primitive fields of a JSON object without parsing nested message bodies. */
function jsonHeader(input: string, wrapperDepth = 0, wrappers: readonly string[] = ['$set']): Row {
  const row: Row = {};
  let i = 0;
  const skipSpace = () => { while (i < input.length && /\s/.test(input[i] ?? '')) i++; };
  const token = (): string => {
    const start = i++;
    let escaped = false;
    while (i < input.length) { const c = input[i++]; if (c === '"' && !escaped) break; escaped = c === '\\' && !escaped; if (c !== '\\') escaped = false; }
    return input.slice(start, i);
  };
  skipSpace();
  if (input[i++] !== '{') throw new Error('Invalid session metadata.');
  const allowed = new Set(['sessionId', 'session_id', 'id', 'projectHash', 'projectPath', 'cwd', 'title', 'summary', 'startTime', 'lastUpdated', 'timestamp', 'type',
    'parent_thread_id', 'agent_nickname', 'agent_role', 'agent_path', 'thread_source', 'step_index', 'source', 'created_at']);
  while (i < input.length) {
    skipSpace();
    if (input[i] === '}' || input[i] !== '"') break;
    const key = JSON.parse(token()) as string;
    skipSpace();
    if (input[i++] !== ':') break;
    skipSpace();
    if (input[i] === '{' || input[i] === '[') {
      const start = i, wrapper = wrappers.includes(key) && input[i] === '{' && wrapperDepth === 0;
      let depth = 0;
      do { const c = input[i]; if (c === '"') { token(); continue; } if (c === '{' || c === '[') depth++; if (c === '}' || c === ']') depth--; i++; } while (i < input.length && depth > 0);
      if (wrapper) {
        for (const [name, value] of Object.entries(jsonHeader(input.slice(start, i), 1, wrappers))) if (name !== 'type' || row.type === undefined) row[name] = value;
      }
    } else {
      const raw = input[i] === '"' ? token() : (() => { const s = i; while (i < input.length && !/[,}\s]/.test(input[i] ?? '')) i++; return input.slice(s, i); })();
      if (allowed.has(key)) { try { row[key] = JSON.parse(raw); } catch { /* partial bounded metadata */ } }
    }
    skipSpace();
    if (input[i] !== ',') break;
    i++;
  }
  return row;
}

const SESSION_COLUMNS = ['id', 'session_id', 'title', 'source', 'cwd', 'project_path', 'git_repo_root', 'started_at', 'created_at', 'ended_at', 'updated_at', 'last_activity_at', 'message_count'];

function columns(db: Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${quoted(table)})`).all() as Row[]).map(row => String(row.name)));
}

function sessionQuery(db: Database): { fields: string; id: string; order: string } {
  const cols = columns(db, 'sessions');
  const id = cols.has('id') ? 'id' : cols.has('session_id') ? 'session_id' : undefined;
  if (!id) throw new Error('Unsupported Hermes sessions schema.');
  const order = ['last_activity_at', 'updated_at', 'ended_at', 'started_at', 'created_at'].find(column => cols.has(column)) ?? id;
  const fields = SESSION_COLUMNS.filter(column => cols.has(column)).map(column => `CASE WHEN typeof(${quoted(column)}) = 'text' THEN substr(${quoted(column)}, 1, 4096) ELSE ${quoted(column)} END AS ${quoted(column)}`).join(', ');
  return { fields, id, order };
}

export interface NativeImportOptions {
  homeDirectory: string;
  env: Readonly<Record<string, string | undefined>>;
  now?: () => number;
}

export interface NativePreview {
  sessions: { candidateId: string; session: PortableSession; steps?: TranscriptStep[]; model?: string; context?: TranscriptContext }[];
  diagnostics: ImportDiagnostic[];
}

/** Host-only reference pinned by a selected preview. Never accepted as a UI argument. */
export interface NativeObservationRef { locationId: string; sourceId: string; nativeSessionId: string; path: string }

/**
 * A transcript read for live observation: the conversation and its structured
 * activity, including the activity of its sub-agents (Claude Code subagent
 * files, Codex threads it spawned), and the lead's latest model.
 */
export interface ObservedRead { session: PortableSession; steps: TranscriptStep[]; model?: string; context?: TranscriptContext }

/** A session whose source changed after `since`, found by automatic discovery. */
export interface DiscoveredSession { reference: NativeObservationRef; updatedAt: number; projectPath?: string }

interface DiscoveryCache {
  dirs: Map<string, { stamp: string; entries: { name: string; dir: boolean }[] }>;
  files: Map<string, { mtime: number; ino: number; header?: { nativeSessionId: string; projectPath?: string; child?: boolean } }>;
  cursor: number;
  dbStamp?: string;
  dbFound?: { nativeSessionId: string; updatedAt: number }[];
}

export class NativeImportService {
  private readonly snapshots = new Map<string, { at: number; refs: Map<string, Ref> }>();
  private readonly observationLocations = new Map<string, Location>();
  private readonly discoveryCaches = new Map<string, DiscoveryCache>();
  private readonly threadListings = new Map<string, DiscoveryCache>();
  private readonly threadHeaders = new Map<string, ThreadHeader>();
  private readonly threadFileMemo = new Map<string, { at: number; files: string[] }>();
  private readonly subagentReads = new Map<string, { stamp: string; value: ParsedSubagent }>();
  private readonly lineCounts = new Map<string, { ino: number; position: number; lines: number }>();
  private threadNames?: { stamp: string; names: Map<string, string> };
  private readonly now: () => number;

  private constructor(private readonly options: NativeImportOptions, private readonly sqlite: SqliteModule | undefined) {
    this.now = options.now ?? Date.now;
  }

  /** `node:sqlite` is loaded lazily so hosts without it still import file-based histories. */
  static async create(options: NativeImportOptions): Promise<NativeImportService> {
    let sqlite: SqliteModule | undefined;
    try { sqlite = await import('node:sqlite'); } catch { sqlite = undefined; }
    return new NativeImportService(options, sqlite);
  }

  locations(): ImportLocation[] {
    return this.knownLocations().map(({ root: _root, kind: _kind, ...location }) => location);
  }

  private knownLocations(): Location[] {
    const { env, homeDirectory: home } = this.options;
    const locations: Location[] = [];
    const add = (sourceId: Location['sourceId'], label: string, root: string, path: string, kind: Kind, format: string, profile?: string, note?: string) => {
      let available = false;
      try { contained(root, path); available = statSync(path).isDirectory() || (kind === 'hermes' && statSync(path).isFile()); } catch { /* missing or unsafe */ }
      let supported = kind !== 'binary' && kind !== 'unavailable';
      if (kind === 'hermes' && !this.sqlite) { supported = false; note = 'Reading Hermes history needs Node.js 22.13 or newer.'; }
      locations.push({ id: `loc-${digest(`${sourceId}:${profile ?? ''}:${path}`).slice(0, 20)}`, sourceId, label, root, path, kind, format, available, supported, ...(profile ? { profile } : {}), ...(note ? { note } : {}) });
    };
    const codex = env.CODEX_HOME || join(home, '.codex');
    add('codex', 'Codex', codex, join(codex, 'sessions'), 'codex', 'JSONL');
    add('codex', 'Codex (archived)', codex, join(codex, 'archived_sessions'), 'codex', 'JSONL');
    const claude = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
    add('claude-code', 'Claude Code', claude, join(claude, 'projects'), 'claude', 'JSONL');
    const hermes = env.HERMES_HOME || join(home, '.hermes');
    add('hermes', 'Hermes Agent', hermes, join(hermes, 'state.db'), 'hermes', 'SQLite', 'default');
    try {
      const profiles = join(hermes, 'profiles');
      contained(hermes, profiles);
      for (const entry of readdirSync(profiles, { withFileTypes: true }).slice(0, 100)) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const profileRoot = join(profiles, entry.name);
        try { contained(hermes, profileRoot); } catch { continue; }
        add('hermes', 'Hermes Agent', hermes, join(profileRoot, 'state.db'), 'hermes', 'SQLite', entry.name);
      }
    } catch { /* no profiles */ }
    const gemini = join(home, '.gemini');
    add('gemini-cli', 'Gemini CLI', gemini, join(gemini, 'tmp'), 'gemini', 'JSON / JSONL');
    const sandbox = join(home, '.cache', '.gemini');
    if (existsSync(join(sandbox, 'tmp'))) add('gemini-cli', 'Gemini CLI (sandbox)', sandbox, join(sandbox, 'tmp'), 'gemini', 'JSON / JSONL');
    const antigravity = join(gemini, 'antigravity');
    add('antigravity', 'Antigravity', antigravity, join(antigravity, 'brain'), 'antigravity', 'JSONL');
    add('antigravity-ide', 'Antigravity IDE', antigravity, join(antigravity, 'conversations'), 'binary', 'Protocol Buffers', undefined, 'Conversations are detected, but this version cannot read their binary format.');
    locations.push({ id: 'loc-antigravity-cli', sourceId: 'antigravity-cli', label: 'Antigravity CLI', root: '', path: '', kind: 'unavailable', available: false, supported: false, format: 'Unknown', note: 'No verified history format or location is known yet.' });
    return locations;
  }

  scan(locationIds?: readonly string[]): ImportScan {
    if (locationIds && (locationIds.length > 200 || locationIds.some(id => typeof id !== 'string'))) throw new Error('Invalid location selection.');
    this.prune();
    const all = this.knownLocations();
    if (locationIds?.some(id => !all.some(location => location.id === id || location.sourceId === id))) throw new Error('Unknown history location.');
    const scanId = randomUUID();
    const result: ImportScan = { scanId, sessions: [], diagnostics: [], truncated: false };
    const diagnostic = (location: Location, message: string) => { if (result.diagnostics.length < 100) result.diagnostics.push({ locationId: location.id, message }); };
    const latest = new Map<string, Ref>();
    const collect = (ref: Ref) => {
      // Codex sub-agent threads belong to the session that spawned them.
      if (ref.spawn) return;
      const key = `${ref.location.sourceId}:${ref.location.profile ?? ''}:${ref.candidate.nativeSessionId}`;
      const previous = latest.get(key);
      if (!previous || Date.parse(ref.candidate.updatedAt) > Date.parse(previous.candidate.updatedAt)) latest.set(key, ref);
    };
    const selected = all.filter(location => !locationIds || locationIds.includes(location.id) || locationIds.includes(location.sourceId));
    const quota = Math.floor(MAX_FILES / Math.max(1, selected.filter(location => location.available).length));
    const iterators: { location: Location; iterator: Generator<Ref>; budget: Budget }[] = [];
    for (const location of selected) {
      if (!location.available) { if (locationIds) diagnostic(location, location.note ?? 'This history location was not found.'); continue; }
      if (!location.supported && location.kind === 'hermes') { diagnostic(location, location.note ?? 'Unsupported.'); continue; }
      const budget: Budget = { files: 0, limit: quota, truncated: false };
      iterators.push({ location, budget, iterator: location.kind === 'hermes' ? this.scanHermes(location, budget, diagnostic) : this.fileRefs(location, budget, diagnostic) });
    }
    try {
      // Take one record from each location in turn so one large history never hides the others.
      while (iterators.length && latest.size < MAX_CANDIDATES) {
        for (let i = 0; i < iterators.length && latest.size < MAX_CANDIDATES;) {
          const entry = iterators[i]!;
          try {
            const next = entry.iterator.next();
            result.truncated ||= entry.budget.truncated;
            if (next.done) { iterators.splice(i, 1); continue; }
            collect(next.value);
            i++;
          } catch (error) {
            diagnostic(entry.location, error instanceof Error ? error.message : 'Unable to scan this location.');
            iterators.splice(i, 1);
          }
        }
      }
      if (iterators.length) result.truncated = true;
    } finally {
      for (const entry of iterators) entry.iterator.return(undefined as never);
    }
    const refs = new Map<string, Ref>();
    for (const ref of latest.values()) { refs.set(ref.candidate.id, ref); result.sessions.push(ref.candidate); }
    result.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.snapshots.set(scanId, { at: this.now(), refs });
    while (this.snapshots.size > 5) this.snapshots.delete(this.snapshots.keys().next().value!);
    return result;
  }

  private *fileRefs(location: Location, budget: Budget, diagnostic: (location: Location, message: string) => void): Generator<Ref> {
    const files = [...this.files(location, budget, diagnostic)]
      .map(path => ({ path, mtime: (() => { try { return identity(contained(location.path, path)).mtime; } catch { return 0; } })() }))
      .sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path));
    for (const { path } of files) {
      try { yield this.fileRef(location, path); }
      catch (error) { diagnostic(location, `${basename(path)}: ${error instanceof Error ? error.message : 'Unreadable session.'}`); }
    }
  }

  private *files(location: Location, budget: Budget, diagnostic: (location: Location, message: string) => void): Generator<string> {
    const visit = function* (root: string, folder: string, depth: number): Generator<string> {
      if (depth > 8 || budget.files >= budget.limit) { budget.truncated = true; return; }
      try { contained(root, folder); } catch { diagnostic(location, 'Ignored a folder that escapes the history root.'); return; }
      let entries;
      try { entries = readdirSync(folder, { withFileTypes: true }); } catch { diagnostic(location, 'Unreadable history folder.'); return; }
      for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
        if (++budget.files > budget.limit) { budget.truncated = true; return; }
        const path = join(folder, entry.name);
        try {
          contained(root, path);
          const info = statSync(path);
          if (info.isDirectory()) { if (location.kind === 'codex' && /^\d{2,4}$/.test(entry.name)) yield* visit(root, path, depth + 1); }
          else if (info.isFile() && (location.kind === 'binary' ? entry.name.endsWith('.pb') : entry.name.endsWith('.jsonl'))) yield path;
        } catch { diagnostic(location, 'Ignored an unreadable file or a link that escapes the history root.'); }
      }
    };
    if (location.kind === 'antigravity') {
      for (const conv of readdirSync(contained(location.root, location.path), { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name))) {
        if (++budget.files > budget.limit) { budget.truncated = true; return; }
        if (!conv.isDirectory() && !conv.isSymbolicLink()) continue;
        const path = join(location.path, conv.name, '.system_generated', 'logs', 'transcript.jsonl');
        try {
          if (!existsSync(path)) continue;
          contained(location.path, path);
          if (statSync(path).isFile()) yield path;
        } catch { diagnostic(location, 'Ignored an unreadable Antigravity transcript.'); }
      }
    } else if (location.kind === 'claude' || location.kind === 'gemini') {
      // Claude: projects/<project>/*.jsonl (subagent files excluded). Gemini: tmp/<project>/chats/session-*.
      for (const project of readdirSync(contained(location.root, location.path), { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name))) {
        if (++budget.files > budget.limit) { budget.truncated = true; return; }
        const projectPath = join(location.path, project.name);
        try {
          contained(location.path, projectPath);
          if (!statSync(projectPath).isDirectory()) continue;
          const folder = location.kind === 'gemini' ? join(projectPath, 'chats') : projectPath;
          if (!existsSync(folder)) continue;
          contained(location.path, folder);
          for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name))) {
            if (++budget.files > budget.limit) { budget.truncated = true; return; }
            if (location.kind === 'claude' ? !entry.name.endsWith('.jsonl') || entry.name.startsWith('agent-') : !/^session-.*\.jsonl?$/.test(entry.name)) continue;
            const path = join(folder, entry.name);
            contained(location.path, path);
            if (statSync(path).isFile()) yield path;
          }
        } catch { diagnostic(location, 'Ignored an unreadable project history.'); }
      }
    } else {
      yield* visit(location.path, location.path, 0);
    }
  }

  private fileRef(location: Location, path: string): Ref {
    contained(location.root, location.path);
    const canonical = contained(location.path, path), fileIdentity = identity(canonical);
    const large = fileIdentity.size > MAX_FILE_BYTES;
    let meta: Row = {}, spawn: CodexThreadSpawn | undefined;
    if (location.kind !== 'binary') {
      const head = readBounded(location.path, path, HEADER_BYTES);
      if (location.kind === 'gemini' && path.endsWith('.json')) meta = jsonHeader(head);
      else {
        for (const line of head.split('\n').slice(0, 100)) {
          if (!line.trim()) continue;
          try {
            const wrappers = location.kind === 'codex' ? ['payload'] : location.kind === 'gemini' ? ['$set', 'payload', 'data'] : [];
            const header = jsonHeader(line, 0, wrappers);
            if (location.kind === 'codex' && header.type === 'session_meta') {
              meta = header;
              try { spawn = codexThreadSpawn((JSON.parse(line) as Row).payload); } catch { spawn = codexThreadSpawn(header); }
              break;
            }
            if (location.kind === 'gemini' && header.type === 'metadata') { meta = header; break; }
            for (const [key, value] of Object.entries(header)) if (value !== undefined) meta[key] = value;
            if (location.kind === 'claude' && text(meta.sessionId) && text(meta.cwd)) break;
            if (location.kind === 'gemini' && text(meta.sessionId) && text(meta.projectHash)) break;
            if (location.kind === 'antigravity' && !text(meta.title) && header.type === 'USER_INPUT') {
              try {
                const row = JSON.parse(line) as Row;
                const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(String(row.content ?? ''));
                const prompt = (match ? match[1]! : String(row.content ?? '')).trim().split(/\r?\n/)[0]?.trim();
                if (prompt) meta.title = safeLabel(prompt, 160);
              } catch { /* ignore */ }
            }
          } catch { /* skip truncated or non-metadata lines */ }
        }
      }
      if (!Object.keys(meta).length || (location.kind === 'codex' && !text(meta.id))) throw new Error('Missing or malformed session metadata.');
    }
    const antigravityId = location.kind === 'antigravity' ? basename(join(path, '..', '..', '..')) : undefined;
    // A Codex sub-agent thread names its root in `session_id`; its own id is the thread id.
    const nativeSessionId = (location.kind === 'codex' ? text(meta.id) : antigravityId) ?? text(meta.sessionId) ?? text(meta.session_id) ?? text(meta.id) ?? basename(path).replace(/\.(jsonl?|pb)$/, '');
    const rawProject = text(meta.cwd) ?? text(meta.projectPath) ?? (location.kind === 'gemini' ? this.geminiProject(location, path) : undefined);
    const mutableTime = location.kind === 'gemini' ? Date.parse(isoDate(meta.lastUpdated, fileIdentity.mtime)) : fileIdentity.mtime;
    const candidate: ImportCandidate = {
      id: randomUUID(), sourceId: location.sourceId, locationId: location.id, sourceName: location.label, nativeSessionId,
      title: safeLabel(text(meta.title) ?? text(meta.summary) ?? `${location.label} · ${nativeSessionId.slice(0, 24)}`, 160),
      updatedAt: new Date(Math.max(fileIdentity.mtime, mutableTime)).toISOString(), format: location.format, supported: location.supported,
      ...(location.profile ? { profile: location.profile } : {}),
      ...(rawProject ? { projectPath: safeText(rawProject, 2000) } : {}),
      ...(location.note || large ? { note: large ? 'Larger than 25 MB: its latest activity can be observed, but it cannot be imported.' : location.note } : {}),
    };
    if (!same(fileIdentity, identity(contained(location.path, path)))) throw new Error('The session changed during the scan; scan again.');
    return { location, path, candidate, identity: fileIdentity, titled: Boolean(text(meta.title) ?? text(meta.summary)), ...(spawn ? { spawn } : {}) };
  }

  /** Gemini stores sessions by project hash; only verified markers map them to a folder. */
  private geminiProject(location: Location, path: string): string | undefined {
    const projectFolder = join(path, '..', '..');
    try {
      const marker = join(projectFolder, '.project_root');
      if (identity(contained(location.root, marker)).size <= 8192) {
        const project = readBounded(location.root, marker, 8192).trim();
        if (isAbsolute(project)) return project;
      }
    } catch { /* optional */ }
    const folderId = basename(projectFolder);
    for (const root of [location.root, join(this.options.homeDirectory, '.gemini')]) {
      try {
        const registryPath = join(root, 'projects.json');
        if (identity(contained(root, registryPath)).size > 1024 * 1024) continue;
        const registry = JSON.parse(readBounded(root, registryPath, 1024 * 1024)) as Row;
        if (!registry.projects || typeof registry.projects !== 'object' || Array.isArray(registry.projects)) continue;
        for (const [project, slug] of Object.entries(registry.projects as Row)) {
          if (isAbsolute(project) && (slug === folderId || digest(project) === folderId)) return project;
        }
      } catch { /* a hash alone never becomes a path */ }
    }
    return undefined;
  }

  private database(location: Location): Database {
    if (!this.sqlite) throw new Error('Reading Hermes history needs Node.js 22.13 or newer.');
    const path = contained(location.root, location.path);
    identity(path);
    for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(`${location.path}${suffix}`)) contained(location.root, `${location.path}${suffix}`);
    const db = new this.sqlite.DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only = ON');
    return db;
  }

  private *scanHermes(location: Location, budget: Budget, diagnostic: (location: Location, message: string) => void): Generator<Ref> {
    const db = this.database(location);
    try {
      const query = sessionQuery(db);
      const rows = db.prepare(`SELECT ${query.fields} FROM sessions ORDER BY ${quoted(query.order)} DESC LIMIT ?`).all(MAX_CANDIDATES + 1) as Row[];
      if (rows.length > MAX_CANDIDATES) budget.truncated = true;
      for (const row of rows.slice(0, MAX_CANDIDATES)) {
        const nativeSessionId = text(row[query.id]);
        if (!nativeSessionId) { diagnostic(location, 'Ignored a Hermes session without an id.'); continue; }
        const fileIdentity = identity(contained(location.root, location.path));
        const project = text(row.cwd) ?? text(row.project_path) ?? text(row.git_repo_root);
        yield {
          location, path: location.path, identity: fileIdentity, titled: Boolean(text(row.title)), rowFingerprint: digest(JSON.stringify(row)),
          candidate: {
            id: randomUUID(), sourceId: 'hermes', locationId: location.id, sourceName: location.label, nativeSessionId,
            title: safeLabel(text(row.title) ?? `Hermes · ${nativeSessionId.slice(0, 24)}`, 160),
            updatedAt: isoDate(row.last_activity_at ?? row.updated_at ?? row.ended_at ?? row.started_at ?? row.created_at, fileIdentity.mtime),
            format: 'SQLite', supported: true,
            ...(location.profile ? { profile: location.profile } : {}),
            ...(project ? { projectPath: safeText(project, 2000) } : {}),
          },
        };
      }
    } finally {
      db.close();
    }
  }

  observation(scanId: string, candidateId: string): { reference: NativeObservationRef } & ObservedRead {
    this.threadFileMemo.clear();
    const picked = this.snapshots.get(scanId)?.refs.get(candidateId);
    if (picked?.spawn) {
      // Observing a Codex sub-agent thread observes the session that spawned it.
      const root = this.codexRoot(picked.location, picked.path);
      if (!root) throw new Error('The session that started this sub-agent was not found.');
      this.observationLocations.set(picked.location.id, picked.location);
      const reference = { locationId: picked.location.id, sourceId: picked.location.sourceId, nativeSessionId: root.id, path: root.path };
      return { reference, ...this.readObservation(reference) };
    }
    const preview = this.preview(scanId, [candidateId], 'linked', true);
    const entry = preview.sessions[0];
    const ref = this.snapshots.get(scanId)?.refs.get(candidateId);
    if (!ref || !entry) throw new Error(preview.diagnostics[0]?.message ?? 'This transcript cannot be observed. Scan again.');
    this.observationLocations.set(ref.location.id, ref.location);
    return { reference: { locationId: ref.location.id, sourceId: ref.location.sourceId, nativeSessionId: ref.candidate.nativeSessionId, path: ref.path }, ...this.observedRead(ref, entry) };
  }

  /**
   * The session a Codex sub-agent thread belongs to (its root thread), with the
   * sub-agent's thread id; any other reference is returned unchanged. Metadata only.
   */
  rootReference(reference: NativeObservationRef): NativeObservationRef & { subagentId?: string } {
    this.threadFileMemo.clear();
    try {
      if (!reference.path) return reference;
      const location = this.observationLocation(reference);
      if (location.kind !== 'codex') return reference;
      const header = this.codexHeader(location, reference.path);
      if (!header?.spawn) return reference;
      const root = this.codexRoot(location, reference.path);
      return root ? { locationId: reference.locationId, sourceId: reference.sourceId, nativeSessionId: root.id, path: root.path, subagentId: header.id } : reference;
    } catch { return reference; }
  }

  /**
   * The transcript an agent app's hook names for a session, as an observation
   * reference, only when it lies inside a known history location of that app
   * (symlinks resolved) and has a supported transcript name. Hermes keeps every
   * session of a profile in its `state.db`, so the profile picks the location.
   * Nothing is read beyond file metadata.
   */
  hookReference(sourceId: string, nativeSessionId: string, transcriptPath?: string, profile?: string): NativeObservationRef | undefined {
    for (const location of this.knownLocations()) {
      if (location.sourceId !== sourceId || !location.supported || !location.available) continue;
      try {
        if (location.kind === 'hermes') {
          if ((location.profile ?? 'default') !== (profile || 'default')) continue;
          const reference = { locationId: location.id, sourceId, nativeSessionId, path: location.path };
          this.observationLocation(reference);
          return reference;
        }
        if (!transcriptPath || !isAbsolute(transcriptPath)) continue;
        const reference = { locationId: location.id, sourceId, nativeSessionId, path: transcriptPath };
        this.observationLocation(reference);
        return reference;
      } catch { /* outside this location, or not created yet */ }
    }
    return undefined;
  }

  /** Locations whose new sessions can be watched automatically (readable transcript formats only). */
  autoWatchable(locationId: string): boolean {
    const location = this.knownLocations().find(item => item.id === locationId);
    return Boolean(location?.supported && ['codex', 'claude', 'gemini', 'antigravity', 'hermes'].includes(location.kind));
  }

  /**
   * Sessions of the given locations whose source changed after `since` (epoch ms),
   * newest first, at most `limit` per location. Metadata only: directory listings
   * are reused while a folder is unchanged, recently changed files are checked on
   * every call and older ones in a rotating slice; a file's header is read once to
   * learn its session id. Unknown, missing or unsupported locations are skipped.
   */
  discover(locationIds: readonly string[], since: number, limit = 24): DiscoveredSession[] {
    this.threadFileMemo.clear();
    const found: DiscoveredSession[] = [];
    const locations = this.knownLocations();
    for (const locationId of locationIds) {
      const location = locations.find(item => item.id === locationId);
      if (!location?.available || !this.autoWatchable(locationId)) continue;
      let cache = this.discoveryCaches.get(locationId);
      if (!cache) { cache = { dirs: new Map(), files: new Map(), cursor: 0 }; this.discoveryCaches.set(locationId, cache); }
      try {
        if (location.kind === 'hermes') found.push(...this.discoverHermes(location, cache, since, limit));
        else found.push(...this.discoverFiles(location, cache, since, limit));
      } catch { /* an unreadable location is retried on the next poll */ }
    }
    return found;
  }

  private listing(cache: DiscoveryCache, root: string, folder: string): { name: string; dir: boolean }[] {
    const info = statSync(folder), stamp = `${info.ino}:${info.mtimeMs}:${info.ctimeMs}`;
    const cached = cache.dirs.get(folder);
    if (cached?.stamp === stamp) return cached.entries;
    contained(root, folder);
    const entries = readdirSync(folder, { withFileTypes: true }).slice(0, MAX_FILES).flatMap((entry: Dirent) => {
      if (entry.isDirectory()) return [{ name: entry.name, dir: true }];
      if (entry.isFile()) return [{ name: entry.name, dir: false }];
      if (!entry.isSymbolicLink()) return [];
      try { const path = join(folder, entry.name); contained(root, path); return [{ name: entry.name, dir: statSync(path).isDirectory() }]; } catch { return []; }
    });
    cache.dirs.set(folder, { stamp, entries });
    return entries;
  }

  private candidateFiles(location: Location, cache: DiscoveryCache): string[] {
    const files: string[] = [], root = location.path, folders = new Set<string>();
    const list = (folder: string) => { folders.add(folder); return this.listing(cache, root, folder); };
    const visit = (folder: string, depth: number) => {
      for (const entry of list(folder)) {
        if (files.length >= MAX_FILES) return;
        if (entry.dir) { if (depth < 8 && /^\d{2,4}$/.test(entry.name)) visit(join(folder, entry.name), depth + 1); }
        else if (entry.name.endsWith('.jsonl')) files.push(join(folder, entry.name));
      }
    };
    contained(location.root, location.path);
    if (location.kind === 'codex') visit(root, 0);
    else if (location.kind === 'antigravity') {
      for (const conv of list(root)) {
        if (!conv.dir || files.length >= MAX_FILES) continue;
        const folder = join(root, conv.name, '.system_generated', 'logs');
        let entries;
        try { entries = list(folder); } catch { continue; }
        for (const entry of entries) {
          if (!entry.dir && entry.name === 'transcript.jsonl') files.push(join(folder, entry.name));
        }
      }
    } else for (const project of list(root)) {
      if (!project.dir || files.length >= MAX_FILES) continue;
      const folder = location.kind === 'gemini' ? join(root, project.name, 'chats') : join(root, project.name);
      let entries;
      try { entries = list(folder); } catch { continue; }
      for (const entry of entries) {
        if (entry.dir || files.length >= MAX_FILES) continue;
        if (location.kind === 'claude' ? entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent-') : /^session-.*\.jsonl?$/.test(entry.name)) files.push(join(folder, entry.name));
      }
    }
    for (const folder of cache.dirs.keys()) if (!folders.has(folder)) cache.dirs.delete(folder);
    return files;
  }

  private discoverFiles(location: Location, cache: DiscoveryCache, since: number, limit: number): DiscoveredSession[] {
    const files = this.candidateFiles(location, cache), present = new Set(files), hot = this.now() - DISCOVERY_HOT_MS;
    for (const path of cache.files.keys()) if (!present.has(path)) cache.files.delete(path);
    const due: string[] = [], cold: string[] = [];
    for (const path of files) { const seen = cache.files.get(path); (!seen || seen.mtime >= hot ? due : cold).push(path); }
    if (cold.length) {
      const start = cache.cursor % cold.length;
      due.push(...cold.slice(start, start + DISCOVERY_COLD_PER_POLL));
      if (start + DISCOVERY_COLD_PER_POLL > cold.length) due.push(...cold.slice(0, start + DISCOVERY_COLD_PER_POLL - cold.length));
      cache.cursor = start + DISCOVERY_COLD_PER_POLL;
    }
    for (const path of due) {
      try {
        const info = statSync(path);
        if (!info.isFile()) { cache.files.delete(path); continue; }
        const previous = cache.files.get(path), ino = Number(info.ino);
        cache.files.set(path, { mtime: info.mtimeMs, ino, ...(previous?.ino === ino && previous.header ? { header: previous.header } : {}) });
      } catch { cache.files.delete(path); }
    }
    const recent = [...cache.files.entries()].filter(([, seen]) => seen.mtime > since).sort((a, b) => b[1].mtime - a[1].mtime).slice(0, limit);
    const result = new Map<string, DiscoveredSession>();
    for (const [path, seen] of recent) {
      if (!seen.header) {
        try {
          const ref = this.fileRef(location, path);
          seen.header = { nativeSessionId: ref.candidate.nativeSessionId, ...(ref.candidate.projectPath ? { projectPath: ref.candidate.projectPath } : {}), ...(ref.spawn ? { child: true } : {}) };
        } catch { continue; }
      }
      let reference: NativeObservationRef = { locationId: location.id, sourceId: location.sourceId, nativeSessionId: seen.header.nativeSessionId, path };
      let projectPath = seen.header.projectPath;
      if (seen.header.child) {
        // A sub-agent thread's activity belongs to the session that spawned it.
        const root = this.codexRoot(location, path);
        if (!root) continue;
        reference = { ...reference, nativeSessionId: root.id, path: root.path };
        projectPath = this.codexHeader(location, root.path)?.cwd ?? projectPath;
      }
      const key = reference.nativeSessionId, previous = result.get(key);
      if (!previous || previous.updatedAt < seen.mtime) result.set(key, { reference, updatedAt: Math.max(seen.mtime, previous?.updatedAt ?? 0), ...(projectPath ? { projectPath } : {}) });
    }
    return [...result.values()];
  }

  private discoverHermes(location: Location, cache: DiscoveryCache, since: number, limit: number): DiscoveredSession[] {
    const stamp = this.observationRevision({ locationId: location.id, sourceId: location.sourceId, nativeSessionId: '', path: location.path });
    if (stamp !== cache.dbStamp || !cache.dbFound) {
      const db = this.database(location);
      try {
        const cols = columns(db, 'messages'), latest = new Map<string, number>();
        if (cols.has('session_id') && cols.has('timestamp')) {
          // Insertion order: the newest rows name the sessions that are active now.
          for (const row of db.prepare('SELECT session_id, timestamp FROM messages ORDER BY rowid DESC LIMIT 1000').all() as Row[]) {
            const id = text(row.session_id), at = Date.parse(isoDate(row.timestamp, 0));
            if (id && at > (latest.get(id) ?? -Infinity)) latest.set(id, at);
          }
        } else {
          const query = sessionQuery(db);
          for (const row of db.prepare(`SELECT ${query.fields} FROM sessions ORDER BY ${quoted(query.order)} DESC LIMIT ?`).all(limit) as Row[]) {
            const id = text(row[query.id]);
            if (id) latest.set(id, Date.parse(isoDate(row[query.order], 0)));
          }
        }
        cache.dbFound = [...latest.entries()].map(([nativeSessionId, updatedAt]) => ({ nativeSessionId, updatedAt }));
        cache.dbStamp = stamp;
      } finally { db.close(); }
    }
    return cache.dbFound.filter(item => item.updatedAt > since).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
      .map(item => ({ reference: { locationId: location.id, sourceId: location.sourceId, nativeSessionId: item.nativeSessionId, path: location.path }, updatedAt: item.updatedAt }));
  }

  private observationLocation(reference: NativeObservationRef): Location {
    const location = this.observationLocations.get(reference.locationId) ?? this.knownLocations().find(item => item.id === reference.locationId);
    if (!location || location.sourceId !== reference.sourceId || !location.supported || location.kind === 'binary' || location.kind === 'unavailable') throw new Error('The selected history source is unavailable.');
    if (typeof reference.path !== 'string' || typeof reference.nativeSessionId !== 'string' || reference.nativeSessionId.length > 4096) throw new Error('Invalid observed session reference.');
    contained(location.root, location.path);
    if (location.kind === 'hermes') {
      if (contained(location.root, reference.path) !== contained(location.root, location.path)) throw new Error('The observed database does not match its source.');
    } else {
      if (!(location.kind === 'gemini' ? /^session-.*\.jsonl?$/.test(basename(reference.path)) : location.kind === 'antigravity' ? basename(reference.path) === 'transcript.jsonl' : reference.path.endsWith('.jsonl'))) throw new Error('The observed path is not a supported transcript.');
      contained(location.path, reference.path);
    }
    this.observationLocations.set(location.id, location);
    return location;
  }

  /** Metadata only. WAL changes invalidate Hermes snapshots even when its session row stays unchanged. */
  observationRevision(reference: NativeObservationRef): string {
    this.threadFileMemo.clear();
    const location = this.observationLocation(reference);
    const root = location.kind === 'hermes' ? location.root : location.path;
    const stamp = (path: string) => {
      const canonical = contained(root, path), info = statSync(canonical, { bigint: true });
      if (!info.isFile()) throw new Error('The observed source is not a regular file.');
      return [canonical, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String);
    };
    const stamps = [stamp(reference.path)];
    if (location.kind === 'claude' || location.kind === 'codex') {
      for (const path of this.relatedFiles(location, reference)) { try { stamps.push(stamp(path)); } catch { /* removed meanwhile */ } }
    }
    if (location.kind === 'hermes') for (const suffix of ['-wal', '-journal', '-shm']) {
      const sidecar = `${location.path}${suffix}`;
      if (!existsSync(sidecar)) continue;
      // Validate shared-memory links too; its lock bookkeeping is not a transcript change.
      if (suffix === '-shm') contained(root, sidecar); else stamps.push(stamp(sidecar));
    }
    return digest(JSON.stringify(stamps));
  }

  readObservation(reference: NativeObservationRef): ObservedRead {
    this.threadFileMemo.clear();
    const location = this.observationLocation(reference);
    let ref: Ref;
    if (location.kind === 'hermes') {
      const db = this.database(location);
      try {
        const query = sessionQuery(db);
        const row = db.prepare(`SELECT ${query.fields} FROM sessions WHERE ${quoted(query.id)} = ?`).get(reference.nativeSessionId) as Row | undefined;
        if (!row) throw new Error('The selected native session no longer exists.');
        const info = identity(contained(location.root, location.path));
        const project = text(row.cwd) ?? text(row.project_path) ?? text(row.git_repo_root);
        ref = { location, path: location.path, identity: info, titled: Boolean(text(row.title)), rowFingerprint: digest(JSON.stringify(row)),
          candidate: { id: randomUUID(), sourceId: location.sourceId, locationId: location.id, sourceName: location.label,
            nativeSessionId: reference.nativeSessionId, title: safeLabel(text(row.title) ?? `${location.label} · ${reference.nativeSessionId.slice(0, 24)}`, 160),
            updatedAt: isoDate(row.updated_at ?? row.started_at, info.mtime), format: location.format, supported: true,
            ...(project ? { projectPath: safeText(project, 2000) } : {}), ...(location.profile ? { profile: location.profile } : {}) } };
      } finally { db.close(); }
    } else {
      ref = this.fileRef(location, reference.path);
      if (ref.candidate.nativeSessionId !== reference.nativeSessionId) throw new Error('The source file now belongs to another session.');
    }
    const scanId = randomUUID();
    this.snapshots.set(scanId, { at: this.now(), refs: new Map([[ref.candidate.id, ref]]) });
    try {
      const preview = this.preview(scanId, [ref.candidate.id], 'linked', true);
      if (!preview.sessions[0]) throw new Error(preview.diagnostics[0]?.message ?? 'This transcript is not readable yet.');
      return this.observedRead(ref, preview.sessions[0]);
    } finally { this.snapshots.delete(scanId); }
  }

  /** `withSteps` keeps the structured activity for live observation; previews for the UI leave it out. */
  preview(scanId: string, candidateIds: readonly string[], mode: ImportMode = 'imported', withSteps = false): NativePreview {
    this.prune();
    const snapshot = this.snapshots.get(scanId);
    if (!snapshot) throw new Error('This scan expired; scan again.');
    if (!Array.isArray(candidateIds) || candidateIds.length > MAX_SELECTION || candidateIds.some(id => typeof id !== 'string') || (mode !== 'imported' && mode !== 'linked')) {
      throw new Error(`Select at most ${MAX_SELECTION} sessions.`);
    }
    if (candidateIds.some(id => !snapshot.refs.has(id))) throw new Error('Unknown session selection; scan again.');
    const result: NativePreview = { sessions: [], diagnostics: [] };
    let bytes = 0;
    for (const id of new Set(candidateIds)) {
      const ref = snapshot.refs.get(id)!;
      const add = (message: string) => result.diagnostics.push({ locationId: ref.location.id, candidateId: id, message });
      if (!ref.candidate.supported) { add(ref.candidate.note ?? 'This format is not supported yet.'); continue; }
      try {
        const context = {
          sourceId: ref.location.sourceId as NativeSourceId, nativeSessionId: ref.candidate.nativeSessionId,
          exportedAt: new Date(this.now()).toISOString(), importMode: mode,
          ...(ref.titled ? { title: ref.candidate.title } : {}),
          ...((custom => custom ? { customTitle: custom } : {})(this.customTitle(ref))),
          ...(ref.location.profile ? { profile: ref.location.profile } : {}),
          ...(ref.candidate.projectPath ? { projectPath: ref.candidate.projectPath } : {}),
          ...(ref.location.kind === 'antigravity' ? {
            readMedia: (mediaPath: string) => {
              try {
                const canonical = contained(join(ref.path, '..', '..', '..'), mediaPath);
                return identity(canonical).size <= 5 * 1024 * 1024 ? readBoundedBuffer(join(ref.path, '..', '..', '..'), mediaPath, 5 * 1024 * 1024).toString('base64') : undefined;
              } catch { return undefined; }
            },
          } : {}),
        };
        let parsed: NativeParseResult;
        if (ref.location.kind === 'hermes') parsed = this.readHermes(ref, context);
        else {
          contained(ref.location.root, ref.location.path);
          const before = identity(contained(ref.location.path, ref.path));
          if (!same(before, ref.identity)) throw new Error('The session changed since the scan; scan again.');
          if (withSteps && before.size > LIVE_FULL_BYTES && (ref.location.kind === 'codex' || ref.location.kind === 'claude' || ref.location.kind === 'antigravity')) parsed = this.parseWindow(ref.location, ref.path, before, context, !ref.titled);
          else {
            if (before.size > MAX_FILE_BYTES) throw new Error('The session is larger than the 25 MB read limit.');
            const content = readBounded(ref.location.path, ref.path, MAX_FILE_BYTES);
            if (!same(before, identity(contained(ref.location.path, ref.path)))) throw new Error('The session changed while reading; scan again.');
            parsed = ref.location.kind === 'codex' ? parseCodex(content, context) : ref.location.kind === 'claude' ? parseClaude(content, context) : ref.location.kind === 'antigravity' ? parseAntigravity(content, context) : parseGemini(content, context);
          }
        }
        for (const message of parsed.diagnostics) add(message);
        if (parsed.session) {
          const length = Buffer.byteLength(JSON.stringify(parsed.session));
          if (bytes + length > MAX_PREVIEW_BYTES) { add('The preview is larger than 10 MB; select fewer sessions.'); continue; }
          bytes += length;
          result.sessions.push({ candidateId: id, session: parsed.session, ...(withSteps && parsed.steps ? { steps: parsed.steps } : {}), ...(withSteps && parsed.model ? { model: parsed.model } : {}), ...(withSteps && parsed.context ? { context: parsed.context } : {}) });
        }
      } catch (error) {
        add(error instanceof Error ? error.message : 'Unable to read this session.');
      }
    }
    return result;
  }

  /**
   * Parse the beginning and the latest part of a large JSONL transcript (complete
   * lines only, up to the size seen before reading, so appends while reading are
   * harmless). Positions are rewritten to absolute line numbers; the title comes
   * from the beginning so it does not change as the window moves.
   */
  private parseWindow(location: Location, path: string, before: FileIdentity, context: ParseContext, titleFromHead: boolean): NativeParseResult {
    const canonical = contained(location.path, path), fd = openSync(canonical, 'r');
    let head: string, tail: string, tailStart: number;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || Number(opened.ino) !== before.ino || opened.size < before.size) throw new Error('Source changed while opening; scan again.');
      const read = (start: number, length: number) => { const bytes = Buffer.alloc(length); return bytes.subarray(0, readSync(fd, bytes, 0, length, start)); };
      const headBytes = read(0, Math.min(before.size, LIVE_HEAD_BYTES)), headEnd = headBytes.lastIndexOf(0x0a) + 1;
      head = headBytes.subarray(0, headEnd).toString('utf8');
      const windowStart = Math.max(headEnd, before.size - LIVE_TAIL_BYTES);
      const tailBytes = read(windowStart, before.size - windowStart);
      // Start at a line boundary (the window start may cut a line) and stop after the last complete line.
      const first = windowStart === headEnd ? 0 : tailBytes.indexOf(0x0a) + 1;
      tailStart = windowStart + first;
      tail = tailBytes.subarray(first, tailBytes.lastIndexOf(0x0a) + 1).toString('utf8');
      this.countLines(fd, canonical, before.ino, tailStart);
    } finally { closeSync(fd); }
    const tailBase = this.lineCounts.get(canonical)!.lines;
    // Absolute line number of each record the parser keeps (non-blank lines holding a JSON object).
    const numbers: number[] = [];
    const number = (text: string, base: number) => text.split('\n').forEach((line, index) => {
      if (!line.trim()) return;
      try { const row = JSON.parse(line) as unknown; if (row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length) numbers.push(base + index); } catch { /* skipped by the parser too */ }
    });
    number(head, 0);
    if (tail) number(tail, tailBase);
    const parse = (text: string, extra: Partial<ParseContext> = {}) => location.kind === 'codex' ? parseCodex(text, { ...context, ...extra }) : location.kind === 'antigravity' ? parseAntigravity(text, { ...context, ...extra }) : parseClaude(text, { ...context, ...extra });
    const headTitle = titleFromHead && !context.title ? parse(head).session?.title : undefined;
    const parsed = parse(head + tail, headTitle ? { title: headTitle } : {});
    for (const step of parsed.steps ?? []) step.pos = step.pos.replace(/^(L|A:\d+:)(\d+)/, (match, prefix: string, index: string) => numbers[Number(index)] !== undefined ? `${prefix}${numbers[Number(index)]}` : match);
    return { ...parsed, diagnostics: [...parsed.diagnostics, 'Only the beginning and the latest activity of this large transcript are read.'] };
  }

  /** Lines before byte `end` of a growing file, counted incrementally from the previous count. */
  private countLines(fd: number, key: string, ino: number, end: number): void {
    const cached = this.lineCounts.get(key);
    let position = 0, lines = 0;
    if (cached && cached.ino === ino && cached.position <= end) ({ position, lines } = cached);
    const chunk = Buffer.alloc(1024 * 1024);
    while (position < end) {
      const length = readSync(fd, chunk, 0, Math.min(chunk.length, end - position), position);
      if (length <= 0) break;
      for (let index = 0; index < length; index++) if (chunk[index] === 0x0a) lines++;
      position += length;
    }
    this.lineCounts.delete(key);
    this.lineCounts.set(key, { ino, position, lines });
    while (this.lineCounts.size > 200) this.lineCounts.delete(this.lineCounts.keys().next().value!);
  }

  /** A live read: the lead's steps merged with its sub-agents' steps (a failing sub-agent read never hides the lead). */
  private observedRead(ref: Ref, entry: { session: PortableSession; steps?: TranscriptStep[]; model?: string; context?: TranscriptContext }): ObservedRead {
    const steps = entry.steps ?? [];
    let subagents: SubagentTranscript[];
    try { subagents = this.subagents(ref, steps, entry.session.startedAt); } catch { subagents = []; }
    return { session: entry.session, steps: subagents.length ? mergeSubagentSteps(steps, subagents) : steps, ...(entry.model ? { model: entry.model } : {}), ...(entry.context ? { context: entry.context } : {}) };
  }

  /** Claude Code keeps a session's extras in a folder named after it: `<project>/<sessionId>/`. */
  private claudeSessionFolder(path: string): string {
    return join(dirname(path), basename(path, '.jsonl'));
  }

  /** Files besides the transcript whose changes change the observed session (sub-agents, custom titles). */
  private relatedFiles(location: Location, reference: NativeObservationRef): string[] {
    if (location.kind === 'claude') {
      const folder = this.claudeSessionFolder(reference.path), files: string[] = [];
      const title = join(folder, 'custom-title.json');
      if (existsSync(title)) files.push(title);
      const subagents = join(folder, 'subagents');
      if (existsSync(subagents)) {
        contained(location.path, subagents);
        for (const name of readdirSync(subagents).sort().slice(0, MAX_SUBAGENTS * 3)) if (/^agent-[\w-]{1,120}\.(?:jsonl|meta\.json)$/.test(name)) files.push(join(subagents, name));
      }
      return files;
    }
    if (location.kind === 'codex') {
      const root = this.codexHeader(location, reference.path);
      if (!root) return [];
      const files = this.codexDescendants(location, root.id, this.rolloutStart(reference.path, root)).map(item => item.path);
      const index = join(location.root, 'session_index.jsonl');
      if (existsSync(index)) files.push(index);
      return files;
    }
    return [];
  }

  /** A title the user gave the session in its app: Claude Code `custom-title.json`, Codex `session_index.jsonl` thread names. */
  private customTitle(ref: Ref): string | undefined {
    try {
      if (ref.location.kind === 'claude') {
        const file = join(this.claudeSessionFolder(ref.path), 'custom-title.json');
        if (!existsSync(file) || identity(contained(ref.location.path, file)).size > MAX_SIDECAR_BYTES) return undefined;
        const value = JSON.parse(readBounded(ref.location.path, file, MAX_SIDECAR_BYTES)) as Row;
        return text(value?.customTitle);
      }
      if (ref.location.kind === 'codex') return this.codexThreadNames(ref.location).get(ref.candidate.nativeSessionId);
    } catch { /* optional metadata */ }
    return undefined;
  }

  private codexThreadNames(location: Location): Map<string, string> {
    const file = join(location.root, 'session_index.jsonl');
    if (!existsSync(file)) return new Map();
    const info = identity(contained(location.root, file)), stamp = `${info.ino}:${info.size}:${info.mtime}`;
    if (this.threadNames?.stamp === stamp) return this.threadNames.names;
    if (info.size > MAX_THREAD_INDEX_BYTES) return new Map();
    const names = new Map<string, string>();
    for (const line of readBounded(location.root, file, MAX_THREAD_INDEX_BYTES).split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Row, id = text(row.id), name = text(row.thread_name);
        if (id && name) names.set(id, name);
      } catch { /* partial line */ }
    }
    this.threadNames = { stamp, names };
    return names;
  }

  /** The first record of a Codex rollout, read once per file (it never changes after it is written). */
  private codexHeader(location: Location, path: string): ThreadHeader | undefined {
    try {
      const canonical = contained(location.path, path), info = statSync(canonical);
      if (!info.isFile()) return undefined;
      const ino = Number(info.ino), cached = this.threadHeaders.get(path);
      if (cached?.ino === ino) return cached;
      const fd = openSync(canonical, 'r');
      let head: string;
      try {
        const bytes = Buffer.alloc(Math.min(info.size, HEADER_BYTES));
        head = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString('utf8');
      } finally { closeSync(fd); }
      const end = head.indexOf('\n');
      if (end < 0) return undefined;
      const row = JSON.parse(head.slice(0, end)) as Row;
      const payload = (row?.payload && typeof row.payload === 'object' ? row.payload : {}) as Row;
      const id = text(payload.id);
      if (row?.type !== 'session_meta' || !id) return undefined;
      const spawn = codexThreadSpawn(payload), cwd = text(payload.cwd), startMs = Date.parse(String(payload.timestamp ?? row.timestamp ?? ''));
      const header: ThreadHeader = { ino, id: safeLabel(id, 200), ...(spawn ? { spawn } : {}), ...(cwd ? { cwd: safeText(cwd, 2000) } : {}), ...(Number.isFinite(startMs) ? { startMs } : {}) };
      this.threadHeaders.set(path, header);
      if (this.threadHeaders.size > MAX_FILES) this.threadHeaders.delete(this.threadHeaders.keys().next().value!);
      return header;
    } catch { return undefined; }
  }

  /** Rollout files of a Codex location; one listing serves all lookups of one call (public entry points clear it). */
  private codexFiles(location: Location): string[] {
    const memo = this.threadFileMemo.get(location.id);
    if (memo) return memo.files;
    let cache = this.threadListings.get(location.id);
    if (!cache) { cache = { dirs: new Map(), files: new Map(), cursor: 0 }; this.threadListings.set(location.id, cache); }
    const files = this.candidateFiles(location, cache);
    this.threadFileMemo.set(location.id, { at: Date.now(), files });
    return files;
  }

  private rolloutStart(path: string, header?: ThreadHeader): number {
    return rolloutTime(path) ?? header?.startMs ?? 0;
  }

  /** The root thread (started by the user) of a Codex sub-agent thread. */
  private codexRoot(location: Location, path: string): { id: string; path: string } | undefined {
    let current = path, header = this.codexHeader(location, path);
    for (let depth = 0; header?.spawn && depth < 8; depth++) {
      const parentId = header.spawn.parentThreadId, files = this.codexFiles(location);
      const parentPath = files.find(file => basename(file).endsWith(`-${parentId}.jsonl`))
        ?? [...this.threadHeaders.entries()].find(([file, item]) => item.id === parentId && files.includes(file))?.[0];
      const parent = parentPath ? this.codexHeader(location, parentPath) : undefined;
      if (!parentPath || parent?.id !== parentId) return undefined;
      current = parentPath; header = parent;
    }
    return header && !header.spawn ? { id: header.id, path: current } : undefined;
  }

  /** Threads a Codex thread spawned, directly or through its sub-agents, oldest first. */
  private codexDescendants(location: Location, rootId: string, startMs: number): { path: string; header: ThreadHeader & { spawn: CodexThreadSpawn } }[] {
    const since = startMs - THREAD_SLACK_MS, byParent = new Map<string, { path: string; header: ThreadHeader & { spawn: CodexThreadSpawn } }[]>();
    for (const path of this.codexFiles(location)) {
      const time = rolloutTime(path);
      if (time !== undefined ? time < since : (() => { try { return statSync(path).mtimeMs < since; } catch { return true; } })()) continue;
      const header = this.codexHeader(location, path);
      if (!header?.spawn) continue;
      const siblings = byParent.get(header.spawn.parentThreadId) ?? [];
      siblings.push({ path, header: header as ThreadHeader & { spawn: CodexThreadSpawn } });
      byParent.set(header.spawn.parentThreadId, siblings);
    }
    const found: { path: string; header: ThreadHeader & { spawn: CodexThreadSpawn } }[] = [], seen = new Set([rootId]);
    for (let queue = [rootId], depth = 0; queue.length && depth < 8; depth++) {
      const next: string[] = [];
      for (const parent of queue) for (const child of byParent.get(parent) ?? []) {
        if (seen.has(child.header.id)) continue;
        seen.add(child.header.id); found.push(child); next.push(child.header.id);
      }
      queue = next;
    }
    return found.sort((a, b) => this.rolloutStart(a.path, a.header) - this.rolloutStart(b.path, b.header) || a.path.localeCompare(b.path)).slice(-MAX_SUBAGENTS);
  }

  /**
   * A sub-agent transcript, parsed again only when its file changed. A file that
   * cannot be read right now (it is being written) keeps its previous read.
   */
  private subagentRead(location: Location, path: string, nativeSessionId: string): ParsedSubagent | undefined {
    const cached = this.subagentReads.get(path);
    try {
      const info = identity(contained(location.path, path)), stamp = `${info.ino}:${info.size}:${info.mtime}`;
      if (cached?.stamp === stamp) return cached.value;
      const context = { sourceId: location.sourceId as NativeSourceId, nativeSessionId, exportedAt: new Date(this.now()).toISOString(), importMode: 'linked' as const };
      const parsed = info.size > LIVE_FULL_BYTES ? this.parseWindow(location, path, info, context, true)
        : (content => location.kind === 'codex' ? parseCodex(content, context) : parseClaude(content, context))(readBounded(location.path, path, MAX_FILE_BYTES));
      const value: ParsedSubagent = { steps: parsed.steps ?? [], ...(parsed.model ? { model: parsed.model } : {}), ...(parsed.session ? { startedAt: parsed.session.startedAt } : {}) };
      this.subagentReads.delete(path);
      this.subagentReads.set(path, { stamp, value });
      while (this.subagentReads.size > MAX_SUBAGENTS * 10) this.subagentReads.delete(this.subagentReads.keys().next().value!);
      return value;
    } catch { return cached?.value; }
  }

  private sidecarJson(location: Location, path: string): Row {
    try {
      if (!existsSync(path) || identity(contained(location.path, path)).size > MAX_SIDECAR_BYTES) return {};
      const value = JSON.parse(readBounded(location.path, path, MAX_SIDECAR_BYTES)) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
    } catch { return {}; }
  }

  /** Sub-agents of an observed session, with what their source states about them. */
  private subagents(ref: Ref, steps: readonly TranscriptStep[], startedAt: string): SubagentTranscript[] {
    const location = ref.location, result: SubagentTranscript[] = [];
    if (location.kind === 'codex') {
      for (const { path, header } of this.codexDescendants(location, ref.candidate.nativeSessionId, this.rolloutStart(ref.path, this.codexHeader(location, ref.path)) || Date.parse(startedAt))) {
        const read = this.subagentRead(location, path, header.id);
        const start = header.startMs ?? rolloutTime(path);
        result.push({
          id: header.id, ...(header.spawn.parentThreadId !== ref.candidate.nativeSessionId ? { parentId: header.spawn.parentThreadId } : {}),
          ...(header.spawn.nickname ? { label: header.spawn.nickname } : {}), ...(header.spawn.role ? { role: header.spawn.role } : {}),
          ...(read?.model ? { model: read.model } : {}),
          ...(read?.startedAt ? { at: read.startedAt } : start !== undefined ? { at: new Date(start).toISOString() } : {}),
          steps: read?.steps ?? [],
        });
      }
      return result;
    }
    if (location.kind !== 'claude') return result;
    const folder = join(this.claudeSessionFolder(ref.path), 'subagents');
    if (!existsSync(folder)) return result;
    contained(location.path, folder);
    const files = readdirSync(folder).filter(name => /^agent-[\w-]{1,120}\.jsonl$/.test(name))
      .map(name => ({ name, mtime: (() => { try { return statSync(join(folder, name)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name)).slice(0, MAX_SUBAGENTS);
    const owners = new Map<string, string>();
    const own = (agentId: string, list: readonly TranscriptStep[]) => { for (const step of list) if (step.type === 'tool.call' && step.callId) owners.set(step.callId, agentId); };
    own('primary', steps);
    const pending: { id: string; meta: Row; read?: ParsedSubagent }[] = [];
    for (const { name } of files) {
      const id = name.slice('agent-'.length, -'.jsonl'.length);
      const read = this.subagentRead(location, join(folder, name), ref.candidate.nativeSessionId);
      if (read) own(id, read.steps);
      pending.push({ id, meta: this.sidecarJson(location, join(folder, `agent-${id}.meta.json`)), ...(read ? { read } : {}) });
    }
    for (const { id, meta, read } of pending) {
      const owner = typeof meta.toolUseId === 'string' ? owners.get(meta.toolUseId) : undefined;
      const label = text(meta.description), role = text(meta.agentType);
      const model = read?.steps.find((step): step is Extract<TranscriptStep, { type: 'reply' }> => step.type === 'reply' && Boolean(step.model))?.model ?? read?.model ?? text(meta.model);
      result.push({
        id, ...(owner && owner !== 'primary' && owner !== id ? { parentId: owner } : {}),
        ...(label ? { label } : {}), ...(role ? { role } : {}), ...(model ? { model } : {}),
        ...(read?.startedAt ? { at: read.startedAt } : {}), steps: read?.steps ?? [],
      });
    }
    return result;
  }

  private readHermes(ref: Ref, context: Parameters<typeof parseHermes>[2]): NativeParseResult {
    if (identity(contained(ref.location.root, ref.path)).ino !== ref.identity.ino) throw new Error('The database was replaced since the scan; scan again.');
    const db = this.database(ref.location);
    try {
      db.exec('BEGIN');
      const query = sessionQuery(db);
      const row = db.prepare(`SELECT ${query.fields} FROM sessions WHERE ${quoted(query.id)} = ?`).get(ref.candidate.nativeSessionId) as Row | undefined;
      if (!row || digest(JSON.stringify(row)) !== ref.rowFingerprint) throw new Error('The session changed since the scan; scan again.');
      const cols = columns(db, 'messages');
      if (!cols.has('session_id') || !cols.has('role') || !cols.has('content')) throw new Error('Unsupported Hermes messages schema.');
      const allowed = ['id', 'session_id', 'role', 'content', 'tool_call_id', 'tool_calls', 'tool_name', 'timestamp', 'active'];
      const where = `session_id = ?${cols.has('active') ? ' AND active = 1' : ''}`;
      const toolSize = cols.has('tool_calls') ? '+ coalesce(length(CAST(tool_calls AS BLOB)), 0)' : '';
      const size = db.prepare(`SELECT coalesce(sum(coalesce(length(CAST(content AS BLOB)), 0) ${toolSize}), 0) AS bytes, count(*) AS count FROM messages WHERE ${where}`).get(ref.candidate.nativeSessionId) as Row;
      if (Number(size.bytes) > MAX_FILE_BYTES || Number(size.count) > 20_000) throw new Error('The session is too large to preview.');
      const order = cols.has('id') ? 'id' : cols.has('timestamp') ? 'timestamp' : 'rowid';
      const messages = db.prepare(`SELECT ${allowed.filter(column => cols.has(column)).map(quoted).join(',')} FROM messages WHERE ${where} ORDER BY ${quoted(order)} LIMIT 20001`).all(ref.candidate.nativeSessionId) as Row[];
      const parsed = parseHermes(row, messages, context);
      db.exec('ROLLBACK');
      return parsed;
    } finally {
      db.close();
    }
  }

  private prune(): void {
    for (const [id, snapshot] of this.snapshots) if (this.now() - snapshot.at > SCAN_TTL_MS) this.snapshots.delete(id);
  }
}
