import { createAgentHost } from '../src/service.js';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs(), hosts: AgentHostRuntime[] = [];
afterEach(async () => { while (hosts.length) await hosts.pop()!.close(); });
interface Body { model: string; messages: { role: string; content?: string }[]; tools?: unknown[] }
const prediction = (body: Body) => body.messages[0]?.content?.startsWith('Suggest useful next user prompts') ?? false;
const response = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(options: { hold?: Promise<void>; history?: boolean; failed?: boolean } = {}) {
  const root = await temp(), project = path.join(root, 'project'), data = path.join(root, 'data'), home = path.join(root, 'home');
  await mkdir(project); await mkdir(home);
  const requests: Body[] = [];
  const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
    env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_HERMES_BIN: path.join(root, 'missing'), EXTALIA_NATIVE_CORE: 'typescript', PATH: '' },
    fetch: async (url, init) => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'fixture-model' }] });
      const body = JSON.parse(String(init?.body)) as Body; requests.push(body);
      if (prediction(body)) { await options.hold; return response(JSON.stringify({ prompts: ['Review parser edge cases.'] })); }
      return options.failed ? new Response('Unavailable', { status: 503 }) : response('Completed the parser update and verified the relevant behavior.');
    },
  });
  hosts.push(runtime); const host = runtime.host;
  const connection = (await host.saveConnection({ name: 'Fixture', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'fixture-model', credential: { kind: 'none' },
    features: { memory: 'off', skills: 'off', history: options.history ?? true } })).connections[0]!;
  const workspace = (await host.saveWorkspace({ name: 'Fixture', projectLocation: project, connectionId: connection.id,
    permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  const session = await host.createSession(workspace.id);
  const finish = async (text = 'Update the parser.') => { await host.sendPrompt(session.id, text); await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { interval: 5 }); };
  return { root, data, host, runtime, session, requests, finish };
}

it('offers without inference, then uses the approved model once without altering task history or sending a follow-up', async () => {
  const f = await fixture(); await f.finish();
  const offered = await f.host.promptSuggestions!(f.session.id);
  expect(offered).toMatchObject({ canRequest: true, origin: 'native', prompts: [], anchor: expect.any(String) });
  expect(f.requests).toHaveLength(1);
  await f.host.requestPromptSuggestions!(f.session.id, offered.anchor!);
  await vi.waitFor(async () => expect((await f.host.promptSuggestions!(f.session.id)).state).toBe('ready'), { interval: 5 });
  expect((await f.host.promptSuggestions!(f.session.id)).prompts).toEqual(['Review parser edge cases.']);
  const generated = f.requests.filter(prediction); expect(generated).toHaveLength(1);
  expect(generated[0]).toMatchObject({ model: 'fixture-model' }); expect(generated[0]!.tools ?? []).toEqual([]);
  await f.host.requestPromptSuggestions!(f.session.id, offered.anchor!); expect(f.requests).toHaveLength(2);
  expect(JSON.stringify(await f.host.sessionEvents(f.session.id))).not.toContain('Review parser edge cases.');
  expect((await f.host.getState()).sessions).toHaveLength(1);
});

it('does not keep the task busy and discards a late prediction after a new user task', async () => {
  const hold = deferred(), f = await fixture({ hold: hold.promise });
  try {
    await f.finish(); const old = await f.host.promptSuggestions!(f.session.id);
    await f.host.requestPromptSuggestions!(f.session.id, old.anchor!);
    expect(f.runtime.isBusy()).toBe(false);
    await f.finish('Check the updated parser.'); const next = await f.host.promptSuggestions!(f.session.id);
    expect(next.anchor).not.toBe(old.anchor); expect(next.prompts).toEqual([]);
    hold.resolve(); await Promise.resolve(); await Promise.resolve();
    expect((await f.host.promptSuggestions!(f.session.id)).prompts).toEqual([]);
    expect(f.requests.filter(prediction)).toHaveLength(1);
  } finally { hold.resolve(); }
});

it('lets queued work take precedence and never generates on a failed task', async () => {
  const f = await fixture(); await f.finish(); const offered = await f.host.promptSuggestions!(f.session.id);
  const queue = await f.host.promptQueueStatus!(f.session.id);
  await f.host.changePromptQueue!(f.session.id, { revision: queue.revision, action: 'add', text: 'Next queued task.' });
  expect(await f.host.promptSuggestions!(f.session.id)).toMatchObject({ canRequest: false, prompts: [] });
  await f.host.requestPromptSuggestions!(f.session.id, offered.anchor!); expect(f.requests.filter(prediction)).toHaveLength(0);
  const failed = await fixture({ failed: true }); await failed.finish();
  expect(await failed.host.promptSuggestions!(failed.session.id)).toMatchObject({ canRequest: false, prompts: [] });
  expect(failed.requests.filter(prediction)).toHaveLength(0);
});

it('keeps history-off suggestion text out of profile files', async () => {
  const f = await fixture({ history: false }); await f.finish(); const offered = await f.host.promptSuggestions!(f.session.id);
  await f.host.requestPromptSuggestions!(f.session.id, offered.anchor!);
  await vi.waitFor(async () => expect((await f.host.promptSuggestions!(f.session.id)).state).toBe('ready'), { interval: 5 });
  for (const file of await readdir(f.data, { recursive: true })) if (/\.jsonl?$/.test(file))
    expect(await readFile(path.join(f.data, file), 'utf8')).not.toContain('Review parser edge cases.');
});

it('stages authenticated observed harness reports until completion, clears on a new task, and honors privacy', async () => {
  const f = await fixture();
  const listener = await f.runtime.hooks!.listen(0);
  const token = (await readFile((await f.host.hookIngest()).tokenPath, 'utf8')).trim();
  const emit = async (hook_event_name: string, extra: Record<string, unknown> = {}) => {
    const result = await fetch(`http://127.0.0.1:${listener.port}/api/hooks/claude`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ session_id: 'observed-source', hook_event_name, ...extra }) });
    expect(result.ok).toBe(true);
  };
  await emit('SessionStart');
  let id = '';
  await vi.waitFor(async () => {
    id = (await f.host.getState()).sessions.find(session => session.observation?.nativeSessionId === 'observed-source')?.id ?? '';
    expect(id).not.toBe('');
  }, { interval: 5 });
  await emit('UserPromptSubmit', { prompt: 'Update the parser.' });
  const prompts = ['Inspect optional-field scenarios.'];
  await emit('report_followups', { tool_input: { prompts } });
  expect((await f.host.promptSuggestions!(id)).prompts).toEqual([]);
  await emit('Stop', { last_assistant_message: 'Completed the parser work.' });
  await vi.waitFor(async () => expect(await f.host.promptSuggestions!(id)).toMatchObject({ state: 'ready', origin: 'harness', prompts, canRequest: false }), { interval: 5 });
  expect(JSON.stringify(await f.host.sessionEvents(id))).not.toContain(prompts[0]);
  await f.host.setObservation(id, false);
  await f.host.setObservation(id, true);
  expect((await f.host.promptSuggestions!(id)).prompts).toEqual([]);
  await emit('UserPromptSubmit', { prompt: 'Start a different task.' });
  await vi.waitFor(async () => expect((await f.host.promptSuggestions!(id)).prompts).toEqual([]), { interval: 5 });
  await f.host.setHookPrivacy({ labelsOnly: true });
  await emit('report_followups', { tool_input: { prompts } });
  await emit('Stop', { last_assistant_message: 'Done.' });
  expect(await f.host.promptSuggestions!(id)).toMatchObject({ state: 'private', prompts: [], canRequest: false });
  expect(f.requests).toHaveLength(0);
});
