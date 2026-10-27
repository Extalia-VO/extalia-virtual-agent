import { decodePortableSession, generateFullName, isContextUsage, safeLabel, safeText, type MemberGender, type PortableSession } from '@extalia/core';
import { claudeAnchor, isInjectedContext, type TranscriptStep } from '@extalia/importers';
import { detectImageMimeType, normalizeAgentIdentity, type AttachmentPreview, type HookPrivacyOptions, type SessionContextUsage, type SessionSummary } from '@extalia/platform';
import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { open, readFile, rm, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { HermesDashboardClient, parseHermesDashboardUrl } from './hermesDashboard.js';
import { HOOK_APP_LABELS, HOOK_SOURCE_IDS, hookProtocolEvents, hookSource, isHookApp, type HookApp, type NormalizedHook } from './hooks/normalize.js';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import type { NativeImportService, NativeObservationRef, ObservedRead } from './nativeImport.js';
import { sessionContext } from './sessionContext.js';
import { checkSessionId, newSessionId } from './sessions.js';
import { latestTurn, transcriptEvents } from './transcriptEvents.js';

/** Sessions the user picked by hand. */
const MAX_OBSERVATIONS = 10;
/** Automatically discovered sessions kept live; older ones are retired to history (LRU). */
export const MAX_AUTO_OBSERVATIONS = 24;
/** Automatic discovery adds sessions whose transcript changed within this window. */
const DISCOVERY_WINDOW_MS = 10 * 60 * 1000;
const MAX_IGNORED = 500;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const DASHBOARD_LOCATION_ID = 'loc-hermes-dashboard';
/** Folders whose sessions are not observed automatically unless the user removes them: claude-mem's helper sessions. */
export const DEFAULT_IGNORE_FOLDERS: readonly string[] = ['~/.claude-mem'];
const MAX_IGNORE_FOLDERS = 50;

/** Validated ignored folders: absolute or `~`-relative, without trailing separators, deduplicated. Throws for invalid input. */
export function normalizeIgnoreFolders(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_IGNORE_FOLDERS) throw new Error(`Enter at most ${MAX_IGNORE_FOLDERS} folders.`);
  const folders: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('Invalid folder.');
    let folder = item.trim();
    if (!folder) continue;
    if (folder.length > 1000 || /[\0\r\n]/.test(folder)) throw new Error('Invalid folder.');
    if (!(folder === '~' || /^~[\\/]/.test(folder) || path.isAbsolute(folder))) throw new Error('Enter a full folder path or one starting with ~/.');
    while (folder.length > 1 && /[\\/]$/.test(folder) && !/^[A-Za-z]:[\\/]$/.test(folder)) folder = folder.slice(0, -1);
    if (!folders.includes(folder)) folders.push(folder);
  }
  return folders;
}
interface ObservationRecord {
  id: string; title: string; reference: NativeObservationRef; watching: boolean;
  createdAt: string; lastActiveAt: string; projectPath?: string;
  /** Added by automatic discovery; subject to the LRU limit. */
  auto?: boolean;
  /** Registered or fed by an agent app's hooks. A hook-only record has an empty `reference.path`. */
  hook?: { app: HookApp };
  /** The lead's generated full name and gender, kept for the life of the observation. */
  agentName?: string; agentGender?: MemberGender;
  /** The lead's newest model: the latest of the transcript's and the hooks' reports (`modelAt`, ISO time of that report). */
  model?: string;
  modelAt?: string;
  /** Claude Code: the first message uuid of the transcript; a continued conversation's new file copies it (see `continuation`). */
  anchor?: string;
  /** The lead's context in use, read from the transcript's usage reports (v0.0.48). */
  context?: SessionContextUsage;
  /** The title the source gave last; while the title still equals it (not renamed), it follows the source. */
  sourceTitle?: string;
}
/** Hooks active for a session in this host run: they are its live channel, transcript events only fill history before `since`. */
interface HookLive {
  app: HookApp; since: string; lastAt: string; events: ExtaliaEvent[]; subagents?: Set<string>;
  /** v0.0.38: sub-agents whose transcript label/model were merged into the hook stream. */
  identified?: Set<string>;
}
interface Live {
  snapshot?: PortableSession; steps?: TranscriptStep[]; eventIds?: Set<string>; lastEventAt?: string;
  revision: string; sourceRevision?: string; status: 'watching' | 'paused' | 'unavailable'; lastCheckedAt?: string; error?: string;
  hook?: HookLive;
}
interface DiscoverySettings {
  schema: 'extalia.observer-discovery.v1';
  /** Locations whose new sessions are watched automatically. */
  locations: Record<string, { enabledAt: string }>;
  /** Sessions deleted or retired by the user/LRU: re-added only when their source changes after this time (epoch ms). */
  ignored: Record<string, number>;
  /** When true, drop prompt text, assistant replies and tool output from outside apps. */
  labelsOnly?: boolean;
  /** Optional local Hermes dashboard URL (`http://127.0.0.1:9119`) for read-only session discovery and polling. */
  hermesDashboardUrl?: string;
  /** Folders whose sessions are not observed automatically; absent means `DEFAULT_IGNORE_FOLDERS`. */
  ignoreFolders?: string[];
}
export interface ObservationHooks {
  /** Keeps a retired observation in history (the library). Throwing keeps the observation. */
  retire?: (session: PortableSession) => Promise<void>;
  /** True for sources that must not be added automatically (for example sessions Extalia itself runs). */
  skip?: (reference: NativeObservationRef, context?: { cwd?: string }) => boolean | Promise<boolean>;
  /** Injected fetch for testing Hermes dashboard polling. */
  fetch?: typeof fetch;
  /** Home folder that `~` in ignored folders stands for (default: the user's). */
  homeDirectory?: string;
  /** Agent names used elsewhere in the Office (managed sessions, teams), so observed leads get unique names. */
  takenNames?: () => readonly string[] | Promise<readonly string[]>;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceKey = (ref: NativeObservationRef) => `${ref.locationId}:${ref.nativeSessionId}`;
const sameSession = (a: NativeObservationRef, b: NativeObservationRef) => a.sourceId === b.sourceId && a.nativeSessionId === b.nativeSessionId;
/** Identifies the same step reported by a hook and by the transcript. */
function stepKey(event: ExtaliaEvent): string | undefined {
  const body = event.body;
  if ((body.type === 'tool.started' || body.type === 'tool.completed') && body.toolCallId) return `${body.type}:${body.toolCallId}`;
  if (body.type === 'prompt.submitted') return `prompt:${body.text.slice(0, 500)}`;
  if (body.type === 'model.completed') return `reply:${body.text.slice(0, 500)}`;
  return undefined;
}
/** The lead's newest model: a report replaces the stored one only when it is at least as new (a tie goes to the later report). */
function reportModel(record: ObservationRecord, model: string | undefined, at: string | undefined): boolean {
  const time = at ? Date.parse(at) : Number.NaN;
  if (!model || !Number.isFinite(time)) return false;
  if (record.modelAt !== undefined && time < Date.parse(record.modelAt)) return false;
  const modelAt = new Date(time).toISOString();
  if (record.model === model && record.modelAt === modelAt) return false;
  record.model = model; record.modelAt = modelAt;
  return true;
}
const LEAD_MODEL_EVENTS: ReadonlySet<string> = new Set(['session.started', 'model.completed', 'turn.completed']);
/** When the lead's transcript last stated a model (its newest model-bearing event), else its last message. */
function transcriptModelAt(events: readonly ExtaliaEvent[], snapshot: PortableSession): string | undefined {
  let latest: number | undefined;
  for (const event of events) {
    if ((event.agentId ?? 'primary') !== 'primary' || !LEAD_MODEL_EVENTS.has(event.body.type) || !(event.body as { model?: unknown }).model) continue;
    const at = Date.parse(event.at);
    if (Number.isFinite(at) && (latest === undefined || at >= latest)) latest = at;
  }
  return latest !== undefined ? new Date(latest).toISOString() : snapshot.lastMessageAt;
}
const CLAUDE_SOURCE = 'claude-code';
const ANCHOR_HEAD_BYTES = 1024 * 1024;
/** Claude Code's anchor (see `claudeAnchor`), read from the first megabyte of the transcript. */
async function headAnchor(file: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(ANCHOR_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, ANCHOR_HEAD_BYTES, 0);
    return claudeAnchor(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch { return undefined; } finally { await handle?.close().catch(() => undefined); }
}

const emptySettings = (): DiscoverySettings => ({ schema: 'extalia.observer-discovery.v1', locations: {}, ignored: {} });

function decodeSettings(raw: unknown): DiscoverySettings {
  const settings = emptySettings();
  if (!raw || typeof raw !== 'object') return settings;
  const value = raw as Partial<DiscoverySettings>;
  for (const [id, entry] of Object.entries(value.locations ?? {})) {
    if (/^loc-[\w-]{1,80}$/.test(id) && entry && Number.isFinite(Date.parse(entry.enabledAt))) settings.locations[id] = { enabledAt: entry.enabledAt };
  }
  // Before v0.0.37 large transcripts were ignored for good; they are now observed through a window, so those marks are dropped.
  for (const [key, at] of Object.entries(value.ignored ?? {}).slice(0, MAX_IGNORED)) if (typeof at === 'number' && Number.isFinite(at) && at < Number.MAX_SAFE_INTEGER) settings.ignored[key] = at;
  if (typeof value.labelsOnly === 'boolean') settings.labelsOnly = value.labelsOnly;
  if (typeof value.hermesDashboardUrl === 'string' && value.hermesDashboardUrl.trim()) {
    try { settings.hermesDashboardUrl = parseHermesDashboardUrl(value.hermesDashboardUrl); } catch { /* ignore invalid saved URL */ }
  }
  if (value.ignoreFolders !== undefined) {
    try { settings.ignoreFolders = normalizeIgnoreFolders(value.ignoreFolders); } catch { /* an invalid saved list keeps the default */ }
  }
  return settings;
}

/** Only opt-in transcripts are polled. Native files are never modified or executed. */
export class Observations {
  private records: ObservationRecord[] = [];
  private live = new Map<string, Live>();
  private settings = emptySettings();
  private settingsStamp?: number;
  private settingsLoaded = false;
  private dashboard?: { url: string; client: HermesDashboardClient };
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private refreshing?: Promise<void>;
  private saving: Promise<unknown> = Promise.resolve();
  private hookChain: Promise<unknown> = Promise.resolve();
  private hookCounter = 0;
  private hookSaveTimer?: ReturnType<typeof setTimeout>;
  private skippedHooks = new Set<string>();
  private constructor(private directory: string, private source: NativeImportService, private emit: (event: ExtaliaEvent) => void, private hooks: ObservationHooks) {}

  static async create(directory: string, source: NativeImportService, emit: (event: ExtaliaEvent) => void, intervalMs = 2000, hooks: ObservationHooks = {}): Promise<Observations> {
    const service = new Observations(directory, source, emit, hooks);
    const raw = await readJson<unknown>(service.index(), []);
    if (!Array.isArray(raw) || raw.length > MAX_OBSERVATIONS + MAX_AUTO_OBSERVATIONS) throw new Error('The observer registry is invalid. Existing data was preserved.');
    for (const item of raw) {
      if (!item || typeof item !== 'object') throw new Error('Invalid observer record.');
      const record = item as ObservationRecord;
      checkSessionId(record.id);
      if (record.hook !== undefined && !isHookApp(record.hook?.app)) delete record.hook;
      const identity = normalizeAgentIdentity(record.agentName, record.agentGender);
      delete record.agentName; delete record.agentGender;
      if (identity.agentName && identity.agentGender) Object.assign(record, identity);
      if (record.model !== undefined && (typeof record.model !== 'string' || !safeLabel(record.model, 120))) delete record.model;
      if (record.modelAt !== undefined && (typeof record.modelAt !== 'string' || !Number.isFinite(Date.parse(record.modelAt)))) delete record.modelAt;
      if (record.anchor !== undefined && (typeof record.anchor !== 'string' || !record.anchor || record.anchor.length > 200)) delete record.anchor;
      if (record.context !== undefined && !isContextUsage(record.context)) delete record.context;
      if (record.sourceTitle !== undefined && typeof record.sourceTitle !== 'string') delete record.sourceTitle;
      if (typeof record.title !== 'string' || typeof record.watching !== 'boolean' || !record.reference || (record.auto !== undefined && typeof record.auto !== 'boolean') ||
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
    await service.syncSettings();
    // Observations saved before v0.0.37 get a lead name now, oldest first.
    if (service.records.some(record => !record.agentName)) {
      for (const record of [...service.records].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) await service.name(record);
      await service.save();
    }
    await service.refresh();
    service.timer = setInterval(() => { void service.refresh().catch(() => undefined); }, Math.max(10, intervalMs));
    service.timer.unref();
    return service;
  }

  private index() { return path.join(this.directory, 'observations.json'); }
  private settingsFile() { return path.join(this.directory, 'observer-discovery.json'); }
  private file(id: string) { return path.join(this.directory, 'observed', `${checkSessionId(id)}.json`); }
  private revision(session: PortableSession) { return digest({ messages: session.messages, startedAt: session.startedAt, lastMessageAt: session.lastMessageAt, workspace: session.workspace }); }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The observer host is closed.'));
    const next = this.chain.then(async () => { await this.syncSettings(); return work(); }); this.chain = next.catch(() => undefined); return next;
  }
  /** Saves run one after another, each writing the records as they are when it starts. */
  private save() {
    const next = this.saving.then(() => writeJsonAtomic(this.index(), this.records, { mode: 0o600 }));
    this.saving = next.catch(() => undefined);
    return next;
  }
  private async saveSettings() {
    await writeJsonAtomic(this.settingsFile(), this.settings, { mode: 0o600 });
    this.settingsStamp = await this.settingsMtime();
  }
  private settingsMtime() { return stat(this.settingsFile()).then(info => info.mtimeMs, () => undefined); }
  /**
   * `extalia connect` (a separate process) may change discovery settings while
   * this host runs; re-read them whenever the file changed so neither side
   * loses the other's update.
   */
  private async syncSettings() {
    const stamp = await this.settingsMtime();
    if (this.settingsLoaded && stamp === this.settingsStamp) return;
    // Discovery preferences are not user content; a damaged file only resets them.
    this.settings = decodeSettings(await readJson<unknown>(this.settingsFile(), undefined).catch(() => undefined));
    this.settingsStamp = stamp;
    this.settingsLoaded = true;
  }
  /** Picks up settings written by another process, e.g. auto-watch enabled by `extalia connect`. */
  reloadSettings(): Promise<void> { return this.serialize(async () => undefined); }
  private ignore(key: string, at: number) {
    this.settings.ignored[key] = at;
    const entries = Object.entries(this.settings.ignored);
    if (entries.length > MAX_IGNORED) this.settings.ignored = Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_IGNORED));
  }
  has(id: string) { return this.records.some(record => record.id === id); }
  /** Give an observed lead a full name unique in the Office, generated from its session id. */
  private async name(record: ObservationRecord) {
    if (record.agentName && record.agentGender) return;
    let others: readonly string[];
    try { others = (await this.hooks.takenNames?.()) ?? []; } catch { others = []; }
    const taken = new Set([...others, ...this.records.filter(item => item !== record && item.agentName).map(item => item.agentName!)].map(name => name.toLowerCase()));
    const identity = generateFullName(record.id, taken);
    record.agentName = identity.name; record.agentGender = identity.gender;
  }
  /** Folders whose sessions are not observed automatically. */
  ignoreFolders(): string[] { return [...(this.settings.ignoreFolders ?? DEFAULT_IGNORE_FOLDERS)]; }
  /** True when `folder` lies in an ignored folder. */
  ignoredPath(folder: string | undefined): boolean {
    if (!folder || !path.isAbsolute(folder)) return false;
    const home = this.hooks.homeDirectory ?? homedir();
    const fold = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const target = fold(path.resolve(folder));
    return this.ignoreFolders().some(entry => {
      const base = fold(path.resolve(entry === '~' ? home : /^~[\\/]/.test(entry) ? path.join(home, entry.slice(2)) : entry));
      return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
    });
  }
  /** Automatic observations inside ignored folders leave the live list (they are not kept in History). */
  private async sweepIgnored() {
    for (const record of this.records.filter(item => item.auto && this.ignoredPath(item.projectPath))) await this.retire(record, false);
  }
  /** Location ids whose new sessions are watched automatically. */
  autoWatching(): string[] { return Object.keys(this.settings.locations); }
  labelsOnly(): boolean { return Boolean(this.settings.labelsOnly); }
  hermesDashboardUrl(): string | undefined { return this.settings.hermesDashboardUrl; }

  private dashboardClient(): HermesDashboardClient | undefined {
    const url = this.settings.hermesDashboardUrl;
    if (!url) { this.dashboard = undefined; return undefined; }
    if (this.dashboard?.url !== url) {
      this.dashboard = { url, client: new HermesDashboardClient({ baseUrl: url, ...(this.hooks.fetch ? { fetch: this.hooks.fetch } : {}) }) };
    }
    return this.dashboard.client;
  }

  /** Update outside-agent privacy ("labels only") and the optional local Hermes dashboard read URL. */
  setPrivacy(options: HookPrivacyOptions): Promise<void> {
    return this.serialize(async () => {
      if (options.labelsOnly !== undefined) {
        if (typeof options.labelsOnly !== 'boolean') throw new Error('Invalid labelsOnly option.');
        if (options.labelsOnly) this.settings.labelsOnly = true;
        else delete this.settings.labelsOnly;
      }
      if (options.hermesDashboardUrl !== undefined) {
        const raw = options.hermesDashboardUrl?.trim() ?? '';
        if (!raw) {
          delete this.settings.hermesDashboardUrl;
          this.dashboard = undefined;
        } else {
          this.settings.hermesDashboardUrl = parseHermesDashboardUrl(raw);
        }
      }
      if (options.ignoreFolders !== undefined) {
        if (options.ignoreFolders === null) delete this.settings.ignoreFolders;
        else this.settings.ignoreFolders = normalizeIgnoreFolders(options.ignoreFolders);
      }
      await this.saveSettings();
      if (options.ignoreFolders !== undefined) await this.sweepIgnored();
    }).then(async () => {
      if (this.settings.hermesDashboardUrl) await this.refresh();
    });
  }

  summaries(): SessionSummary[] {
    return this.records.map(record => {
      const live = this.live.get(record.id)!;
      const channel = live.hook ? 'hook' as const : record.reference.locationId === DASHBOARD_LOCATION_ID ? 'dashboard' as const : 'transcript' as const;
      const model = record.model;
      return { id: record.id, workspaceId: '', connectionId: '', title: record.title, createdAt: record.createdAt, lastActiveAt: record.lastActiveAt, control: 'observed', running: false,
        ...normalizeAgentIdentity(record.agentName, record.agentGender), ...(model ? { model } : {}),
        observation: { sourceId: record.reference.sourceId, nativeSessionId: safeLabel(record.reference.nativeSessionId, 200), watching: record.watching, status: live.status, channel,
          ...(record.projectPath ? { projectPath: record.projectPath } : {}), ...(live.lastCheckedAt ? { lastCheckedAt: live.lastCheckedAt } : {}), ...(live.error ? { error: live.error } : {}),
          ...(live.lastEventAt ? { lastEventAt: live.lastEventAt } : {}), ...(record.auto ? { auto: true } : {}), ...(live.hook || record.hook ? { hook: true } : {}) },
        ...(record.context ? { context: record.context } : {}) };
    });
  }
  snapshot(id: string): PortableSession {
    const snapshot = this.live.get(id)?.snapshot;
    if (!snapshot) throw new Error('This observed transcript is not available yet.');
    return structuredClone(snapshot);
  }
  private derive(record: ObservationRecord, live: Pick<Live, 'snapshot' | 'steps'>): ExtaliaEvent[] {
    return transcriptEvents({
      sessionId: record.id, runtime: record.reference.sourceId, title: record.title, createdAt: record.createdAt,
      ...(record.projectPath ? { cwd: record.projectPath } : {}), steps: live.steps ?? [],
      labelsOnly: this.labelsOnly(), nowMs: Date.now(), keepAttachment: data => this.keepAttachment(record.id, data),
    });
  }
  /** Private copies of images that observed prompts embed: `<data>/observed-files/<sessionId>/<sha256>`. */
  private attachmentFolder(id: string) { return path.join(this.directory, 'observed-files', checkSessionId(id)); }
  private keptAttachments = new Set<string>();
  /** Keep an embedded image (PNG, JPEG, WebP or GIF only) and return its SHA-256; anything else is not kept. */
  private keepAttachment(id: string, data: string): string | undefined {
    try {
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length || !detectImageMimeType(bytes)) return undefined;
      const ref = createHash('sha256').update(bytes).digest('hex');
      const file = path.join(this.attachmentFolder(id), ref);
      if (this.keptAttachments.has(file)) return ref;
      if (!existsSync(file)) {
        mkdirSync(this.attachmentFolder(id), { recursive: true, mode: 0o700 });
        writeFileSync(file, bytes, { mode: 0o600 });
      }
      this.keptAttachments.add(file);
      return ref;
    } catch { return undefined; }
  }
  /** An image an observed prompt embedded, by the reference its event carries. */
  async attachment(id: string, ref: string): Promise<AttachmentPreview | undefined> {
    if (!/^[0-9a-f]{64}$/.test(ref) || !this.records.some(item => item.id === id)) return undefined;
    let bytes: Buffer;
    try { bytes = await readFile(path.join(this.attachmentFolder(id), ref)); } catch { return undefined; }
    const mimeType = detectImageMimeType(bytes);
    return mimeType ? { mimeType, data: bytes.toString('base64') } : undefined;
  }
  events(id: string): ExtaliaEvent[] {
    const record = this.records.find(item => item.id === id);
    if (!record) throw new Error('That observed session no longer exists.');
    const live = this.live.get(id);
    const history = this.history(record, live);
    const hook = live?.hook;
    if (!hook?.events.length) return history;
    // Hooks are the live channel; the transcript supplies history steps that hooks never reported (e.g. final assistant reply, earlier history).
    const reported = new Set(hook.events.map(stepKey).filter(Boolean));
    const unhooked = history.filter(event => !reported.has(stepKey(event)));
    const started = unhooked.some(event => event.body.type === 'session.started');
    const filteredHooks = hook.events.filter(event => !(started && event.body.type === 'session.started'));
    return [...unhooked, ...filteredHooks].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }
  private history(record: ObservationRecord, live: Live | undefined): ExtaliaEvent[] {
    const id = record.id;
    if (live?.steps) return this.derive(record, live);
    // Only the saved conversation is known (the source has not been read since the host started).
    const snapshot = live?.snapshot;
    const source = { runtime: record.reference.sourceId, channel: 'transcript' as const, adapter: 'native-transcript' };
    const make = (body: EventBody, at: string, seq: number) => createEvent({ id: `observed-${digest([id, seq, at, body])}`, at, seq, sessionId: id, source, body });
    const started = make({ type: 'session.started', control: 'observed', title: record.title, ...(record.projectPath ? { cwd: record.projectPath } : {}) }, record.createdAt, 0);
    if (this.labelsOnly()) return [started];
    return [started,
      ...(snapshot?.messages ?? []).map((message, index) => make(message.role === 'user'
        ? { type: 'prompt.submitted', via: 'native', text: safeText(message.content, 180_000) }
        : message.role === 'assistant' ? { type: 'model.completed', text: safeText(message.content, 180_000) }
          : { type: 'tool.output', text: safeText(message.content, 180_000) }, message.createdAt, index + 1))];
  }
  private notify(record: ObservationRecord) {
    const live = this.live.get(record.id)!;
    this.emit(createEvent({ sessionId: record.id, source: { runtime: record.reference.sourceId, channel: 'transcript', adapter: 'native-transcript' },
      body: { type: 'session.updated', revision: digest([live.revision, live.lastEventAt, live.eventIds?.size, live.status, record.watching, record.title]), messageCount: live.snapshot?.messages.length ?? 0 } }));
  }
  private publish(events: readonly ExtaliaEvent[]) {
    for (const event of events) { try { this.emit(event); } catch { /* a disconnected listener must not stop polling */ } }
  }
  /**
   * Store a fresh read. Events the previous read did not have are published live;
   * `introduce` publishes the session start and its latest turn for a new observation.
   * The first read after a host start only sets the baseline, so history is not replayed live.
   */
  private async update(record: ObservationRecord, read: ObservedRead, sourceRevision?: string, introduce = false) {
    const snapshot = read.session;
    if (snapshot.messages.length > 5000 || Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) throw new Error('Live observation is limited to 5000 messages / 5 MB. Import this history instead.');
    const current = this.live.get(record.id)!;
    const revision = this.revision(snapshot), lastCheckedAt = new Date().toISOString();
    let identityChanged = false;
    if (revision !== current.revision) {
      await writeJsonAtomic(this.file(record.id), snapshot, { mode: 0o600 });
      record.lastActiveAt = snapshot.lastMessageAt;
      record.projectPath = snapshot.workspace?.projectLocation;
    }
    // Until the user renames it, the title follows the source (a custom title set later, the first typed prompt).
    // Older records follow only when their title is injected context or a hook placeholder.
    const sourceTitle = safeLabel(snapshot.title, 200);
    const follows = record.sourceTitle !== undefined ? record.title === record.sourceTitle
      : record.title === sourceTitle || isInjectedContext(record.title) || Object.values(HOOK_APP_LABELS).some(label => record.title.startsWith(`${label} · `));
    if (sourceTitle && follows && (record.title !== sourceTitle || record.sourceTitle !== sourceTitle)) { record.title = sourceTitle; record.sourceTitle = sourceTitle; identityChanged = true; }
    // The lead's model is the newest report of the transcript (its latest lead model event) and of the hooks (see `reportModel`).
    const events = this.derive(record, { steps: read.steps });
    if (reportModel(record, read.model, transcriptModelAt(events, snapshot))) identityChanged = true;
    // v0.0.48: the context follows the transcript's latest usage report; an unchanged reading keeps the stored record.
    if (read.context) {
      const contextUsage = sessionContext({ usedTokens: read.context.usedTokens, ...(read.context.windowTokens ? { windowTokens: read.context.windowTokens } : {}),
        estimated: false, compactions: read.context.compactions, model: record.model, at: new Date().toISOString(), previous: record.context });
      if (contextUsage !== record.context) { record.context = contextUsage; identityChanged = true; }
    }
    const fresh = introduce ? [events[0]!, ...latestTurn(events).filter(event => event !== events[0])]
      : current.eventIds ? events.filter(event => !current.eventIds!.has(event.id)) : [];
    const latest = this.live.get(record.id)?.hook ?? current.hook;
    // While hooks report this session live, transcript events would repeat the same steps; only history is kept.
    const transcriptAt = events.at(-1)?.at;
    const lastEventAt = latest && (!transcriptAt || latest.lastAt > transcriptAt) ? latest.lastAt : transcriptAt;
    const changed = identityChanged || revision !== current.revision || current.status !== 'watching' || fresh.length > 0 || lastEventAt !== current.lastEventAt;
    this.live.set(record.id, { snapshot, steps: read.steps, eventIds: new Set(events.map(event => event.id)), ...(lastEventAt ? { lastEventAt } : {}),
      revision, ...(sourceRevision ? { sourceRevision } : {}), status: 'watching', lastCheckedAt, ...(latest ? { hook: latest } : {}) });
    const identities = latest ? this.identities(record, latest, events) : [];
    if (changed) { await this.save(); if (!latest) this.publish(fresh); this.notify(record); }
    if (identities.length && record.watching) this.publish(identities);
  }
  /** Claude Code's anchor of a validated transcript reference (other sources never continue a conversation this way). */
  private async anchorFor(reference: NativeObservationRef): Promise<string | undefined> {
    if (reference.sourceId !== CLAUDE_SOURCE || !reference.path) return undefined;
    return headAnchor(reference.path);
  }
  /** A record's anchor, read once and kept on the record. */
  private async anchorOf(record: ObservationRecord): Promise<string | undefined> {
    if (record.anchor !== undefined) return record.anchor;
    const anchor = await this.anchorFor(record.reference);
    if (anchor) record.anchor = anchor;
    return anchor;
  }
  /** A record's conversation as its transcript is now; the stored snapshot when the file cannot be read (a hook-only record). */
  private async currentSnapshot(record: ObservationRecord): Promise<PortableSession | undefined> {
    try { return this.source.readObservation(record.reference).session; } catch { return this.live.get(record.id)?.snapshot; }
  }
  private async birth(reference: NativeObservationRef): Promise<number | undefined> {
    if (!reference.path) return undefined;
    try { const info = await stat(reference.path); return info.birthtimeMs > 0 ? info.birthtimeMs : undefined; } catch { return undefined; }
  }
  /**
   * v0.0.49: a continued Claude Code conversation is a new transcript file that starts with copies of the earlier
   * file's rows (the same uuids, so the same anchor), and the earlier file stops being written. Both files are one
   * conversation when the earlier one's last message is not after the later file was created. The later file then
   * takes over the record (`successor`); an earlier file read after its successor is a stale copy (`!successor`).
   * Two branches that both keep being written stay separate, as do sessions without an anchor.
   */
  private async continuation(reference: NativeObservationRef, snapshot: PortableSession, anchor: string | undefined):
    Promise<{ record: ObservationRecord; successor: boolean } | undefined> {
    if (!anchor || !snapshot.messages.length || reference.sourceId !== CLAUDE_SOURCE) return undefined;
    const ownBirth = await this.birth(reference), ownLast = Date.parse(snapshot.lastMessageAt);
    if (ownBirth === undefined || !Number.isFinite(ownLast)) return undefined;
    for (const record of this.records) {
      if (record.reference.sourceId !== reference.sourceId || sameSession(record.reference, reference)) continue;
      if ((await this.anchorOf(record)) !== anchor) continue;
      // The earlier file as it is now: a message written since the last poll counts.
      const other = await this.currentSnapshot(record);
      if (!other?.messages.length) continue;
      const otherBirth = await this.birth(record.reference), otherLast = Date.parse(other.lastMessageAt);
      if (otherBirth === undefined || !Number.isFinite(otherLast)) continue;
      if (otherBirth < ownBirth && otherLast <= ownBirth) return { record, successor: true };
      if (ownBirth < otherBirth && ownLast <= otherBirth) return { record, successor: false };
    }
    return undefined;
  }
  /** The record takes over the native session that continues its conversation; the earlier one stays ignored until it changes. */
  private async adopt(record: ObservationRecord, reference: NativeObservationRef, read: ObservedRead, revision: string) {
    const previous = record.reference;
    record.reference = reference;
    this.ignore(sourceKey(previous), Date.now());
    await this.saveSettings();
    await this.update(record, read, revision);
  }
  /**
   * A hook from a session that no record has yet: when it continues a known conversation, the record takes it over (the
   * continuing file) or keeps it (an earlier file the hook reports from); otherwise the caller creates a record.
   */
  private async linkHook(reference: NativeObservationRef): Promise<ObservationRecord | undefined> {
    if (reference.sourceId !== CLAUDE_SOURCE || !reference.path) return undefined;
    let revision: string, read: ObservedRead;
    try { revision = this.source.observationRevision(reference); read = this.source.readObservation(reference); } catch { return undefined; }
    const continued = await this.continuation(reference, read.session, await this.anchorFor(reference));
    if (!continued) return undefined;
    if (continued.successor) await this.adopt(continued.record, reference, read, revision);
    return continued.record;
  }
  /**
   * v0.0.38: hooks give a live session's timing and states; its transcript (Claude Code `subagents/agent-<id>`
   * files and their meta) names its sub-agents and their models. For each sub-agent the hooks reported, the
   * transcript's announcement is merged into the hook stream once (hook `agent_id` = transcript agent id).
   */
  private identities(record: ObservationRecord, hook: HookLive, events: readonly ExtaliaEvent[]): ExtaliaEvent[] {
    if (!hook.subagents?.size) return [];
    const merged: ExtaliaEvent[] = [];
    const at = new Date().toISOString();
    for (const event of events) {
      const body = event.body;
      if (body.type !== 'subagent.spawned' || !hook.subagents.has(body.subagentId) || hook.identified?.has(body.subagentId)) continue;
      if (!body.label && !body.role && !body.model) continue;
      (hook.identified ??= new Set()).add(body.subagentId);
      try {
        merged.push(createEvent({ id: `hook-${record.id}-${++this.hookCounter}-identity`, at, sessionId: record.id, agentId: event.agentId ?? 'primary', source: event.source,
          body: { type: 'subagent.spawned', subagentId: body.subagentId, ...(body.label ? { label: body.label } : {}), ...(body.role ? { role: body.role } : {}), ...(body.model ? { model: body.model } : {}) } }));
      } catch { /* not a valid event */ }
    }
    hook.events.push(...merged);
    return merged;
  }
  observe(scanId: string, candidateIds: string[]): Promise<void> {
    return this.serialize(async () => {
      if (!Array.isArray(candidateIds) || !candidateIds.length || candidateIds.length > MAX_OBSERVATIONS) throw new Error(`Select 1–${MAX_OBSERVATIONS} sessions to observe.`);
      const selected = [...new Set(candidateIds)].map(id => this.source.observation(scanId, id));
      const manual = this.records.filter(record => !record.auto);
      if (manual.length + selected.filter(item => !manual.some(record => sameSession(record.reference, item.reference))).length > MAX_OBSERVATIONS) throw new Error(`Observe at most ${MAX_OBSERVATIONS} sessions. Delete an old observation first.`);
      for (const item of selected) {
        if (item.session.messages.length > 5000 || Buffer.byteLength(JSON.stringify(item.session)) > MAX_SNAPSHOT_BYTES) throw new Error('This history is too large for live observation. Import it instead.');
      }
      for (const { reference, session, steps, model, context } of selected) {
        let record = this.records.find(item => sameSession(item.reference, reference));
        const created = !record;
        if (!record) {
          record = { id: newSessionId(), reference, title: safeLabel(session.title, 200), watching: true, createdAt: session.startedAt, lastActiveAt: session.lastMessageAt };
          await this.name(record);
          this.records.push(record); this.live.set(record.id, { revision: 'empty', status: 'watching' });
        }
        // A hook can register the native session before its transcript location is known.
        // Selecting that transcript attaches it to the existing character.
        record.reference = reference;
        // Picking a session by hand keeps it out of the automatic LRU.
        record.watching = true; delete record.auto;
        await this.update(record, { session, steps, ...(model ? { model } : {}), ...(context ? { context } : {}) }, undefined, created);
      }
      await this.save();
    });
  }
  /** Add recently changed sessions of opted-in locations and the optional Hermes dashboard, then retire LRU overflow. */
  private async discover() {
    const enabled = this.autoWatching();
    if (enabled.length) {
      const found = this.source.discover(enabled, Date.now() - DISCOVERY_WINDOW_MS, MAX_AUTO_OBSERVATIONS).sort((a, b) => b.updatedAt - a.updatedAt);
      for (const item of found) {
        const key = sourceKey(item.reference);
        const known = () => this.records.some(record => sourceKey(record.reference) === key || sameSession(record.reference, item.reference));
        if (known() || (this.settings.ignored[key] ?? -Infinity) >= item.updatedAt || this.ignoredPath(item.projectPath)) continue;
        if (await this.hooks.skip?.(item.reference)) continue;
        // Hooks may have registered the session meanwhile.
        if (known()) continue;
        let revision: string, read: ObservedRead;
        // A transcript that has no conversation yet is tried again on the next poll.
        try { revision = this.source.observationRevision(item.reference); read = this.source.readObservation(item.reference); } catch { continue; }
        if (read.session.messages.length > 5000 || Buffer.byteLength(JSON.stringify(read.session)) > MAX_SNAPSHOT_BYTES) { this.ignore(key, Number.MAX_SAFE_INTEGER); await this.saveSettings(); continue; }
        if (this.ignoredPath(read.session.workspace?.projectLocation)) continue;
        // A continued conversation is the same character: its earlier file takes over or is dropped, no new record.
        const continued = await this.continuation(item.reference, read.session, await this.anchorFor(item.reference));
        if (continued) {
          if (continued.successor) await this.adopt(continued.record, item.reference, read, revision);
          else { this.ignore(key, Date.now()); await this.saveSettings(); }
          continue;
        }
        const record: ObservationRecord = { id: newSessionId(), reference: item.reference, title: safeLabel(read.session.title, 200), watching: true,
          createdAt: read.session.startedAt, lastActiveAt: read.session.lastMessageAt, auto: true };
        await this.name(record);
        this.records.push(record); this.live.set(record.id, { revision: 'empty', status: 'watching' });
        await this.update(record, read, revision, true);
      }
    }
    const dash = this.dashboardClient();
    if (dash) {
      try {
        const since = Date.now() - DISCOVERY_WINDOW_MS;
        const sessions = await dash.listSessions();
        for (const meta of sessions.slice(0, MAX_AUTO_OBSERVATIONS)) {
          const updatedMs = Date.parse(meta.updatedAt) || Date.now();
          if (updatedMs < since) continue;
          const reference: NativeObservationRef = { locationId: DASHBOARD_LOCATION_ID, sourceId: 'hermes', nativeSessionId: meta.id, path: '' };
          const key = sourceKey(reference);
          const known = () => this.records.some(record => sourceKey(record.reference) === key || sameSession(record.reference, reference));
          if (known() || (this.settings.ignored[key] ?? -Infinity) >= updatedMs || this.ignoredPath(meta.cwd)) continue;
          if (await this.hooks.skip?.(reference, meta.cwd ? { cwd: meta.cwd } : undefined)) continue;
          if (known()) continue;
          try {
            const read = await dash.readSession(meta.id, { sessionMeta: meta });
            const record: ObservationRecord = {
              id: newSessionId(), reference, title: safeLabel(read.session.title, 200), watching: true,
              createdAt: read.session.startedAt, lastActiveAt: read.session.lastMessageAt,
              ...(meta.cwd ? { projectPath: meta.cwd } : {}), auto: true,
            };
            await this.name(record);
            this.records.push(record);
            this.live.set(record.id, { revision: 'empty', status: 'watching' });
            await this.update(record, { session: read.session, steps: read.steps }, `dash:${read.cursor}`, true);
          } catch { /* skip unreadable dashboard session */ }
        }
      } catch { /* dashboard down or unreachable; retried on next poll */ }
    }
    await this.sweepIgnored();
    await this.trim();
  }
  /** Retire the least recently active automatic observations beyond the LRU limit. */
  private async trim() {
    const activity = (record: ObservationRecord) => Math.max(Date.parse(record.lastActiveAt), Date.parse(this.live.get(record.id)?.lastEventAt ?? '') || 0);
    const overflow = this.records.filter(record => record.auto).sort((a, b) => activity(b) - activity(a)).slice(MAX_AUTO_OBSERVATIONS);
    for (const record of overflow) await this.retire(record);
  }
  /** `archive` keeps the conversation in History; ignored-folder noise is dropped instead. */
  private async retire(record: ObservationRecord, archive = true) {
    const snapshot = this.live.get(record.id)?.snapshot, before = this.records;
    // Leave the live list first so the session never shows in both places at once.
    this.records = this.records.filter(item => item.id !== record.id);
    if (archive && snapshot && this.hooks.retire) {
      try { await this.hooks.retire(structuredClone(snapshot)); } catch { this.records = before; return; }
    }
    this.ignore(sourceKey(record.reference), Date.now());
    const live = this.live.get(record.id)!;
    this.live.delete(record.id);
    await this.saveSettings(); await this.save(); await rm(this.file(record.id), { force: true });
    await rm(this.attachmentFolder(record.id), { recursive: true, force: true });
    // Tells views to reload the session list; the native session itself is unaffected.
    this.emit(createEvent({ sessionId: record.id, source: { runtime: record.reference.sourceId, channel: 'transcript', adapter: 'native-transcript' },
      body: { type: 'session.updated', revision: digest(['retired', live.revision]), messageCount: live.snapshot?.messages.length ?? 0 } }));
  }
  refresh(): Promise<void> {
    // One pending poll at most: slow disks must not build an interval backlog.
    if (this.refreshing) return this.refreshing;
    const pending = this.serialize(async () => {
      try { await this.discover(); } catch { /* discovery is retried on the next poll */ }
      const dash = this.dashboardClient();
      for (const record of this.records.filter(item => item.watching)) {
        if (record.reference.locationId === DASHBOARD_LOCATION_ID) {
          if (!dash) continue;
          try {
            const read = await dash.readSession(record.reference.nativeSessionId);
            await this.update(record, { session: read.session, steps: read.steps }, `dash:${read.cursor}`);
          } catch { /* keep last known state while dashboard is unreachable */ }
          continue;
        }
        // Hook-only sessions have no transcript to read.
        if (!record.reference.path) continue;
        // Records made before v0.0.37 may point at a Codex sub-agent thread: they now follow its root session.
        if (record.reference.sourceId === 'codex') {
          const { subagentId, ...root } = this.source.rootReference(record.reference);
          if (subagentId) {
            if (this.records.some(item => item !== record && sameSession(item.reference, root))) {
              this.records = this.records.filter(item => item !== record); this.live.delete(record.id);
              await this.save(); await rm(this.file(record.id), { force: true });
              await rm(this.attachmentFolder(record.id), { recursive: true, force: true });
              continue;
            }
            record.reference = root; await this.save();
          }
        }
        try {
          const revision = this.source.observationRevision(record.reference);
          const live = this.live.get(record.id)!;
          if (live.sourceRevision === revision && live.snapshot && live.steps) {
            const recovered = live.status !== 'watching';
            this.live.set(record.id, { ...live, status: 'watching', error: undefined, lastCheckedAt: new Date().toISOString() });
            if (recovered) this.notify(record);
          } else await this.update(record, this.source.readObservation(record.reference), revision);
        }
        catch (error) {
          const live = this.live.get(record.id)!;
          // Hooks keep the session live; a transcript that is not written yet (or not readable) only means no history.
          if (live.hook) { this.live.set(record.id, { ...live, lastCheckedAt: new Date().toISOString() }); continue; }
          const message = safeText(error instanceof Error ? error.message : 'The transcript could not be read.', 600);
          const changed = live.status !== 'unavailable' || live.error !== message;
          this.live.set(record.id, { ...live, status: 'unavailable', error: message, lastCheckedAt: new Date().toISOString() });
          if (changed) this.notify(record);
        }
      }
    });
    this.refreshing = pending;
    void pending.finally(() => { if (this.refreshing === pending) this.refreshing = undefined; }).catch(() => undefined);
    return pending;
  }
  /** Opt a history location in or out of automatic discovery. Existing observations stay. */
  setAutoWatch(locationId: string, enabled: boolean): Promise<void> {
    return this.serialize(async () => {
      if (typeof locationId !== 'string' || typeof enabled !== 'boolean') throw new Error('Invalid location.');
      if (enabled) {
        if (!this.source.autoWatchable(locationId)) throw new Error('New sessions of this history location cannot be watched automatically.');
        this.settings.locations[locationId] ??= { enabledAt: new Date().toISOString() };
      } else delete this.settings.locations[locationId];
      await this.saveSettings();
    }).then(async () => { if (enabled) await this.refresh(); });
  }
  /** Enable automatic transcript discovery for a connected app's primary locations (graceful fallback per PRD G3). */
  enableAutoWatchForApp(app: HookApp): Promise<void> {
    return this.serialize(async () => {
      const sourceId = HOOK_SOURCE_IDS[app];
      const nowIso = new Date().toISOString();
      let added = false;
      for (const location of this.source.locations()) {
        if (location.sourceId !== sourceId || !this.source.autoWatchable(location.id)) continue;
        if (location.label.toLowerCase().includes('archived')) continue;
        if (!this.settings.locations[location.id]) {
          this.settings.locations[location.id] = { enabledAt: nowIso };
          added = true;
        }
      }
      if (added) await this.saveSettings();
    }).then(async () => { await this.refresh(); });
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
      const clean = safeLabel(title, 200); if (!clean) throw new Error('Enter a title.');
      record.title = clean;
      await this.save(); this.notify(record);
    });
  }
  remove(id: string): Promise<void> {
    return this.serialize(async () => {
      const record = this.records.find(item => item.id === id);
      // A deleted session is not discovered again until its transcript changes.
      if (record) { this.ignore(sourceKey(record.reference), Date.now()); await this.saveSettings(); }
      this.records = this.records.filter(item => item.id !== id); this.live.delete(id);
      await this.save(); await rm(this.file(id), { force: true });
      await rm(this.attachmentFolder(id), { recursive: true, force: true });
    });
  }
  receiveHook(hook: NormalizedHook): Promise<void> {
    if (this.closed) return Promise.resolve();
    const task = () => this.serialize(async () => {
      if (hook.sessionId === 'extalia-connect-test' || hook.event === 'ExtaliaConnectTest') {
        const sourceId = HOOK_SOURCE_IDS[hook.app];
        const nowIso = new Date().toISOString();
        let added = false;
        for (const location of this.source.locations()) {
          if (location.sourceId !== sourceId || !this.source.autoWatchable(location.id)) continue;
          if (location.label.toLowerCase().includes('archived')) continue;
          if (!this.settings.locations[location.id]) {
            this.settings.locations[location.id] = { enabledAt: nowIso };
            added = true;
          }
        }
        if (added) await this.saveSettings();
        return;
      }
      const sourceId = HOOK_SOURCE_IDS[hook.app];
      const skipKey = `${sourceId}:${hook.sessionId}`;
      if (this.skippedHooks.has(skipKey)) return;
      if (!this.records.some(r => r.reference.sourceId === sourceId && r.reference.nativeSessionId === hook.sessionId)) {
        const skip = await this.hooks.skip?.(
          { locationId: `hook-${hook.app}`, sourceId, nativeSessionId: hook.sessionId, path: hook.transcriptPath ?? '' },
          hook.cwd ? { cwd: hook.cwd } : undefined,
        );
        if (skip) {
          this.skippedHooks.add(skipKey);
          return;
        }
      }
      const direct = this.source.hookReference(sourceId, hook.sessionId, hook.transcriptPath, hook.profile)
        ?? { locationId: `hook-${hook.app}`, sourceId, nativeSessionId: hook.sessionId, path: '' };
      // A Codex sub-agent thread reports into the session that spawned it, as that session's sub-agent.
      const { subagentId, ...reference } = this.source.rootReference(direct);
      const at = new Date().toISOString();
      let record = this.records.find(item => sameSession(item.reference, reference));
      // A session the hooks have not reported before may continue a known conversation (Claude Code; see `continuation`).
      if (!record && !subagentId) record = await this.linkHook(reference);
      // Sessions in ignored folders are not observed automatically (a session picked by hand still is).
      if (this.ignoredPath(hook.cwd) && (!record || record.auto)) return;
      const titleHint = this.labelsOnly() ? undefined : hook.titleHint;
      if (!record) {
        record = {
          id: newSessionId(),
          reference,
          title: (subagentId ? undefined : titleHint) ?? `${HOOK_APP_LABELS[hook.app]} · ${reference.nativeSessionId.slice(0, 24)}`,
          watching: true,
          createdAt: at,
          lastActiveAt: at,
          ...(hook.cwd ? { projectPath: hook.cwd } : {}),
          auto: true,
          hook: { app: hook.app },
        };
        await this.name(record);
        this.records.push(record);
        this.live.set(record.id, { revision: 'empty', status: 'watching' });
      } else {
        if (!record.reference.path && reference.path) record.reference = reference;
        record.hook = { app: hook.app };
        record.lastActiveAt = at;
        if (hook.cwd) record.projectPath = hook.cwd;
        if (titleHint && !subagentId && record.title.startsWith(`${HOOK_APP_LABELS[hook.app]} · `)) record.title = titleHint;
      }
      if (hook.model && !subagentId) reportModel(record, safeLabel(hook.model, 120), at);
      const live = this.live.get(record.id)!;
      const ownSteps = subagentId
        ? hook.steps.filter(step => step.body.type !== 'session.started' && step.body.type !== 'session.ended')
          .map(step => ({ ...step, agentId: step.agentId && step.agentId !== 'primary' ? step.agentId : subagentId }))
        : hook.steps;
      const filteredSteps = this.labelsOnly()
        ? ownSteps
            .filter(step => step.body.type !== 'prompt.submitted' && step.body.type !== 'model.completed')
            .map(step => (step.body.type === 'tool.completed' && 'output' in step.body ? { ...step, body: (({ output: _out, ...rest }) => rest)(step.body) } : step))
        : ownSteps;
      const events = hookProtocolEvents({ app: hook.app, steps: filteredSteps }, {
        sessionId: record.id,
        at,
        id: index => `hook-${record.id}-${++this.hookCounter}-${index}`,
      });
      if (!live.hook) {
        live.hook = { app: hook.app, since: at, lastAt: at, events: [] };
        if (!hook.starts && !events.some(e => e.body.type === 'session.started')) {
          events.unshift(createEvent({
            id: `hook-${record.id}-${++this.hookCounter}-start`,
            at,
            sessionId: record.id,
            agentId: 'primary',
            source: hookSource(hook.app),
            body: {
              type: 'session.started',
              control: 'observed',
              title: record.title,
              ...(record.projectPath ? { cwd: record.projectPath } : {}),
              ...(hook.model ? { model: hook.model } : {}),
            },
          }));
        }
      }
      // v0.0.38: every sub-agent is announced once under its lead, before its own events, also when its start hook
      // was missed (a background Claude Code agent started before this host, or a Codex sub-agent thread).
      const announced = (live.hook.subagents ??= new Set());
      for (const event of events) if (event.body.type === 'subagent.spawned') announced.add(event.body.subagentId);
      for (let index = 0; index < events.length; index++) {
        const agent = events[index]!.agentId;
        if (!agent || agent === 'primary' || announced.has(agent)) continue;
        announced.add(agent);
        const role = subagentId ? undefined : hook.agentType;
        events.splice(index, 0, createEvent({
          id: `hook-${record.id}-${++this.hookCounter}-spawn`, at, sessionId: record.id, agentId: 'primary', source: hookSource(hook.app),
          body: { type: 'subagent.spawned', subagentId: agent, ...(role ? { role, label: role } : {}), ...(subagentId && hook.model ? { model: safeLabel(hook.model, 120) } : {}) },
        }));
        index++;
      }
      live.hook.events.push(...events);
      if (live.hook.events.length > 500) {
        // The session start and sub-agent announcements (who nests under whom, models) outlive the activity window.
        const tail = live.hook.events.slice(-480);
        const kept = new Set(tail);
        const lasting = live.hook.events.filter(e => !kept.has(e) && (e.body.type === 'session.started' || e.body.type === 'subagent.spawned')).slice(-200);
        live.hook.events = [...lasting, ...tail];
      }
      live.hook.lastAt = at;
      live.lastEventAt = at;
      if (record.watching) {
        this.publish(events);
        this.notify(record);
      }
      await this.trim();
      if (!this.hookSaveTimer) {
        this.hookSaveTimer = setTimeout(() => {
          this.hookSaveTimer = undefined;
          void this.save().catch(() => undefined);
        }, 1000);
        this.hookSaveTimer.unref?.();
      }
    });
    const next = this.hookChain.then(task, task);
    this.hookChain = next.catch(() => undefined);
    return next;
  }
  async close() {
    clearInterval(this.timer); this.closed = true;
    await this.hookChain; await this.chain;
    if (this.hookSaveTimer) { clearTimeout(this.hookSaveTimer); this.hookSaveTimer = undefined; await this.save().catch(() => undefined); }
    await this.saving;
  }
}
