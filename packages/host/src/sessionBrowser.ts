import { SessionProjectIdentities } from './sessionProjectIdentity.js';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  buildSessionBrowserSnapshot, buildSessionBrowserHarnessGroups,
  type SessionBrowserGroupsInput, type SessionBrowserGroupsPage, type SessionBrowserSessionsInput,
  type SessionBrowserSessionsPage, type SessionBrowserQuery, type SessionBrowserSnapshotInput,
  type SessionBrowserGroup, type SessionBrowserRow,
} from '@extalia/platform';

const MAX_PAGE = 100;
const SNAPSHOT_TTL_MS = 5 * 60_000;
const MAX_SNAPSHOTS = 12;
type PageRows = SessionBrowserGroup[] | SessionBrowserRow[];
interface Snapshot { id: string; profile: string; scope: string; rows: PageRows; expires: number }
export interface SessionBrowserSource {
  /** This port supplies metadata only and must never open a transcript. */
  metadata(collection: SessionBrowserQuery['collection']): SessionBrowserSnapshotInput;
  profileId(): string;
  now?(): number;
}

function invalid(): never { throw new Error('The session browser request is invalid.'); }
function expired(): never { throw new Error('The session browser page expired or changed. Refresh the list.'); }
function text(value: unknown, max: number, optional = true): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0')) return invalid();
  return value;
}
function validate(input: unknown, groups: boolean): SessionBrowserGroupsInput | SessionBrowserSessionsInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const raw = input as Record<string, unknown>;
  const allowed = new Set(['collection', 'query', 'harness', 'status', 'state', 'attentionIds', 'limit', 'cursor', groups ? 'section' : 'groupId']);
  if (Object.keys(raw).some(key => !allowed.has(key))) return invalid();
  if (raw.collection !== 'observed' && raw.collection !== 'library') return invalid();
  if (raw.status !== undefined && !['all', 'running', 'attention', 'paused'].includes(raw.status as string)) return invalid();
  if (raw.state !== undefined && !['active', 'archived', 'trashed'].includes(raw.state as string)) return invalid();
  if (raw.limit !== undefined && (!Number.isInteger(raw.limit) || (raw.limit as number) < 1 || (raw.limit as number) > MAX_PAGE)) return invalid();
  if (raw.attentionIds !== undefined && (!Array.isArray(raw.attentionIds) || raw.attentionIds.length > 1000 || raw.attentionIds.some(id => typeof id !== 'string' || !id || id.length > 300))) return invalid();
  if (raw.collection === 'library' && raw.status !== undefined && raw.status !== 'all') return invalid();
  if (groups && raw.section !== 'harnesses' && raw.section !== 'projects' && raw.section !== 'unassigned') return invalid();
  const query = raw.query === '' ? undefined : text(raw.query, 500);
  const result = { collection: raw.collection, ...(query ? { query } : {}),
    ...(raw.harness === undefined ? {} : { harness: text(raw.harness, 128) }),
    ...(raw.status === undefined ? {} : { status: raw.status }), ...(raw.state === undefined ? {} : { state: raw.state }),
    ...(raw.attentionIds === undefined ? {} : { attentionIds: [...new Set(raw.attentionIds as string[])].sort() }),
    ...(raw.cursor === undefined ? {} : { cursor: text(raw.cursor, 2048) }),
    limit: raw.limit ?? 20,
    ...(groups ? { section: raw.section } : { groupId: text(raw.groupId, 8192, false) }),
  };
  return result as SessionBrowserGroupsInput | SessionBrowserSessionsInput;
}
function scopeOf(input: SessionBrowserGroupsInput | SessionBrowserSessionsInput): string {
  return createHash('sha256').update(JSON.stringify({
    collection: input.collection, query: input.query?.trim().toLocaleLowerCase() ?? '', harness: input.harness ?? '',
    status: input.status ?? 'all', state: input.state ?? 'active', attentionIds: input.attentionIds ?? [],
    ...('section' in input ? { section: input.section } : { groupId: input.groupId }),
  })).digest('hex');
}

