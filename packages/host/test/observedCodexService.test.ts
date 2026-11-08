import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { ObservedCodexService } from '../src/observedCodexService.js';
import type { CodexObservedRpc, CodexObservedRpcOptions } from '../src/codexObservedControl.js';
import { createAgentHost } from '../src/service.js';

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };

async function fixture() {
  const root = await mkdtemp('/tmp/extalia-cx-');
  const socket = `${root}/control.sock`, server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  let binding = { threadId: 'native-one', cwd: '/projects/example', watching: true };
  let channel: CodexObservedRpcOptions | undefined;
  const request = vi.fn(async (method: string) => {
    if (method === 'thread/loaded/list') return { data: ['native-one'] };
    if (method === 'thread/read' || method === 'thread/resume') return { thread: { id: 'native-one', cwd: '/projects/example', status: { type: 'idle' }, turns: [] } };
    if (method === 'turn/start') return { turn: { id: 'turn-one', status: 'inProgress' } };
    return {};
  });
  const rpc: CodexObservedRpc = { request, notify: vi.fn(async () => {}), respond: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const factory = vi.fn(async (options: CodexObservedRpcOptions) => { channel = options; return rpc; });
  const options = { target: (id: string) => id === 'observed-one' ? binding : undefined, env: { EXTALIA_CODEX_BIN: process.execPath, PATH: '' }, rpcFactory: factory };
  const service = new ObservedCodexService(options);
  const cleanup = async () => { await service.close().catch(() => {}); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); };
  return { socket, service, factory, rpc, request, options, channel: () => channel!, change: (next: typeof binding) => { binding = next; }, cleanup };
}

