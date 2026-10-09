import { safeLabel, safeText, type ImportMode, type PortableSession } from '@extalia/core';
import { parseClaude, parseCodex, parseGemini, parseHermes, type NativeParseResult, type NativeSourceId } from '@extalia/importers';
import type { ImportCandidate, ImportDiagnostic, ImportLocation, ImportScan } from '@extalia/platform';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import type * as Sqlite from 'node:sqlite';

/**
 * Read-only discovery of native agent histories in their known locations.
 * Scans index bounded metadata; previews parse only selected sessions and only
 * through opaque ids from a recent scan, so callers can never name a file.
 * Source files and databases are never modified.
 */

const HEADER_BYTES = 128 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_CANDIDATES = 500;
const MAX_SELECTION = 50;
const SCAN_TTL_MS = 15 * 60 * 1000;

type Row = Record<string, unknown>;
type Kind = 'codex' | 'claude' | 'gemini' | 'hermes' | 'binary' | 'unavailable';
interface Location extends ImportLocation { root: string; kind: Kind; sourceId: NativeSourceId | 'antigravity-ide' | 'antigravity-cli' }
interface FileIdentity { size: number; mtime: number; ino: number }
/** `titled` is false when the candidate title is only a placeholder; imports then use the first prompt. */
interface Ref { location: Location; path: string; candidate: ImportCandidate; identity: FileIdentity; titled: boolean; rowFingerprint?: string }
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

/** Resolve symlinks and require the result to stay inside the history root. */
function contained(root: string, path: string): string {
  const canonicalRoot = realpathSync(root), canonical = realpathSync(path), rel = relative(canonicalRoot, canonical);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Source path escapes its history folder.');
  return canonical;
}

function readBounded(root: string, path: string, max: number): string {
  const canonical = contained(root, path), before = identity(canonical);
  const fd = openSync(canonical, 'r');
  try {
    // Check the opened file too, so a path swapped between realpath and open is caught.
    const opened = fstatSync(fd);
    if (!opened.isFile() || !same(before, { size: opened.size, mtime: opened.mtimeMs, ino: Number(opened.ino) }) || !same(before, identity(contained(root, path)))) throw new Error('Source changed while opening; scan again.');
    const bytes = Buffer.alloc(Math.min(before.size, max));
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, length).toString('utf8');
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
  const allowed = new Set(['sessionId', 'session_id', 'id', 'projectHash', 'projectPath', 'cwd', 'title', 'summary', 'startTime', 'lastUpdated', 'timestamp', 'type']);
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
  sessions: { candidateId: string; session: PortableSession }[];
  diagnostics: ImportDiagnostic[];
}

/** Host-only reference pinned by a selected preview. Never accepted as a UI argument. */
export interface NativeObservationRef { locationId: string; sourceId: string; nativeSessionId: string; path: string }

