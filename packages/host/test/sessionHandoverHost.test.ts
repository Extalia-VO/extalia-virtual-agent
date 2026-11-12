import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_HOST_METHODS, type ContinuityNotes } from '@extalia/platform';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { SessionStore } from '../src/sessions.js';
import { pollObservedInbox } from '../src/observedInboxClient.js';
import { handleMcpJsonRpc } from '../src/hooks/mcp.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const active = new Set<AgentHostRuntime>();
afterEach(async () => { await Promise.all([...active].map(runtime => runtime.close())); active.clear(); });
type Request = { model: string; messages: unknown[]; tools?: { function: { name: string } }[] };
function response(text = 'Verified response') {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
async function fixture(history = true) {
  const root = await temp('extalia-handover-');
  const project = path.join(root, 'project'), home = path.join(root, 'home'), data = path.join(root, 'data');
  await mkdir(project); await mkdir(home);
  const requests: Request[] = [];
  const open = async () => {
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
      env: { EXTALIA_SECRET_STORE: 'memory', PATH: '' }, observationIntervalMs: 60_000,
      fetch: async (url, init) => {
        if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }] });
        const request = JSON.parse(String(init?.body)) as Request; requests.push(request);
        return response(JSON.stringify(request.messages).includes('ORIGINAL-OBJECTIVE') ? 'ORIGINAL-OBJECTIVE retained' : 'No original objective');
      } });
    active.add(runtime); return runtime;
  };
  let runtime = await open();
  const connections = [];
  for (const model of ['alpha', 'beta', 'gamma']) {
    const state = await runtime.host.saveConnection({ name: `Connection ${model}`, preset: 'custom', api: 'openai-chat',
      baseUrl: `http://${model}.example/v1`, model, credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history } });
    connections.push(state.connections.find(connection => connection.name === `Connection ${model}`)!);
  }
  const state = await runtime.host.saveWorkspace({ name: 'Example project', projectLocation: project, connectionId: connections[0]!.id,
    crossWorkspaceAccess: 'read-only', permissions: { fileWrite: 'ask', commands: 'ask' } });
  const workspace = state.workspaces[0]!;
  return { root, project, home, data, requests, connections, workspace, store: new SessionStore(path.join(data, 'sessions')),
    get runtime() { return runtime; }, get host() { return runtime.host; },
    async restart() { await runtime.close(); active.delete(runtime); runtime = await open(); },
    async observed() {
      const folder = path.join(home, '.codex', 'sessions'); await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, 'rollout.jsonl'), [
        { type: 'session_meta', payload: { id: '11111111-1111-4111-8111-111111111111', cwd: project, timestamp: '2026-01-01T00:00:00.000Z' } },
        { type: 'response_item', timestamp: '2026-01-01T00:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ORIGINAL-OBJECTIVE from observed source' }] } },
        { type: 'response_item', timestamp: '2026-01-01T00:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Observed decision: retain existing artifacts' }] } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      const scan = await runtime.host.scanImports(['codex']);
      const result = await runtime.host.observeImports(scan.scanId, [scan.sessions[0]!.id]);
      return result.sessions.find(session => session.control === 'observed')!;
    },
  };
}
const notes: ContinuityNotes = { goal: 'ORIGINAL-OBJECTIVE', decisions: 'Keep prior verified artifacts', completed: 'First analysis',
  pending: 'Continue implementation', verification: 'External test evidence remains attributed', risks: 'Do not replay old tools' };
async function idle(runtime: AgentHostRuntime) { await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5000, interval: 10 }); }

