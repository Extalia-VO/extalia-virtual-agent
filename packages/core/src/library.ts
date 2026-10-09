import {
  PORTABLE_SESSION_FORMAT, decodeMessages, decodePortableSession, decodeProvenance, decodeWorkspaceHint, sourceKey,
  type ImportMode, type PortableMessage, type PortableSession, type Provenance, type WorkspaceHint,
} from './portable.js';
import { assertNoCredentialFields, countSecrets, redact } from './privacy.js';
import { decode, entityId, object, oneOf, optionalText, text, timestamp, type DecodeResult } from './validation.js';

/**
 * The local session library keeps three kinds of data apart:
 * - imported content and provenance (replaced only by a newer import of the same source session);
 * - local organization in `local` (rename, move, archive, trash), never overwritten by imports;
 * - exclusions: tombstones for linked sessions the user removed, so sync does not bring them back.
 */
export const LIBRARY_SCHEMA = 'extalia.library.v1';

export type LocalState = 'active' | 'archived' | 'trashed';
export const LOCAL_STATES: readonly LocalState[] = ['active', 'archived', 'trashed'];

export interface LocalOrganization {
  state: LocalState;
  renamedTitle?: string;
  /** Workspace chosen by the user; unset sessions appear under Unassigned. */
  workspaceId?: string;
  updatedAt: string;
}

export interface LibrarySession {
  /** Equal to the session's source key, so re-imports always find it. */
  id: string;
  title: string;
  importMode: ImportMode;
  provenance: Provenance;
  workspace?: WorkspaceHint;
  messages: PortableMessage[];
  startedAt: string;
  lastMessageAt: string;
  local: LocalOrganization;
}

export interface SessionLibrary {
  schema: typeof LIBRARY_SCHEMA;
  sessions: LibrarySession[];
  /** Source keys of linked sessions the user trashed. */
  exclusions: string[];
}

export function emptyLibrary(): SessionLibrary {
  return { schema: LIBRARY_SCHEMA, sessions: [], exclusions: [] };
}

export function displayTitle(session: LibrarySession): string {
  return session.local.renamedTitle || session.title;
}

function decodeLibrarySession(raw: unknown): LibrarySession {
  const value = object(raw, 'session');
  const startedAt = timestamp(value.startedAt, 'startedAt'), lastMessageAt = timestamp(value.lastMessageAt, 'lastMessageAt');
  const provenance = decodeProvenance(value.provenance);
  const id = entityId(value.id, 'id');
  if (id !== sourceKey(provenance)) throw new Error('id: must equal the session source key.');
  const local = object(value.local, 'local');
  const organization: LocalOrganization = { state: oneOf(local.state, LOCAL_STATES, 'local.state'), updatedAt: timestamp(local.updatedAt, 'local.updatedAt') };
  const renamedTitle = optionalText(local.renamedTitle, 'local.renamedTitle', { singleLine: true, max: 300 });
  const workspaceId = optionalText(local.workspaceId, 'local.workspaceId', { singleLine: true, max: 200 });
  if (renamedTitle) organization.renamedTitle = renamedTitle;
  if (workspaceId) organization.workspaceId = workspaceId;
  const session: LibrarySession = {
    id,
    title: text(value.title, 'title', { singleLine: true, max: 300 }),
    importMode: oneOf(value.importMode, ['imported', 'linked'] as const, 'importMode'),
    provenance,
    messages: decodeMessages(value.messages, startedAt, lastMessageAt),
    startedAt,
    lastMessageAt,
    local: organization,
  };
  if (value.workspace !== undefined) session.workspace = decodeWorkspaceHint(value.workspace);
  return session;
}

