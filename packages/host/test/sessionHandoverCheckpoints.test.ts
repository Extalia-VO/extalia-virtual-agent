import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HandoverTarget } from '@extalia/platform';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { handleMcpJsonRpc } from '../src/hooks/mcp.js';
import { SessionStore } from '../src/sessions.js';
import * as jsonStore from '../src/jsonStore.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const active = new Set<AgentHostRuntime>();
afterEach(async () => { await Promise.all([...active].map(runtime => runtime.close())); active.clear(); });
const CODEX = '11111111-1111-4111-8111-111111111111';
const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const message = (role: 'user' | 'assistant', text: string) => ({ type: 'response_item', timestamp: new Date().toISOString(),
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
function response() {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'NATIVE-FINISHED: retain the verified checkpoint' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
}

/** Real host/persistence/Observe boundaries; model and external conversation evidence are synthetic. */
async function fixture(options: { observeMode?: boolean; register?: boolean; isolated?: boolean } = {}) {
  const root = await temp('extalia-handover-checkpoints-');
  const home = path.join(root, 'home'), project = path.join(root, 'project'), data = path.join(root, 'data');
  const rollout = path.join(home, '.codex', 'sessions', 'rollout.jsonl');
  await Promise.all([mkdir(project), mkdir(path.dirname(rollout), { recursive: true })]);
  await writeFile(rollout, lines([{ type: 'session_meta', payload: { id: CODEX, cwd: project, timestamp: new Date().toISOString() } },
    message('user', 'ORIGINAL-CHECKPOINT: continue the same migration'), message('assistant', 'DECISION-KEEP: preserve the tested schema')]));
  let hold = false, approval = false, release: (() => void) | undefined;
  const requests: { model: string; messages: unknown[] }[] = [];
  const open = async () => {
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', homeDirectory: home, importHome: home,
      dataDirectory: data, env: { EXTALIA_SECRET_STORE: 'memory', PATH: '' }, observationIntervalMs: 60_000,
      fetch: async (url, init) => {
        if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'fixture-model' }] });
        requests.push(JSON.parse(String(init?.body)) as typeof requests[number]);
        if (hold) { hold = false; await new Promise<void>(resolve => { release = resolve; }); }
        if (approval) {
          approval = false;
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'checkpoint-write',
            function: { name: 'write_file', arguments: JSON.stringify({ path: 'pending.txt', content: 'Needs the original approval' }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } });
        }
        return response();
      } });
    active.add(runtime); return runtime;
  };
  let runtime = await open();
  const connection = (await runtime.host.saveConnection({ name: 'Checkpoint model', preset: 'custom', api: 'openai-chat',
    baseUrl: 'https://checkpoint.example/v1', model: 'fixture-model', credential: { kind: 'none' },
    features: { memory: 'off', skills: 'off', history: true } })).connections[0]!;
  const register = async (isolated = options.isolated ?? false, observe = options.observeMode ?? false) => {
    const state = await runtime.host.saveWorkspace({ name: 'Checkpoint project', projectLocation: project,
      mode: observe ? 'observe' : 'managed', connectionId: connection.id,
      crossWorkspaceAccess: isolated ? 'isolated' : 'read-only', permissions: { fileWrite: 'ask', commands: 'ask' } });
    return state.workspaces.find(workspace => workspace.projectLocation === project)!;
  };
  const workspace = options.register === false ? undefined : await register();
  if (options.observeMode) await runtime.host.setWorkflow!('observe');
  const scan = await runtime.host.scanImports(['codex']);
  const observed = (await runtime.host.observeImports(scan.scanId, scan.sessions.map(session => session.id))).sessions.find(session => session.control === 'observed')!;
  return { home, project, data, rollout, workspace, connection, observed, requests, register,
    get runtime() { return runtime; }, get host() { return runtime.host; },
    store: new SessionStore(path.join(data, 'sessions')),
    holdNext() { hold = true; }, release() { release?.(); },
    requestApproval() { approval = true; },
    async restart() { await runtime.close(); active.delete(runtime); runtime = await open(); },
    async append(text: string) { await appendFile(rollout, lines([message('assistant', text)])); await runtime.host.setObservation(observed.id, true); },
    async markActive() {
      await runtime.hooks!.listen();
      await handleMcpJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'report_intent',
        arguments: { session_id: CODEX, cwd: project, intent: 'Still verifying the current migration' } } },
      { extaliaHome: data, app: 'codex' });
      await vi.waitFor(async () => expect((await runtime.host.getState()).sessions.find(session => session.id === observed.id)?.running).toBe(true));
    },
  };
}
const idle = async (runtime: AgentHostRuntime) => vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5000, interval: 10 });

