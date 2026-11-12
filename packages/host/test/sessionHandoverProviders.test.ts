import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ContinuityNotes } from '@extalia/platform';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { SessionStore } from '../src/sessions.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const active = new Set<AgentHostRuntime>();
afterEach(async () => { await Promise.all([...active].map(runtime => runtime.close())); active.clear(); });
type Body = Record<string, unknown>;
const notes: ContinuityNotes = { goal: 'Continue the original objective', decisions: 'Keep verified decisions', completed: 'Initial review',
  pending: 'Continue without replaying tools', verification: 'Verify the next provider response', risks: 'No hidden context is available' };

function openAi(text = 'OpenAI continuation') {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
}
function anthropic(text = 'Anthropic continuation') {
  const events = [
    { type: 'message_start', message: { id: 'msg-1', type: 'message', role: 'assistant', model: 'beta', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 21, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

async function fixture() {
  const root = await temp('extalia-handover-providers-');
  const project = path.join(root, 'project'), home = path.join(root, 'home'), data = path.join(root, 'data');
  await mkdir(project); await mkdir(home);
  const requests: { url: string; body: Body }[] = [];
  const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
    observationIntervalMs: 60_000, env: { EXTALIA_SECRET_STORE: 'memory', PATH: '' }, fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'alpha' }, { id: 'beta' }] });
      const body = JSON.parse(String(init?.body ?? '{}')) as Body; requests.push({ url, body });
      if (url.endsWith('/messages')) return anthropic();
      if (body.model === 'approval-model') return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'pending-write', function: { name: 'write_file', arguments: '{"path":"handover.txt","content":"pending"}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      return openAi();
    } });
  active.add(runtime);
  const open = (await runtime.host.saveConnection({ name: 'OpenAI compatible', preset: 'custom', api: 'openai-chat', baseUrl: 'https://alpha.example/v1', model: 'alpha',
    credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history: true } })).connections.find(item => item.name === 'OpenAI compatible')!;
  const anthropicConnection = (await runtime.host.saveConnection({ name: 'Anthropic Messages', preset: 'custom', api: 'anthropic-messages', baseUrl: 'https://beta.example', model: 'beta', effort: 'high',
    credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history: true } })).connections.find(item => item.name === 'Anthropic Messages')!;
  const workspace = (await runtime.host.saveWorkspace({ name: 'Provider handover', projectLocation: project, connectionId: open.id,
    permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  const store = new SessionStore(path.join(data, 'sessions'));
  return { runtime, host: runtime.host, requests, open, anthropicConnection, workspace, store };
}
async function idle(runtime: AgentHostRuntime) { await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5000, interval: 10 }); }

