import { existsSync } from 'node:fs';
import { appendFile, chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_OBSERVE_WORKSPACE_ID, type ConnectionInput } from '@extalia/platform';
import type { ExtaliaEvent, WorkMemoryEntry, WorkMemoryRecord } from '@extalia/protocol';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { RustLearningBackend, type RustLearningAction, type RustLearningInputs, type RustLearningResults } from '../src/rustLearning.js';
import { skillStoragePaths } from '../src/skillStorage.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const runtimes = new Set<AgentHostRuntime>();
const importedStores = new Set<string>();
afterEach(async () => {
  for (const runtime of runtimes) await runtime.close();
  runtimes.clear();
  for (const directory of importedStores) await unlock(directory);
  importedStores.clear();
});
async function unlock(directory: string): Promise<void> {
  const info = await lstat(directory).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory)) await unlock(path.join(directory, entry));
  } else await chmod(directory, 0o600);
}
interface Body {
  model: string;
  messages: { role: string; content?: string }[];
  tools?: { function: { name: string } }[];
}
type Reply = { text: string } | { tool: string; args: Record<string, unknown> };
type StoredRecord = Omit<WorkMemoryRecord, 'entries'> & { entries: WorkMemoryEntry[] };
const system = (body: Body) => body.messages[0]?.content ?? '';
const curator = (body: Body) => system(body).startsWith('You are a bounded post-task Skills curator.');
const worker = (body: Body) => system(body).startsWith('You are a worker agent');
const suggestion = (body: Body) => system(body).startsWith('Suggest useful next user prompts');
const prompt = (body: Body) => body.messages.filter(message => message.role === 'user').at(-1)?.content ?? '';
const toolNames = (body: Body) => body.tools?.map(tool => tool.function.name) ?? [];
function response(reply: Reply, call: number): Response {
  const delta = 'tool' in reply
    ? { tool_calls: [{ index: 0, id: `call-${call}`, function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }
    : { content: reply.text };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool' in reply ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
const marker = 'The cobalt parser uses checksum window 73 and validates before saving.';
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
};
const idle = async (runtime: AgentHostRuntime) => {
  await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 10_000, interval: 10 });
};

