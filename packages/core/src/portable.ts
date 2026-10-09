import { assertNoCredentialFields } from './privacy.js';
import { isSourceId } from './sources.js';
import { decode, entityId, object, oneOf, optionalText, slug, text, timestamp, type DecodeResult } from './validation.js';

/**
 * Extalia Portable Session v1: the interchange format every importer produces
 * and every export writes. It carries content and provenance only; local
 * organization (renames, archive, trash) never travels with it.
 */
export const PORTABLE_SESSION_FORMAT = 'extalia.session.v1';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
export const MESSAGE_ROLES: readonly MessageRole[] = ['system', 'user', 'assistant', 'tool'];
export type ImportMode = 'imported' | 'linked';

export interface PortableMessage {
  index: number;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface Provenance {
  /** Source identifier such as `codex` or `hermes`. */
  sourceId: string;
  /** Session id in the source; together with sourceId it identifies the session everywhere. */
  sourceSessionId: string;
  exportedAt: string;
  providerId?: string;
  originVersion?: string;
}

export interface WorkspaceHint {
  slug: string;
  name: string;
  projectLocation?: string;
}

export interface PortableSession {
  format: typeof PORTABLE_SESSION_FORMAT;
  title: string;
  importMode: ImportMode;
  provenance: Provenance;
  /** The source's notion of a project, used to suggest a workspace on import. */
  workspace?: WorkspaceHint;
  messages: PortableMessage[];
  startedAt: string;
  lastMessageAt: string;
}

/** Stable identity of a session across imports: `<sourceId>:<sourceSessionId>`. */
export function sourceKey(provenance: Pick<Provenance, 'sourceId' | 'sourceSessionId'>): string {
  return `${provenance.sourceId}:${provenance.sourceSessionId}`;
}

export function decodeProvenance(raw: unknown): Provenance {
  const value = object(raw, 'provenance');
  if (!isSourceId(value.sourceId)) throw new Error('provenance.sourceId: use lowercase letters, numbers and hyphens.');
  const provenance: Provenance = {
    sourceId: value.sourceId,
    sourceSessionId: entityId(value.sourceSessionId, 'provenance.sourceSessionId'),
    exportedAt: timestamp(value.exportedAt, 'provenance.exportedAt'),
  };
  const providerId = optionalText(value.providerId, 'provenance.providerId', { singleLine: true, max: 64 });
  const originVersion = optionalText(value.originVersion, 'provenance.originVersion', { singleLine: true, max: 64 });
  if (providerId) provenance.providerId = providerId;
  if (originVersion) provenance.originVersion = originVersion;
  return provenance;
}

export function decodeWorkspaceHint(raw: unknown): WorkspaceHint {
  const value = object(raw, 'workspace');
  const hint: WorkspaceHint = { slug: slug(value.slug, 'workspace.slug'), name: text(value.name, 'workspace.name', { singleLine: true, max: 120 }).trim() };
  const projectLocation = optionalText(value.projectLocation, 'workspace.projectLocation', { singleLine: true, max: 4096 });
  if (projectLocation) hint.projectLocation = projectLocation;
  return hint;
}

/** Validate messages: consecutive indices, known roles, ordered timestamps inside the session span. */
export function decodeMessages(raw: unknown, startedAt: string, lastMessageAt: string): PortableMessage[] {
  if (!Array.isArray(raw)) throw new Error('messages: expected an array.');
  if (Date.parse(startedAt) > Date.parse(lastMessageAt)) throw new Error('startedAt: must not be later than lastMessageAt.');
  let previous = Date.parse(startedAt);
  return raw.map((item, position) => {
    const message = object(item, `messages[${position}]`);
    if (message.index !== position) throw new Error('messages: indices must be consecutive, starting at zero.');
    const createdAt = timestamp(message.createdAt, `messages[${position}].createdAt`);
    const at = Date.parse(createdAt);
    if (at < previous || at > Date.parse(lastMessageAt)) throw new Error('messages: timestamps are out of order or outside the session.');
    previous = at;
    return {
      index: position,
      role: oneOf(message.role, MESSAGE_ROLES, `messages[${position}].role`),
      content: text(message.content, `messages[${position}].content`, { allowEmpty: true }),
      createdAt,
    };
  });
}

export function decodePortableSession(raw: unknown): DecodeResult<PortableSession> {
  return decode(() => {
    assertNoCredentialFields(raw);
    const value = object(raw, 'session');
    if (value.format !== PORTABLE_SESSION_FORMAT) throw new Error(`format: expected ${PORTABLE_SESSION_FORMAT}.`);
    const startedAt = timestamp(value.startedAt, 'startedAt'), lastMessageAt = timestamp(value.lastMessageAt, 'lastMessageAt');
    const session: PortableSession = {
      format: PORTABLE_SESSION_FORMAT,
      title: text(value.title, 'title', { singleLine: true, max: 300 }).trim(),
      importMode: oneOf(value.importMode, ['imported', 'linked'] as const, 'importMode'),
      provenance: decodeProvenance(value.provenance),
      messages: decodeMessages(value.messages, startedAt, lastMessageAt),
      startedAt,
      lastMessageAt,
    };
    if (value.workspace !== undefined) session.workspace = decodeWorkspaceHint(value.workspace);
    return session;
  });
}
