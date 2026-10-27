import { safeLabel, safeText, type ImportMode, type PortableSession } from '@extalia/core';
import { parseHermes, type TranscriptStep } from '@extalia/importers';

/**
 * Optional read-only client for the local Hermes dashboard (`http://127.0.0.1:9119`).
 *
 * Reads `/api/sessions` and `/api/sessions/{id}/timeline` (with cursor
 * `after_row_id`) as an alternative to opening `state.db` directly.
 * Strictly loopback-only, read-only (`GET`), and never used as a control channel.
 */

export const DEFAULT_HERMES_DASHBOARD_URL = 'http://127.0.0.1:9119';
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_TIMELINE_ROWS = 5_000;

export interface HermesDashboardSession {
  id: string;
  title: string;
  cwd?: string;
  profile?: string;
  startedAt: string;
  updatedAt: string;
  messageCount?: number;
  raw: Record<string, unknown>;
}

export interface HermesTimelinePage {
  rows: Record<string, unknown>[];
  /** Highest `row_id` / `id` seen in this page, for incremental `after_row_id` polling. */
  cursor: number;
}

export interface HermesDashboardRead {
  session: PortableSession;
  steps: TranscriptStep[];
  cursor: number;
}

type Row = Record<string, unknown>;
const isObject = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

function isoTime(value: unknown, fallbackMs = Date.now()): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

/**
 * Validate and normalize a Hermes dashboard URL. Only plain HTTP on the
 * loopback interface (`127.0.0.1`, `localhost`, `[::1]`) is accepted.
 */
export function parseHermesDashboardUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Enter the local Hermes dashboard URL, for example http://127.0.0.1:9119.');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('The Hermes dashboard URL is not a valid URL.');
  }
  if (url.protocol !== 'http:') {
    throw new Error('The Hermes dashboard URL must use http:// on this computer.');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())) {
    throw new Error('The Hermes dashboard URL must point to this computer (127.0.0.1 or localhost).');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The Hermes dashboard URL must not include credentials, query parameters or fragments.');
  }
  const cleanPath = url.pathname.replace(/\/+$/, '');
  if (cleanPath && cleanPath !== '') {
    throw new Error('Use the root Hermes dashboard URL (for example http://127.0.0.1:9119).');
  }
  const port = url.port ? Number(url.port) : 9119;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('The Hermes dashboard port must be between 1 and 65535.');
  }
  return `http://${url.hostname.toLowerCase()}:${port}`;
}

function rowIdOf(row: Row, fallback: number): number {
  for (const key of ['row_id', 'rowId', 'id', 'seq']) {
    const val = row[key];
    if (typeof val === 'number' && Number.isInteger(val) && val >= 0) return val;
    if (typeof val === 'string' && /^\d+$/.test(val)) return Number(val);
  }
  return fallback;
}

/** Convert a Hermes dashboard timeline item into the message row shape expected by `parseHermes`. */
function normalizeTimelineRow(raw: Row, sessionId: string, index: number): Row {
  const rowId = rowIdOf(raw, index + 1);
  const role = str(raw.role) ?? (str(raw.type) === 'user' || str(raw.type) === 'prompt'
    ? 'user'
    : str(raw.type) === 'tool' || str(raw.type) === 'tool_result'
      ? 'tool'
      : 'assistant');
  const content = raw.content ?? raw.text ?? raw.message ?? raw.output ?? '';
  const timestamp = raw.timestamp ?? raw.created_at ?? raw.at;
  const toolCalls = raw.tool_calls ?? raw.toolCalls;
  const toolCallId = raw.tool_call_id ?? raw.toolCallId;
  const toolName = raw.tool_name ?? raw.toolName ?? raw.tool;
  return {
    ...raw,
    id: rowId,
    row_id: rowId,
    session_id: sessionId,
    role,
    content,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
    ...(toolCallId !== undefined ? { tool_call_id: toolCallId } : {}),
    ...(toolName !== undefined ? { tool_name: toolName } : {}),
  };
}

