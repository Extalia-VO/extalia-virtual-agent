import path from 'node:path';
import { DaemonRequestError } from './daemon/index.js';
import type { RustLearningPort } from './rustLearning.js';

export interface ProfileNoteDestination { root: string; profileId: string; revision: string }
export interface ProfileNoteContext { workspaceId: string; sessionId: string }
export type ProfileNoteWriter<Record> = ((record: Record, signal?: AbortSignal) => Promise<string>) & { close(): Promise<void> };
export interface ProfileNoteOptions {
  backend: RustLearningPort;
  context: ProfileNoteContext;
  resolve(): Promise<ProfileNoteDestination>;
  authorize?(absolutePath: string): Promise<void>;
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const identity = (value: string) => { if (!identifier.test(value)) throw new Error('Invalid note identity.'); };
function failure(error: unknown): never {
  if (error instanceof DaemonRequestError) {
    const reason = error.reason ?? error.code;
    const message = /exist|overwrit|conflict/.test(reason) ? 'A different note already exists; it was not overwritten.'
      : /identity|changed|replaced/.test(reason) ? 'The notes destination changed on disk.'
        : /symlink|directory|unsafe|path/.test(reason) ? 'The notes destination is not a regular directory.'
          : /participant/.test(reason) ? 'The note contains an unknown participant.' : 'The native core refused the note evidence.';
    throw new Error(message, { cause: error });
  }
  throw error;
}

/** The host checks consent; all note bytes, filesystem identities and writes belong to Rust. */
export async function pinProfileNotes<Record>(options: ProfileNoteOptions, purpose: 'learning' | 'meeting', id: (record: Record) => string): Promise<ProfileNoteWriter<Record>> {
  identity(options.context.workspaceId); identity(options.context.sessionId);
  const pinned = await options.resolve(); identity(pinned.profileId);
  if (!path.isAbsolute(pinned.root)) throw new Error('The notes destination must be absolute.');
  const absolute = path.resolve(pinned.root);
  let pinId: string;
  try { ({ pinId } = await options.backend.process('note.pin', { ...pinned, root: absolute, ...options.context, purpose })); }
  catch (error) { return failure(error); }
  let closed = false;
  const check = async (signal?: AbortSignal) => {
    if (closed || signal?.aborted) throw new Error('Note export cancelled.');
    const current = await options.resolve();
    if (current.profileId !== pinned.profileId || current.revision !== pinned.revision || path.resolve(current.root) !== absolute)
      throw new Error('The notes destination changed; notes were not retargeted.');
    if (closed || signal?.aborted) throw new Error('Note export cancelled.');
  };
  const save = async (record: Record, signal?: AbortSignal): Promise<string> => {
    const recordId = id(record); identity(recordId);
    const expected = `${purpose === 'learning' ? 'Learning' : 'Meetings'}/${options.context.workspaceId}/${recordId}.md`;
    const target = path.join(absolute, ...expected.split('/'));
    await check(signal);
    await options.authorize?.(target);
    await check(signal);
    let draftId: string | undefined;
    try {
      const draft = await options.backend.process('note.prepare', { pinId, record });
      draftId = draft.draftId;
      if (draft.path !== expected) throw new Error('The native note destination did not match its source.');
      await check(signal);
      await options.authorize?.(target);
      await check(signal);
      const published = await options.backend.process('note.commit', { draftId });
      if (published.path !== expected) throw new Error('The native note receipt did not match its destination.');
      draftId = undefined;
      return published.path;
    } catch (error) { return failure(error); }
    finally { if (draftId) await options.backend.process('note.discard', { draftId }).catch(() => undefined); }
  };
  return Object.assign(save, { close: async () => {
    if (closed) return;
    closed = true;
    await options.backend.process('note.release', { pinId });
  } });
}
