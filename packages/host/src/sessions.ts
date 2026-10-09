import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseEventLines, type ExtaliaEvent } from '@extalia/protocol';
import { appendLine, CorruptFileError, isNotFound, readJson, writeJsonAtomic } from './jsonStore.js';

export interface SessionRecord {
  id: string;
  workspaceId: string;
  connectionId: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
}

export type SessionPatch = Partial<Omit<SessionRecord, 'id'>>;

export const SESSION_ID_PATTERN = /^s_[a-z0-9]{6,40}$/;

/** `s_` + time + randomness in base36: sortable by creation and safe in file names. */
export function newSessionId(now = Date.now()): string {
  const random = BigInt(`0x${randomBytes(8).toString('hex')}`).toString(36).padStart(13, '0');
  return `s_${now.toString(36)}${random}`;
}

export function checkSessionId(id: string): string {
  if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) throw new Error('Invalid session id.');
  return id;
}

function isRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && SESSION_ID_PATTERN.test(record.id)
    && ['workspaceId', 'connectionId', 'title', 'createdAt', 'lastActiveAt'].every(key => typeof record[key] === 'string');
}

/**
 * Session index plus per-session files:
 * `index.json` (records), `<id>.events.jsonl` (Extalia Protocol events) and
 * `<id>.messages.json` (the model history the service keeps; opaque here).
 */
export class SessionStore {
  private readonly indexFile: string;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(readonly directory: string) {
    this.indexFile = path.join(directory, 'index.json');
  }

  /** Run one task at a time per key, so read-modify-write cycles and appends never interleave. */
  private serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(key) ?? Promise.resolve()).then(task);
    const tail = result.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
    return result;
  }

  private async readIndex(): Promise<SessionRecord[]> {
    const data = await readJson<unknown>(this.indexFile, []);
    if (!Array.isArray(data)) throw new CorruptFileError(this.indexFile, 'expected a list of sessions');
    return data.filter(isRecord);
  }

  private file(id: string, suffix: 'events.jsonl' | 'messages.json'): string {
    return path.join(this.directory, `${checkSessionId(id)}.${suffix}`);
  }

  /** Most recently active first. */
  async list(): Promise<SessionRecord[]> {
    await this.queues.get('index');
    const records = await this.readIndex();
    return records.sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0));
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    checkSessionId(id);
    return (await this.list()).find(record => record.id === id);
  }

  create(record: SessionRecord): Promise<SessionRecord> {
    checkSessionId(record.id);
    if (!isRecord(record)) return Promise.reject(new Error('A session record needs workspaceId, connectionId, title, createdAt and lastActiveAt.'));
    return this.serialize('index', async () => {
      const records = await this.readIndex();
      if (records.some(item => item.id === record.id)) throw new Error(`Session ${record.id} already exists.`);
      const created = { ...record };
      await writeJsonAtomic(this.indexFile, [...records, created]);
      return created;
    });
  }

  update(id: string, patch: SessionPatch): Promise<SessionRecord> {
    checkSessionId(id);
    return this.serialize('index', async () => {
      const records = await this.readIndex();
      const index = records.findIndex(item => item.id === id);
      if (index === -1) throw new Error(`Session ${id} does not exist.`);
      const updated = { ...records[index]!, ...patch, id };
      if (!isRecord(updated)) throw new Error('The session update has invalid fields.');
      records[index] = updated;
      await writeJsonAtomic(this.indexFile, records);
      return updated;
    });
  }

  /** Remove a session and its event and message files. Removing an unknown session does nothing. */
  remove(id: string): Promise<void> {
    checkSessionId(id);
    return this.serialize('index', async () => {
      const records = await this.readIndex();
      if (records.some(item => item.id === id)) await writeJsonAtomic(this.indexFile, records.filter(item => item.id !== id));
      await this.serialize(id, async () => {
        await rm(this.file(id, 'events.jsonl'), { force: true });
        await rm(this.file(id, 'messages.json'), { force: true });
      });
    });
  }

  appendEvent(id: string, event: ExtaliaEvent): Promise<void> {
    const file = this.file(id, 'events.jsonl');
    return this.serialize(id, () => appendLine(file, JSON.stringify(event)));
  }

  /** Valid events in file order. Lines that are not valid protocol events (for example a torn last line) are skipped. */
  async readEvents(id: string): Promise<ExtaliaEvent[]> {
    const file = this.file(id, 'events.jsonl');
    await this.queues.get(id);
    let content: string;
    try { content = await readFile(file, 'utf8'); }
    catch (error) { if (isNotFound(error)) return []; throw error; }
    return parseEventLines(content).flatMap(entry => (entry.result.ok ? [entry.result.event] : []));
  }

  async readMessages(id: string): Promise<unknown[]> {
    const file = this.file(id, 'messages.json');
    await this.queues.get(id);
    const data = await readJson<unknown>(file, []);
    if (!Array.isArray(data)) throw new CorruptFileError(file, 'expected a list of messages');
    return data;
  }

  writeMessages(id: string, messages: readonly unknown[]): Promise<void> {
    const file = this.file(id, 'messages.json');
    return this.serialize(id, () => writeJsonAtomic(file, messages));
  }
}