export interface HermesDashboardOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export class HermesDashboardClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly caches = new Map<string, { sessionRow?: Row; rows: Map<number, Row>; cursor: number }>();

  constructor(options: HermesDashboardOptions = {}) {
    this.baseUrl = parseHermesDashboardUrl(options.baseUrl ?? DEFAULT_HERMES_DASHBOARD_URL);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  private async getJson(pathname: string): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Hermes dashboard answered ${response.status} for ${pathname}.`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('Hermes dashboard response exceeds the 10 MB read limit.');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Hermes dashboard did not return valid JSON.');
    }
  }

  /** Read `/api/sessions` from the Hermes dashboard. */
  async listSessions(): Promise<HermesDashboardSession[]> {
    const payload = await this.getJson('/api/sessions');
    const list: unknown[] = Array.isArray(payload)
      ? payload
      : isObject(payload) && Array.isArray(payload.sessions)
        ? payload.sessions
        : isObject(payload) && Array.isArray(payload.items)
          ? payload.items
          : [];
    const nowMs = this.now();
    const sessions: HermesDashboardSession[] = [];
    for (const item of list) {
      if (!isObject(item)) continue;
      const id = str(item.id) ?? str(item.session_id) ?? str(item.sessionId);
      if (!id) continue;
      const startedAt = isoTime(item.started_at ?? item.created_at ?? item.startedAt, nowMs);
      const updatedAt = isoTime(item.last_activity_at ?? item.updated_at ?? item.ended_at ?? item.updatedAt ?? startedAt, nowMs);
      const cwd = str(item.cwd) ?? str(item.project_path) ?? str(item.git_repo_root);
      const profile = str(item.profile);
      const title = safeLabel(str(item.title) ?? `Hermes · ${id.slice(0, 24)}`, 160);
      const count = typeof item.message_count === 'number' ? item.message_count : typeof item.messageCount === 'number' ? item.messageCount : undefined;
      sessions.push({
        id,
        title,
        startedAt,
        updatedAt,
        ...(cwd ? { cwd: safeText(cwd, 2000) } : {}),
        ...(profile ? { profile: safeLabel(profile, 80) } : {}),
        ...(count !== undefined ? { messageCount: count } : {}),
        raw: item,
      });
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Read `/api/sessions/{id}/timeline`, optionally passing `after_row_id` so only
   * rows added after the previous poll are transferred.
   */
  async readTimeline(sessionId: string, options: { afterRowId?: number } = {}): Promise<HermesTimelinePage> {
    const cleanId = sessionId.trim();
    if (!cleanId || /[/\\\0]/.test(cleanId)) throw new Error('Invalid Hermes session id.');
    const query = options.afterRowId !== undefined && options.afterRowId > 0
      ? `?after_row_id=${encodeURIComponent(String(options.afterRowId))}`
      : '';
    const payload = await this.getJson(`/api/sessions/${encodeURIComponent(cleanId)}/timeline${query}`);
    const rawRows: unknown[] = Array.isArray(payload)
      ? payload
      : isObject(payload) && Array.isArray(payload.timeline)
        ? payload.timeline
        : isObject(payload) && Array.isArray(payload.rows)
          ? payload.rows
          : isObject(payload) && Array.isArray(payload.messages)
            ? payload.messages
            : [];
    let cursor = options.afterRowId ?? 0;
    const rows: Row[] = [];
    for (let index = 0; index < rawRows.length && rows.length < MAX_TIMELINE_ROWS; index++) {
      const item = rawRows[index];
      if (!isObject(item)) continue;
      const normalized = normalizeTimelineRow(item, cleanId, cursor + index);
      const id = normalized.row_id as number;
      if (options.afterRowId !== undefined && id <= options.afterRowId) continue;
      if (id > cursor) cursor = id;
      rows.push(normalized);
    }
    if ( isObject(payload) && typeof payload.last_row_id === 'number' && payload.last_row_id > cursor) {
      cursor = payload.last_row_id;
    }
    return { rows, cursor };
  }

  /**
   * Read a full session and its structured steps using incremental `after_row_id`
   * timeline fetches, returning a `PortableSession` and `TranscriptStep[]`.
   */
  async readSession(sessionId: string, options: { importMode?: ImportMode; sessionMeta?: HermesDashboardSession } = {}): Promise<HermesDashboardRead> {
    const cached = this.caches.get(sessionId) ?? { rows: new Map<number, Row>(), cursor: 0 };
    if (options.sessionMeta) cached.sessionRow = options.sessionMeta.raw;
    if (!cached.sessionRow) {
      const list = await this.listSessions();
      const found = list.find(item => item.id === sessionId);
      cached.sessionRow = found?.raw ?? { id: sessionId, title: `Hermes · ${sessionId.slice(0, 24)}` };
    }
    const page = await this.readTimeline(sessionId, cached.cursor > 0 ? { afterRowId: cached.cursor } : {});
    for (const row of page.rows) {
      const id = row.row_id as number;
      if (cached.rows.size < MAX_TIMELINE_ROWS || cached.rows.has(id)) {
        cached.rows.set(id, row);
      }
    }
    if (page.cursor > cached.cursor) cached.cursor = page.cursor;
    this.caches.set(sessionId, cached);

    const ordered = [...cached.rows.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
    const parsed = parseHermes(cached.sessionRow, ordered, {
      sourceId: 'hermes',
      importMode: options.importMode ?? 'linked',
      nativeSessionId: sessionId,
      exportedAt: new Date(this.now()).toISOString(),
    });
    if (!parsed.session) {
      throw new Error(parsed.diagnostics[0] ?? 'The Hermes dashboard session could not be parsed.');
    }
    return {
      session: parsed.session,
      steps: parsed.steps ?? [],
      cursor: cached.cursor,
    };
  }
}
