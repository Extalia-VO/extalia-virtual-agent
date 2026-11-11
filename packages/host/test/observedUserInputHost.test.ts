import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { AGENT_HOST_METHODS } from '@extalia/platform';
import { createAgentHost } from '../src/service.js';
import { useTempDirs } from './helpers.js';
const temporary = useTempDirs();
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
it('projects questions from the existing observation read and revokes pause, privacy and replaced sources', async () => {
  const root = await temporary(), home = path.join(root, 'home'), data = path.join(root, 'data');
  const folder = path.join(home, '.codex', 'sessions');
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, 'rollout.jsonl');
  const header = line({ type: 'session_meta', payload: { id: '11111111-1111-4111-8111-111111111111', cwd: '/projects/example', timestamp: '2026-11-10T00:00:00.000Z' } });
  const content = header + line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Plan the scope.' }] } })
    + line({ type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', call_id: 'call-one', arguments: JSON.stringify({ questions: [{ title: 'Which scope?', options: ['One', 'Two'] }] }) } })
    + line({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-one', output: '{"accepted":true}' } });
  await writeFile(file, content);
  const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, env: { EXTALIA_SECRET_STORE: 'memory', PATH: '' }, observationIntervalMs: 20 });
  try {
    expect(AGENT_HOST_METHODS).toContain('observedUserInputStatus');
    expect(AGENT_HOST_METHODS).toContain('answerObservedUserInput');
    const scan = await runtime.host.scanImports(['codex']);
    const state = await runtime.host.observeImports(scan.scanId, [scan.sessions[0]!.id]);
    const id = state.sessions[0]!.id;
    const initial = await runtime.host.observedUserInputStatus!(id);
    expect(initial).toMatchObject({ state: 'ready', requests: [{ origin: 'codex-async', state: 'pending', questions: [{ title: 'Which scope?', options: ['One', 'Two'], allowOther: true }] }] });
    expect(initial.requests[0]?.canAnswer).toBe(false); // No queue CLI exists in this synthetic home.
    await runtime.host.setObservation(id, false);
    expect((await runtime.host.observedUserInputStatus!(id)).state).toBe('unavailable');
    await runtime.host.setObservation(id, true);
    const resumed = await runtime.host.observedUserInputStatus!(id);
    expect(resumed.requests[0]?.id).toBe(initial.requests[0]?.id);
    expect(resumed.requests[0]?.revision).not.toBe(initial.requests[0]?.revision);
    await appendFile(file, line({ type: 'event_msg', payload: { type: 'task_complete' } }));
    await expect.poll(async () => (await runtime.host.observedUserInputStatus!(id)).requests.length).toBe(1);
    await runtime.host.setHookPrivacy({ labelsOnly: true });
    expect((await runtime.host.observedUserInputStatus!(id)).state).toBe('private');
    await runtime.host.setHookPrivacy({ labelsOnly: false });
    await expect.poll(async () => (await runtime.host.observedUserInputStatus!(id)).requests.length).toBe(1);
    await rename(file, path.join(folder, 'old.jsonl'));
    await writeFile(file, content);
    // Stable native thread id alone cannot preserve an answer handle after the file identity changes.
    expect((await runtime.host.observedUserInputStatus!(id)).requests).toEqual([]);
    await runtime.host.setHookPrivacy({ labelsOnly: true });
    expect(await runtime.host.observedUserInputStatus!(id)).toEqual({ sessionId: id, state: 'private', requests: [] });
  } finally { await runtime.close(); }
});
