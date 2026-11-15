import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import type { HermesObservedRpcOptions } from '../src/hermesObservedControl.js';
import { pollObservedInbox } from '../src/observedInboxClient.js';
import { SessionStore } from '../src/sessions.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const active = new Set<AgentHostRuntime>();
afterEach(async () => { await Promise.all([...active].map(runtime => runtime.close())); active.clear(); });
const stamp = Date.parse('2026-01-02T03:04:05Z') / 1000;

function withDatabase<T>(file: string, action: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(file);
  try { return action(database); } finally { database.close(); }
}
function initializeDatabase(file: string) {
  withDatabase(file, database => database.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, started_at REAL); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER)'));
}
async function fixture() {
  const root = await temp('extalia-hermes-handover-host-'), home = path.join(root, 'home'), data = path.join(root, 'data');
  const project = path.join(root, 'project'), unrelated = path.join(root, 'unrelated');
  const hermesRoot = path.join(home, '.hermes'), selected = path.join(hermesRoot, 'profiles', 'team');
  await mkdir(selected, { recursive: true }); await mkdir(project); await mkdir(unrelated);
  const cwd = await realpath(project), profileHome = await realpath(selected), database = path.join(profileHome, 'state.db');
  initializeDatabase(database);
  // The same native ID in another profile must never become the created observation.
  const otherDatabase = path.join(hermesRoot, 'state.db'); initializeDatabase(otherDatabase);
  withDatabase(otherDatabase, db => db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('hermes-created-1', 'Unrelated profile row', unrelated, stamp));
  const rolloutDirectory = path.join(home, '.codex', 'sessions'); await mkdir(rolloutDirectory, { recursive: true });
  const rollout = path.join(rolloutDirectory, 'rollout.jsonl');
  await writeFile(rollout, [
    { type: 'session_meta', payload: { id: '11111111-1111-4111-8111-111111111111', cwd, timestamp: new Date(stamp * 1000).toISOString() } },
    { type: 'response_item', timestamp: new Date((stamp + 1) * 1000).toISOString(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ORIGINAL-HERMES-HANDOVER-OBJECTIVE: preserve the parser evidence.' }] } },
    { type: 'response_item', timestamp: new Date((stamp + 2) * 1000).toISOString(), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Original decision: validate all boundaries before publication.' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const beforeRollout = await readFile(rollout, 'utf8');
  const creations = new Map<string, { nativeId: string; params: Record<string, unknown> }>();
  let loseNextAck = false, instance = 'gateway-one', epoch = 7;
  const snapshot = (nativeId: string) => ({ session_id: nativeId, stored_session_id: nativeId, authority_epoch: epoch,
    replay_epoch: 'replay-one', last_sequence: 0, subscription_id: 'viewer-one', execution_generation: 0,
    running: false, messages: [], message_count: 0, pending: [], prompts: [],
    info: { desktop_protocol: 'hermes-gateway-v1', profile_id: profileHome, cwd } });
  const appendMessage = (nativeId: string, role: string, text: string) => withDatabase(database, db => {
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, ?, ?, ?, 1)').run(nativeId, role, text, stamp + 10);
  });
  const request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'runtime.describe') return { profile_id: profileHome, instance_id: instance, authority_epoch: epoch,
      capabilities: ['durable-admission-v1'], session_create: { sources: ['cli'], parameters: ['request_id', 'source', 'cwd'] } };
    if (method === 'session.create') {
      expect(params).toEqual({ request_id: expect.stringMatching(/^extalia-[a-f0-9]{64}$/), source: 'cli', cwd });
      const requestId = String(params.request_id), prior = creations.get(requestId), nativeId = prior?.nativeId ?? `hermes-created-${creations.size + 1}`;
      if (prior) expect(params).toEqual(prior.params);
      else {
        creations.set(requestId, { nativeId, params: structuredClone(params) });
        withDatabase(database, db => db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(nativeId, 'New empty Hermes conversation', cwd, stamp));
      }
      if (loseNextAck) { loseNextAck = false; throw new Error('Native creation committed, acknowledgement lost.'); }
      return snapshot(nativeId);
    }
    if (method === 'session.resume') {
      const nativeId = String(params.session_id);
      expect([...creations.values()].some(value => value.nativeId === nativeId)).toBe(true);
      expect(params).toEqual({ session_id: nativeId, omit_messages: true });
      return snapshot(nativeId);
    }
    if (method === 'prompt.submit') {
      const nativeId = String(params.session_id); expect([...creations.values()].some(value => value.nativeId === nativeId)).toBe(true);
      appendMessage(nativeId, 'user', String(params.text));
      return { ref: { profile_id: profileHome, session_id: nativeId }, admission_id: 'admission-one', sequence: 1,
        status: 'queued', authority_epoch: epoch, execution_generation: null };
    }
    throw new Error(`Unexpected native mutation or lookup: ${method}`);
  });
  const rpcFactory = vi.fn(async (options: HermesObservedRpcOptions) => {
    expect(options.expectedProfileId).toBe(profileHome); expect(options.env?.HERMES_HOME).toBe(profileHome); expect(options.profile).toBeUndefined();
    return { profileId: profileHome, instanceId: instance, request, close: vi.fn(async () => {}) };
  });
  const providerCalls: string[] = [];
  const open = async () => {
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
      env: { EXTALIA_SECRET_STORE: 'memory', PATH: '', HERMES_HOME: profileHome, EXTALIA_HERMES_BIN: process.execPath },
      observedHermesRpc: rpcFactory, observationIntervalMs: 20,
      fetch: async url => {
        if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'native-model' }] });
        providerCalls.push(String(url)); throw new Error('Handover must not invoke a model provider.');
      } });
    active.add(runtime); return runtime;
  };
  let runtime = await open();
  const connected = await runtime.host.saveConnection({ name: 'Native continuation', preset: 'custom', api: 'openai-chat', baseUrl: 'http://example.test/v1',
    model: 'native-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
  const connection = connected.connections[0]!;
  const configured = await runtime.host.saveWorkspace({ name: 'Temporary project', projectLocation: cwd, connectionId: connection.id,
    crossWorkspaceAccess: 'isolated', permissions: { fileWrite: 'ask', commands: 'ask' } });
  const workspace = configured.workspaces[0]!;
  const scan = await runtime.host.scanImports(['codex']);
  const observed = await runtime.host.observeImports(scan.scanId, scan.sessions.filter(session => session.supported).map(session => session.id));
  const source = observed.sessions.find(session => session.control === 'observed')!;
  return { root, home, data, cwd, profileHome, database, request, rpcFactory, creations, providerCalls, connection, workspace, source,
    store: new SessionStore(path.join(data, 'sessions')), appendMessage,
    get runtime() { return runtime; }, get host() { return runtime.host; },
    loseAck() { loseNextAck = true; },
    async restart() { await runtime.close(); active.delete(runtime); instance = 'gateway-after-restart'; epoch++; runtime = await open(); },
    async assertSourceUntouched() { expect(await readFile(rollout, 'utf8')).toBe(beforeRollout); },
    createdRows() { return withDatabase(database, db => db.prepare('SELECT id, cwd FROM sessions').all()); },
    messageRows() { return withDatabase(database, db => db.prepare('SELECT session_id, role, content FROM messages').all()); },
  };
}

describe('actual host Hermes destination creation and handover', () => {
  it('discovers without attaching, registers the exact empty profile session, and retains one lineage through Hermes, Native and the original Codex conversation', async () => {
    const f = await fixture(), inventory = await f.host.handoverHarnesses!(f.source.id);
    expect(inventory.harnesses.find(harness => harness.id === 'hermes')).toMatchObject({ create: 'setup-required', creationProfile: 'team' });
    expect(f.rpcFactory).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
    const created = await f.host.createHandoverDestination!(f.source.id, { harnessId: 'hermes', revision: inventory.revision, operationId: 'create-hermes-destination' });
    expect(created).toMatchObject({ state: 'created', harnessId: 'hermes', retryable: false }); expect(created.sessionId).toBeTruthy();
    expect(f.creations.size).toBe(1); expect(f.messageRows()).toEqual([]);
    expect(f.createdRows()).toEqual([{ id: 'hermes-created-1', cwd: f.cwd }]);
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['runtime.describe', 'runtime.describe', 'session.create', 'runtime.describe', 'session.resume']);
    const destination = (await f.host.getState()).sessions.find(session => session.id === created.sessionId)!;
    expect(destination).toMatchObject({ workspaceId: f.workspace.id, control: 'observed', observation: { sourceId: 'hermes', nativeSessionId: 'hermes-created-1', projectPath: f.cwd } });
    expect((await f.host.sessionEvents(destination.id)).filter(event => ['prompt.submitted', 'model.completed'].includes(event.body.type))).toEqual([]);
    expect(await f.host.observedHermesStatus!(destination.id)).toMatchObject({ state: 'connected', nativeSessionId: 'hermes-created-1', canSend: true });
    const controls = await f.host.observedControlStatus!(destination.id);
    const capabilityId = controls.routes.find(route => route.route === 'hermes-native')!.capabilities.find(capability => capability.available && capability.action === 'start')!.capabilityId!;
    const review = await f.host.previewHandover!(f.source.id, { capture: 'checkpoint', target: { kind: 'observed', sessionId: destination.id, capabilityId } });
    const receipt = await f.host.applyHandover!(f.source.id, { reviewId: review.reviewId, operationId: 'codex-to-created-hermes' });
    expect(receipt).toMatchObject({ state: 'submitted', targetSessionId: destination.id, canonicalId: review.canonicalId });
    expect(f.request.mock.calls.filter(([method]) => method === 'prompt.submit')).toEqual([['prompt.submit', { session_id: 'hermes-created-1', text: review.packet, submission_id: expect.any(String) }]]);
    f.appendMessage('hermes-created-1', 'assistant', 'HERMES-VERIFIED-MARKER: parser boundary checks are recorded for review.');
    await vi.waitFor(async () => expect(JSON.stringify(await f.host.sessionEvents(destination.id))).toContain('HERMES-VERIFIED-MARKER'), { timeout: 5000, interval: 20 });
    const nativeReview = await f.host.previewHandover!(destination.id, { capture: 'checkpoint', target: { kind: 'native', connectionId: f.connection.id } });
    expect(nativeReview.packet).toContain('ORIGINAL-HERMES-HANDOVER-OBJECTIVE'); expect(nativeReview.packet).toContain('HERMES-VERIFIED-MARKER');
    const native = await f.host.applyHandover!(destination.id, { reviewId: nativeReview.reviewId, operationId: 'hermes-to-native' });
    expect(native).toMatchObject({ state: 'native-ready', canonicalId: review.canonicalId });
    expect(JSON.stringify(await f.store.readMessages(native.targetSessionId!))).toContain('HERMES-VERIFIED-MARKER');
    const inbox = await f.host.createObservedInbox!(f.source.id), sourceControls = await f.host.observedControlStatus!(f.source.id);
    const sourceCapability = sourceControls.routes.find(route => route.route === 'cooperative-inbox')!.capabilities.find(capability => capability.available)!.capabilityId!;
    const back = await f.host.previewHandover!(native.targetSessionId!, { capture: 'checkpoint', target: { kind: 'observed', sessionId: f.source.id, capabilityId: sourceCapability } });
    expect(await f.host.applyHandover!(native.targetSessionId!, { reviewId: back.reviewId, operationId: 'native-to-original-codex' })).toMatchObject({ state: 'queued', canonicalId: review.canonicalId });
    expect(JSON.stringify(await pollObservedInbox({ url: inbox.url!, token: inbox.token!, waitMs: 0 }))).toContain('HERMES-VERIFIED-MARKER');
    expect((await f.host.sessionContinuity!(f.source.id)).handovers).toHaveLength(3);
    expect(f.providerCalls).toEqual([]); await f.assertSourceUntouched();
  });

  it('recovers a lost native creation acknowledgement after restart using the exact operation without duplicate sessions or any prompt', async () => {
    const f = await fixture(), inventory = await f.host.handoverHarnesses!(f.source.id);
    f.loseAck();
    const input = { harnessId: 'hermes', revision: inventory.revision, operationId: 'lost-native-create-ack' };
    expect(await f.host.createHandoverDestination!(f.source.id, input)).toMatchObject({ state: 'unknown', retryable: false });
    const before = f.request.mock.calls.filter(([method]) => method === 'session.create'); expect(before).toHaveLength(1);
    expect((await f.host.handoverHarnesses!(f.source.id)).pendingCreation).toMatchObject({ harnessId: 'hermes', operationId: input.operationId, state: 'unknown' });
    expect(f.creations.size).toBe(1); expect(f.messageRows()).toEqual([]);
    await f.restart(); const attachments = f.rpcFactory.mock.calls.length;
    const inspected = await f.host.handoverHarnesses!(f.source.id);
    expect(inspected.pendingCreation?.operationId).toBe(input.operationId); expect(f.rpcFactory).toHaveBeenCalledTimes(attachments);
    const recovered = await f.host.createHandoverDestination!(f.source.id, input);
    expect(recovered).toMatchObject({ state: 'created', retryable: false }); expect(recovered.sessionId).toBeTruthy();
    expect(f.request.mock.calls.filter(([method]) => method === 'session.create')).toEqual([before[0], before[0]]);
    expect(await f.host.createHandoverDestination!(f.source.id, input)).toEqual(recovered);
    expect(f.request.mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(2);
    expect(f.createdRows()).toEqual([{ id: 'hermes-created-1', cwd: f.cwd }]); expect(f.messageRows()).toEqual([]);
    expect((await f.host.getState()).sessions.filter(session => session.observation?.sourceId === 'hermes')).toHaveLength(1);
    expect((await f.host.handoverHarnesses!(f.source.id)).pendingCreation).toBeUndefined();
    expect(f.request.mock.calls.every(([method]) => ['runtime.describe', 'session.create', 'session.resume'].includes(method))).toBe(true);
    expect(f.providerCalls).toEqual([]); await f.assertSourceUntouched();
  });
});
