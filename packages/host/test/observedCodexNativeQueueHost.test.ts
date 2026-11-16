import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { AGENT_HOST_METHODS } from '@extalia/platform';
import { createAgentHost } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temporary = useTempDirs();

it('exposes a source-bound read-only snapshot through the actual host without enabling submission or creating a session', async () => {
  const root = await realpath(await temporary()), home = path.join(root, 'home'), project = path.join(root, 'project');
  const codexHome = path.join(home, '.codex'), sessions = path.join(codexHome, 'sessions');
  const threadId = '11111111-1111-4111-8111-111111111111';
  await mkdir(sessions, { recursive: true }); await mkdir(project);
  await writeFile(path.join(sessions, 'rollout.jsonl'), [
    { type: 'session_meta', payload: { id: threadId, cwd: project, timestamp: '2026-11-08T00:00:00.000Z' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Existing source task' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const read = vi.fn(async () => ({ items: [{ id: 'native-pending', text: 'Source-owned waiting prompt', nonTextItems: 0 }] }));
  const fetch = vi.fn(async () => { throw new Error('No provider request belongs to queue inspection.'); });
  const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: path.join(root, 'data'), homeDirectory: home, importHome: home,
    env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_CODEX_BIN: process.execPath, PATH: '' }, observedCodexNativeQueueRead: read, fetch, observationIntervalMs: 60_000 });
  try {
    expect(AGENT_HOST_METHODS).toContain('observedCodexNativeQueueStatus');
    const scan = await runtime.host.scanImports(['codex']);
    const state = await runtime.host.observeImports(scan.scanId, [scan.sessions[0]!.id]);
    const id = state.sessions[0]!.id;
    const status = await runtime.host.observedCodexNativeQueueStatus!(id);
    expect(status).toMatchObject({ sessionId: id, threadId, state: 'ready', items: [{ text: 'Source-owned waiting prompt' }] });
    expect(read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ codexHome, cwd: project, threadId, signal: expect.any(AbortSignal) }));
    expect(JSON.stringify(status)).not.toContain(root);
    expect((await runtime.host.observedCodexQueueStatus!(id)).enabled).toBe(false);
    expect((await runtime.host.getState()).sessions.map(session => session.control)).toEqual(['observed']);
    expect(JSON.stringify(await runtime.host.observationSession(id))).not.toContain('Source-owned waiting prompt');
    await runtime.host.setHookPrivacy({ labelsOnly: true });
    expect(await runtime.host.observedCodexNativeQueueStatus!(id)).toMatchObject({ state: 'private', items: [] });
    expect(read).toHaveBeenCalledTimes(1);
    await runtime.host.setHookPrivacy({ labelsOnly: false });
    expect((await runtime.host.observedCodexNativeQueueStatus!(id)).state).toBe('ready');
    expect(read).toHaveBeenCalledTimes(2);
    await runtime.host.setObservation(id, false);
    expect(await runtime.host.observedCodexNativeQueueStatus!(id)).toMatchObject({ state: 'unavailable', items: [] });
    expect(read).toHaveBeenCalledTimes(2); expect(fetch).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});
