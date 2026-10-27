import { randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ATTACHMENT_ID_PATTERN, ATTACHMENT_LIMITS, attachmentLimit, classifyAttachment, decodeAttachmentData, detectImageMimeType, isCredentialFileName,
  isReadableText, sanitizeAttachmentName, type PromptAttachment, type PromptAttachmentInput,
} from '@extalia/platform';
import { ensurePrivateDirectory, PRIVATE_FILE_MODE } from './paths.js';
import { checkSessionId } from './sessions.js';

/** An attachment with its bytes, as a turn reads it. */
export interface TakenAttachment extends PromptAttachment {
  bytes: Uint8Array;
}

interface Entry {
  meta: PromptAttachment;
  /** Kept in memory only (sessions with history off). */
  bytes?: Uint8Array;
}

function refusal(message: string): Error {
  const error = new Error(message);
  error.name = 'UserError';
  return error;
}

const LIMIT_TEXT: Record<PromptAttachment['kind'], string> = {
  image: 'Images can be up to 5 MB.',
  text: 'Text files can be up to 1 MB.',
  file: 'Other files can be up to 10 MB.',
};

/**
 * Files waiting to be sent with a session's next prompt. Sessions that keep history
 * store them privately under `<dataDirectory>/attachments/<sessionId>/`; sessions with
 * history off keep them in memory only, so nothing reaches the disk. A file is removed
 * when it is sent, removed, or its session is deleted. Ids are only looked up inside
 * the session that owns them, so an id of another session is simply not found.
 */
export class AttachmentStore {
  private readonly memory = new Map<string, Map<string, Entry>>();

  constructor(
    /** Root directory for persisted attachments (created privately on first use). */
    private readonly root: string,
    /** Whether a session keeps its history on disk. */
    private readonly persistent: (sessionId: string) => boolean,
  ) {}

  private entriesOf(sessionId: string): Map<string, Entry> {
    if (!this.memory.has(sessionId)) this.memory.set(sessionId, new Map());
    return this.memory.get(sessionId)!;
  }

  private directory(sessionId: string): string {
    return path.join(this.root, checkSessionId(sessionId));
  }

  /** Check one file, store it and return its metadata. Errors are safe to show. */
  async upload(sessionId: string, file: PromptAttachmentInput): Promise<PromptAttachment> {
    const sanitized = sanitizeAttachmentName(file.name);
    if (isCredentialFileName(file.name) || isCredentialFileName(sanitized)) throw refusal('Credential files cannot be attached.');
    const { kind, mimeType } = classifyAttachment(sanitized, file.mimeType);
    const limit = attachmentLimit(kind);
    if (typeof file.data !== 'string' || file.data.length > Math.ceil(limit / 3) * 4) throw refusal(`"${sanitized}" is too large. ${LIMIT_TEXT[kind]}`);
    let bytes: Uint8Array;
    try { bytes = decodeAttachmentData(file.data, limit); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      throw refusal(message.includes('too large') ? `"${sanitized}" is too large. ${LIMIT_TEXT[kind]}` : `"${sanitized}" could not be read as a file.`);
    }
    let type = mimeType;
    if (kind === 'image') {
      const detected = detectImageMimeType(bytes);
      if (!detected) throw refusal(`"${sanitized}" is not a PNG, JPEG, WebP or GIF image.`);
      type = detected;
    } else if (kind === 'text' && !isReadableText(bytes)) {
      throw refusal(`"${sanitized}" is not readable text.`);
    }
    const entries = this.entriesOf(sessionId);
    if (entries.size >= ATTACHMENT_LIMITS.pendingPerSession) {
      throw refusal(`This session already has ${entries.size} files waiting. Send or remove some first.`);
    }
    const meta: PromptAttachment = { id: `att_${randomBytes(12).toString('hex')}`, name: sanitized, mimeType: type, size: bytes.length, kind };
    if (this.persistent(sessionId)) {
      const directory = this.directory(sessionId);
      await ensurePrivateDirectory(this.root);
      await ensurePrivateDirectory(directory);
      await writeFile(path.join(directory, `${meta.id}.bin`), bytes, { mode: PRIVATE_FILE_MODE });
      await writeFile(path.join(directory, `${meta.id}.json`), JSON.stringify(meta), { mode: PRIVATE_FILE_MODE });
      entries.set(meta.id, { meta });
    } else {
      entries.set(meta.id, { meta, bytes });
    }
    return { ...meta };
  }

  /**
   * The files of a prompt, in the order given. Unknown ids, ids of other sessions and
   * malformed ids are refused with one message. Nothing is removed yet (see `consume`).
   */
  async take(sessionId: string, ids: readonly string[]): Promise<TakenAttachment[]> {
    const entries = this.entriesOf(sessionId);
    const result: TakenAttachment[] = [];
    for (const id of ids) {
      const entry = ATTACHMENT_ID_PATTERN.test(id) ? entries.get(id) : undefined;
      if (!entry) throw refusal('One of the attached files is no longer available. Attach it again.');
      let bytes = entry.bytes;
      if (!bytes) {
        try { bytes = new Uint8Array(await readFile(path.join(this.directory(sessionId), `${id}.bin`))); }
        catch { throw refusal('One of the attached files is no longer available. Attach it again.'); }
      }
      result.push({ ...entry.meta, bytes });
    }
    return result;
  }

  /** Remove files that were sent. Best effort: a file that cannot be removed stays until its session ends. */
  async consume(sessionId: string, ids: readonly string[]): Promise<void> {
    for (const id of ids) await this.remove(sessionId, id);
  }

  /** Discard one waiting file. Unknown ids do nothing. */
  async remove(sessionId: string, id: string): Promise<void> {
    if (!ATTACHMENT_ID_PATTERN.test(id)) return;
    const entries = this.entriesOf(sessionId);
    if (!entries.delete(id)) return;
    if (this.persistent(sessionId)) {
      const directory = this.directory(sessionId);
      await rm(path.join(directory, `${id}.bin`), { force: true }).catch(() => undefined);
      await rm(path.join(directory, `${id}.json`), { force: true }).catch(() => undefined);
    }
  }

  /** Forget everything a session has waiting (the session is being deleted). */
  async drop(sessionId: string): Promise<void> {
    this.memory.delete(sessionId);
    await rm(this.directory(sessionId), { recursive: true, force: true }).catch(() => undefined);
  }

  /** Number of files waiting in a session (tests and diagnostics). */
  pending(sessionId: string): number {
    return this.memory.get(sessionId)?.size ?? 0;
  }
}
