import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContinuityNotes } from '@extalia/platform';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs(), runtimes = new Set<AgentHostRuntime>(), servers = new Set<ReturnType<typeof createServer>>();
afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear();
  await Promise.all([...servers].map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))); servers.clear();
});
const nativeCodexId = '11111111-1111-4111-8111-111111111111', MODEL = 'MODEL_TEST_FLASH';
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const notes: ContinuityNotes = { goal: 'ORIGINAL-GOAL: preserve the work', decisions: 'Keep the verified decision', completed: 'Initial progress', pending: 'Continue the remaining task', verification: 'Evidence stays attributed', risks: 'Do not replay archived tools' };

async function readBody(request: IncomingMessage) {
  let text = ''; for await (const chunk of request) { text += String(chunk); if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Fixture request limit.'); }
  return JSON.parse(text) as Record<string, unknown>;
}
async function fixture() {
  const root = await realpath(await temp('extalia-native-handover-')), home = path.join(root, 'home'), project = path.join(root, 'project'), data = path.join(root, 'data');
  await mkdir(home); await mkdir(project);
  const codexFolder = path.join(home, '.codex', 'sessions'); await mkdir(codexFolder, { recursive: true });
  await writeFile(path.join(codexFolder, 'rollout-test.jsonl'), line({ type: 'session_meta', payload: { id: nativeCodexId, cwd: project, timestamp: '2026-01-01T00:00:00.000Z' } })
    + line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: notes.goal }] } })
    + line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `${notes.decisions}. ${notes.completed}.` }] } }));
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  type Conversation = { uri: string; steps: Array<Record<string, unknown>>; model: string };
  const conversations = new Map<string, Conversation>();
  let loseNextCreation = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.headers['x-codeium-csrf-token'] !== 'fixture-native-csrf' || request.headers['connect-protocol-version'] !== '1') { response.writeHead(403).end(); return; }
      const method = request.url!.split('/').at(-1)!, body = await readBody(request); calls.push({ method, body });
      const reply = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (method === 'GetCascadeModelConfigData') { reply({ defaultOverrideModelConfig: { modelOrAlias: { model: MODEL } }, clientModelConfigs: [{ modelId: 'fixture-native-model', modelOrAlias: { model: MODEL }, quotaInfo: { remainingFraction: 1 } }] }); return; }
      if (method === 'StartCascade') {
        conversations.set(body.cascadeId as string, { uri: (body.workspaceUris as string[])[0]!, steps: [], model: body.requestedModel as string });
        if (loseNextCreation) { loseNextCreation = false; request.socket.destroy(); return; }
        reply({ cascadeId: body.cascadeId }); return;
      }
      const nativeId = String(body.conversationId ?? body.cascadeId), conversation = conversations.get(nativeId);
      if (!conversation) { reply({ code: 'not_found' }, 404); return; }
      const metadata = { workspaceUris: [conversation.uri], rootConversationId: nativeId, staticConfig: { cascadeConfig: { plannerConfig: { planModel: conversation.model } } } };
      if (method === 'GetConversationMetadata') { reply({ metadata, trajectoryId: nativeId, numSteps: conversation.steps.length }); return; }
      if (method === 'GetCascadeTrajectory') { reply({ trajectory: { cascadeId: nativeId, trajectoryId: nativeId, metadata, steps: conversation.steps }, status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: conversation.steps.length }); return; }
      if (method === 'SendUserCascadeMessage') {
        const text = (body.items as Array<{ text: string }>)[0]!.text, bootstrap = text.includes('readiness check');
        const start = conversation.steps.length;
        conversation.steps.push({ type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { clientMessageId: body.clientMessageId, items: [{ text }] } }, { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' });
        const folder = path.join(home, '.gemini', 'antigravity', 'brain', nativeId, '.system_generated', 'logs'); await mkdir(folder, { recursive: true });
        // Native transcript rows intentionally carry no cwd/project metadata: only authenticated RPC evidence can bind them.
        await appendFile(path.join(folder, 'transcript.jsonl'), line({ type: 'USER_INPUT', step_index: start, created_at: new Date().toISOString(), content: text })
          + line({ type: 'PLANNER_RESPONSE', step_index: start + 1, created_at: new Date().toISOString(), content: bootstrap ? 'READY' : 'NATIVE-PROGRESS: preserve the reviewed decision', model: 'fixture-native-model' }));
        reply({}); return;
      }
      reply({ code: 'unimplemented' }, 404);
    } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  servers.add(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture server unavailable.');
  const open = async () => {
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 100,
      env: { PATH: '', EXTALIA_SECRET_STORE: 'memory', ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${address.port}`, ANTIGRAVITY_CSRF_TOKEN: 'fixture-native-csrf' } });
    runtimes.add(runtime); return runtime;
  };
  let runtime = await open();
  const connected = await runtime.host.saveConnection({ name: 'Fixture connection', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'fixture-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history: true } });
  const state = await runtime.host.saveWorkspace({ name: 'Controlled project', projectLocation: project, connectionId: connected.connections[0]!.id, crossWorkspaceAccess: 'read-only', permissions: { fileWrite: 'ask', commands: 'ask' } });
  const workspace = state.workspaces[0]!, scan = await runtime.host.scanImports(['codex']);
  const observed = await runtime.host.observeImports(scan.scanId, [scan.sessions[0]!.id]);
  const source = observed.sessions.find(session => session.observation?.nativeSessionId === nativeCodexId)!;
  return { home, project, workspace, source, calls, conversations, get runtime() { return runtime; },
    loseCreationAcknowledgement: () => { loseNextCreation = true; },
    async restart() { await runtime.close(); runtimes.delete(runtime); runtime = await open(); },
  };
}
const idle = async (runtime: AgentHostRuntime) => vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5000 });

describe('public host Antigravity destination factory over native HTTP', () => {
  it('creates and registers one scoped native destination, dispatches one reviewed packet and retains canonical work on return', async () => {
    const f = await fixture(), inventory = await f.runtime.host.handoverHarnesses!(f.source.id);
    expect(inventory.harnesses.find(item => item.id === 'antigravity')).toMatchObject({ evidence: expect.arrayContaining(['native-connection']), create: 'ready' });
    const input = { harnessId: 'antigravity', revision: inventory.revision, operationId: 'create-native-destination' };
    const created = await f.runtime.host.createHandoverDestination!(f.source.id, input);
    expect(created).toMatchObject({ state: 'created', retryable: false }); await idle(f.runtime);
    const target = (await f.runtime.host.getState()).sessions.find(session => session.id === created.sessionId)!;
    expect(target.model).toBe('fixture-native-model');
    expect(target).toMatchObject({ control: 'observed', workspaceId: f.workspace.id, observation: { sourceId: 'antigravity', projectPath: f.project } });
    const nativeId = target.observation!.nativeSessionId;
    expect(f.calls.filter(call => call.method === 'StartCascade').map(call => call.body.cascadeId)).toEqual([nativeId]);
    expect(f.calls.filter(call => call.method === 'SendUserCascadeMessage')).toHaveLength(1);
    const transcript = await readFile(path.join(f.home, '.gemini', 'antigravity', 'brain', nativeId, '.system_generated', 'logs', 'transcript.jsonl'), 'utf8');
    expect(transcript).not.toContain(f.project); expect(transcript).not.toMatch(/"cwd"|"projectPath"/);
    expect(await f.runtime.host.createHandoverDestination!(f.source.id, { ...input, revision: 'stale-after-reload' })).toEqual(created);
    expect(f.calls.filter(call => call.method === 'StartCascade')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'SendUserCascadeMessage')).toHaveLength(1);
    const nativeMutationCount = f.calls.filter(call => ['StartCascade', 'SendUserCascadeMessage'].includes(call.method)).length;
    expect(await f.runtime.host.reconcileObservedAntigravity!(target.id)).toMatchObject({ state: 'ready', nativeSessionId: nativeId });
    expect(f.calls.filter(call => ['StartCascade', 'SendUserCascadeMessage'].includes(call.method))).toHaveLength(nativeMutationCount);
    await expect(f.runtime.host.reconcileObservedAntigravity!(f.source.id)).rejects.toThrow(/watched Antigravity/);
    const controls = await f.runtime.host.observedControlStatus!(target.id), route = controls.routes.find(route => route.route === 'antigravity-native')!;
    const capabilityId = route.capabilities.find(capability => capability.available)!.capabilityId!;
    const preview = await f.runtime.host.previewHandover!(f.source.id, { target: { kind: 'observed', sessionId: target.id, capabilityId }, notes });
    const sent = await f.runtime.host.applyHandover!(f.source.id, { reviewId: preview.reviewId, operationId: 'send-reviewed-handover' });
    expect(sent).toMatchObject({ state: 'submitted', canonicalId: preview.canonicalId, targetSessionId: target.id }); await idle(f.runtime);
    const sends = f.calls.filter(call => call.method === 'SendUserCascadeMessage');
    expect(sends).toHaveLength(2); expect(sends[1]!.body).toMatchObject({ cascadeId: nativeId, items: [{ text: preview.packet }] });
    expect(await f.runtime.host.applyHandover!(f.source.id, { reviewId: preview.reviewId, operationId: 'send-reviewed-handover' })).toEqual(sent);
    expect(f.calls.filter(call => call.method === 'SendUserCascadeMessage')).toHaveLength(2);
    const reverse = await f.runtime.host.previewHandover!(target.id, { target: { kind: 'manual', label: 'Return to original Codex', sessionId: f.source.id } });
    expect(reverse.packet).toContain(notes.goal); expect(reverse.packet).toContain('NATIVE-PROGRESS');
    const returned = await f.runtime.host.applyHandover!(target.id, { reviewId: reverse.reviewId, operationId: 'return-original-context' });
    expect(returned).toMatchObject({ state: 'manual-ready', canonicalId: preview.canonicalId, targetSessionId: f.source.id });
    expect((await f.runtime.host.sessionContinuity!(f.source.id)).handovers).toHaveLength(2);
  });

  it('recovers an unknown creation by inspecting the original native ID, while missing IDs remain fenced without replay', async () => {
    const f = await fixture(), inventory = await f.runtime.host.handoverHarnesses!(f.source.id); f.loseCreationAcknowledgement();
    const input = { harnessId: 'antigravity', revision: inventory.revision, operationId: 'recover-original-native-creation' };
    expect(await f.runtime.host.createHandoverDestination!(f.source.id, input)).toMatchObject({ state: 'unknown' });
    const pending = (await f.runtime.host.handoverHarnesses!(f.source.id)).pendingCreation!;
    expect(pending).toMatchObject({ harnessId: 'antigravity', operationId: input.operationId, state: 'unknown' });
    const native = f.conversations.get(pending.nativeSessionId)!; f.conversations.delete(pending.nativeSessionId);
    expect(await f.runtime.host.createHandoverDestination!(f.source.id, { ...input, revision: 'stale' })).toMatchObject({ state: 'unknown' });
    expect(f.calls.filter(call => call.method === 'StartCascade')).toHaveLength(1); expect(f.calls.some(call => call.method === 'SendUserCascadeMessage')).toBe(false);
    f.conversations.set(pending.nativeSessionId, native); await f.restart();
    const recovered = await f.runtime.host.createHandoverDestination!(f.source.id, { ...input, revision: 'stale-after-restart' });
    expect(recovered).toMatchObject({ state: 'created', retryable: false }); await idle(f.runtime);
    const target = (await f.runtime.host.getState()).sessions.find(session => session.id === recovered.sessionId)!;
    expect(target).toMatchObject({ workspaceId: f.workspace.id, observation: { nativeSessionId: pending.nativeSessionId } });
    expect(f.calls.filter(call => call.method === 'StartCascade')).toHaveLength(1); expect(f.calls.filter(call => call.method === 'SendUserCascadeMessage')).toHaveLength(1);
    expect((await f.runtime.host.handoverHarnesses!(f.source.id)).pendingCreation).toBeUndefined();
  });
});