/** Bounded immutable metadata snapshots keep pagination stable while source hooks update sessions. */
export class SessionBrowser {
  private readonly key = randomBytes(32);
  private readonly identities = new SessionProjectIdentities();
  private readonly snapshots = new Map<string, Snapshot>();
  constructor(private readonly source: SessionBrowserSource) {}
  private async projectMetadata(collection: SessionBrowserQuery['collection'], harness?: string): Promise<SessionBrowserSnapshotInput> {
    const base = this.source.metadata(collection);
    const metadata = !harness ? base : { ...base, observed: base.observed?.filter(row => row.observation?.sourceId === harness), library: base.library?.filter(row => row.sourceId === harness) };
    const folders = collection === 'observed' ? metadata.observed?.flatMap(row => row.observation?.projectPath ? [row.observation.projectPath] : []) : metadata.library?.flatMap(row => row.projectLocation ? [row.projectLocation] : []);
    const projectIdentities = await this.identities.resolve(folders ?? [], metadata.workspaces);
    return { ...metadata, projectIdentities };
  }
  async groupsWithProjects(raw: SessionBrowserGroupsInput): Promise<SessionBrowserGroupsPage> {
    const input = validate(raw, true) as SessionBrowserGroupsInput;
    return this.groups(input, input.cursor || input.section !== 'projects' ? undefined : await this.projectMetadata(input.collection, input.harness));
  }
  async sessionsWithProjects(raw: SessionBrowserSessionsInput): Promise<SessionBrowserSessionsPage> {
    const input = validate(raw, false) as SessionBrowserSessionsInput;
    return this.sessions(input, input.cursor || input.groupId === 'unassigned' ? undefined : await this.projectMetadata(input.collection, input.harness));
  }
  resolveProjects(folders: readonly string[], workspaces: SessionBrowserSnapshotInput['workspaces']) {
    return this.identities.resolve(folders, workspaces);
  }
  private clock(): number { return this.source.now?.() ?? Date.now(); }
  private signature(value: string): string { return createHmac('sha256', this.key).update(value).digest('base64url'); }
  private cursor(snapshot: Snapshot, offset: number): string {
    const body = Buffer.from(JSON.stringify({ id: snapshot.id, offset })).toString('base64url');
    return `${body}.${this.signature(body)}`;
  }
  private resume(cursor: string, scope: string): { snapshot: Snapshot; offset: number } {
    const pieces = cursor.split('.');
    if (pieces.length !== 2) return expired();
    const [body, mac] = pieces as [string, string];
    const expected = this.signature(body);
    if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]{43}$/.test(mac) || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return expired();
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return expired(); }
    if (!parsed || typeof parsed !== 'object') return expired();
    const { id, offset } = parsed as { id?: unknown; offset?: unknown };
    if (typeof id !== 'string' || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 1) return expired();
    const snapshot = this.snapshots.get(id);
    if (!snapshot || snapshot.profile !== this.source.profileId() || snapshot.scope !== scope || snapshot.expires <= this.clock() || offset >= snapshot.rows.length) return expired();
    this.snapshots.delete(id); this.snapshots.set(id, snapshot);
    return { snapshot, offset };
  }
  private page<T extends PageRows>(rows: () => T, input: SessionBrowserGroupsInput | SessionBrowserSessionsInput): { rows: T; total: number; totalSessions: number; nextCursor?: string } {
    for (const [id, snapshot] of this.snapshots) if (snapshot.expires <= this.clock()) this.snapshots.delete(id);
    const scope = scopeOf(input);
    const resumed = input.cursor ? this.resume(input.cursor, scope) : undefined;
    const snapshot = resumed?.snapshot ?? { id: randomUUID(), profile: this.source.profileId(), scope, rows: rows(), expires: this.clock() + SNAPSHOT_TTL_MS };
    const offset = resumed?.offset ?? 0;
    const end = Math.min(offset + input.limit!, snapshot.rows.length);
    let nextCursor: string | undefined;
    if (end < snapshot.rows.length) {
      this.snapshots.set(snapshot.id, snapshot);
      while (this.snapshots.size > MAX_SNAPSHOTS) this.snapshots.delete(this.snapshots.keys().next().value!);
      nextCursor = this.cursor(snapshot, end);
    }
    // Pages own their DTOs; transport consumers cannot mutate a retained snapshot.
    return { rows: structuredClone(snapshot.rows.slice(offset, end)) as T, total: snapshot.rows.length, totalSessions: snapshot.rows.reduce((sum, row) => sum + ('count' in row ? row.count : 1), 0), ...(nextCursor ? { nextCursor } : {}) };
  }
  groups(raw: SessionBrowserGroupsInput, prepared?: SessionBrowserSnapshotInput): SessionBrowserGroupsPage {
    const input = validate(raw, true) as SessionBrowserGroupsInput;
    // Counts are computed from metadata. A resumed page retains the same snapshot and totals.
    const result = this.page(() => {
      const metadata = { ...(prepared ?? this.source.metadata(input.collection)), includeSessions: false };
      return input.section === 'harnesses' ? buildSessionBrowserHarnessGroups(metadata, input)
        : buildSessionBrowserSnapshot(metadata, input).groups.filter(group => group.section === input.section);
    }, input);
    return { collection: input.collection, section: input.section, groups: result.rows, totalGroups: result.total,
      totalSessions: result.totalSessions, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
  }
  sessions(raw: SessionBrowserSessionsInput, prepared?: SessionBrowserSnapshotInput): SessionBrowserSessionsPage {
    const input = validate(raw, false) as SessionBrowserSessionsInput;
    const result = this.page(() => buildSessionBrowserSnapshot({ ...(prepared ?? this.source.metadata(input.collection)), groupId: input.groupId }, input).sessionsByGroup.get(input.groupId) ?? [], input);
    return { collection: input.collection, sessions: result.rows, total: result.total, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) } as SessionBrowserSessionsPage;
  }
}
