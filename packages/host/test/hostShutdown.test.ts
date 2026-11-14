import { skillStoragePaths } from '../src/skillStorage.js';
import { createAgentHost } from '../src/service.js';
import type { DaemonLearningParams, ExtaliaEvent } from '@extalia/protocol';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AgentHostOptions, type AgentHostRuntime } from '../src/service.js';
import { SessionStore } from '../src/sessions.js';
import * as credentials from '../src/secrets.js';
import * as jsonStore from '../src/jsonStore.js';
import { MemoryStore } from '../src/memory.js';
import { SkillRegistry, SKILL_REGISTRY_OPS } from '../src/skillRegistry.js';
import type { DaemonClient } from '../src/daemon/index.js';
import { IntegrationQueue, WorktreeManager, type IntegrationProposal } from '../src/worktrees/index.js';
import * as connectServices from '../src/connect/service.js';
import { withConnectOperation } from '../src/connect/operationJournal.js';
import { useTempDirs } from './helpers.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof filesystem>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), open: vi.fn(actual.open), rm: vi.fn(actual.rm) };
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const answer = (text = 'Done.') => Response.json({ model: 'mock-agent', choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
const tempDir = useTempDirs();
const runtimes: AgentHostRuntime[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
  while (runtimes.length) await runtimes.pop()!.close();
});

async function setup(fetch: NonNullable<AgentHostOptions['fetch']>, history = true, memory = false, registry = false, secretStore: 'memory' | 'file' = 'memory') {
  const root = await tempDir();
  const project = path.join(root, 'project');
  await mkdir(project);
  const options: AgentHostOptions = {
    kind: 'bridge', version: '0.0.0-test', dataDirectory: path.join(root, 'data'),
    homeDirectory: path.join(root, 'home'), importHome: path.join(root, 'home'), observationIntervalMs: 60_000,
    env: { EXTALIA_SECRET_STORE: secretStore, EXTALIA_HERMES_BIN: path.join(root, 'not-installed'), ...(registry ? { EXTALIA_DAEMON_PATH: DAEMON_BINARY } : {}) }, fetch,
    ...(registry ? { nativeCore: 'rust' } : {}),
  };
  const runtime = await createAgentHost(options);
  runtimes.push(runtime);
  const saved = await runtime.host.saveConnection({
    name: 'Mock', preset: 'custom', api: 'openai-chat', baseUrl: 'https://api.example.com/v1', model: 'mock-agent', credential: { kind: 'none' },
    features: { memory: memory ? 'extalia' : 'off', skills: registry ? 'extalia' : 'off', ...(history ? {} : { history: false }) }, orchestration: { enabled: false, maxDelegations: 0, tiers: {} },
  });
  const state = await runtime.host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: saved.connections[0]!.id, permissions: { fileWrite: 'allow', commands: 'ask' } });
  const session = await runtime.host.createSession(state.workspaces[0]!.id);
  const events: ExtaliaEvent[] = [];
  runtime.host.subscribe(event => events.push(event));
  return { runtime, options, session, events, root, project, workspace: state.workspaces[0]! };
}

async function idle(runtime: AgentHostRuntime) {
  for (let index = 0; index < 200 && runtime.isBusy(); index++) await pause();
  expect(runtime.isBusy()).toBe(false);
}

async function snapshot(options: AgentHostOptions, sessionId: string) {
  const root = options.dataDirectory!;
  const files = ['config/extalia.json', 'sessions/index.json', `sessions/${sessionId}.messages.json`, `sessions/${sessionId}.events.jsonl`];
  return Promise.all(files.map(file => readFile(path.join(root, file), 'utf8').catch(() => undefined)));
}

type RpcHold = { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> };
function fakeSkillClient(holds: Partial<Record<'skill.stage' | 'skill.stageFolder' | 'skill.cleanup', RpcHold>> = {}) {
  const registryPrototype = SkillRegistry.prototype as unknown as { client(): Promise<DaemonClient> };
  const realClient = registryPrototype.client;
  let connectReal: () => Promise<DaemonClient>;
  let connected: DaemonClient | undefined;
  const request = vi.fn(async (op: string, params?: unknown, deadlineMs?: number) => {
    if (op === 'learning.process') {
      // Exercise real temporary Rust staging. Only its acknowledgement is held;
      // these host tests cover lifetime fencing, not Rust's filesystem internals.
      connected ??= await connectReal();
      const action = params as DaemonLearningParams;
      const result = await connected.request('learning.process', action, deadlineMs);
      const hold = holds[action.action as keyof typeof holds];
      if (hold) { hold.entered.resolve(); await hold.release.promise; }
      return result;
    }
    if (op === 'skill.list') return { revisions: [], indexGeneration: 0 };
    if (op === 'skill.import') throw new Error('Controlled import interruption.');
    throw new Error(`Unexpected fixture operation: ${op}`);
  });
  const client = { get usable() { return connected?.usable ?? true; }, capabilities: [...SKILL_REGISTRY_OPS, 'learning.process'], request } as unknown as DaemonClient;
  vi.spyOn(registryPrototype, 'client').mockImplementation(async function (this: typeof registryPrototype) { connectReal = realClient.bind(this); return client; });
  return request;
}