describe('Native provider handover continuity', () => {
  it('keeps one native session and tool history across OpenAI-compatible → Anthropic Messages → OpenAI-compatible', async () => {
    const f = await fixture(), session = await f.host.createSession(f.workspace.id);
    const nativeHistory = [
      { role: 'user', text: 'ORIGINAL-OBJECTIVE: retain the investigation' },
      { role: 'assistant', text: 'I inspected the source.', toolCalls: [{ id: 'call-read-1', name: 'read_file', input: { path: 'notes.md' } }], native: { api: 'openai-chat', content: { preservedMarker: 'provider-native-history' } } },
      { role: 'tool', results: [{ toolCallId: 'call-read-1', name: 'read_file', content: 'TOOL-RESULT: verified facts', isError: false }] },
    ];
    await f.store.writeMessages(session.id, nativeHistory);
    const canonicalId = (await f.host.sessionContinuity!(session.id)).canonicalId;
    const preview = await f.host.previewHandover!(session.id, { target: { kind: 'native', connectionId: f.anthropicConnection.id, model: 'beta', effort: 'high' }, notes });
    expect(preview.coverage[0]?.context).toBeUndefined(); // No reported context usage means no invented token budget.
    expect(preview.packet).toContain('Hidden harness context');
    const before = f.requests.length;
    const receipt = await f.host.applyHandover!(session.id, { reviewId: preview.reviewId, operationId: 'provider-hop-anthropic' });
    expect(f.requests).toHaveLength(before); // Applying a handover queues context; it never calls a model.
    expect(receipt).toMatchObject({ canonicalId, targetSessionId: session.id, state: 'native-ready' });
    expect((await f.store.get(session.id))?.id).toBe(session.id);
    expect((await f.store.readMessages(session.id)).slice(0, nativeHistory.length)).toEqual(nativeHistory);
    await f.host.sendPrompt(session.id, 'Continue from the verified tool result'); await idle(f.runtime);
    const anthro = f.requests.at(-1)!;
    expect(anthro.url).toBe('https://beta.example/v1/messages');
    expect(anthro.body).toMatchObject({ model: 'beta', output_config: { effort: 'high' } });
    const anthroMessages = anthro.body.messages as Body[];
    expect(JSON.stringify(anthroMessages)).toContain('ORIGINAL-OBJECTIVE');
    expect(JSON.stringify(anthroMessages)).toContain('TOOL-RESULT: verified facts');
    expect(JSON.stringify(anthroMessages)).toContain('tool_use');

    const back = await f.host.previewHandover!(session.id, { target: { kind: 'native', connectionId: f.open.id, model: 'alpha' }, notes });
    await f.host.applyHandover!(session.id, { reviewId: back.reviewId, operationId: 'provider-hop-openai' });
    const retained = await f.store.readMessages(session.id) as { role?: string; native?: { content?: { preservedMarker?: string } } }[];
    expect(retained.filter(item => item.role === 'assistant' && item.native?.content?.preservedMarker)).toHaveLength(1);
    await f.host.sendPrompt(session.id, 'Keep going on the same work'); await idle(f.runtime);
    const openAiRequest = f.requests.at(-1)!;
    expect(openAiRequest.url).toBe('https://alpha.example/v1/chat/completions');
    expect(openAiRequest.body.model).toBe('alpha');
    const openMessages = openAiRequest.body.messages as Body[];
    expect(JSON.stringify(openMessages)).toContain('call-read-1');
    expect(JSON.stringify(openMessages)).toContain('TOOL-RESULT: verified facts');
    expect((await f.host.sessionContinuity!(session.id)).canonicalId).toBe(canonicalId);
  });

  it('rejects unsupported effort, stale destination reviews, active work and pending approval ownership', async () => {
    const f = await fixture(), session = await f.host.createSession(f.workspace.id);
    await f.store.writeMessages(session.id, [{ role: 'user', text: 'ORIGINAL-OBJECTIVE' }]);
    await expect(f.host.previewHandover!(session.id, { target: { kind: 'native', connectionId: f.open.id, effort: 'high' } })).rejects.toThrow(/effort/i);
    const stale = await f.host.previewHandover!(session.id, { target: { kind: 'native', connectionId: f.anthropicConnection.id } });
    await f.host.saveConnection({ ...f.anthropicConnection, model: 'beta-v2' });
    await expect(f.host.applyHandover!(session.id, { reviewId: stale.reviewId, operationId: 'stale-provider-review' })).rejects.toThrow(/changed|review/i);
    expect((await f.store.get(session.id))?.connectionId).toBe(f.open.id);

    const events: { body: { type: string; approvalId?: string } }[] = [];
    f.host.subscribe(event => events.push(event as typeof events[number]));
    const pendingSession = await f.host.createSession(f.workspace.id, { model: 'approval-model' });
    await f.host.sendPrompt(pendingSession.id, 'Write a file and wait for approval');
    await expect(f.host.previewHandover!(pendingSession.id, { target: { kind: 'native', connectionId: f.anthropicConnection.id } })).rejects.toThrow(/finish|stop|working/i);
    const approval = await vi.waitFor(() => {
      const event = events.find(item => item.body.type === 'approval.requested');
      if (!event?.body.approvalId) throw new Error('approval not requested yet');
      return event.body.approvalId;
    }, { timeout: 5000 });
    await f.host.sessionContinuity!(pendingSession.id);
    await expect(f.host.previewHandover!(pendingSession.id, { target: { kind: 'native', connectionId: f.anthropicConnection.id } })).rejects.toThrow(/finish|stop|approval|ownership/i);
    expect((await f.host.getState()).sessions.find(item => item.id === pendingSession.id)?.pendingApprovalId).toBe(approval);
  });
});
