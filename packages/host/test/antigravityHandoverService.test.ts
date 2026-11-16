import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntigravityHandoverService, type AntigravityHandoverEndpoint } from '../src/antigravityHandoverService.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs(), active = new Set<AntigravityHandoverService>();
afterEach(async () => { await Promise.all([...active].map(service => service.close())); active.clear(); });
const MODEL = 'MODEL_TEST_FLASH';
const IDLE = 'CASCADE_RUN_STATUS_IDLE';
const existingId = '11111111-1111-4111-8111-111111111111';

async function fixture() {
  const root = await realpath(await temp()), cwd = path.join(root, 'project'); await mkdir(cwd);
  let endpoint: AntigravityHandoverEndpoint | undefined = { address: '127.0.0.1:4321', csrfToken: 'test-local-csrf', identity: 'native-daemon-one' };
  let workspace = { id: 'workspace-one', cwd, fingerprint: 'original-workspace-boundary' };
  let failStart = false, mismatchIdentity = false, mismatchWorkspace = false, failSend = false, nativeStatus = IDLE;
  let listedModel = MODEL, modelName = 'test-native-flash', failCatalog = false;
  const calls: Array<{ method: string; body: Record<string, unknown>; headers: unknown }> = [];
  const conversations = new Map<string, { uri: string; steps: number; model?: string; clientMessageId?: string }>();
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const method = String(url).split('/').at(-1)!, body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ method, body, headers: init?.headers });
    if (method === 'GetCascadeModelConfigData') return failCatalog ? Response.json({ code: 'unavailable' }, { status: 503 }) : Response.json({ defaultOverrideModelConfig: { modelOrAlias: { model: listedModel } }, clientModelConfigs: [{ modelId: modelName, modelOrAlias: { model: listedModel }, quotaInfo: { remainingFraction: 1 } }] });
    if (method === 'StartCascade') {
      if (failStart) throw new Error('private native transport detail');
      const nativeId = body.cascadeId as string;
      conversations.set(nativeId, { uri: mismatchWorkspace ? pathToFileURL(root).href : (body.workspaceUris as string[])[0]!, steps: 0 });
      return Response.json({ cascadeId: mismatchIdentity ? existingId : nativeId });
    }
    const nativeId = String(body.conversationId ?? body.cascadeId), conversation = conversations.get(nativeId)!;
    if (!conversation) return Response.json({ code: 'not_found' }, { status: 404 });
    const metadata = { workspaceUris: [conversation.uri], staticConfig: { cascadeConfig: { plannerConfig: { ...(conversation.model ? { planModel: conversation.model } : {}) } } } };
    if (method === 'GetConversationMetadata') return Response.json({ metadata, trajectoryId: nativeId, numSteps: conversation.steps });
    if (method === 'GetCascadeTrajectory') return Response.json({ trajectory: { cascadeId: nativeId, trajectoryId: nativeId, metadata, steps: Array.from({ length: conversation.steps }, (_, index) => index === conversation.steps - 2 && conversation.clientMessageId ? { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { clientMessageId: conversation.clientMessageId } } : { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' }) }, status: nativeStatus, numTotalSteps: conversation.steps });
    if (method === 'SendUserCascadeMessage') {
      // Even a lost acknowledgement may have already changed the native conversation.
      conversation.steps += 2;
      conversation.clientMessageId = body.clientMessageId as string;
      if (failSend) throw new Error('private native credential detail');
      return Response.json({});
    }
    throw new Error('Unexpected native method.');
  });
  const options = { file: path.join(root, 'state.json'), endpoint: async () => endpoint, workspace: async (value: string) => value === workspace.id ? workspace : undefined, fetch };
  let service = new AntigravityHandoverService(options); active.add(service);
  const create = async (operationId = 'create-one') => { const view = await service.describe(workspace.id); expect(view.state).toBe('ready'); return service.create(workspace.id, { operationId, revision: view.revision! }); };
  return { root, cwd, options, calls, conversations, get service() { return service; }, create,
    async restart() { await service.close(); active.delete(service); service = new AntigravityHandoverService(options); active.add(service); },
    endpoint: (value: AntigravityHandoverEndpoint | undefined) => { endpoint = value; },
    boundary: () => { workspace = { ...workspace, fingerprint: 'changed-boundary' }; },
    failStart: () => { failStart = true; }, mismatchIdentity: () => { mismatchIdentity = true; }, mismatchWorkspace: () => { mismatchWorkspace = true; }, failSend: () => { failSend = true; }, status: (value: string) => { nativeStatus = value; },
    catalog: (model: string, name: string) => { listedModel = model; modelName = name; }, failCatalog: () => { failCatalog = true; },
  };
}

describe('reviewed Antigravity native handover', () => {
  it('pins typed native creation, attests the exact ID and workspace, and resumes registration without recreating', async () => {
    const f = await fixture(), created = await f.create();
    expect(created).toMatchObject({ state: 'created', cwd: f.cwd, retryable: false });
    expect(created.nativeSessionId).toMatch(/^[a-f0-9-]{36}$/);
    const call = f.calls.find(call => call.method === 'StartCascade')!;
    expect(call.body).toMatchObject({ cascadeId: created.nativeSessionId, workspaceUris: [pathToFileURL(f.cwd).href], overrideWorkspaceUris: [pathToFileURL(f.cwd).href], source: 'CORTEX_TRAJECTORY_SOURCE_AGENT_API', trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE', requestedModel: MODEL });
    expect(call.headers).toMatchObject({ 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': 'test-local-csrf' });
    expect((await f.service.inspect(created.nativeSessionId!))).toMatchObject({ nativeSessionId: created.nativeSessionId, workspaceUris: [pathToFileURL(f.cwd).href], deliveryState: 'uncertain' });
    expect((await f.service.describe('workspace-one')).state).toBe('unavailable');
    await f.restart();
    expect((await f.service.describe('workspace-one')).state).toBe('unavailable');
    const readCount = f.calls.length;
    expect(await f.service.creationStatus('workspace-one', 'create-one')).toEqual(created);
    expect(await f.service.creationStatus('other-workspace', 'create-one')).toBeUndefined();
    expect(f.calls).toHaveLength(readCount);
    expect(await f.service.create('workspace-one', { operationId: 'create-one', revision: 'old' })).toEqual(created);
    expect(await f.service.create('workspace-one', { operationId: 'replacement-create', revision: 'old' })).toMatchObject({ state: 'rejected' });
    expect(f.calls.filter(call => call.method === 'StartCascade')).toHaveLength(1);
    expect(await f.service.markRegistered('create-one')).toBe(false);
    expect(await f.service.markRegistered('create-one', 'observed-native-one')).toBe(true);
    expect((await f.service.inspect(created.nativeSessionId!)).deliveryState).toBe('ready');
    expect((await f.service.describe('workspace-one')).state).toBe('ready');
    expect(await readFile(f.options.file, 'utf8')).not.toContain('test-local-csrf');
  });

  it('rejects changed workspace or daemon identity before creating any conversation', async () => {
    for (const change of ['workspace', 'endpoint'] as const) {
      const f = await fixture(), view = await f.service.describe('workspace-one');
      if (change === 'workspace') f.boundary(); else f.endpoint({ address: '127.0.0.1:4321', csrfToken: 'new-csrf', identity: 'native-daemon-two' });
      expect(await f.service.create('workspace-one', { operationId: 'create-one', revision: view.revision! })).toMatchObject({ state: 'rejected' });
      expect(f.calls.some(call => call.method === 'StartCascade')).toBe(false);
    }
  });

  it.each(['lost acknowledgement', 'wrong identity', 'wrong workspace'])('fences %s across new operation IDs and restart', async failure => {
    const f = await fixture();
    if (failure === 'lost acknowledgement') f.failStart(); else if (failure === 'wrong identity') f.mismatchIdentity(); else f.mismatchWorkspace();
    const receipt = await f.create(); expect(receipt).toMatchObject({ state: 'unknown', retryable: false });
    expect(JSON.stringify(receipt)).not.toContain('private native transport detail');
    await f.restart();
    expect((await f.service.describe('workspace-one')).state).toBe('unavailable');
    expect(await f.service.create('workspace-one', { operationId: 'create-one', revision: 'old' })).toEqual(receipt);
    expect(await f.service.create('workspace-one', { operationId: 'new-operation', revision: 'old' })).toMatchObject({ state: 'rejected' });
    expect(f.calls.filter(call => call.method === 'StartCascade')).toHaveLength(1);
  });

  it.each(['workspace', 'endpoint'] as const)('refuses native creation when %s changes while persisting intent', async change => {
    const f = await fixture(), view = await f.service.describe('workspace-one');
    const storage = f.service as unknown as { save(): Promise<void> }, save = storage.save.bind(storage);
    vi.spyOn(storage, 'save').mockImplementationOnce(async () => {
      await save();
      if (change === 'workspace') f.boundary(); else f.endpoint({ address: '127.0.0.1:4321', csrfToken: 'rotated-csrf', identity: 'changed-daemon' });
    });
    expect(await f.service.create('workspace-one', { operationId: 'persist-race-create', revision: view.revision! })).toMatchObject({ state: 'unknown', retryable: false });
    expect(f.calls.some(call => call.method === 'StartCascade')).toBe(false);
    await f.restart();
    expect(await f.service.pendingCreation('workspace-one')).toMatchObject({ operationId: 'persist-race-create', state: 'unknown' });
  });

  it.each(['workspace', 'endpoint'] as const)('refuses native submission when %s changes while persisting intent', async change => {
    const f = await fixture();
    f.conversations.set(existingId, { uri: pathToFileURL(f.cwd).href, steps: 0, model: MODEL });
    const inspection = await f.service.inspect(existingId, 'workspace-one');
    const storage = f.service as unknown as { save(): Promise<void> }, save = storage.save.bind(storage);
    vi.spyOn(storage, 'save').mockImplementationOnce(async () => {
      await save();
      if (change === 'workspace') f.boundary(); else f.endpoint({ address: '127.0.0.1:4321', csrfToken: 'rotated-csrf', identity: 'changed-daemon' });
    });
    const input = { text: 'Continue once', workspaceId: 'workspace-one', operationId: 'persist-race-send' };
    expect(await f.service.sendOnce(existingId, input, inspection.revision)).toMatchObject({ state: 'unknown', retryable: false });
    expect(f.calls.some(call => call.method === 'SendUserCascadeMessage')).toBe(false);
    await f.restart();
    expect(await f.service.sendOnce(existingId, input, inspection.revision)).toMatchObject({ state: 'unknown', retryable: false });
    expect(f.calls.some(call => call.method === 'SendUserCascadeMessage')).toBe(false);
  });

  it('recovers a lost creation receipt by explicitly inspecting the original ID without any native mutation', async () => {
    const f = await fixture(); f.failStart();
    const unknown = await f.create(), nativeId = unknown.nativeSessionId!;
    expect(await f.service.pendingCreation('workspace-one')).toMatchObject({ operationId: 'create-one', nativeSessionId: nativeId, state: 'unknown' });
    f.conversations.set(nativeId, { uri: pathToFileURL(f.cwd).href, steps: 0, model: MODEL });
    const recovered = await f.service.inspectCreation('workspace-one', 'create-one');
    expect(recovered).toMatchObject({ state: 'created', nativeSessionId: nativeId });
    expect(await f.service.pendingCreation('workspace-one')).toMatchObject({ operationId: 'create-one', nativeSessionId: nativeId, state: 'created' });
    expect((await f.service.describe('workspace-one')).state).toBe('unavailable');
    expect(f.calls.filter(call => call.method === 'StartCascade')).toHaveLength(1);
    expect(f.calls.some(call => call.method === 'SendUserCascadeMessage')).toBe(false);
    expect(await f.service.markRegistered('create-one', 'observed-native-one')).toBe(true);
    expect(await f.service.pendingCreation('workspace-one')).toBeUndefined();
    expect(await f.service.inspectCreation('other-workspace', 'create-one')).toBeUndefined();
  });

  it('keeps a missing original native ID uncertain after inspection instead of creating a replacement', async () => {
    const f = await fixture(); f.failStart();
    const original = await f.create();
    expect(await f.service.inspectCreation('workspace-one', 'create-one')).toEqual(original);
    await f.restart();
    expect(await f.service.pendingCreation('workspace-one')).toMatchObject({ operationId: 'create-one', state: 'unknown' });
    expect(await f.service.inspectCreation('workspace-one', 'create-one')).toEqual(original);
    expect(f.calls.filter(call => call.method === 'StartCascade')).toHaveLength(1);
    expect(f.calls.some(call => call.method === 'SendUserCascadeMessage')).toBe(false);
  });

  it('submits once with a persisted client message ID and selected native model, retaining work ownership until native idle', async () => {
    const f = await fixture(), created = await f.create(), nativeId = created.nativeSessionId!, inspection = await f.service.inspect(nativeId);
    expect(await f.service.markRegistered('create-one', 'observed-native-one')).toBe(true);
    const input = { operationId: 'send-one', text: 'Continue the reviewed work exactly once.' };
    expect(await f.service.sendOnce(nativeId, input, inspection.revision)).toMatchObject({ state: 'submitted', nativeSessionId: nativeId });
    expect(f.service.isBusy()).toBe(true);
    expect((await f.service.inspect(nativeId)).deliveryState).toBe('running');
    expect(await f.service.sendOnce(nativeId, input, inspection.revision)).toMatchObject({ state: 'submitted' });
    const sends = f.calls.filter(call => call.method === 'SendUserCascadeMessage'); expect(sends).toHaveLength(1);
    expect(sends[0]!.body).toMatchObject({ cascadeId: nativeId, items: [{ text: input.text }], cascadeConfig: { plannerConfig: { planModel: MODEL } }, messageOrigin: 'AGENT_MESSAGE_ORIGIN_SDK_EXECUTABLE' });
    expect(sends[0]!.body.clientMessageId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.parse(await readFile(f.options.file, 'utf8')).submissions[0].clientMessageId).toBe(sends[0]!.body.clientMessageId);
    await vi.waitFor(() => expect(f.service.isBusy()).toBe(false), { timeout: 5000 });
    expect((await f.service.inspect(nativeId)).deliveryState).toBe('ready');
    await f.restart(); expect(await f.service.sendOnce(nativeId, input, inspection.revision)).toMatchObject({ state: 'submitted' });
    expect(f.calls.filter(call => call.method === 'SendUserCascadeMessage')).toHaveLength(1);
  });

  it('attests an existing native conversation and rejects busy, stale or uncertain sends without alternate routes', async () => {
    const f = await fixture(); f.conversations.set(existingId, { uri: pathToFileURL(f.cwd).href, steps: 2, model: MODEL });
    const original = await f.service.inspect(existingId), input = { operationId: 'existing-send', text: 'Continue', workspaceId: 'workspace-one' };
    f.status('CASCADE_RUN_STATUS_RUNNING'); expect(await f.service.sendOnce(existingId, input, original.revision)).toMatchObject({ state: 'rejected' });
    f.status(IDLE); expect(await f.service.sendOnce(existingId, input, 'stale-binding')).toMatchObject({ state: 'rejected' });
    f.failSend(); expect(await f.service.sendOnce(existingId, input, original.revision)).toMatchObject({ state: 'unknown' });
    expect((await f.service.inspect(existingId)).deliveryState).toBe('uncertain');
    expect((await f.service.describe('workspace-one')).state).toBe('unavailable');
    await f.restart(); expect((await f.service.inspect(existingId)).deliveryState).toBe('uncertain');
    expect(await f.service.sendOnce(existingId, { ...input, operationId: 'replacement-send' }, original.revision)).toMatchObject({ state: 'rejected' });
    expect(f.calls.filter(call => call.method === 'SendUserCascadeMessage')).toHaveLength(1);
  });

  it('permits only the fixed idempotent bootstrap before verified observation registration', async () => {
    const f = await fixture(), created = await f.create(), nativeId = created.nativeSessionId!, inspection = await f.service.inspect(nativeId);
    expect(await f.service.sendOnce(nativeId, { operationId: 'premature-handover', text: 'Private transferred work context' }, inspection.revision)).toMatchObject({ state: 'rejected' });
    expect(await f.service.bootstrapOnce('create-one')).toMatchObject({ state: 'submitted', nativeSessionId: nativeId });
    expect(await f.service.bootstrapOnce('create-one')).toMatchObject({ state: 'submitted' });
    const sends = f.calls.filter(call => call.method === 'SendUserCascadeMessage'); expect(sends).toHaveLength(1);
    expect(JSON.stringify(sends[0]!.body.items)).toContain('Reply exactly READY');
    expect(JSON.stringify(sends[0]!.body.items)).not.toContain('Private transferred work context');
    await vi.waitFor(() => expect(f.service.isBusy()).toBe(false), { timeout: 5000 });
    expect((await f.service.inspect(nativeId)).deliveryState).toBe('uncertain');
    await f.restart();
    expect(await f.service.bootstrapOnce('create-one')).toMatchObject({ state: 'submitted' });
    expect(f.calls.filter(call => call.method === 'SendUserCascadeMessage')).toHaveLength(1);
    expect(await f.service.markRegistered('create-one', 'observed-native-one')).toBe(true);
    expect((await f.service.inspect(nativeId)).deliveryState).toBe('ready');
  });

  it('does not settle its submission when unrelated native work becomes idle', async () => {
    const f = await fixture(), created = await f.create(), nativeId = created.nativeSessionId!;
    await f.service.markRegistered('create-one', 'observed-native-one');
    const inspection = await f.service.inspect(nativeId);
    expect(await f.service.sendOnce(nativeId, { operationId: 'pending-native-send', text: 'Continue' }, inspection.revision)).toMatchObject({ state: 'submitted' });
    f.conversations.get(nativeId)!.clientMessageId = 'another-native-client-message';
    const reads = f.calls.filter(call => call.method === 'GetCascadeTrajectory').length;
    await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'GetCascadeTrajectory').length).toBeGreaterThan(reads), { timeout: 5000 });
    expect(f.service.isBusy()).toBe(true);
    await f.restart();
    expect((await f.service.inspect(nativeId)).deliveryState).toBe('uncertain');
    expect(f.calls.filter(call => call.method === 'SendUserCascadeMessage')).toHaveLength(1);
  });

  it('reviews an explicit configured native model separately from an older stored model', async () => {
    const f = await fixture(); f.conversations.set(existingId, { uri: pathToFileURL(f.cwd).href, steps: 2, model: 'MODEL_OLD_NATIVE_SELECTION' });
    const configured = new AntigravityHandoverService({ ...f.options, model: async () => MODEL }); active.add(configured);
    const observed = await configured.inspect(existingId), reviewed = await configured.inspect(existingId, 'workspace-one');
    expect(observed.model).toBe('MODEL_OLD_NATIVE_SELECTION'); expect(reviewed.model).toBe(MODEL);
    expect(reviewed.revision).not.toBe(observed.revision);
    const input = { operationId: 'configured-send', text: 'Continue with the explicitly reviewed native model.', workspaceId: 'workspace-one' };
    expect(await configured.sendOnce(existingId, input, observed.revision)).toMatchObject({ state: 'rejected' });
    expect(await configured.sendOnce(existingId, input, reviewed.revision)).toMatchObject({ state: 'submitted' });
    expect(f.calls.find(call => call.method === 'SendUserCascadeMessage')?.body).toMatchObject({ cascadeConfig: { plannerConfig: { planModel: MODEL } } });
    await vi.waitFor(() => expect(configured.isBusy()).toBe(false), { timeout: 5000 });
  });

  it('does not attach a native credential to non-loopback endpoints', async () => {
    const f = await fixture(); f.endpoint({ address: 'example.com:4321', csrfToken: 'test-local-csrf', identity: 'foreign-endpoint' });
    expect((await f.service.describe('workspace-one')).state).toBe('unavailable'); expect(f.calls).toEqual([]);
  });

  it('resolves model display identity only from the current native catalog and isolates endpoint generations', async () => {
    const f = await fixture(), nativeModel = 'MODEL_PLACEHOLDER_M320';
    f.catalog(nativeModel, 'native-catalog-display-one'); f.conversations.set(existingId, { uri: pathToFileURL(f.cwd).href, steps: 2, model: nativeModel });
    expect(await f.service.inspect(existingId)).toMatchObject({ model: nativeModel, modelId: 'native-catalog-display-one' });
    f.catalog(nativeModel, 'native-catalog-display-two');
    expect((await f.service.inspect(existingId)).modelId).toBe('native-catalog-display-one');
    expect(f.calls.filter(call => call.method === 'GetCascadeModelConfigData')).toHaveLength(1);
    f.endpoint({ address: '127.0.0.1:4321', csrfToken: 'rotated-local-csrf', identity: 'native-daemon-two' });
    expect((await f.service.inspect(existingId)).modelId).toBe('native-catalog-display-two');
    f.conversations.get(existingId)!.model = 'MODEL_NOT_LISTED';
    expect(await f.service.inspect(existingId)).toMatchObject({ model: 'MODEL_NOT_LISTED' });
    expect((await f.service.inspect(existingId)).modelId).toBeUndefined();
    expect(f.calls.filter(call => call.method === 'GetCascadeModelConfigData')).toHaveLength(3); // The unknown enum is negatively cached.
  });

  it('expires optional native model display metadata after sixty seconds', async () => {
    const f = await fixture(); f.conversations.set(existingId, { uri: pathToFileURL(f.cwd).href, steps: 2, model: MODEL });
    expect((await f.service.inspect(existingId)).modelId).toBe('test-native-flash');
    f.catalog(MODEL, 'updated-native-catalog-name');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    try { expect((await f.service.inspect(existingId)).modelId).toBe('updated-native-catalog-name'); }
    finally { clock.mockRestore(); }
    expect(f.calls.filter(call => call.method === 'GetCascadeModelConfigData')).toHaveLength(2);
  });

  it('keeps native identity and workspace inspection available when optional model display lookup fails', async () => {
    const f = await fixture(); f.conversations.set(existingId, { uri: pathToFileURL(f.cwd).href, steps: 2, model: MODEL }); f.failCatalog();
    const inspected = await f.service.inspect(existingId);
    expect(inspected).toMatchObject({ nativeSessionId: existingId, workspaceUris: [pathToFileURL(f.cwd).href], status: IDLE, model: MODEL });
    expect(inspected.modelId).toBeUndefined(); expect(inspected).not.toHaveProperty('context');
    await f.service.inspect(existingId);
    expect(f.calls.filter(call => call.method === 'GetCascadeModelConfigData')).toHaveLength(1);
  });

  it('bounds model display caches to eight native endpoint generations', async () => {
    const f = await fixture(); f.conversations.set(existingId, { uri: pathToFileURL(f.cwd).href, steps: 2, model: MODEL });
    for (let index = 0; index < 9; index++) {
      f.endpoint({ address: '127.0.0.1:4321', csrfToken: `local-csrf-${index}`, identity: `native-daemon-${index}` });
      expect((await f.service.inspect(existingId)).modelId).toBe('test-native-flash');
    }
    expect(f.calls.filter(call => call.method === 'GetCascadeModelConfigData')).toHaveLength(9);
    f.endpoint({ address: '127.0.0.1:4321', csrfToken: 'local-csrf-0', identity: 'native-daemon-0' }); await f.service.inspect(existingId);
    expect(f.calls.filter(call => call.method === 'GetCascadeModelConfigData')).toHaveLength(10);
  });

  it('reconciles a restarted unknown submission from exact idle native evidence without rewriting or replaying its receipt', async () => {
    const f = await fixture(), created = await f.create(), nativeId = created.nativeSessionId!;
    await f.service.markRegistered('create-one', 'observed-native-one');
    const inspection = await f.service.inspect(nativeId), input = { operationId: 'uncertain-send', text: 'Continue the reviewed work' };
    f.failSend(); expect(await f.service.sendOnce(nativeId, input, inspection.revision)).toMatchObject({ state: 'unknown' });
    await f.restart();
    expect((await f.service.inspect(nativeId)).deliveryState).toBe('uncertain');
    const before = f.calls.length;
    expect(await f.service.reconcile(nativeId, 'workspace-one')).toMatchObject({ state: 'reconciled', reconciledOperations: 1, rebound: false });
    expect(f.calls.slice(before).every(call => call.method.startsWith('Get'))).toBe(true);
    expect((await f.service.inspect(nativeId)).deliveryState).toBe('ready');
    expect(await f.service.sendOnce(nativeId, input, inspection.revision)).toMatchObject({ state: 'unknown' });
    const saved = JSON.parse(await readFile(f.options.file, 'utf8'));
    expect(saved.submissions[0]).toMatchObject({ state: 'unknown', reconciled: true, settled: true });
    await f.restart();
    expect((await f.service.inspect(nativeId)).deliveryState).toBe('ready');
    expect(await f.service.reconcile(nativeId, 'workspace-one')).toMatchObject({ state: 'reconciled', reconciledOperations: 0 });
    expect(f.calls.filter(call => call.method === 'StartCascade')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'SendUserCascadeMessage')).toHaveLength(1);
  });

  it('requires explicit read-only re-attestation after daemon rotation before continuing a registered conversation', async () => {
    const f = await fixture(), created = await f.create(), nativeId = created.nativeSessionId!;
    await f.service.markRegistered('create-one', 'observed-native-one');
    f.endpoint({ address: '127.0.0.1:4321', csrfToken: 'rotated-local-csrf', identity: 'native-daemon-two' });
    const changed = await f.service.inspect(nativeId);
    expect(changed).toMatchObject({ deliveryState: 'uncertain', problem: expect.stringContaining('daemon changed') });
    expect(await f.service.sendOnce(nativeId, { operationId: 'before-rebind', text: 'Continue' }, changed.revision)).toMatchObject({ state: 'rejected' });
    const before = f.calls.length;
    expect(await f.service.reconcile(nativeId, 'workspace-one')).toMatchObject({ state: 'reconciled', reconciledOperations: 0, rebound: true });
    expect(f.calls.slice(before).every(call => call.method.startsWith('Get'))).toBe(true);
    await f.restart();
    const ready = await f.service.inspect(nativeId); expect(ready.deliveryState).toBe('ready');
    expect(await f.service.sendOnce(nativeId, { operationId: 'after-rebind', text: 'Continue' }, ready.revision)).toMatchObject({ state: 'submitted' });
    // Re-attested delivery needs fresh native idle polls, also under full-suite load.
    await vi.waitFor(() => expect(f.service.isBusy()).toBe(false), { timeout: 10_000 });
    expect(f.calls.filter(call => call.method === 'StartCascade')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'SendUserCascadeMessage')).toHaveLength(1);
  });

  it('recovers a submission that settled natively after host shutdown without resuming or cancelling native execution', async () => {
    const f = await fixture(), created = await f.create(), nativeId = created.nativeSessionId!;
    await f.service.markRegistered('create-one', 'observed-native-one');
    expect(await f.service.sendOnce(nativeId, { operationId: 'interrupted-watch', text: 'Continue' }, (await f.service.inspect(nativeId)).revision)).toMatchObject({ state: 'submitted' });
    f.status('CASCADE_RUN_STATUS_RUNNING');
    await f.restart();
    expect(await f.service.reconcile(nativeId, 'workspace-one')).toMatchObject({ state: 'rejected' });
    f.status(IDLE);
    expect(await f.service.reconcile(nativeId, 'workspace-one')).toMatchObject({ state: 'reconciled', reconciledOperations: 1 });
    expect(JSON.parse(await readFile(f.options.file, 'utf8')).submissions[0]).toMatchObject({ state: 'unknown', reconciled: true, settled: true });
    expect(f.calls.filter(call => !call.method.startsWith('Get')).map(call => call.method)).toEqual(['StartCascade', 'SendUserCascadeMessage']);
  });

  it.each([false, true])('binds external-session recovery to its original workspace boundary (changed=%s)', async changed => {
    const f = await fixture(); f.conversations.set(existingId, { uri: pathToFileURL(f.cwd).href, steps: 0, model: MODEL });
    const inspection = await f.service.inspect(existingId);
    f.failSend(); await f.service.sendOnce(existingId, { operationId: 'external-send', workspaceId: 'workspace-one', text: 'Continue' }, inspection.revision);
    await f.restart(); if (changed) f.boundary();
    expect(await f.service.reconcile(existingId, 'workspace-one')).toMatchObject({ state: changed ? 'rejected' : 'reconciled', reconciledOperations: changed ? 0 : 1 });
    expect(f.calls.filter(call => call.method === 'SendUserCascadeMessage')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'StartCascade')).toHaveLength(0);
  });

  it('inspects an ordinary external conversation without acquiring ownership or creating a journal', async () => {
    const f = await fixture(); f.conversations.set(existingId, { uri: pathToFileURL(f.cwd).href, steps: 2, model: MODEL });
    expect(await f.service.reconcile(existingId, 'workspace-one')).toEqual({ state: 'reconciled', nativeSessionId: existingId, reconciledOperations: 0, rebound: false });
    expect(f.calls.every(call => call.method.startsWith('Get'))).toBe(true);
    await expect(readFile(f.options.file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.service.creationStatus('workspace-one', 'create-one')).toBeUndefined();
    f.status('CASCADE_RUN_STATUS_RUNNING');
    expect(await f.service.reconcile(existingId, 'workspace-one')).toMatchObject({ state: 'rejected' });
    f.status(IDLE); f.conversations.get(existingId)!.uri = pathToFileURL(f.root).href;
    expect(await f.service.reconcile(existingId, 'workspace-one')).toMatchObject({ state: 'rejected' });
    expect(f.calls.every(call => call.method.startsWith('Get'))).toBe(true);
    await expect(readFile(f.options.file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['active', 'uncorrelated', 'wrong-workspace', 'changed-boundary', 'missing-native', 'wrong-workspace-id', 'before-baseline'] as const)('refuses reconciliation with %s evidence and preserves its fence', async reason => {
    const f = await fixture(), created = await f.create(), nativeId = created.nativeSessionId!;
    await f.service.markRegistered('create-one', 'observed-native-one');
    f.conversations.get(nativeId)!.steps = 2;
    const inspection = await f.service.inspect(nativeId);
    f.failSend(); await f.service.sendOnce(nativeId, { operationId: 'unknown-send', text: 'Continue' }, inspection.revision);
    await f.restart();
    if (reason === 'active') f.status('CASCADE_RUN_STATUS_RUNNING');
    if (reason === 'uncorrelated') f.conversations.get(nativeId)!.clientMessageId = 'unrelated-native-client';
    if (reason === 'wrong-workspace') f.conversations.get(nativeId)!.uri = pathToFileURL(f.root).href;
    if (reason === 'changed-boundary') f.boundary();
    if (reason === 'missing-native') f.conversations.delete(nativeId);
    if (reason === 'before-baseline') f.conversations.get(nativeId)!.steps = 2;
    const before = f.calls.length;
    expect(await f.service.reconcile(nativeId, reason === 'wrong-workspace-id' ? 'other-workspace' : 'workspace-one')).toMatchObject({ state: 'rejected', reconciledOperations: 0, rebound: false });
    expect(f.calls.slice(before).every(call => call.method.startsWith('Get'))).toBe(true);
    expect(JSON.parse(await readFile(f.options.file, 'utf8')).submissions[0]).toMatchObject({ state: 'unknown', settled: false });
  });

  it('keeps unregistered and ambiguous creations fenced during submission reconciliation', async () => {
    const f = await fixture(), created = await f.create();
    expect(await f.service.reconcile(created.nativeSessionId!, 'workspace-one')).toMatchObject({ state: 'rejected' });
    const other = await fixture(); other.failStart(); const unknown = await other.create();
    expect(await other.service.reconcile(unknown.nativeSessionId!, 'workspace-one')).toMatchObject({ state: 'rejected' });
    expect(f.calls.filter(call => call.method === 'SendUserCascadeMessage')).toHaveLength(0);
    expect(other.calls.filter(call => call.method === 'StartCascade')).toHaveLength(1);
  });

  it.each(['workspace', 'endpoint'] as const)('does not persist reconciliation when %s changes during native inspection', async change => {
    const f = await fixture(), created = await f.create(), nativeId = created.nativeSessionId!;
    await f.service.markRegistered('create-one', 'observed-native-one');
    f.failSend(); await f.service.sendOnce(nativeId, { operationId: 'unknown-send', text: 'Continue' }, (await f.service.inspect(nativeId)).revision);
    await f.restart();
    const fetch = f.options.fetch.getMockImplementation()!;
    f.options.fetch.mockImplementation(async (url, init) => {
      const result = await fetch(url, init);
      if (String(url).endsWith('/GetCascadeTrajectory')) {
        if (change === 'workspace') f.boundary(); else f.endpoint({ address: '127.0.0.1:4321', csrfToken: 'rotated-local-csrf', identity: 'native-daemon-two' });
      }
      return result;
    });
    expect(await f.service.reconcile(nativeId, 'workspace-one')).toMatchObject({ state: 'rejected' });
    expect(JSON.parse(await readFile(f.options.file, 'utf8')).submissions[0]).not.toHaveProperty('reconciled');
  });

  it.each(['creations', 'submissions'] as const)('reports the persisted %s retention limit without deleting idempotency history', async limit => {
    const f = await fixture(), created = await f.create(), nativeId = created.nativeSessionId!;
    await f.service.markRegistered('create-one', 'observed-native-one');
    await f.service.sendOnce(nativeId, { operationId: 'settled-send', text: 'Continue' }, (await f.service.inspect(nativeId)).revision);
    await vi.waitFor(() => expect(f.service.isBusy()).toBe(false), { timeout: 5000 });
    await f.service.close(); active.delete(f.service);
    const stored = JSON.parse(await readFile(f.options.file, 'utf8'));
    stored[limit] = Array.from({ length: limit === 'creations' ? 128 : 512 }, (_, index) => ({ ...stored[limit][0], operationId: `retained-${limit}-${index}` }));
    await writeFile(f.options.file, JSON.stringify(stored));
    await f.restart();
    const before = f.calls.length;
    expect(await f.service.describe('workspace-one')).toMatchObject({ state: 'unavailable', problem: expect.stringContaining('retention limit') });
    expect(f.calls).toHaveLength(before);
    if (limit === 'submissions') expect(await f.service.inspect(nativeId)).toMatchObject({ deliveryState: 'uncertain', problem: expect.stringContaining('retention limit') });
    expect(JSON.parse(await readFile(f.options.file, 'utf8'))[limit]).toHaveLength(limit === 'creations' ? 128 : 512);
  });
});
