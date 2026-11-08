import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { PromptQueueStatus } from '@extalia/platform';
import { createAgentHost } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
async function fixture(history = true) {
  const root = await temp('extalia-prompt-integration-'), project = path.join(root, 'project'), home = path.join(root, 'home'), dataDirectory = path.join(root, 'data');
  await mkdir(project); await mkdir(home);
  const prompts: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'example-model' }] });
    const body = JSON.parse(String(init?.body));
    const user = body.messages.filter((item: { role: string }) => item.role === 'user').at(-1);
    prompts.push(user?.content);
    if (user?.content === 'hold current turn' && init?.signal && !init.signal.aborted) {
      await new Promise<void>(resolve => init.signal!.addEventListener('abort', () => resolve(), { once: true }));
    }
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory, homeDirectory: home, importHome: home,
    env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_HERMES_BIN: path.join(root, 'missing'), PATH: '' }, fetch });
  const host = runtime.host;
  const saved = await host.saveConnection({ name: 'Example', preset: 'custom', api: 'openai-chat', baseUrl: 'http://example.test/v1', model: 'example-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history } });
  const next = await host.saveWorkspace({ name: 'Example', projectLocation: project, connectionId: saved.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
  const session = await host.createSession(next.workspaces[0]!.id);
  return { root, home, dataDirectory, runtime, host, session, prompts };
}
const wait = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('The isolated queue did not settle.');
};
it('runs edited pending prompts in the selected managed session and waits for each prior turn', async () => {
  const f = await fixture();
  try {
    let queue = await f.host.promptQueueStatus!(f.session.id);
    for (const text of ['first', 'second', 'delete me']) queue = await f.host.changePromptQueue!(f.session.id, { revision: queue.revision, action: 'add', text });
    expect(f.prompts).toEqual([]); expect(queue.paused).toBe(true);
    queue = await f.host.changePromptQueue!(f.session.id, { revision: queue.revision, action: 'delete', itemId: queue.items[2]!.id });
    queue = await f.host.changePromptQueue!(f.session.id, { revision: queue.revision, action: 'edit', itemId: queue.items[1]!.id, text: 'second edited' });
    queue = await f.host.changePromptQueue!(f.session.id, { revision: queue.revision, action: 'reorder', itemIds: [queue.items[1]!.id, queue.items[0]!.id] });
    await f.host.changePromptQueue!(f.session.id, { revision: queue.revision, action: 'pause', paused: false });
    await wait(async () => (await f.host.promptQueueStatus!(f.session.id)).items.filter(item => item.state === 'sent').length === 2);
    expect(f.prompts).toEqual(['second edited', 'first']);
    const events = await f.host.sessionEvents(f.session.id);
    expect(events.filter(event => event.body.type === 'prompt.submitted').map(event => event.body.type === 'prompt.submitted' ? event.body.text : '')).toEqual(['second edited', 'first']);
    expect((await f.host.getState()).sessions).toHaveLength(1);
  } finally { await f.runtime.close(); }
});
it('does not persist transient queued text and drops only its local queue when the session is deleted', async () => {
  const f = await fixture(false);
  try {
    let queue = await f.host.promptQueueStatus!(f.session.id);
    queue = await f.host.changePromptQueue!(f.session.id, { revision: queue.revision, action: 'add', text: 'EPHEMERAL_QUEUED_EXAMPLE' });
    expect(queue.items).toHaveLength(1);
    for (const file of await readdir(f.dataDirectory, { recursive: true, withFileTypes: true })) if (file.isFile()) {
      expect(await readFile(path.join(file.parentPath, file.name), 'utf8').catch(() => '')).not.toContain('EPHEMERAL_QUEUED_EXAMPLE');
    }
    await f.host.deleteSession(f.session.id);
    expect((await f.host.promptQueueStatus!(f.session.id)).items).toEqual([]);
    expect(f.prompts).toEqual([]);
  } finally { await f.runtime.close(); }
});
it('pauses queued follow-ups when the user stops the active managed turn', async () => {
  const f = await fixture();
  try {
    await f.host.sendPrompt(f.session.id, 'hold current turn');
    await wait(async () => f.prompts.length === 1);
    let queue = await f.host.promptQueueStatus!(f.session.id);
    queue = await f.host.changePromptQueue!(f.session.id, { revision: queue.revision, action: 'add', text: 'follow-up held' });
    await f.host.changePromptQueue!(f.session.id, { revision: queue.revision, action: 'pause', paused: false });
    await f.host.cancel(f.session.id);
    await wait(async () => !(await f.host.getState()).sessions.find(item => item.id === f.session.id)?.running);
    queue = await f.host.promptQueueStatus!(f.session.id);
    expect(queue.paused).toBe(true); expect(queue.items[0]?.state).toBe('pending');
    expect(f.prompts).toEqual(['hold current turn']);
  } finally { await f.runtime.close(); }
});
it('edits an observed Codex outbox without sending into the source or changing queue opt-in', async () => {
  const f = await fixture();
  try {
    const folder = path.join(f.home, '.codex', 'sessions'); await mkdir(folder, { recursive: true });
    const nativeId = '11111111-1111-4111-8111-111111111111';
    await writeFile(path.join(folder, 'rollout.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: f.root, timestamp: '2026-01-01T00:00:00Z' } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Original synthetic message' }] } })}\n`);
    const scan = await f.host.scanImports(['codex']);
    const candidate = scan.sessions.find(item => item.nativeSessionId === nativeId)!;
    const state = await f.host.observeImports(scan.scanId, [candidate.id]);
    const observed = state.sessions.find(item => item.observation?.nativeSessionId === nativeId)!;
    let queue: PromptQueueStatus = await f.host.promptQueueStatus!(observed.id);
    queue = await f.host.changePromptQueue!(observed.id, { revision: queue.revision, action: 'add', text: 'Edit before native handoff' });
    queue = await f.host.changePromptQueue!(observed.id, { revision: queue.revision, action: 'edit', itemId: queue.items[0]!.id, text: 'Edited locally' });
    expect(queue.items[0]?.text).toBe('Edited locally'); expect(queue.paused).toBe(true);
    expect((await f.host.observedCodexQueueStatus!(observed.id)).enabled).toBe(false);
    await f.host.setObservation(observed.id, false);
    expect((await f.host.promptQueueStatus!(observed.id)).paused).toBe(true);
    expect(f.prompts).toEqual([]);
  } finally { await f.runtime.close(); }
});