async function fixture(options: { mode?: 'default' | 'profile' | 'isolated'; notes?: boolean; skills?: boolean } = {}) {
  const root = await temp('extalia-work-memory-service-');
  const data = path.join(root, 'data'), home = path.join(root, 'home'), project = path.join(root, 'project');
  await mkdir(home); await mkdir(project);
  await writeFile(path.join(project, 'parser.txt'), marker);
  const requests: Body[] = [], events: ExtaliaEvent[] = [], logs: string[] = [];
  let script: (body: Body, call: number, signal?: AbortSignal | null) => Response | Promise<Response> = (body, call) => {
    if (curator(body)) return response({ tool: 'submit_learning', args: { skipReason: 'No additional reusable finding in this fixture.' } }, call);
    if (prompt(body).startsWith('Inspect') && !body.messages.some(message => message.role === 'tool'))
      return response({ tool: 'read_file', args: { path: 'parser.txt' } }, call);
    return response({ text: marker }, call);
  };
  const open = async () => {
    const value = await createAgentHost({
      kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 50,
      env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_NATIVE_CORE: 'typescript', EXTALIA_DAEMON_PATH: DAEMON_BINARY,
        EXTALIA_HERMES_BIN: path.join(root, 'missing'), PATH: '' },
      daemon: { log: line => { logs.push(line); } }, knowledge: { watcher: false },
      fetch: async (url, init) => {
        if (url.endsWith('/models')) return Response.json({ data: [{ id: 'fixture-model' }, { id: 'worker-model' }] });
        const body = JSON.parse(String(init?.body)) as Body;
        requests.push(body);
        return suggestion(body) ? response({ text: '{"prompts":[]}' }, requests.length) : script(body, requests.length, init?.signal);
      },
    });
    runtimes.add(value); value.host.subscribe(event => { events.push(event); });
    return value;
  };
  let runtime = await open();
  const connectionInput: ConnectionInput = {
    name: 'Memory fixture', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'fixture-model',
    credential: { kind: 'none' }, features: { memory: 'extalia', skills: options.skills ? 'extalia' : 'off', history: true },
    orchestration: { enabled: false, maxDelegations: 0, tiers: {} },
  };
  const connection = (await runtime.host.saveConnection(connectionInput)).connections[0]!;
  const workspace = (await runtime.host.saveWorkspace({ name: 'Memory fixture', projectLocation: project, connectionId: connection.id,
    ...(options.mode === 'isolated' ? { crossWorkspaceAccess: 'isolated' } : {}), permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  const before = await runtime.host.listVaultProfiles!();
  const catalog = await runtime.host.saveVaultProfile!({ ...(options.mode === undefined || options.mode === 'default' ? { id: before.defaultProfileId } : {}),
    name: 'Memory learning fixture', vaultRoot: null, workspaceIds: [workspace.id], minutesEnabled: false,
    automaticLearning: { enabled: true, skills: options.skills ?? false, notes: options.notes ?? false }, expectedRevision: before.revision });
  const profile = catalog.profiles.find(item => item.workspaceIds.includes(workspace.id))!;
  if (options.skills) importedStores.add(skillStoragePaths(data).root);
  const session = await runtime.host.createSession(workspace.id);
  return {
    root, data, home, project, workspace, profile, connection, connectionInput, session, requests, events, logs,
    get runtime() { return runtime; }, get host() { return runtime.host; },
    setScript(next: typeof script) { script = next; },
    async restart() { const previous = runtime; await previous.close(); runtimes.delete(previous); runtime = await open(); },
    records(profileId = profile.id): StoredRecord[] {
      const file = path.join(data, 'profiles', profileId, 'work-memory.sqlite');
      if (!existsSync(file)) return [];
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        return (db.prepare('SELECT record_json FROM work_memory_records ORDER BY captured_at, id').all() as { record_json: string }[])
          .map(row => JSON.parse(row.record_json) as StoredRecord);
      } finally { db.close(); }
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function send(f: Fixture, sessionId: string, text: string) {
  const before = f.requests.length;
  await f.host.sendPrompt(sessionId, text);
  await idle(f.runtime);
  return f.requests.slice(before).filter(body => !suggestion(body) && !curator(body));
}
async function runLearning(f: Fixture, sessionId: string) {
  const snapshot = await f.host.learningSchedule!();
  const job = snapshot.jobs.find(item => item.sessionId === sessionId && item.state === 'scheduled');
  expect(job).toBeDefined();
  await f.host.changeLearningSchedule!(job!.id, snapshot.revision, 'run-now');
  await vi.waitFor(async () => expect((await f.host.learningSchedule!()).jobs.find(item => item.id === job!.id)?.state)
    .toMatch(/^(completed|partial|failed)$/), { timeout: 10_000, interval: 10 });
  await idle(f.runtime);
  return (await f.host.learningSchedule!()).jobs.find(item => item.id === job!.id)!;
}
function receipt(f: Fixture, sessionId: string) {
  return f.events.find(event => event.sessionId === sessionId && event.body.type === 'tool.completed'
    && event.body.tool === 'work_memory_capture' && event.body.ok);
}
async function observedSource(f: Fixture, global = false) {
  const nativeId = '33333333-3333-4333-8333-333333333333';
  const project = global ? path.join(f.root, 'unregistered-project') : f.project;
  if (global) await mkdir(project);
  const directory = path.join(f.home, '.codex', 'sessions'); await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'rollout-work-memory.jsonl');
  const row = (value: unknown) => `${JSON.stringify(value)}\n`;
  let sequence = 0;
  const timestamp = () => `2026-01-01T00:00:${String(sequence++).padStart(2, '0')}.000Z`;
  const message = (role: 'user' | 'assistant', text: string) => row({ timestamp: timestamp(), type: 'response_item', payload: {
    type: 'message', role, ...(role === 'assistant' ? { channel: 'final' } : {}),
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
  } });
  await writeFile(file, row({ type: 'session_meta', payload: { id: nativeId, cwd: project, timestamp: timestamp() } })
    + message('user', 'Historical backlog must not be learned on activation.') + message('assistant', 'Historical backlog response.'));
  const scan = await f.host.scanImports(['codex']);
  const imported = scan.sessions.find(item => item.nativeSessionId === nativeId) ?? scan.sessions[0]!;
  const watched = (await f.host.observeImports(scan.scanId, [imported.id])).sessions.find(item => item.observation?.nativeSessionId === nativeId)!;
  expect(watched).toBeDefined();
  const before = await f.host.listVaultProfiles!();
  await f.host.saveVaultProfile!({ id: f.profile.id, name: f.profile.name, vaultRoot: null, workspaceIds: [f.workspace.id],
    minutesEnabled: false, automaticLearning: { enabled: true, notes: false, skills: false, observed: true }, expectedRevision: before.revision });
  await idle(f.runtime);
  expect(f.records()).toEqual([]);
  expect(f.requests).toEqual([]);
  return { watched, nativeId,
    async completed(text: string) { await appendFile(file, message('user', 'Review the indigo parser procedure.') + message('assistant', text)); },
    async failed() { await appendFile(file, message('user', 'Check the indigo parser failure.')
      + row({ timestamp: timestamp(), type: 'event_msg', payload: { type: 'error', message: 'Synthetic indigo parser provider error.' } })); },
  };
}

/** Actual host lifecycle, Rust store and provider requests; completions are scripted and never billed. */
describe.skipIf(!HAS_DAEMON || process.platform === 'win32')('operational work memory through the Native host', () => {
  it('captures current work durably and recalls it automatically in a new session after host restart', async () => {
    const f = await fixture();
    await send(f, f.session.id, 'Inspect the cobalt parser procedure.');
    expect(receipt(f, f.session.id)).toBeDefined();
    expect(f.records()).toMatchObject([{ source: { kind: 'native', sessionId: f.session.id }, outcome: 'completed', trust: 'attributed-evidence' }]);
    expect(f.records()[0]!.entries.some(entry => entry.kind === 'tool' && entry.text.includes(marker))).toBe(true);
    const previousId = f.records()[0]!.id;
    await f.restart();
    const next = await f.host.createSession(f.workspace.id);
    const requests = await send(f, next.id, 'Recall cobalt parser procedure.');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.messages.filter(message => message.role === 'user')).toEqual([{ role: 'user', content: 'Recall cobalt parser procedure.' }]);
    expect(system(requests[0]!)).toContain('Operational work memory:');
    expect(system(requests[0]!)).toContain(previousId);
    expect(system(requests[0]!)).toContain(marker);
    expect(toolNames(requests[0]!)).toEqual(expect.arrayContaining(['work_memory_search', 'work_memory_read']));
    expect(f.records()).toHaveLength(2);
  });

  it('retains a Rust-committed capture when shutdown starts before its acknowledgement reaches the host', async () => {
    const f = await fixture();
    const acknowledgement = deferred();
    let committed = false;
    const original = RustLearningBackend.prototype.process;
    const delayed: RustLearningBackend['process'] = async function <A extends RustLearningAction>(this: RustLearningBackend, action: A,
      input: RustLearningInputs[A]): Promise<RustLearningResults[A]> {
      const result = await original.call(this, action, input) as RustLearningResults[A];
      if (action === 'memory.capture') { committed = true; await acknowledgement.promise; }
      return result;
    };
    const interception = vi.spyOn(RustLearningBackend.prototype, 'process').mockImplementation(delayed);
    let closing: Promise<void> | undefined;
    try {
      await f.host.sendPrompt(f.session.id, 'Inspect the cobalt parser procedure.');
      await vi.waitFor(() => expect(committed).toBe(true), { timeout: 10_000, interval: 10 });
      expect(f.records()).toHaveLength(1);
      const capturedId = f.records()[0]!.id;
      expect(receipt(f, f.session.id)).toBeUndefined();
      let closed = false;
      closing = f.runtime.close().then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false);
      acknowledgement.resolve(); await closing;
      interception.mockRestore();
      await f.restart();
      expect(f.records()).toMatchObject([{ id: capturedId, outcome: 'completed' }]);
      const session = await f.host.createSession(f.workspace.id);
      const requests = await send(f, session.id, 'Recall cobalt parser procedure.');
      expect(system(requests[0]!)).toContain(capturedId);
      expect(system(requests[0]!)).toContain(marker);
    } finally {
      acknowledgement.resolve(); await closing; interception.mockRestore();
    }
  });

  it('durably captures a Native turn cancelled by host shutdown without treating shutdown as consent withdrawal', async () => {
    const f = await fixture();
    let entered = false;
    f.setScript((_body, _call, signal) => new Promise<Response>((_resolve, reject) => {
      entered = true;
      const stop = () => reject(new DOMException('Synthetic provider aborted during shutdown.', 'AbortError'));
      if (signal?.aborted) stop();
      else signal?.addEventListener('abort', stop, { once: true });
    }));
    await f.host.sendPrompt(f.session.id, 'Review cobalt parser cancellation.');
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000, interval: 10 });
    await f.runtime.close();
    expect(f.records()).toMatchObject([{ source: { kind: 'native', sessionId: f.session.id }, outcome: 'cancelled' }]);
    const capturedId = f.records()[0]!.id;
    f.setScript((_body, call) => response({ text: 'The previous parser request was cancelled; it is not a successful execution.' }, call));
    await f.restart();
    const session = await f.host.createSession(f.workspace.id);
    const requests = await send(f, session.id, 'Recall cobalt parser cancellation.');
    expect(system(requests[0]!)).toContain(capturedId);
    expect(system(requests[0]!)).toContain('"outcome":"cancelled"');
  });

  it.each(['default', 'profile', 'isolated'] as const)('keeps %s memory out of a different workspace', async mode => {
    const f = await fixture({ mode });
    const otherProject = path.join(f.root, 'other-project'); await mkdir(otherProject);
    const state = await f.host.saveWorkspace({ name: 'Other fixture', projectLocation: otherProject, connectionId: f.connection.id,
      permissions: { fileWrite: 'ask', commands: 'ask' } });
    const other = state.workspaces.find(item => item.id !== f.workspace.id)!;
    if (mode === 'profile') {
      const catalog = await f.host.listVaultProfiles!();
      await f.host.saveVaultProfile!({ id: f.profile.id, name: f.profile.name, vaultRoot: null, workspaceIds: [f.workspace.id, other.id],
        minutesEnabled: false, automaticLearning: { enabled: true, notes: false, skills: false }, expectedRevision: catalog.revision });
    }
    await send(f, f.session.id, 'Inspect the cobalt parser procedure.');
    expect(receipt(f, f.session.id)).toBeDefined();
    const foreign = await f.host.createSession(other.id);
    const foreignRequests = await send(f, foreign.id, 'Recall cobalt parser procedure.');
    expect(system(foreignRequests[0]!)).not.toContain(marker);
    expect(system(foreignRequests[0]!)).not.toContain('Operational work memory:');
    const same = await f.host.createSession(f.workspace.id);
    const local = await send(f, same.id, 'Recall cobalt parser procedure.');
    expect(system(local[0]!)).toContain(marker);
    const captured = f.records().find(record => record.source.sessionId === f.session.id)!;
    expect(captured.scope).toMatchObject({ profileId: f.profile.id, workspaceId: f.workspace.id });
    expect(system(local[0]!)).toContain(captured.id);
  });

  it.each(['memory-off', 'history-off', 'automatic-learning-off'] as const)('stops both capture and old-memory injection after %s', async mode => {
    const f = await fixture();
    await send(f, f.session.id, 'Inspect the cobalt parser procedure.');
    expect(receipt(f, f.session.id)).toBeDefined();
    expect(f.records()).toHaveLength(1);
    if (mode === 'automatic-learning-off') {
      const catalog = await f.host.listVaultProfiles!();
      await f.host.saveVaultProfile!({ id: f.profile.id, name: f.profile.name, vaultRoot: null, workspaceIds: [f.workspace.id],
        minutesEnabled: false, automaticLearning: { enabled: false, notes: false, skills: false }, expectedRevision: catalog.revision });
    } else await f.host.saveConnection({ ...f.connectionInput, id: f.connection.id,
      features: { memory: mode === 'memory-off' ? 'off' : 'extalia', skills: 'off', history: mode !== 'history-off' } });
    const next = await f.host.createSession(f.workspace.id);
    const requests = await send(f, next.id, 'Recall cobalt parser procedure.');
    expect(requests.length).toBeGreaterThan(0);
    expect(system(requests[0]!)).not.toContain(marker);
    expect(system(requests[0]!)).not.toContain('Operational work memory:');
    expect(toolNames(requests[0]!)).not.toContain('work_memory_search');
    expect(receipt(f, next.id)).toBeUndefined();
    expect(f.records()).toHaveLength(1);
  });

  it('does not migrate an existing workspace memory into a newly selected vault profile', async () => {
    const f = await fixture({ mode: 'profile' });
    await send(f, f.session.id, 'Inspect the cobalt parser procedure.');
    const prior = f.records()[0]!;
    const before = await f.host.listVaultProfiles!();
    const catalog = await f.host.saveVaultProfile!({ name: 'Replacement learning fixture', vaultRoot: null, workspaceIds: [f.workspace.id],
      minutesEnabled: false, automaticLearning: { enabled: true, notes: false, skills: false }, expectedRevision: before.revision });
    const replacement = catalog.profiles.find(profile => profile.workspaceIds.includes(f.workspace.id))!;
    expect(replacement.id).not.toBe(f.profile.id);
    const next = await f.host.createSession(f.workspace.id);
    const requests = await send(f, next.id, 'Recall cobalt parser procedure.');
    expect(system(requests[0]!)).not.toContain(marker);
    expect(system(requests[0]!)).not.toContain(prior.id);
    expect(f.records()).toHaveLength(1);
    expect(f.records(replacement.id)).toMatchObject([{ source: { sessionId: next.id }, scope: { profileId: replacement.id } }]);
    expect(f.records(replacement.id)[0]!.scope.boundary).not.toBe(prior.scope.boundary);
  });

  it('stores a failed provider turn as failed and preserves that outcome in later context', async () => {
    const f = await fixture();
    f.setScript(() => Response.json({ error: { type: 'invalid_request_error', message: 'Synthetic parser provider rejection.' } }, { status: 400 }));
    await send(f, f.session.id, 'Inspect the cobalt parser failure.');
    expect(f.events.some(event => event.sessionId === f.session.id && event.body.type === 'turn.failed')).toBe(true);
    expect(receipt(f, f.session.id)).toBeDefined();
    expect(f.records()).toMatchObject([{ outcome: 'failed', trust: 'attributed-evidence', source: { sessionId: f.session.id } }]);
    f.setScript((_body, call) => response({ text: 'The prior parser request failed; no successful execution is claimed.' }, call));
    const next = await f.host.createSession(f.workspace.id);
    const requests = await send(f, next.id, 'Recall cobalt parser failure.');
    expect(system(requests[0]!)).toContain('"outcome":"failed"');
    expect(system(requests[0]!)).toContain('Outcome: failed.');
  });

  it('reuses prior memory in a separate curator context, publishes grounded notes and an inactive skill, then recalls the fresh note', async () => {
    const f = await fixture({ notes: true, skills: true });
    await send(f, f.session.id, 'Inspect the cobalt parser procedure.');
    expect((await runLearning(f, f.session.id)).state).toBe('completed');
    const prior = f.records().find(record => record.source.sessionId === f.session.id)!;
    const corrected = 'Validate cobalt parser input before saving. The current checksum window is 91.';
    await writeFile(path.join(f.project, 'parser.txt'), corrected);
    let submittedIds: string[] = [];
    f.setScript((body, call) => {
      if (curator(body)) {
        const evidenceText = body.messages.find(message => message.role === 'user')!.content!;
        const evidence = JSON.parse(evidenceText.slice(evidenceText.indexOf('\n') + 1)) as { id: string; name: string; content: string }[];
        submittedIds = evidence.filter(entry => entry.name === 'read_file').map(entry => entry.id);
        expect(submittedIds.length).toBeGreaterThan(0);
        expect(submittedIds).not.toContain(prior.id);
        expect(evidenceText).toContain('checksum window is 91');
        expect(evidenceText).not.toContain(prior.id);
        expect(system(body)).toContain('Operational work memory:');
        expect(system(body)).toContain(prior.id);
        expect(system(body)).toContain(marker);
        expect(toolNames(body)).toEqual(expect.arrayContaining(['work_memory_search', 'work_memory_read', 'submit_learning']));
        return response({ tool: 'submit_learning', args: { title: 'Cobalt parser validation', lesson: corrected, evidenceIds: submittedIds,
          skill: { name: 'cobalt-parser-validation', description: 'Validate the cobalt parser before saving.',
            instructions: 'Read the current parser rules. Validate the input before saving parsed data. Report validation failures and the verified checksum window.' } } }, call);
      }
      if (prompt(body).startsWith('Inspect') && !body.messages.some(message => message.role === 'tool'))
        return response({ tool: 'read_file', args: { path: 'parser.txt' } }, call);
      return response({ text: corrected }, call);
    });
    const second = await f.host.createSession(f.workspace.id);
    await send(f, second.id, 'Inspect the cobalt parser validation update.');
    const learned = await runLearning(f, second.id);
    expect(learned.state).toBe('completed');
    expect(learned.result?.knowledge).toMatchObject({ status: 'saved', indexed: true });
    expect(learned.result?.skill).toMatchObject({ kind: 'skill-candidate', profileId: f.profile.id, workspaceId: f.workspace.id,
      sessionId: second.id, activationPerformed: false });
    expect(learned.result?.skill?.state).not.toBe('active');
    const notePath = learned.result!.knowledge!.path!;
    const note = await readFile(path.join(f.profile.root, notePath), 'utf8');
    expect(note).toContain(corrected);
    const registry = await f.host.skillRegistry();
    expect(registry.revisions).toEqual(expect.arrayContaining([expect.objectContaining({ revisionId: learned.result!.skill!.revisionId,
      state: learned.result!.skill!.state, active: false })]));
    expect(submittedIds.every(id => f.events.some(event => event.sessionId === second.id && event.body.type === 'tool.completed'
      && event.body.toolCallId === id && event.body.ok))).toBe(true);
    const next = await f.host.createSession(f.workspace.id);
    const requests = await send(f, next.id, 'Cobalt parser validation procedure.');
    const knowledgeContext = system(requests[0]!).split('Relevant Knowledge / Obsidian excerpts.')[1];
    expect(knowledgeContext).toBeDefined();
    expect(knowledgeContext).toContain(notePath);
    expect(knowledgeContext).toContain('checksum window is 91');
    expect(f.requests.filter(curator)).toHaveLength(2);
  });

  it.each([
    { name: 'memory enabled', memory: 'extalia', history: true },
    { name: 'memory disabled', memory: 'off', history: true },
    { name: 'history disabled', memory: 'extalia', history: false },
  ] as const)('gates worker context, tools and raw evidence with $name', async ({ memory, history }) => {
    const f = await fixture();
    await send(f, f.session.id, 'Inspect the cobalt parser procedure.');
    const workerEvidence = 'The violet worker-only fixture uses independent checksum window 125.';
    await writeFile(path.join(f.project, 'worker.txt'), workerEvidence);
    const saved = await f.host.saveConnection({ ...f.connectionInput, name: 'Worker fixture', model: 'worker-model',
      features: { memory, skills: 'off', history } });
    const workerConnection = saved.connections.find(connection => connection.name === 'Worker fixture')!;
    f.setScript((body, call) => {
      if (worker(body)) return body.messages.some(message => message.role === 'tool')
        ? response({ text: 'Worker completed a review; no source text is repeated in this report.' }, call)
        : response({ tool: 'read_file', args: { path: 'worker.txt' } }, call);
      if (!body.messages.some(message => message.role === 'tool')) return response({ tool: 'delegate_task',
        args: { member: 'parser-reviewer', task: 'Review the cobalt parser validation procedure.' } }, call);
      return response({ text: 'Reviewed the worker finding.' }, call);
    });
    const session = await f.host.createSession(f.workspace.id, { team: { enabled: true, allowedModels: [],
      connections: [{ connectionId: workerConnection.id, allowedModels: ['worker-model'] }],
      members: [{ id: 'parser-reviewer', name: 'Parser Reviewer', role: 'Reviewer', connectionId: workerConnection.id, models: ['worker-model'] }] } });
    const requests = await send(f, session.id, 'Ask the reviewer to review the cobalt parser procedure.');
    const delegated = requests.filter(worker);
    expect(delegated).toHaveLength(2);
    expect(delegated[0]!.model).toBe('worker-model');
    const enabled = memory === 'extalia' && history;
    if (enabled) {
      expect(system(delegated[0]!)).toContain('Operational work memory:');
      expect(system(delegated[0]!)).toContain(marker);
      expect(toolNames(delegated[0]!)).toEqual(expect.arrayContaining(['work_memory_search', 'work_memory_read']));
    } else {
      expect(system(delegated[0]!)).not.toContain('Operational work memory:');
      expect(system(delegated[0]!)).not.toContain(marker);
      expect(toolNames(delegated[0]!)).not.toContain('work_memory_search');
      expect(toolNames(delegated[0]!)).not.toContain('work_memory_read');
    }
    expect(delegated[1]!.messages.some(message => message.role === 'tool' && message.content?.includes(workerEvidence))).toBe(true);
    const captured = f.records().find(record => record.source.sessionId === session.id)!;
    expect(captured).toBeDefined();
    expect(captured.entries.some(entry => entry.text.includes(workerEvidence))).toBe(enabled);
  });

  it('mirrors completed and failed Observe frames, recalls the authorized source in Native, and excludes it after watch revocation', async () => {
    const f = await fixture();
    const observed = await observedSource(f);
    expect((await f.host.observedWorkspaceLink!(observed.watched.id)).mode).toBe('automatic');
    const observedMarker = 'The indigo parser uses checksum window 83; this is an unverified observed report.';
    await observed.completed(observedMarker);
    await vi.waitFor(() => expect(f.records().filter(record => record.source.kind === 'observed')).toHaveLength(1), { timeout: 10_000, interval: 20 });
    await observed.failed();
    await vi.waitFor(() => expect(f.records().filter(record => record.source.kind === 'observed')).toHaveLength(2), { timeout: 10_000, interval: 20 });
    const retained = f.records().filter(record => record.source.kind === 'observed');
    expect(retained.map(record => record.outcome).sort()).toEqual(['completed', 'failed']);
    for (const record of retained) {
      expect(record).toMatchObject({ scope: { profileId: f.profile.id, workspaceId: f.workspace.id },
        source: { kind: 'observed', sourceId: 'codex', sessionId: observed.nativeId }, trust: 'attributed-evidence' });
      expect(record.source.accessKey).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(JSON.stringify(retained)).not.toContain('Historical backlog');
    expect(f.requests).toEqual([]);
    expect((await f.host.learningSchedule!()).jobs).toEqual([]);
    const session = await f.host.createSession(f.workspace.id);
    const requests = await send(f, session.id, 'Recall indigo parser procedure and failure.');
    expect(system(requests[0]!)).toContain(observedMarker);
    expect(system(requests[0]!)).toContain('"source":"observed"');
    expect(system(requests[0]!)).toContain('"outcome":"failed"');
    for (const record of retained) expect(system(requests[0]!)).toContain(record.id);
    await f.host.setObservation(observed.watched.id, false);
    const next = await f.host.createSession(f.workspace.id);
    const revoked = await send(f, next.id, 'Recall indigo parser procedure and failure.');
    expect(system(revoked[0]!)).not.toContain(observedMarker);
    expect(system(revoked[0]!)).not.toContain('"source":"observed"');
    for (const record of retained) expect(system(revoked[0]!)).not.toContain(record.id);
  });

  it('stores unbound Observe work in the default global scope without exposing it to an unrelated Native workspace', async () => {
    const f = await fixture();
    const observed = await observedSource(f, true);
    expect((await f.host.observedWorkspaceLink!(observed.watched.id)).mode).toBe('unbound');
    const globalMarker = 'The global indigo parser uses checksum window 97; the external source has no workspace grant.';
    await observed.completed(globalMarker);
    await vi.waitFor(() => expect(f.records()).toHaveLength(1), { timeout: 10_000, interval: 20 });
    const record = f.records()[0]!;
    expect(record).toMatchObject({ outcome: 'completed', source: { kind: 'observed', sessionId: observed.nativeId },
      scope: { profileId: f.profile.id, workspaceId: GLOBAL_OBSERVE_WORKSPACE_ID } });
    expect(f.profile.id).toBe((await f.host.listVaultProfiles!()).defaultProfileId);
    expect(JSON.stringify(record)).toContain(globalMarker);
    expect(f.requests).toEqual([]);
    expect((await f.host.learningSchedule!()).jobs).toEqual([]);
    const session = await f.host.createSession(f.workspace.id);
    const requests = await send(f, session.id, 'Recall global indigo parser procedure.');
    expect(system(requests[0]!)).not.toContain(globalMarker);
    expect(system(requests[0]!)).not.toContain(record.id);
    expect(system(requests[0]!)).not.toContain('"source":"observed"');
  });
});