/** Validate a stored library, including identity uniqueness and linked/exclusion consistency. */
export function decodeLibrary(raw: unknown): DecodeResult<SessionLibrary> {
  return decode(() => {
    assertNoCredentialFields(raw);
    const value = object(raw, 'library');
    if (value.schema !== LIBRARY_SCHEMA) throw new Error(`schema: expected ${LIBRARY_SCHEMA}.`);
    if (!Array.isArray(value.sessions) || !Array.isArray(value.exclusions)) throw new Error('library: sessions and exclusions must be arrays.');
    const sessions = value.sessions.map(decodeLibrarySession);
    const exclusions = [...new Set(value.exclusions.map((item, index) => entityId(item, `exclusions[${index}]`)))];
    if (new Set(sessions.map(session => session.id)).size !== sessions.length) throw new Error('library: duplicate session identities.');
    for (const session of sessions) {
      const excluded = exclusions.includes(session.id);
      if (session.importMode === 'linked' && (session.local.state === 'trashed') !== excluded) throw new Error('library: linked session exclusion does not match its state.');
    }
    return { schema: LIBRARY_SCHEMA, sessions, exclusions };
  });
}

export interface ImportOptions {
  /** Restrict which sources may be imported. Omit to allow any valid source id. */
  allowedSources?: readonly string[];
  /** Mask likely credentials in message content before storing. Defaults to true. */
  redactSecrets?: boolean;
  now?: string;
}

export type ImportAction = 'add' | 'update' | 'skip';

export interface ImportPreview {
  results: { sourceKey: string; title: string; action: ImportAction; reason?: string; redactions: number }[];
  addCount: number;
  updateCount: number;
  skipCount: number;
  /** Set when the whole batch was refused; nothing is imported in that case. */
  rejectionReason?: string;
}

function emptyPreview(): ImportPreview {
  return { results: [], addCount: 0, updateCount: 0, skipCount: 0 };
}

function planImport(json: string, library: SessionLibrary, options: ImportOptions): { preview: ImportPreview; library: SessionLibrary } {
  const preview = emptyPreview();
  const now = options.now ?? new Date().toISOString();
  try {
    const raw: unknown = JSON.parse(json);
    assertNoCredentialFields(raw);
    const items = Array.isArray(raw) ? raw : [raw];
    if (!items.length) throw new Error('The import contains no sessions.');
    // Validate the whole batch first: one invalid session refuses the batch atomically.
    const incoming: PortableSession[] = items.map((item, position) => {
      const result = decodePortableSession(item);
      if (!result.ok) throw new Error(`Session ${position + 1}: ${result.errors.join('; ')}`);
      if (options.allowedSources && !options.allowedSources.includes(result.value.provenance.sourceId)) throw new Error(`Session ${position + 1}: source ${result.value.provenance.sourceId} is not enabled.`);
      return result.value;
    });

    const sessions = [...library.sessions];
    const exclusions = new Set(library.exclusions);
    const seen = new Set<string>();
    for (const session of incoming) {
      const key = sourceKey(session.provenance);
      const existingIndex = sessions.findIndex(item => item.id === key);
      const existing = existingIndex >= 0 ? sessions[existingIndex] : undefined;
      let redactions = 0;
      const messages = session.messages.map(message => {
        const found = countSecrets(message.content);
        redactions += found;
        return options.redactSecrets === false || !found ? message : { ...message, content: redact(message.content) };
      });

      let reason: string | undefined;
      if (seen.has(key)) reason = 'Duplicate within this import.';
      else if (exclusions.has(key)) reason = 'Removed earlier from a linked source; restore it from Trash to sync it again.';
      seen.add(key);
      const action: ImportAction = reason ? 'skip' : existing ? 'update' : 'add';
      preview.results.push({ sourceKey: key, title: session.title, action, redactions, ...(reason ? { reason } : {}) });
      if (action === 'skip') { preview.skipCount++; continue; }

      const next: LibrarySession = {
        id: key,
        title: session.title,
        // A session keeps the mode it was first imported with; organization is never overwritten.
        importMode: existing?.importMode ?? session.importMode,
        provenance: session.provenance,
        messages,
        startedAt: session.startedAt,
        lastMessageAt: session.lastMessageAt,
        local: existing ? { ...existing.local } : { state: 'active', updatedAt: now },
      };
      if (session.workspace) next.workspace = session.workspace;
      if (existing) { sessions[existingIndex] = next; preview.updateCount++; }
      else { sessions.push(next); preview.addCount++; }
    }
    return { preview, library: { schema: LIBRARY_SCHEMA, sessions, exclusions: [...exclusions] } };
  } catch (error) {
    const rejected = emptyPreview();
    rejected.rejectionReason = error instanceof Error ? error.message : 'Invalid import.';
    return { preview: rejected, library };
  }
}