describe('host shutdown persistence fencing', () => {
  it('checkpoints the exact composed user text before inference while excluding image bytes', async () => {
    const entered = deferred(), reply = deferred<Response>();
    releases.push(() => reply.resolve(answer()));
    let sent: { messages: { role: string; content: { type: string; text?: string }[] }[] } | undefined;
    const h = await setup(async (_url, init) => { sent = JSON.parse(String(init?.body)); entered.resolve(); return reply.promise; });
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]).toString('base64');
    const attached = await h.runtime.host.uploadAttachment(h.session.id, { name: 'sample.png', mimeType: 'image/png', data: image });
    await h.runtime.host.sendPrompt(h.session.id, 'Describe the attachment.', { attachmentIds: [attached.id] });
    await entered.promise;
    const historyFile = (await snapshot(h.options, h.session.id))[2]!;
    const text = sent!.messages.at(-1)!.content.find(block => block.type === 'text')!.text;
    expect(JSON.parse(historyFile)).toEqual([{ role: 'user', text }]);
    expect(text).toContain('sent as an image');
    expect(historyFile).not.toContain(image);
    const closing = h.runtime.close();
    reply.resolve(answer());
    await closing;
  });

  it('keeps an accepted prompt and interruption, then blocks old provider writes after close/reopen/new writes', async () => {
    const entered = deferred(), oldReply = deferred<Response>();
    releases.push(() => oldReply.resolve(answer('Late old answer.')));
    let sent: { messages: { role: string; content: unknown }[] } | undefined;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)); entered.resolve(); return oldReply.promise;
    });
    const h = await setup(fetch);
    const attached = await h.runtime.host.uploadAttachment(h.session.id, { name: 'note.txt', mimeType: 'text/plain', data: Buffer.from('Attached source text.').toString('base64') });
    await h.runtime.host.sendPrompt(h.session.id, 'Original accepted prompt.', { attachmentIds: [attached.id] });
    await entered.promise;
    const before = JSON.parse((await snapshot(h.options, h.session.id))[2]!);
    expect(before).toEqual([{ role: 'user', text: sent!.messages.at(-1)!.content }]);
    expect(before[0].text).toContain('Attached source text.');
    const configBeforeClosing = (await snapshot(h.options, h.session.id))[0];
    const closing = h.runtime.close(); // The real five-second remote-provider grace must expire.
    await expect(h.runtime.host.saveProfile({ displayName: 'Refused during grace' })).rejects.toThrow(/shutting down/);
    await expect(h.runtime.host.saveConnection({ name: 'Refused during grace', preset: 'custom', api: 'openai-chat', baseUrl: 'https://api.example.com/v1', model: 'mock-agent', credential: { kind: 'stored' }, features: { memory: 'off', skills: 'off' } }, 'synthetic-fixture-key')).rejects.toThrow(/shutting down/);
    await expect(h.runtime.host.renameSession(h.session.id, 'Refused during grace')).rejects.toThrow(/shutting down/);
    await expect(h.runtime.host.createSession(h.workspace.id)).rejects.toThrow(/shutting down/);
    await expect(h.runtime.host.setWorkflow('observe')).rejects.toThrow(/shutting down/);
    expect((await snapshot(h.options, h.session.id))[0]).toBe(configBeforeClosing);
    await closing;
    const storedEvents = await h.runtime.host.sessionEvents(h.session.id);
    expect(storedEvents.some(event => event.body.type === 'prompt.submitted' && event.body.text === 'Original accepted prompt.')).toBe(true);
    expect(storedEvents.some(event => event.body.type === 'turn.failed' && event.body.error.includes('host closed before this turn settled'))).toBe(true);
    const broadcasts = h.events.length;
    const reopened = await createAgentHost({ ...h.options, fetch: async () => answer('New owner answer.') });
    runtimes.push(reopened);
    await reopened.host.renameSession(h.session.id, 'New owner title');
    await reopened.host.sendPrompt(h.session.id, 'New owner prompt.');
    await idle(reopened);
    const current = await snapshot(h.options, h.session.id);
    oldReply.resolve(answer('Late old answer.'));
    await idle(h.runtime);
    expect(await snapshot(h.options, h.session.id)).toEqual(current);
    expect(h.events).toHaveLength(broadcasts);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('persists accepted work before a held credential preflight and refuses its late continuation', async () => {
    const fetch = vi.fn(async () => answer());
    const h = await setup(fetch);
    const entered = deferred(), release = deferred<string | undefined>();
    releases.push(() => release.resolve(undefined));
    vi.spyOn(credentials, 'resolveCredential').mockImplementation(async () => { entered.resolve(); return release.promise; });
    const starting = h.runtime.host.sendPrompt(h.session.id, 'Keep the preflight prompt.');
    const rejected = expect(starting).rejects.toThrow(/shutting down/);
    await entered.promise;
    expect(JSON.parse((await snapshot(h.options, h.session.id))[2]!)).toEqual([{ role: 'user', text: 'Keep the preflight prompt.' }]);
    await h.runtime.close();
    const afterClose = await snapshot(h.options, h.session.id);
    release.resolve(undefined);
    await rejected;
    await idle(h.runtime);
    expect(await snapshot(h.options, h.session.id)).toEqual(afterClose);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('drains an admitted index write before releasing the profile lock', async () => {
    const h = await setup(async () => answer());
    const entered = deferred(), release = deferred();
    releases.push(() => release.resolve());
    const original = jsonStore.writeJsonAtomic;
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementation(async (file, value, options) => {
      if (file.endsWith('index.json') && Array.isArray(value) && value.some(record => record.title === 'Held title')) { entered.resolve(); await release.promise; }
      return original(file, value, options);
    });
    const writing = h.runtime.host.renameSession(h.session.id, 'Held title');
    await entered.promise;
    const queued = h.runtime.host.renameSession(h.session.id, 'Queued title');
    let closed = false;
    const closing = h.runtime.close().then(() => { closed = true; });
    await pause(50);
    expect(closed).toBe(false);
    await expect(createAgentHost(h.options)).rejects.toThrow(/already running/i);
    release.resolve();
    await Promise.all([writing, queued, closing]);
    const reopened = await createAgentHost(h.options);
    runtimes.push(reopened);
    expect((await reopened.host.getState()).sessions[0]!.title).toBe('Queued title');
  });

  it('admits events before their deferred append and drains them without late broadcasts', async () => {
    const h = await setup(async () => answer());
    const entered = deferred(), release = deferred();
    releases.push(() => release.resolve());
    const original = SessionStore.prototype.appendEvent;
    vi.spyOn(SessionStore.prototype, 'appendEvent').mockImplementation(async function (this: SessionStore, id, event) {
      if (event.body.type === 'session.started') { entered.resolve(); await release.promise; }
      return original.call(this, id, event);
    });
    const creating = h.runtime.host.createSession(h.workspace.id);
    await entered.promise;
    const before = h.events.length;
    let closed = false;
    const closing = h.runtime.close().then(() => { closed = true; });
    await pause(50);
    expect(closed).toBe(false);
    release.resolve();
    const [created] = await Promise.all([creating, closing]);
    expect(h.events).toHaveLength(before);
    expect((await h.runtime.host.sessionEvents(created.id)).map(event => event.body.type)).toEqual(['session.started']);
  });

  it('drains an admitted configuration save and refuses later API saves', async () => {
    const h = await setup(async () => answer());
    const entered = deferred(), release = deferred();
    releases.push(() => release.resolve());
    const original = jsonStore.writeJsonAtomic;
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementation(async (file, value, options) => {
      if (file.endsWith('extalia.json')) { entered.resolve(); await release.promise; }
      return original(file, value, options);
    });
    const writing = h.runtime.host.setWorkflow('observe');
    await entered.promise;
    let closed = false;
    const closing = h.runtime.close().then(() => { closed = true; });
    await pause(50);
    expect(closed).toBe(false);
    release.resolve();
    await Promise.all([writing, closing]);
    expect(JSON.parse((await snapshot(h.options, h.session.id))[0]!).workflow).toBe('observe');
    await expect(h.runtime.host.saveProfile({ displayName: 'Late profile change' })).rejects.toThrow(/shutting down/);
    await expect(h.runtime.host.renameSession(h.session.id, 'Late title')).rejects.toThrow(/shutting down/);
  });

  it('does not infer when reading or persisting the accepted history fails', async () => {
    const fetch = vi.fn(async () => answer());
    const h = await setup(fetch);
    const read = vi.spyOn(SessionStore.prototype, 'readMessages').mockRejectedValueOnce(new Error('History read failed.'));
    await expect(h.runtime.host.sendPrompt(h.session.id, 'Cannot read history.')).rejects.toThrow('History read failed.');
    await idle(h.runtime); // The initial session-start append may still be draining.
    read.mockRestore();
    vi.spyOn(SessionStore.prototype, 'writeMessages').mockRejectedValueOnce(new Error('History write failed.'));
    await expect(h.runtime.host.sendPrompt(h.session.id, 'Cannot save history.')).rejects.toThrow('History write failed.');
    await idle(h.runtime);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not infer or retain a busy reservation when strict prompt-event persistence fails', async () => {
    const fetch = vi.fn(async () => answer());
    const h = await setup(fetch);
    const original = SessionStore.prototype.appendEvent;
    vi.spyOn(SessionStore.prototype, 'appendEvent').mockImplementation(async function (this: SessionStore, id, event) {
      if (event.body.type === 'prompt.submitted') throw new Error('Prompt event write failed.');
      return original.call(this, id, event);
    });
    await expect(h.runtime.host.sendPrompt(h.session.id, 'Keep the failed-checkpoint text.')).rejects.toThrow('Prompt event write failed.');
    expect(h.runtime.isBusy()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse((await snapshot(h.options, h.session.id))[2]!)[0].text).toBe('Keep the failed-checkpoint text.');
  });

  it('waits for an already invoked memory writer without waiting forever on a remote provider', async () => {
    const entered = deferred(), release = deferred();
    releases.push(() => release.resolve());
    const original = MemoryStore.prototype.write;
    vi.spyOn(MemoryStore.prototype, 'write').mockImplementation(async function (this: MemoryStore, ...args) {
      entered.resolve(); await release.promise; return original.apply(this, args);
    });
    const fetch = vi.fn(async () => Response.json({ model: 'mock-agent', choices: [{ message: { content: '', tool_calls: [{ id: 'm1', type: 'function', function: { name: 'memory_write', arguments: JSON.stringify({ name: 'shutdown-note', content: 'Accepted local write.', expected_revision: null }) } }] }, finish_reason: 'tool_calls' }] }));
    const h = await setup(fetch, true, true);
    await h.runtime.host.sendPrompt(h.session.id, 'Save a note.');
    await entered.promise;
    let closed = false;
    const closing = h.runtime.close().then(() => { closed = true; });
    await pause(5_100);
    expect(closed).toBe(false);
    await expect(createAgentHost(h.options)).rejects.toThrow(/already running/i);
    release.resolve();
    await closing;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await new MemoryStore(path.join(h.options.dataDirectory!, 'workspaces', h.workspace.id, 'memory')).read('shutdown-note')).toBe('Accepted local write.');
  });

  it('holds the profile lock for an invoked file write that ignores abort', async () => {
    const entered = deferred(), release = deferred();
    releases.push(() => release.resolve());
    const actual = await vi.importActual<typeof filesystem>('node:fs/promises');
    let descriptorClosed = false;
    vi.spyOn(filesystem, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await actual.open(file, flags, mode);
      if (String(file).endsWith('held-write.txt')) {
        const write = handle.writeFile.bind(handle), close = handle.close.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementation(async (data, options) => {
          entered.resolve(); await release.promise;
          return write(data, options);
        });
        vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); descriptorClosed = true; });
      }
      return handle;
    });
    const fetch = vi.fn(async () => Response.json({ model: 'mock-agent', choices: [{ message: { content: '', tool_calls: [{ id: 'f1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'held-write.txt', content: 'Accepted file write.' }) } }] }, finish_reason: 'tool_calls' }] }));
    const h = await setup(fetch);
    await h.runtime.host.sendPrompt(h.session.id, 'Save a file.');
    await entered.promise;
    let closed = false;
    const closing = h.runtime.close().then(() => { closed = true; });
    await pause(5_100);
    expect(closed).toBe(false);
    expect(descriptorClosed).toBe(false);
    await expect(createAgentHost(h.options)).rejects.toThrow(/already running/i);
    release.resolve();
    await closing;
    expect(descriptorClosed).toBe(true);
    expect(await readFile(path.join(h.project, 'held-write.txt'), 'utf8')).toBe('Accepted file write.');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps accepted transient prompts off disk through shutdown', async () => {
    const entered = deferred(), reply = deferred<Response>();
    releases.push(() => reply.resolve(answer()));
    const h = await setup(async () => { entered.resolve(); return reply.promise; }, false);
    await h.runtime.host.sendPrompt(h.session.id, 'TRANSIENT_SHUTDOWN_TEXT');
    await entered.promise;
    const closing = h.runtime.close();
    reply.resolve(answer());
    await closing;
    const files = await readdir(h.options.dataDirectory!, { recursive: true, withFileTypes: true });
    for (const file of files.filter(entry => entry.isFile())) expect(await readFile(path.join(file.parentPath, file.name), 'utf8').catch(() => '')).not.toContain('TRANSIENT_SHUTDOWN_TEXT');
    expect((await h.runtime.host.sessionEvents(h.session.id)).some(event => event.body.type === 'prompt.submitted')).toBe(true);
  });

  it.skipIf(!HAS_DAEMON || process.platform === 'win32')('drains chat skill staging and its finally cleanup after the provider grace expires', async () => {
    const stageEntered = deferred(), stageRelease = deferred(), cleanupEntered = deferred(), cleanupRelease = deferred();
    releases.push(() => { stageRelease.resolve(); cleanupRelease.resolve(); });
    const registryCalls = fakeSkillClient({
      'skill.stage': { entered: stageEntered, release: stageRelease },
      'skill.cleanup': { entered: cleanupEntered, release: cleanupRelease },
    });
    const fetch = vi.fn(async () => Response.json({ model: 'mock-agent', choices: [{ message: { content: '', tool_calls: [{ id: 's1', type: 'function', function: { name: 'skill_propose', arguments: JSON.stringify({ name: 'shutdown-review', description: 'Review a change', instructions: 'Read the diff and report evidence.' }) } }] }, finish_reason: 'tool_calls' }] }));
    const h = await setup(fetch, true, false, true);
    await h.runtime.host.sendPrompt(h.session.id, '/learn-skill Save a review draft.');
    await stageEntered.promise;
    const inbox = skillStoragePaths(h.options.dataDirectory!).imports;
    const [staged] = await readdir(inbox);
    expect(staged).toBeDefined();
    expect(await readFile(path.join(inbox, staged!, 'SKILL.md'), 'utf8')).toContain('Read the diff and report evidence.');
    const idleNotification = vi.fn();
    h.runtime.onIdle(idleNotification);
    let closed = false;
    const closing = h.runtime.close().then(() => { closed = true; });
    await pause(5_100);
    expect(closed).toBe(false);
    await expect(createAgentHost(h.options)).rejects.toThrow(/already running/i);
    await expect(h.runtime.host.importSkill!({ kind: 'folder', path: h.project })).rejects.toThrow(/shutting down/);
    stageRelease.resolve();
    await cleanupEntered.promise;
    expect(closed).toBe(false);
    expect(h.runtime.isBusy()).toBe(true);
    expect(await readdir(inbox)).toEqual([]);
    await expect(createAgentHost(h.options)).rejects.toThrow(/already running/i);
    await expect(h.runtime.host.inspectSkill!(`skr_${'a'.repeat(64)}`)).rejects.toThrow(/shutting down/);
    cleanupRelease.resolve();
    await closing;
    expect(await readdir(inbox)).toEqual([]);
    expect(registryCalls.mock.calls.filter(([op, params]) => op === 'learning.process' && (params as DaemonLearningParams).action === 'skill.stage')).toHaveLength(1);
    expect(registryCalls.mock.calls.filter(([op, params]) => op === 'learning.process' && (params as DaemonLearningParams).action === 'skill.cleanup')).toHaveLength(1);
    expect(registryCalls.mock.calls.filter(([op]) => op === 'skill.import')).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(idleNotification).not.toHaveBeenCalled();
    const reopened = await createAgentHost(h.options);
    runtimes.push(reopened);
    await reopened.host.saveProfile({ displayName: 'New profile owner' });
    await expect(h.runtime.host.importSkill!({ kind: 'folder', path: h.project })).rejects.toThrow(/shutting down/);
  });

  it.skipIf(!HAS_DAEMON || process.platform === 'win32')('drains a human skill import held in Rust staging and refuses new registry mutations', async () => {
    const entered = deferred(), release = deferred(), cleanupEntered = deferred(), cleanupRelease = deferred();
    releases.push(() => { release.resolve(); cleanupRelease.resolve(); });
    const registryCalls = fakeSkillClient({
      'skill.stageFolder': { entered, release },
      'skill.cleanup': { entered: cleanupEntered, release: cleanupRelease },
    });
    const h = await setup(async () => answer(), true, false, true);
    const actual = await vi.importActual<typeof filesystem>('node:fs/promises');
    const source = path.join(h.root, 'skill-source');
    await mkdir(source);
    await actual.writeFile(path.join(source, 'SKILL.md'), '---\nname: fixture-skill\ndescription: Review a change\n---\nRead the diff.\n');
    const importing = h.runtime.host.importSkill!({ kind: 'folder', path: source });
    const rejected = expect(importing).rejects.toThrow('Controlled import interruption.');
    await entered.promise;
    expect(h.runtime.isBusy()).toBe(true);
    let closed = false;
    const closing = h.runtime.close().then(() => { closed = true; });
    await pause(50);
    expect(closed).toBe(false);
    await expect(createAgentHost(h.options)).rejects.toThrow(/already running/i);
    await expect(h.runtime.host.inspectSkill!(`skr_${'a'.repeat(64)}`)).rejects.toThrow(/shutting down/);
    release.resolve();
    await cleanupEntered.promise;
    expect(closed).toBe(false);
    expect(h.runtime.isBusy()).toBe(true);
    await expect(createAgentHost(h.options)).rejects.toThrow(/already running/i);
    await expect(h.runtime.host.importSkill!({ kind: 'folder', path: source })).rejects.toThrow(/shutting down/);
    cleanupRelease.resolve();
    await Promise.all([rejected, closing]);
    expect(await readdir(skillStoragePaths(h.options.dataDirectory!).imports)).toEqual([]);
    expect(registryCalls.mock.calls.filter(([op]) => op === 'skill.import')).toHaveLength(1);
    const reopened = await createAgentHost(h.options);
    runtimes.push(reopened);
    await reopened.host.saveProfile({ displayName: 'New owner after import' });
    expect(h.runtime.isBusy()).toBe(false);
  });

  it.each(['remove', 'propose', 'apply'] as const)('drains an admitted user worktree %s mutation and denies late admission', async action => {
    const h = await setup(async () => answer());
    const entered = deferred(), release = deferred();
    releases.push(() => release.resolve());
    const registryFile = path.join(h.options.dataDirectory!, 'state', action === 'remove' ? 'worktrees.json' : 'integrations.json');
    const mutate = async () => {
      entered.resolve(); await release.promise;
      await jsonStore.writeJsonAtomic(registryFile, action === 'remove' ? { schema: 'extalia.worktrees.v1', worktrees: [] } : { schema: 'extalia.integrations.v1', proposals: [] });
    };
    const proposal = { id: 'i-fixture' } as IntegrationProposal;
    if (action === 'remove') vi.spyOn(WorktreeManager.prototype, 'remove').mockImplementation(mutate);
    else if (action === 'propose') vi.spyOn(IntegrationQueue.prototype, 'propose').mockImplementation(async () => { await mutate(); return proposal; });
    else vi.spyOn(IntegrationQueue.prototype, 'apply').mockImplementation(async () => { await mutate(); return proposal; });
    const invoke = () => action === 'remove' ? h.runtime.worktrees!.remove('w-fixture')
      : action === 'propose' ? h.runtime.worktrees!.propose('w-fixture', { gate: { command: 'fixture gate' } })
      : h.runtime.worktrees!.apply('i-fixture', { diffDigest: `sha256:${'a'.repeat(64)}` });
    const writing = invoke();
    await entered.promise;
    expect(h.runtime.isBusy()).toBe(true);
    let closed = false;
    const closing = h.runtime.close().then(() => { closed = true; });
    await pause(50);
    expect(closed).toBe(false);
    await expect(createAgentHost(h.options)).rejects.toThrow(/already running/i);
    await expect(invoke()).rejects.toThrow(/shutting down/);
    release.resolve();
    await Promise.all([writing, closing]);
    const reopened = await createAgentHost(h.options);
    runtimes.push(reopened);
    await reopened.host.saveProfile({ displayName: 'New worktree owner' });
    expect(JSON.parse(await readFile(registryFile, 'utf8')).schema).toBe(action === 'remove' ? 'extalia.worktrees.v1' : 'extalia.integrations.v1');
  });

  it.each(['set', 'delete'] as const)('drains the complete file credential %s mutation before unlocking', async action => {
    const h = await setup(async () => answer(), true, false, false, 'file');
    const input = { name: 'Credential fixture', preset: 'custom' as const, api: 'openai-chat' as const, baseUrl: 'https://api.example.com/v1', model: 'mock-agent', credential: { kind: 'stored' as const }, features: { memory: 'off' as const, skills: 'off' as const } };
    let id: string | undefined;
    if (action === 'delete') id = (await h.runtime.host.saveConnection(input, 'synthetic-fixture-key')).connections.find(connection => connection.name === input.name)!.id;
    const entered = deferred(), release = deferred();
    releases.push(() => release.resolve());
    const original = jsonStore.writeJsonAtomic;
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementation(async (file, value, options) => {
      if (file.endsWith('secrets.json')) { entered.resolve(); await release.promise; }
      return original(file, value, options);
    });
    const writing = action === 'set' ? h.runtime.host.saveConnection(input, 'synthetic-fixture-key') : h.runtime.host.deleteConnection(id!);
    const rejected = expect(writing).rejects.toThrow(/shutting down/); // Config continuation gets no new admission after the drain.
    await entered.promise;
    expect(h.runtime.isBusy()).toBe(true);
    let closed = false;
    const closing = h.runtime.close().then(() => { closed = true; });
    await pause(50);
    expect(closed).toBe(false);
    await expect(createAgentHost(h.options)).rejects.toThrow(/already running/i);
    release.resolve();
    await Promise.all([rejected, closing]);
    const reopened = await createAgentHost(h.options);
    runtimes.push(reopened);
    await reopened.host.saveProfile({ displayName: 'New credential owner' });
    const current = await snapshot(h.options, h.session.id);
    await pause();
    expect(await snapshot(h.options, h.session.id)).toEqual(current);
  });

  it('counts pending local persistence as busy, blocks vault switching and notifies idle when it drains', async () => {
    const h = await setup(async () => answer());
    const entered = deferred(), release = deferred(), notified = vi.fn();
    releases.push(() => release.resolve());
    const original = jsonStore.writeJsonAtomic;
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementation(async (file, value, options) => {
      if (file.endsWith('profile.json')) { entered.resolve(); await release.promise; }
      return original(file, value, options);
    });
    h.runtime.onIdle(notified);
    const writing = h.runtime.host.saveProfile({ displayName: 'Pending local profile write' });
    await entered.promise;
    expect(h.runtime.isBusy()).toBe(true);
    expect(notified).not.toHaveBeenCalled();
    await expect(h.runtime.host.setKnowledgeVaultRoot!(path.join(h.root, 'vault'))).rejects.toThrow(/Agent work is running/);
    release.resolve();
    await writing;
    expect(h.runtime.isBusy()).toBe(false);
    expect(notified).toHaveBeenCalledTimes(1);
    await h.runtime.close();
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it('admits an integration proposal before its asynchronous workspace-gate lookup', async () => {
    const h = await setup(async () => answer());
    const entered = deferred(), release = deferred();
    releases.push(() => release.resolve());
    const original = SessionStore.prototype.list;
    vi.spyOn(SessionStore.prototype, 'list').mockImplementation(async function (this: SessionStore) {
      entered.resolve(); await release.promise; return original.call(this);
    });
    vi.spyOn(WorktreeManager.prototype, 'get').mockReturnValue({ owner: { missionId: 'fixture-mission', taskId: 'fixture-task' } } as ReturnType<WorktreeManager['get']>);
    const propose = vi.spyOn(IntegrationQueue.prototype, 'propose').mockResolvedValue({ id: 'i-fixture' } as IntegrationProposal);
    const proposing = h.runtime.worktrees!.propose('w-fixture');
    await entered.promise;
    expect(h.runtime.isBusy()).toBe(true);
    let closed = false;
    const closing = h.runtime.close().then(() => { closed = true; });
    await pause(50);
    expect(closed).toBe(false);
    expect(propose).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([proposing, closing]);
    expect(propose).toHaveBeenCalledTimes(1);
  });

  it.each(['apply', 'disconnect'] as const)('drains an agent-app %s journal before releasing the profile lock', async action => {
    const h = await setup(async () => answer());
    const entered = deferred(), release = deferred();
    releases.push(() => release.resolve());
    const actual = await vi.importActual<typeof filesystem>('node:fs/promises');
    const originalFactory = connectServices.createConnectService;
    const fixtureTarget = path.join(h.options.homeDirectory!, 'fixture-agent', 'config.json');
    const connectDirectory = path.join(h.options.dataDirectory!, 'connect');
    const factory = vi.spyOn(connectServices, 'createConnectService').mockImplementation(context => {
      const base = originalFactory(context);
      const mutation = async () => withConnectOperation(connectDirectory, { kind: action === 'apply' ? 'connect' : 'disconnect', app: 'claude' }, { recoverCommand: 'extalia connections --recover' }, async journal => {
        await actual.mkdir(path.dirname(fixtureTarget), { recursive: true });
        await journal.record(fixtureTarget, undefined, 'fixture configuration');
        entered.resolve(); await release.promise;
        await actual.writeFile(fixtureTarget, 'fixture configuration');
        await journal.complete();
      });
      return {
        ...base,
        apply: async (app, options) => { expect(app).toBe('claude'); expect(options).toEqual({ expectedPreviewDigest: 'fixture-preview' }); await mutation(); return {} as Awaited<ReturnType<typeof base.apply>>; },
        disconnect: async app => { expect(app).toBe('claude'); await mutation(); return {} as Awaited<ReturnType<typeof base.disconnect>>; },
      };
    });
    const invoke = () => action === 'apply' ? h.runtime.host.applyAgentAppConnect('claude', { expectedPreviewDigest: 'fixture-preview' }) : h.runtime.host.disconnectAgentApp('claude');
    const changing = invoke();
    await entered.promise;
    expect(JSON.parse(await readFile(path.join(connectDirectory, 'journal.json'), 'utf8')).operation).toBe(action === 'apply' ? 'connect' : 'disconnect');
    expect(h.runtime.isBusy()).toBe(true);
    let closed = false;
    const closing = h.runtime.close().then(() => { closed = true; });
    await pause(50);
    expect(closed).toBe(false);
    await expect(createAgentHost(h.options)).rejects.toThrow(/already running/i);
    await expect(invoke()).rejects.toThrow(/shutting down/);
    release.resolve();
    await Promise.all([changing, closing]);
    await expect(readFile(path.join(connectDirectory, 'journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(connectDirectory, 'operation.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(await readFile(fixtureTarget, 'utf8')).toBe('fixture configuration');
    const reopened = await createAgentHost(h.options);
    runtimes.push(reopened);
    await reopened.host.saveProfile({ displayName: 'New connector owner' });
  });

  it('drains interrupted connector recovery cleanup through the existing journal protocol', async () => {
    const h = await setup(async () => answer());
    const actual = await vi.importActual<typeof filesystem>('node:fs/promises');
    const connectDirectory = path.join(h.options.dataDirectory!, 'connect');
    const target = path.join(h.options.homeDirectory!, 'fixture-recovery', 'config.json');
    await actual.mkdir(path.dirname(target), { recursive: true });
    await expect(withConnectOperation(connectDirectory, { kind: 'connect', app: 'claude' }, { recoverCommand: 'extalia connections --recover' }, async journal => {
      await journal.record(target, undefined, 'kept fixture configuration');
      await actual.writeFile(target, 'kept fixture configuration');
      throw new Error('Fixture interruption.');
    })).rejects.toThrow('Fixture interruption.');
    const entered = deferred(), release = deferred();
    releases.push(() => release.resolve());
    vi.spyOn(filesystem, 'rm').mockImplementation(async (file, options) => {
      if (String(file) === path.join(connectDirectory, 'journal.json')) { entered.resolve(); await release.promise; }
      return actual.rm(file, options);
    });
    const recovering = h.runtime.host.recoverAgentAppConnection!('keep');
    await entered.promise;
    let closed = false;
    const closing = h.runtime.close().then(() => { closed = true; });
    await pause(50);
    expect(closed).toBe(false);
    expect(h.runtime.isBusy()).toBe(true);
    await expect(createAgentHost(h.options)).rejects.toThrow(/already running/i);
    await expect(h.runtime.host.recoverAgentAppConnection!('rollback')).rejects.toThrow(/shutting down/);
    release.resolve();
    const [result] = await Promise.all([recovering, closing]);
    expect(result).toMatchObject({ action: 'keep', resolved: true });
    await expect(readFile(path.join(connectDirectory, 'journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(target, 'utf8')).toBe('kept fixture configuration');
  });
});