describe.skipIf(process.platform === 'win32')('host-owned observed Codex bindings', () => {
  it('does not connect on a status read or accept an unrelated observed identity', async () => {
    const f = await fixture();
    try {
      expect(await f.service.status('observed-one')).toMatchObject({ state: 'disconnected', canSend: false });
      expect(await f.service.status('unrelated')).toMatchObject({ state: 'unavailable', requests: [] });
      await expect(f.service.connect('unrelated', f.socket)).rejects.toThrow('watched');
      expect(f.factory).not.toHaveBeenCalled();
      const state = await f.service.connect('observed-one', f.socket);
      expect(state).toMatchObject({ state: 'connected', threadId: 'native-one' });
      await f.service.send('observed-one', { connectionId: state.connectionId!, text: 'Continue this original thread' });
      expect(f.request).toHaveBeenCalledWith('turn/start', { threadId: 'native-one', input: [{ type: 'text', text: 'Continue this original thread' }] });
      expect(f.request.mock.calls.some(([method]) => method === 'thread/start' || method === 'thread/fork')).toBe(false);
    } finally { await f.cleanup(); }
  });

  it('revokes immediately on pause and requires explicit observation resume before reconnect', async () => {
    const f = await fixture();
    try {
      const state = await f.service.connect('observed-one', f.socket);
      const stopped = f.service.drop('observed-one');
      await expect(f.service.send('observed-one', { connectionId: state.connectionId!, text: 'late' })).rejects.toThrow('no longer active');
      await stopped;
      await expect(f.service.connect('observed-one', f.socket)).rejects.toThrow('watched');
      expect(f.request).not.toHaveBeenCalledWith('turn/start', expect.anything());
      f.service.resume('observed-one');
      expect(await f.service.connect('observed-one', f.socket)).toMatchObject({ state: 'connected' });
    } finally { await f.cleanup(); }
  });

  it('cannot resurrect a source dropped while connection discovery is pending', async () => {
    const f = await fixture();
    const waiting = deferred<CodexObservedRpc>();
    f.factory.mockImplementationOnce(async () => waiting.promise);
    try {
      const connecting = f.service.connect('observed-one', f.socket);
      while (f.factory.mock.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
      const stopped = f.service.drop('observed-one');
      waiting.resolve(f.rpc);
      await expect(connecting).rejects.toThrow('source changed');
      await stopped;
      expect(await f.service.status('observed-one')).toMatchObject({ state: 'unavailable', canSend: false });
      expect(f.rpc.close).toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it('tracks source-rebinding cleanup, observes failures and blocks replacement', async () => {
    const f = await fixture();
    try {
      const state = await f.service.connect('observed-one', f.socket);
      vi.mocked(f.rpc.close).mockRejectedValueOnce(new Error('unconfirmed reap'));
      f.change({ threadId: 'different-native', cwd: '/projects/example', watching: true });
      expect(await f.service.status('observed-one')).toMatchObject({ canSend: false });
      await settle();
      await expect(f.service.connect('observed-one', f.socket)).rejects.toThrow('cleanup');
      await expect(f.service.send('observed-one', { connectionId: state.connectionId!, text: 'wrong source' })).rejects.toThrow('no longer active');
      await expect(f.service.close()).rejects.toThrow('cleanup');
      expect(f.factory).toHaveBeenCalledTimes(1);
    } finally { await f.cleanup(); }
  });

  it('keeps a late proxy cleanup failure sticky after a dropped connection attempt', async () => {
    const f = await fixture(), waiting = deferred<CodexObservedRpc>();
    f.factory.mockImplementationOnce(async () => waiting.promise);
    vi.mocked(f.rpc.close).mockRejectedValue(new Error('unconfirmed late reap'));
    try {
      const connecting = f.service.connect('observed-one', f.socket);
      // Observe the promise immediately; the late owned proxy intentionally fails cleanup.
      const connectedResult = connecting.catch(error => error);
      while (f.factory.mock.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
      const dropping = f.service.drop('observed-one');
      const droppedResult = dropping.catch(error => error);
      waiting.resolve(f.rpc);
      expect(await connectedResult).toBeInstanceOf(Error);
      expect(await droppedResult).toBeInstanceOf(Error);
      f.service.resume('observed-one');
      await expect(f.service.connect('observed-one', f.socket)).rejects.toThrow('cleanup');
      await expect(f.service.close()).rejects.toThrow('cleanup');
      expect(f.factory).toHaveBeenCalledTimes(1);
    } finally { await f.cleanup(); }
  });

  it('wires authenticated host methods to the internal observed reference and never creates a managed session', async () => {
    const f = await fixture();
    const home = f.socket.replace('/control.sock', '/home');
    const stateDirectory = f.socket.replace('/control.sock', '/profile');
    const sessions = `${home}/.codex/sessions`;
    await mkdir(sessions, { recursive: true });
    await writeFile(`${sessions}/rollout.jsonl`, [
      { type: 'session_meta', payload: { id: 'native-one', cwd: '/projects/example', timestamp: '2026-11-08T00:00:00.000Z' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Example task' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: stateDirectory, homeDirectory: home, importHome: home,
      env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_CODEX_BIN: process.execPath, PATH: '' }, observedCodexRpc: f.options.rpcFactory, observationIntervalMs: 60_000 });
    try {
      const scan = await runtime.host.scanImports(['codex']);
      const state = await runtime.host.observeImports(scan.scanId, [scan.sessions[0]!.id]);
      const id = state.sessions[0]!.id;
      expect(await runtime.host.observedCodexStatus!(id)).toMatchObject({ state: 'disconnected' });
      expect(f.factory).not.toHaveBeenCalled();
      const connected = await runtime.host.connectObservedCodex!(id, f.socket);
      expect(connected).toMatchObject({ state: 'connected', sessionId: id, threadId: 'native-one' });
      await runtime.host.sendObservedCodexMessage!(id, { connectionId: connected.connectionId!, text: 'Continue in Codex' });
      await expect(runtime.host.sendPrompt(id, 'generic bypass')).rejects.toThrow('read-only');
      expect((await runtime.host.getState()).sessions.map(item => item.control)).toEqual(['observed']);
      await runtime.host.setObservation(id, false);
      await expect(runtime.host.sendObservedCodexMessage!(id, { connectionId: connected.connectionId!, text: 'late' })).rejects.toThrow('no longer active');
      expect(f.rpc.close).toHaveBeenCalled();
    } finally { await runtime.close(); await f.cleanup(); }
  });
});