/** Describe what an import would do without changing anything. */
export function previewImport(json: string, library: SessionLibrary = emptyLibrary(), options: ImportOptions = {}): ImportPreview {
  return planImport(json, library, options).preview;
}

/** Apply an import. The returned preview always matches what was applied. */
export function applyImport(json: string, library: SessionLibrary = emptyLibrary(), options: ImportOptions = {}): { library: SessionLibrary; preview: ImportPreview } {
  return planImport(json, library, options);
}

function updateLocal(library: SessionLibrary, id: string, change: (local: LocalOrganization) => LocalOrganization): SessionLibrary {
  return { ...library, sessions: library.sessions.map(session => session.id === id ? { ...session, local: change(session.local) } : session) };
}

export function renameSession(library: SessionLibrary, id: string, title: string, now = new Date().toISOString()): SessionLibrary {
  const renamedTitle = text(title, 'title', { singleLine: true, max: 300 }).trim();
  return updateLocal(library, id, local => ({ ...local, renamedTitle, updatedAt: now }));
}

export function moveSession(library: SessionLibrary, id: string, workspaceId: string | undefined, now = new Date().toISOString()): SessionLibrary {
  return updateLocal(library, id, ({ workspaceId: _previous, ...local }) => ({ ...local, ...(workspaceId ? { workspaceId } : {}), updatedAt: now }));
}

/**
 * Archive, trash or restore. Trashing a linked session records an exclusion so
 * the next sync skips it; restoring removes the exclusion. Source data is never touched.
 */
export function setSessionState(library: SessionLibrary, id: string, state: LocalState, now = new Date().toISOString()): SessionLibrary {
  const session = library.sessions.find(item => item.id === id);
  if (!session) return library;
  const exclusions = new Set(library.exclusions);
  if (session.importMode === 'linked') {
    if (state === 'trashed') exclusions.add(session.id);
    else exclusions.delete(session.id);
  }
  return { ...updateLocal(library, id, local => ({ ...local, state, updatedAt: now })), exclusions: [...exclusions] };
}

/**
 * Permanently remove a session from the library. A linked session keeps its
 * exclusion so sync does not re-add it. The source is never modified.
 */
export function deleteSession(library: SessionLibrary, id: string): SessionLibrary {
  const session = library.sessions.find(item => item.id === id);
  if (!session) return library;
  const exclusions = new Set(library.exclusions);
  if (session.importMode === 'linked') exclusions.add(session.id);
  return { ...library, sessions: library.sessions.filter(item => item.id !== id), exclusions: [...exclusions] };
}

/** Export sessions as portable sessions. Local organization is not exported. */
export function exportSessions(library: SessionLibrary, ids?: readonly string[]): PortableSession[] {
  return library.sessions
    .filter(session => !ids || ids.includes(session.id))
    .map(session => ({
      format: PORTABLE_SESSION_FORMAT,
      title: session.title,
      importMode: session.importMode,
      provenance: session.provenance,
      ...(session.workspace ? { workspace: session.workspace } : {}),
      messages: session.messages.map(message => ({ ...message, content: redact(message.content) })),
      startedAt: session.startedAt,
      lastMessageAt: session.lastMessageAt,
    }));
}