describe('actual host repeatable Observe checkpoints', () => {
  it('freezes an active Observe source, explicitly enables Native on apply, reuses its endpoint and survives restart', async () => {
    const f = await fixture({ observeMode: true });
    await f.markActive();
    await expect(f.host.continueSession({ kind: 'observed', id: f.observed.id }, f.workspace!.id)).rejects.toThrow(/review/i);
    expect((await f.host.handoverHarnesses!(f.observed.id)).harnesses.find(item => item.id === 'extalia')?.create).toBe('ready');
    await expect(f.host.previewHandover!(f.observed.id, { capture: 'checkpoint', target: { kind: 'native', connectionId: f.connection.id } })).rejects.toThrow(/enabling|Enable/i);
    const target: HandoverTarget = { kind: 'native', connectionId: f.connection.id, enableManagedWorkspace: true };
    const preview = await f.host.previewHandover!(f.observed.id, { capture: 'checkpoint', target });
    expect(preview.checkpoint?.activity).toBe('active');
    expect(preview.packet).toContain('DECISION-KEEP');
    expect(preview.coverage.at(-1)?.coverage.mode).toBe('partial');
    expect((await f.host.getState()).workspaces[0]?.mode).toBe('observe');
    await f.append('AFTER-REVIEW: this work is not in the frozen checkpoint');
    await f.host.sessionContinuity!(f.observed.id); // A status refresh must not invalidate the reviewed checkpoint.
    expect(preview.packet).not.toContain('AFTER-REVIEW');
    const receipt = await f.host.applyHandover!(f.observed.id, { reviewId: preview.reviewId, operationId: 'checkpoint-observe-native' });
    expect(receipt.state).toBe('native-ready');
    const nativeId = receipt.targetSessionId!;
    const state = await f.host.getState();
    expect(state.workspaces[0]).toMatchObject({ id: f.workspace!.id, mode: 'managed', permissions: f.workspace!.permissions });
    expect(state.workflow).toBe('managed');
    expect(f.requests).toHaveLength(0);
    const imported = JSON.stringify(await f.store.readMessages(nativeId));
    expect(imported).toContain('ORIGINAL-CHECKPOINT'); expect(imported).not.toContain('AFTER-REVIEW');
    await f.host.sendPrompt(nativeId, 'Continue from the reviewed checkpoint'); await idle(f.runtime);
    expect(JSON.stringify(f.requests[0]?.messages)).toContain('DECISION-KEEP');
    await f.restart();
    const latest = await f.host.previewHandover!(f.observed.id, { capture: 'checkpoint', target: { kind: 'native', connectionId: f.connection.id } });
    expect(latest.canonicalId).toBe(preview.canonicalId); expect(latest.targetSessionId).toBe(nativeId);
    expect(latest.packet).toContain('AFTER-REVIEW');
    const again = await f.host.applyHandover!(f.observed.id, { reviewId: latest.reviewId, operationId: 'checkpoint-observe-native-again' });
    expect(again).toMatchObject({ state: 'native-ready', targetSessionId: nativeId });
    expect((await f.host.getState()).sessions.filter(session => session.control === 'managed')).toHaveLength(1);
    expect((await f.store.readMessages(nativeId) as { extaliaHandover?: unknown }[]).filter(message => message.extaliaHandover)).toHaveLength(1);
  });

  it('permits a Native checkpoint export during inference without stopping the source or changing its model', async () => {
    const f = await fixture(), native = await f.host.createSession(f.workspace!.id);
    f.holdNext();
    try {
      await f.host.sendPrompt(native.id, 'ACTIVE-OBJECTIVE: preserve this ongoing work');
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      const beforeQueue = await f.host.promptQueueStatus!(native.id);
      await f.host.changePromptQueue!(native.id, { revision: beforeQueue.revision, action: 'add', text: 'QUEUED-LATER: keep with the original session' });
      const preview = await f.host.previewHandover!(native.id, { capture: 'checkpoint', target: { kind: 'manual', label: 'Reviewed external destination' } });
      expect(preview.checkpoint?.activity).toBe('active');
      expect(preview.packet).toContain('ACTIVE-OBJECTIVE'); expect(preview.packet).not.toContain('NATIVE-FINISHED');
      expect(preview.packet).not.toContain('QUEUED-LATER');
      expect(preview.coverage.at(-1)?.coverage.limits.join(' ')).toContain('queued prompts');
      expect((await f.host.applyHandover!(native.id, { reviewId: preview.reviewId, operationId: 'active-native-export' })).state).toBe('manual-ready');
      expect((await f.host.getState()).sessions.find(session => session.id === native.id)?.running).toBe(true);
      expect((await f.host.promptQueueStatus!(native.id)).items[0]?.state).toBe('pending');
      // A checkpoint never gives permission to overwrite a busy destination's model history.
      await expect(f.host.previewHandover!(native.id, { capture: 'checkpoint', target: { kind: 'native', connectionId: f.connection.id } })).rejects.toThrow(/Finish|stop|working|pending/);
    } finally { f.release(); }
    await idle(f.runtime);
    const later = await f.host.previewHandover!(native.id, { capture: 'checkpoint', target: { kind: 'manual', label: 'Next checkpoint' } });
    expect(later.packet).toContain('NATIVE-FINISHED');
    expect((await f.store.get(native.id))?.connectionId).toBe(f.connection.id);
  });

  it('captures an approval checkpoint without answering or moving the original approval', async () => {
    const f = await fixture(), native = await f.host.createSession(f.workspace!.id);
    f.requestApproval();
    try {
      await f.host.sendPrompt(native.id, 'Write the pending file after approval');
      await vi.waitFor(async () => expect((await f.host.getState()).sessions.find(session => session.id === native.id)?.pendingApprovalId).toBeTruthy());
      const original = (await f.host.getState()).sessions.find(session => session.id === native.id)!.pendingApprovalId;
      const preview = await f.host.previewHandover!(native.id, { capture: 'checkpoint', target: { kind: 'manual', label: 'Approval checkpoint receiver' } });
      expect(preview.checkpoint?.activity).toBe('approval');
      expect(preview.coverage.at(-1)?.coverage.limits.join(' ')).toContain('not transferred or accepted');
      expect((await f.host.applyHandover!(native.id, { reviewId: preview.reviewId, operationId: 'approval-checkpoint' })).state).toBe('manual-ready');
      expect((await f.host.getState()).sessions.find(session => session.id === native.id)?.pendingApprovalId).toBe(original);
      await expect(readFile(path.join(f.project, 'pending.txt'), 'utf8')).rejects.toThrow();
    } finally { await f.host.cancel(native.id); }
  });

  it('keeps checkpoints pinned to source access and rejects pause/resume ABA without creating a Native destination', async () => {
    const f = await fixture();
    const preview = await f.host.previewHandover!(f.observed.id, { capture: 'checkpoint', target: { kind: 'native', connectionId: f.connection.id } });
    await f.host.setObservation(f.observed.id, false); await f.host.setObservation(f.observed.id, true);
    await expect(f.host.applyHandover!(f.observed.id, { reviewId: preview.reviewId, operationId: 'stale-access' })).rejects.toThrow(/changed|access/i);
    expect((await f.host.getState()).sessions.filter(session => session.control === 'managed')).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  });

  it('does not lock a previously inspected unregistered source out of a matching isolated project', async () => {
    const f = await fixture({ register: false });
    const inspected = await f.host.sessionContinuity!(f.observed.id);
    expect(inspected.workspaceId).toMatch(/^observed:/u);
    expect((await f.host.observedWorkspaceLink!(f.observed.id)).lockedWorkspaceId).toBeUndefined();
    const workspace = await f.register(true);
    const association = await f.host.observedWorkspaceLink!(f.observed.id);
    await f.host.setObservedWorkspaceLink!(f.observed.id, { revision: association.revision, workspaceId: workspace.id });
    const preview = await f.host.previewHandover!(f.observed.id, { capture: 'checkpoint', target: { kind: 'native', connectionId: f.connection.id } });
    const receipt = await f.host.applyHandover!(f.observed.id, { reviewId: preview.reviewId, operationId: 'inspected-then-isolated' });
    expect(receipt.state).toBe('native-ready');
    expect((await f.store.get(receipt.targetSessionId!))?.workspaceId).toBe(workspace.id);
    expect(preview.packet).toContain('ORIGINAL-CHECKPOINT');
  });

  it('uses the same lineage and Native endpoint for repeated legacy Continue actions on an associated source', async () => {
    const f = await fixture();
    const before = await readFile(f.rollout, 'utf8');
    const first = await f.host.continueSession({ kind: 'observed', id: f.observed.id }, f.workspace!.id);
    const canonical = (await f.host.sessionContinuity!(first.id)).canonicalId;
    const second = await f.host.continueSession({ kind: 'observed', id: f.observed.id }, f.workspace!.id);
    expect(second.id).toBe(first.id);
    expect((await f.host.sessionContinuity!(f.observed.id)).canonicalId).toBe(canonical);
    expect(await readFile(f.rollout, 'utf8')).toBe(before);
    expect(f.requests).toHaveLength(0);
  });

  it('refuses a Native destination changed after its durable reservation but before the context write lock', async () => {
    const f = await fixture();
    const initial = await f.host.previewHandover!(f.observed.id, { capture: 'checkpoint', target: { kind: 'native', connectionId: f.connection.id } });
    const created = await f.host.applyHandover!(f.observed.id, { reviewId: initial.reviewId, operationId: 'create-reservation-race-target' });
    expect(created.state).toBe('native-ready');
    const nativeId = created.targetSessionId!, history = await f.store.readMessages(nativeId);
    const preview = await f.host.previewHandover!(f.observed.id, { capture: 'checkpoint', target: { kind: 'native', connectionId: f.connection.id } });
    const operationId = 'destination-changed-during-reservation', writeAtomic = jsonStore.writeJsonAtomic;
    let changed = false;
    const writing = vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementation(async (file, value, options) => {
      await writeAtomic(file, value, options);
      // This is the real journal reservation, before applyEffect acquires the destination lock.
      if (!changed && file === path.join(f.data, 'state', 'session-continuity.json') && JSON.stringify(value).includes(operationId)) {
        changed = true;
        await f.host.setSessionOptions(nativeId, { model: 'changed-after-review' });
      }
    });
    try {
      const receipt = await f.host.applyHandover!(f.observed.id, { reviewId: preview.reviewId, operationId });
      expect(changed).toBe(true);
      expect(receipt.state).toBe('rejected');
      expect(receipt.problem).toContain('Native destination changed after review');
      expect((await f.store.get(nativeId))?.options?.model).toBe('changed-after-review');
      expect(await f.store.readMessages(nativeId)).toEqual(history);
      expect(f.requests).toHaveLength(0);
      expect(await f.host.applyHandover!(f.observed.id, { reviewId: preview.reviewId, operationId })).toEqual(receipt);
    } finally { writing.mockRestore(); }
  });
});