export class NativeImportService {
  private readonly snapshots = new Map<string, { at: number; refs: Map<string, Ref> }>();
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
    if (location.kind === 'claude' || location.kind === 'gemini') {
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
    if (fileIdentity.size > MAX_FILE_BYTES) throw new Error('The session is larger than the 25 MB read limit.');
    let meta: Row = {};
    if (location.kind !== 'binary') {
      const head = readBounded(location.path, path, HEADER_BYTES);
      if (location.kind === 'gemini' && path.endsWith('.json')) meta = jsonHeader(head);
      else {
        for (const line of head.split('\n').slice(0, 100)) {
          if (!line.trim()) continue;
          try {
            const wrappers = location.kind === 'codex' ? ['payload'] : location.kind === 'gemini' ? ['$set', 'payload', 'data'] : [];
            const header = jsonHeader(line, 0, wrappers);
            if (location.kind === 'codex' && header.type === 'session_meta') { meta = header; break; }
            if (location.kind === 'gemini' && header.type === 'metadata') { meta = header; break; }
            for (const [key, value] of Object.entries(header)) if (value !== undefined) meta[key] = value;
            if (location.kind === 'claude' && text(meta.sessionId) && text(meta.cwd)) break;
            if (location.kind === 'gemini' && text(meta.sessionId) && text(meta.projectHash)) break;
          } catch { /* skip truncated or non-metadata lines */ }
        }
      }
      if (!Object.keys(meta).length || (location.kind === 'codex' && !text(meta.id))) throw new Error('Missing or malformed session metadata.');
    }
    const nativeSessionId = text(meta.sessionId) ?? text(meta.session_id) ?? text(meta.id) ?? basename(path).replace(/\.(jsonl?|pb)$/, '');
    const rawProject = text(meta.cwd) ?? text(meta.projectPath) ?? (location.kind === 'gemini' ? this.geminiProject(location, path) : undefined);
    const mutableTime = location.kind === 'gemini' ? Date.parse(isoDate(meta.lastUpdated, fileIdentity.mtime)) : fileIdentity.mtime;
    const candidate: ImportCandidate = {
      id: randomUUID(), sourceId: location.sourceId, locationId: location.id, sourceName: location.label, nativeSessionId,
      title: safeLabel(text(meta.title) ?? text(meta.summary) ?? `${location.label} · ${nativeSessionId.slice(0, 24)}`, 160),
      updatedAt: new Date(Math.max(fileIdentity.mtime, mutableTime)).toISOString(), format: location.format, supported: location.supported,
      ...(location.profile ? { profile: location.profile } : {}),
      ...(rawProject ? { projectPath: safeText(rawProject, 2000) } : {}),
      ...(location.note ? { note: location.note } : {}),
    };
    if (!same(fileIdentity, identity(contained(location.path, path)))) throw new Error('The session changed during the scan; scan again.');
    return { location, path, candidate, identity: fileIdentity, titled: Boolean(text(meta.title) ?? text(meta.summary)) };
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

  observation(scanId: string, candidateId: string): { reference: NativeObservationRef; session: PortableSession } {
    const preview = this.preview(scanId, [candidateId], 'linked');
    const session = preview.sessions[0]?.session;
    const ref = this.snapshots.get(scanId)?.refs.get(candidateId);
    if (!ref || !session) throw new Error(preview.diagnostics[0]?.message ?? 'This transcript cannot be observed. Scan again.');
    return { reference: { locationId: ref.location.id, sourceId: ref.location.sourceId, nativeSessionId: ref.candidate.nativeSessionId, path: ref.path }, session };
  }

  readObservation(reference: NativeObservationRef): PortableSession {
    const location = this.knownLocations().find(item => item.id === reference.locationId && item.sourceId === reference.sourceId);
    if (!location?.available || !location.supported || location.kind === 'binary' || location.kind === 'unavailable') throw new Error('The selected history source is unavailable.');
    if (typeof reference.path !== 'string' || typeof reference.nativeSessionId !== 'string' || reference.nativeSessionId.length > 4096) throw new Error('Invalid observed session reference.');
    let ref: Ref;
    if (location.kind === 'hermes') {
      if (contained(location.root, reference.path) !== contained(location.root, location.path)) throw new Error('The observed database does not match its source.');
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
      if (!(location.kind === 'gemini' ? /session-.*\.jsonl?$/.test(basename(reference.path)) : reference.path.endsWith('.jsonl'))) throw new Error('The observed path is not a supported transcript.');
      ref = this.fileRef(location, reference.path);
      if (ref.candidate.nativeSessionId !== reference.nativeSessionId) throw new Error('The source file now belongs to another session.');
    }
    const scanId = randomUUID();
    this.snapshots.set(scanId, { at: this.now(), refs: new Map([[ref.candidate.id, ref]]) });
    try {
      const preview = this.preview(scanId, [ref.candidate.id], 'linked');
      if (!preview.sessions[0]) throw new Error(preview.diagnostics[0]?.message ?? 'This transcript is not readable yet.');
      return preview.sessions[0].session;
    } finally { this.snapshots.delete(scanId); }
  }

  preview(scanId: string, candidateIds: readonly string[], mode: ImportMode = 'imported'): NativePreview {
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
          ...(ref.location.profile ? { profile: ref.location.profile } : {}),
          ...(ref.candidate.projectPath ? { projectPath: ref.candidate.projectPath } : {}),
        };
        let parsed: NativeParseResult;
        if (ref.location.kind === 'hermes') parsed = this.readHermes(ref, context);
        else {
          contained(ref.location.root, ref.location.path);
          const before = identity(contained(ref.location.path, ref.path));
          if (!same(before, ref.identity)) throw new Error('The session changed since the scan; scan again.');
          const content = readBounded(ref.location.path, ref.path, MAX_FILE_BYTES);
          if (!same(before, identity(contained(ref.location.path, ref.path)))) throw new Error('The session changed while reading; scan again.');
          parsed = ref.location.kind === 'codex' ? parseCodex(content, context) : ref.location.kind === 'claude' ? parseClaude(content, context) : parseGemini(content, context);
        }
        for (const message of parsed.diagnostics) add(message);
        if (parsed.session) {
          const length = Buffer.byteLength(JSON.stringify(parsed.session));
          if (bytes + length > MAX_PREVIEW_BYTES) { add('The preview is larger than 10 MB; select fewer sessions.'); continue; }
          bytes += length;
          result.sessions.push({ candidateId: id, session: parsed.session });
        }
      } catch (error) {
        add(error instanceof Error ? error.message : 'Unable to read this session.');
      }
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
