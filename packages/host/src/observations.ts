import { decodePortableSession, safeLabel, safeText, type PortableSession } from '@extalia/core';
import type { SessionSummary } from '@extalia/platform';
import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import type { NativeImportService, NativeObservationRef } from './nativeImport.js';
import { checkSessionId, newSessionId } from './sessions.js';

const MAX_OBSERVATIONS = 10;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
interface Record {
  id: string; title: string; reference: NativeObservationRef; watching: boolean;
  createdAt: string; lastActiveAt: string; projectPath?: string;
}
interface Live { snapshot?: PortableSession; revision: string; status: 'watching' | 'paused' | 'unavailable'; lastCheckedAt?: string; error?: string }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceKey = (ref: NativeObservationRef) => `${ref.locationId}:${ref.nativeSessionId}`;

/** Only opt-in transcripts are polled. Native files are never modified or executed. */
export class Observations {
  private records: Record[] = [];
  private live = new Map<string, Live>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private constructor(private directory: string, private source: NativeImportService, private emit: (event: ExtaliaEvent) => void) {}

  static async create(directory: string, source: NativeImportService, emit: (event: ExtaliaEvent) => void, intervalMs = 4000): Promise<Observations> {
    const service = new Observations(directory, source, emit);
    const raw = await readJson<unknown>(service.index(), []);
    if (!Array.isArray(raw) || raw.length > MAX_OBSERVATIONS) throw new Error('The observer registry is invalid. Existing data was preserved.');
    for (const item of raw) {
      if (!item || typeof item !== 'object') throw new Error('Invalid observer record.');
      const record = item as Record;
      checkSessionId(record.id);
      if (typeof record.title !== 'string' || typeof record.watching !== 'boolean' || !record.reference ||
        !['locationId', 'sourceId', 'nativeSessionId', 'path'].every(key => typeof record.reference[key as keyof NativeObservationRef] === 'string') ||
        !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.lastActiveAt)) ||
        service.records.some(previous => previous.id === record.id || sourceKey(previous.reference) === sourceKey(record.reference))) throw new Error('Invalid observer record.');
      service.records.push(record);
      let snapshot: PortableSession | undefined;
      const stored = await readJson<unknown>(service.file(record.id), undefined);
      if (stored !== undefined) {
        const decoded = decodePortableSession(stored);
        if (!decoded.ok) throw new Error('An observed transcript is invalid. Existing data was preserved.');
        snapshot = decoded.value;
      }
      service.live.set(record.id, { ...(snapshot ? { snapshot } : {}), revision: snapshot ? service.revision(snapshot) : 'empty', status: record.watching ? 'watching' : 'paused' });
    }
    await service.refresh();
    service.timer = setInterval(() => { void service.refresh().catch(() => undefined); }, Math.max(10, intervalMs));
    service.timer.unref();
    return service;
  }

  private index() { return path.join(this.directory, 'observations.json'); }
  private file(id: string) { return path.join(this.directory, 'observed', `${checkSessionId(id)}.json`); }
  private revision(session: PortableSession) { return digest({ messages: session.messages, startedAt: session.startedAt, lastMessageAt: session.lastMessageAt, workspace: session.workspace }); }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The observer host is closed.'));
    const next = this.chain.then(work); this.chain = next.catch(() => undefined); return next;
  }
  private save() { return writeJsonAtomic(this.index(), this.records, { mode: 0o600 }); }
  has(id: string) { return this.records.some(record => record.id === id); }
  summaries(): SessionSummary[] {
    return this.records.map(record => {
      const live = this.live.get(record.id)!;
      return { id: record.id, workspaceId: '', connectionId: '', title: record.title, createdAt: record.createdAt, lastActiveAt: record.lastActiveAt, control: 'observed', running: false,
        observation: { sourceId: record.reference.sourceId, nativeSessionId: safeLabel(record.reference.nativeSessionId, 200), watching: record.watching, status: live.status,
          ...(record.projectPath ? { projectPath: record.projectPath } : {}), ...(live.lastCheckedAt ? { lastCheckedAt: live.lastCheckedAt } : {}), ...(live.error ? { error: live.error } : {}) } };
    });
  }
  snapshot(id: string): PortableSession {
    const snapshot = this.live.get(id)?.snapshot;
    if (!snapshot) throw new Error('This observed transcript is not available yet.');
    return structuredClone(snapshot);
  }
  events(id: string): ExtaliaEvent[] {
    const record = this.records.find(item => item.id === id);
    if (!record) throw new Error('That observed session no longer exists.');
    const snapshot = this.live.get(id)?.snapshot;
    const source = { runtime: record.reference.sourceId, channel: 'transcript' as const, adapter: 'native-transcript' };
    const make = (body: EventBody, at: string, seq: number) => createEvent({ id: `observed-${digest([id, seq, at, body])}`, at, seq, sessionId: id, source, body });
    return [make({ type: 'session.started', control: 'observed', title: record.title, ...(record.projectPath ? { cwd: record.projectPath } : {}) }, record.createdAt, 0),
      ...(snapshot?.messages ?? []).map((message, index) => make(message.role === 'user'
        ? { type: 'prompt.submitted', via: 'native', text: safeText(message.content, 180_000) }
        : message.role === 'assistant' ? { type: 'model.completed', text: safeText(message.content, 180_000) }
          : { type: 'tool.output', text: safeText(message.content, 180_000) }, message.createdAt, index + 1))];
  }
  private notify(record: Record) {
    const live = this.live.get(record.id)!;
    this.emit(createEvent({ sessionId: record.id, source: { runtime: record.reference.sourceId, channel: 'transcript', adapter: 'native-transcript' },
      body: { type: 'session.updated', revision: digest([live.revision, live.status, record.watching, record.title]), messageCount: live.snapshot?.messages.length ?? 0 } }));
  }
  private async update(record: Record, snapshot: PortableSession) {
    if (snapshot.messages.length > 5000 || Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) throw new Error('Live observation is limited to 5000 messages / 5 MB. Import this history instead.');
    const current = this.live.get(record.id)!;
    const revision = this.revision(snapshot), changed = revision !== current.revision || current.status !== 'watching';
    const lastCheckedAt = new Date().toISOString();
    if (revision !== current.revision) {
      await writeJsonAtomic(this.file(record.id), snapshot, { mode: 0o600 });
      record.lastActiveAt = snapshot.lastMessageAt;
      record.projectPath = snapshot.workspace?.projectLocation;
    }
    this.live.set(record.id, { snapshot, revision, status: 'watching', lastCheckedAt });
    if (changed) { await this.save(); this.notify(record); }
  }
  observe(scanId: string, candidateIds: string[]): Promise<void> {
    return this.serialize(async () => {
      if (!Array.isArray(candidateIds) || !candidateIds.length || candidateIds.length > MAX_OBSERVATIONS) throw new Error(`Select 1–${MAX_OBSERVATIONS} sessions to observe.`);
      const selected = [...new Set(candidateIds)].map(id => this.source.observation(scanId, id));
      if (this.records.length + selected.filter(item => !this.records.some(record => sourceKey(record.reference) === sourceKey(item.reference))).length > MAX_OBSERVATIONS) throw new Error(`Observe at most ${MAX_OBSERVATIONS} sessions. Pause or delete an old observation first.`);
      for (const item of selected) {
        if (item.session.messages.length > 5000 || Buffer.byteLength(JSON.stringify(item.session)) > MAX_SNAPSHOT_BYTES) throw new Error('This history is too large for live observation. Import it instead.');
      }
      for (const { reference, session } of selected) {
        let record = this.records.find(item => sourceKey(item.reference) === sourceKey(reference));
        if (!record) {
          record = { id: newSessionId(), reference, title: safeLabel(session.title, 200), watching: true, createdAt: session.startedAt, lastActiveAt: session.lastMessageAt };
          this.records.push(record); this.live.set(record.id, { revision: 'empty', status: 'watching' });
        }
        record.watching = true;
        await this.update(record, session);
      }
      await this.save();
    });
  }
  refresh(): Promise<void> {
    return this.serialize(async () => {
      for (const record of this.records.filter(item => item.watching)) {
        try { await this.update(record, this.source.readObservation(record.reference)); }
        catch (error) {
          const live = this.live.get(record.id)!;
          const message = safeText(error instanceof Error ? error.message : 'The transcript could not be read.', 600);
          const changed = live.status !== 'unavailable' || live.error !== message;
          this.live.set(record.id, { ...live, status: 'unavailable', error: message, lastCheckedAt: new Date().toISOString() });
          if (changed) this.notify(record);
        }
      }
    });
  }
  setWatching(id: string, watching: boolean): Promise<void> {
    return this.serialize(async () => {
      const record = this.records.find(item => item.id === id);
      if (!record || typeof watching !== 'boolean') throw new Error('Invalid observation.');
      record.watching = watching;
      const live = this.live.get(id)!;
      this.live.set(id, { ...live, status: watching ? 'watching' : 'paused', error: undefined });
      await this.save(); this.notify(record);
    }).then(async () => { if (watching) await this.refresh(); });
  }
  rename(id: string, title: string): Promise<void> {
    return this.serialize(async () => {
      const record = this.records.find(item => item.id === id);
      if (!record) throw new Error('That observed session no longer exists.');
      record.title = safeLabel(title, 200); if (!record.title) throw new Error('Enter a title.');
      await this.save(); this.notify(record);
    });
  }
  remove(id: string): Promise<void> {
    return this.serialize(async () => {
      this.records = this.records.filter(record => record.id !== id); this.live.delete(id);
      await this.save(); await rm(this.file(id), { force: true });
    });
  }
  async close() { clearInterval(this.timer); this.closed = true; await this.chain; }
}