describe('actual host cross-model and observed handover', () => {
  it('keeps one Native ID, team, history and reviewed notes through three connections and restart without inference during handover', async () => {
    const f = await fixture(), session = await f.host.createSession(f.workspace.id);
    for (const name of ['sessionContinuity', 'previewHandover', 'applyHandover', 'readContinuity']) expect(AGENT_HOST_METHODS).toContain(name);
    await f.host.sendPrompt(session.id, 'ORIGINAL-OBJECTIVE: preserve all work'); await idle(f.runtime);
    expect(f.requests[0]!.tools?.map(tool => tool.function.name)).not.toContain('continuity_read');
    const original = (await f.store.get(session.id))!;
    const originalMessages = await f.store.readMessages(session.id);
    const canonical = (await f.host.sessionContinuity!(session.id)).canonicalId;
    for (const [index, connection] of [f.connections[1]!, f.connections[2]!, f.connections[0]!].entries()) {
      const preview = await f.host.previewHandover!(session.id, { target: { kind: 'native', connectionId: connection.id }, notes });
      const count = f.requests.length;
      const receipt = await f.host.applyHandover!(session.id, { reviewId: preview.reviewId, operationId: `handover-${index}` });
      expect(receipt).toMatchObject({ canonicalId: canonical, targetSessionId: session.id, state: 'native-ready' });
      expect(f.requests).toHaveLength(count);
      const record = (await f.store.get(session.id))!;
      expect(record).toMatchObject({ id: session.id, connectionId: connection.id, title: original.title, createdAt: original.createdAt, agentName: original.agentName });
      expect((await f.store.readMessages(session.id)).slice(0, originalMessages.length)).toEqual(originalMessages);
      await f.host.sendPrompt(session.id, `Continue step ${index} without repeating completed work`); await idle(f.runtime);
      expect(f.requests.at(-1)!.model).toBe(connection.model);
      expect(f.requests.at(-1)!.tools?.map(tool => tool.function.name)).toEqual(expect.arrayContaining(['continuity_status', 'continuity_read']));
      expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain(notes.decisions);
      expect(JSON.stringify(f.requests.at(-1)!.messages)).not.toContain('extaliaHandover');
      if (index === 1) await f.restart();
    }
    const continuity = await f.host.sessionContinuity!(session.id);
    expect(continuity.canonicalId).toBe(canonical); expect(continuity.handovers).toHaveLength(3); expect(continuity.notes).toEqual(notes);
    const history = await f.store.readMessages(session.id) as { extaliaHandover?: unknown }[];
    expect(history.filter(message => message.extaliaHandover)).toHaveLength(1);
    expect(continuity.snapshots.some(source => source.model === 'beta')).toBe(true);
    const snapshot = continuity.snapshots[0]!;
    expect((await f.host.readContinuity!(session.id, { snapshotId: snapshot.id })).entries[0]!.text).toContain('ORIGINAL-OBJECTIVE');
    expect(continuity.snapshots.every(source => source.entries < 10)).toBe(true); // Generated capsules do not recursively become evidence.
  });
  it('adopts observed context once, then aliases both applications to the same durable canonical work', async () => {
    const f = await fixture(), observed = await f.observed();
    const preview = await f.host.previewHandover!(observed.id, { target: { kind: 'native', connectionId: f.connections[1]!.id }, notes });
    const receipt = await f.host.applyHandover!(observed.id, { reviewId: preview.reviewId, operationId: 'adopt-observed' });
    expect(receipt.state).toBe('native-ready'); expect(receipt.targetSessionId).not.toBe(observed.id);
    const managedId = receipt.targetSessionId!;
    await f.host.sendPrompt(managedId, 'Continue the observed objective'); await idle(f.runtime);
    expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain('Observed decision');
    expect((await f.host.sessionContinuity!(managedId)).canonicalId).toBe(preview.canonicalId);
    const inbox = await f.host.createObservedInbox!(observed.id);
    const status = await f.host.observedControlStatus!(observed.id);
    const capabilityId = status.routes.find(route => route.route === 'cooperative-inbox')!.capabilities.find(capability => capability.available)!.capabilityId!;
    const back = await f.host.previewHandover!(managedId, { target: { kind: 'observed', sessionId: observed.id, capabilityId } });
    const accessCode = back.packet.match(/\bsk-extalia-context-[a-f0-9]{64}\b/)?.[0];
    expect(accessCode).toBeTruthy();
    await f.runtime.hooks!.listen(0);
    const mcp = (name: string, args: Record<string, unknown>) => handleMcpJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: { access_code: accessCode, ...args } } },
    { extaliaHome: f.data, app: 'codex', sessionId: observed.observation!.nativeSessionId });
    expect((await mcp('extalia_continuity_status', {}))!.result).toMatchObject({ isError: true }); // Preview is not a read grant.
    const sent = await f.host.applyHandover!(managedId, { reviewId: back.reviewId, operationId: 'return-observed' });
    expect(sent).toMatchObject({ state: 'queued', canonicalId: preview.canonicalId, targetSessionId: observed.id });
    const delivered = await pollObservedInbox({ url: inbox.url!, token: inbox.token!, waitMs: 0 });
    expect(JSON.stringify(delivered)).toContain('ORIGINAL-OBJECTIVE');
    const manifest = await mcp('extalia_continuity_status', {});
    expect((manifest!.result as { isError?: boolean }).isError).not.toBe(true);
    expect(JSON.stringify(manifest)).toContain(preview.canonicalId);
    const page = await mcp('extalia_continuity_read', { snapshot_id: back.coverage[0]!.id, offset: 0, limit: 2 });
    expect(JSON.stringify(page)).toContain('ORIGINAL-OBJECTIVE');
    expect((await readFile(path.join(f.data, 'state', 'continuity-access.json'), 'utf8'))).not.toContain(accessCode!);
    expect((await f.host.sessionContinuity!(observed.id)).handovers).toHaveLength(2);
    const again = await f.host.previewHandover!(observed.id, { target: { kind: 'native', connectionId: f.connections[2]!.id } });
    expect(again.targetSessionId).toBe(managedId);
    const resumed = await f.host.applyHandover!(observed.id, { reviewId: again.reviewId, operationId: 'reuse-native-endpoint' });
    expect(resumed).toMatchObject({ canonicalId: preview.canonicalId, targetSessionId: managedId, state: 'native-ready' });
    expect((await f.host.getState()).sessions.filter(session => session.control === 'managed')).toHaveLength(1);
    await f.host.sendPrompt(managedId, 'FUTURE-WORK-NOT-IN-OLD-GRANT'); await idle(f.runtime);
    const latest = await f.host.sessionContinuity!(managedId);
    const futureSnapshot = latest.snapshots.at(-1)!;
    expect(back.coverage.some(snapshot => snapshot.id === futureSnapshot.id)).toBe(false);
    expect((await mcp('extalia_continuity_read', { snapshot_id: futureSnapshot.id }))!.result).toMatchObject({ isError: true });
    await f.host.setHookPrivacy({ labelsOnly: true });
    await expect(f.host.readContinuity!(observed.id, { snapshotId: preview.coverage[0]!.id })).rejects.toThrow(/private|labels-only/);
    await expect(f.host.readContinuity!(managedId, { snapshotId: preview.coverage[0]!.id })).rejects.toThrow(/private|labels-only/);
    expect((await mcp('extalia_continuity_status', {}))!.result).toMatchObject({ isError: true });
    await f.host.setHookPrivacy({ labelsOnly: false });
    expect((await mcp('extalia_continuity_status', {}))!.result).toMatchObject({ isError: true }); // Privacy revoked the old grant permanently.
  });
  it('refuses source, connection, workspace and queued-prompt drift before any handover effect', async () => {
    const f = await fixture(), session = await f.host.createSession(f.workspace.id);
    await f.host.sendPrompt(session.id, 'ORIGINAL-OBJECTIVE'); await idle(f.runtime);
    const target = { kind: 'native' as const, connectionId: f.connections[1]!.id };
    const preview = await f.host.previewHandover!(session.id, { target });
    await f.host.sendPrompt(session.id, 'New foreground evidence'); await idle(f.runtime);
    await expect(f.host.applyHandover!(session.id, { reviewId: preview.reviewId, operationId: 'stale-source' })).rejects.toThrow(/changed|review/i);
    expect((await f.store.get(session.id))!.connectionId).toBe(f.connections[0]!.id);
    const fresh = await f.host.previewHandover!(session.id, { target });
    const queue = await f.host.promptQueueStatus!(session.id);
    await f.host.changePromptQueue!(session.id, { revision: queue.revision, action: 'add', text: 'Pending user prompt' });
    await expect(f.host.applyHandover!(session.id, { reviewId: fresh.reviewId, operationId: 'queued-source' })).rejects.toThrow(/pending|queue|prompts/i);
    expect((await f.store.get(session.id))!.connectionId).toBe(f.connections[0]!.id);
    expect(await readFile(path.join(f.data, 'state', 'session-continuity.json'), 'utf8')).not.toContain('stale-source');
  });
  it('keeps handover context of history-off connections out of durable storage', async () => {
    const f = await fixture(false), session = await f.host.createSession(f.workspace.id);
    await f.host.sendPrompt(session.id, 'ORIGINAL-OBJECTIVE private fixture'); await idle(f.runtime);
    const preview = await f.host.previewHandover!(session.id, { target: { kind: 'native', connectionId: f.connections[1]!.id }, notes });
    expect(preview.persistent).toBe(false);
    await f.host.applyHandover!(session.id, { reviewId: preview.reviewId, operationId: 'private-handover' });
    const journal = await readFile(path.join(f.data, 'state', 'session-continuity.json'), 'utf8');
    expect(journal).not.toContain('ORIGINAL-OBJECTIVE'); expect(journal).not.toContain(session.id);
    await f.restart();
    expect((await f.host.getState()).sessions).toEqual([]);
  });
});
