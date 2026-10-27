import type { AgentHostRuntime } from '@extalia/host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAgents, type Agents } from '../src/agentsIpc';
import { IPC, type IpcReply } from '../src/ipc';

const electron = vi.hoisted(() => ({
  createHost: vi.fn(),
  handle: vi.fn(),
  on: vi.fn(),
  quit: vi.fn(),
  windows: vi.fn(() => []),
}));

vi.mock('@extalia/host', () => ({ createAgentHost: electron.createHost, DESKTOP_HOOK_PORT: 4311 }));
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.0.0', on: electron.on, quit: electron.quit },
  BrowserWindow: { getAllWindows: electron.windows },
  ipcMain: { handle: electron.handle },
}));

const APP = 'extalia://app/index.html';
const LOCKED = 'Extalia is already running (Bridge process 123).';
const instances: Agents[] = [];

function launch() {
  const agents = startAgents({ devServer: undefined });
  instances.push(agents);
  const handler = electron.handle.mock.calls[0]?.[1] as (
    event: { senderFrame: { url: string } }, method: string, args: unknown[],
  ) => Promise<IpcReply<unknown>>;
  return { agents, call: (method = 'getState', args: unknown[] = [], url = APP) => handler({ senderFrame: { url } }, method, args) };
}

function runtime() {
  const state = { setupComplete: false };
  const host = {
    getState: vi.fn(async () => state),
    sendPrompt: vi.fn(async () => { throw new Error('Turn failed.'); }),
    agentAppConnections: vi.fn<() => Promise<{ app: string; installed: boolean; state: string }[]>>(async () => []),
    applyAgentAppConnect: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
  };
  const started = {
    host, hooks: { listen: vi.fn(async () => undefined) },
    isBusy: vi.fn(() => false), onIdle: vi.fn(() => () => undefined), close: vi.fn(async () => undefined),
  };
  return { started, value: started as unknown as AgentHostRuntime, state };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  electron.createHost.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  await Promise.all(instances.splice(0).map(agents => agents.close()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('desktop agent host lifecycle', () => {
  it('retries a failed startup after the profile owner releases it', async () => {
    const recovered = runtime();
    let locked = true;
    electron.createHost.mockImplementation(async () => {
      if (locked) throw new Error(LOCKED);
      return recovered.value;
    });
    const { agents, call } = launch();
    expect(await call()).toEqual({ ok: false, error: `Agents are not available: ${LOCKED}` });
    expect(await call()).toEqual({ ok: false, error: `Agents are not available: ${LOCKED}` });
    expect(recovered.started.host.getState).not.toHaveBeenCalled();
    expect(recovered.started.close).not.toHaveBeenCalled();
    locked = false;
    expect(await call()).toEqual({ ok: true, value: recovered.state });
    expect(await call()).toEqual({ ok: true, value: recovered.state });
    expect(electron.createHost).toHaveBeenCalledTimes(3);
    expect(electron.handle).toHaveBeenCalledExactlyOnceWith(IPC.agents, expect.any(Function));
    expect(recovered.started.hooks.listen).toHaveBeenCalledTimes(1);
    expect(recovered.started.host.subscribe).toHaveBeenCalledTimes(1);
    await agents.close();
    await agents.close();
    expect(recovered.started.close).toHaveBeenCalledTimes(1);
  });

  it('shares one retry among concurrent calls and retains the recovered runtime', async () => {
    const recovered = runtime();
    const pending = deferred<AgentHostRuntime>();
    electron.createHost.mockRejectedValueOnce(new Error(LOCKED)).mockReturnValueOnce(pending.promise);
    const { call } = launch();
    expect((await call()).ok).toBe(false);
    const replies = [call(), call(), call()];
    await Promise.resolve();
    expect(electron.createHost).toHaveBeenCalledTimes(2);
    pending.resolve(recovered.value);
    expect(await Promise.all(replies)).toEqual(Array.from({ length: 3 }, () => ({ ok: true, value: recovered.state })));
    expect(await call()).toEqual({ ok: true, value: recovered.state });
    expect(electron.createHost).toHaveBeenCalledTimes(2);
    expect(recovered.started.host.subscribe).toHaveBeenCalledTimes(1);
  });

  it('validates calls before retrying startup', async () => {
    electron.createHost.mockRejectedValue(new Error(LOCKED));
    const { call } = launch();
    await call();
    expect(await call('getState', [], 'https://example.com/')).toEqual({ ok: false, error: 'Untrusted sender.' });
    expect(await call('close')).toEqual({ ok: false, error: 'Unknown agent host method.' });
    expect(electron.createHost).toHaveBeenCalledTimes(1);
  });

  it('does not restart or replay a failed call on a running host', async () => {
    const recovered = runtime();
    electron.createHost.mockResolvedValue(recovered.value);
    const { call } = launch();
    expect(await call('sendPrompt', ['session', 'hello'])).toEqual({ ok: false, error: 'Turn failed.' });
    expect(await call()).toEqual({ ok: true, value: recovered.state });
    expect(recovered.started.host.sendPrompt).toHaveBeenCalledExactlyOnceWith('session', 'hello');
    expect(electron.createHost).toHaveBeenCalledTimes(1);
  });

  it('prevents retries once a failed host is closing', async () => {
    electron.createHost.mockRejectedValue(new Error(LOCKED));
    const { agents, call } = launch();
    await call();
    await agents.close();
    expect(await call()).toEqual({ ok: false, error: 'The agent host is shutting down.' });
    expect(electron.createHost).toHaveBeenCalledTimes(1);
  });

  it('closes a pending retry during quit before calling app.quit', async () => {
    const recovered = runtime();
    const pending = deferred<AgentHostRuntime>();
    electron.createHost.mockRejectedValueOnce(new Error(LOCKED)).mockReturnValueOnce(pending.promise);
    const { agents, call } = launch();
    await call();
    const reply = call();
    await Promise.resolve();
    const onQuit = electron.on.mock.calls.find(([name]) => name === 'will-quit')?.[1] as (event: { preventDefault(): void }) => void;
    const preventDefault = vi.fn();
    onQuit({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(electron.quit).not.toHaveBeenCalled();
    pending.resolve(recovered.value);
    expect(await reply).toEqual({ ok: false, error: 'The agent host is shutting down.' });
    await agents.close();
    await Promise.resolve();
    expect(recovered.started.close).toHaveBeenCalledTimes(1);
    expect(recovered.started.hooks.listen).not.toHaveBeenCalled();
    expect(recovered.started.host.subscribe).not.toHaveBeenCalled();
    expect(recovered.started.host.getState).not.toHaveBeenCalled();
    expect(electron.quit).toHaveBeenCalledTimes(1);
    onQuit({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('does not auto-connect Hermes if its lookup completes after shutdown', async () => {
    const recovered = runtime();
    const lookup = deferred<{ app: string; installed: boolean; state: string }[]>();
    recovered.started.host.agentAppConnections.mockReturnValue(lookup.promise);
    electron.createHost.mockResolvedValue(recovered.value);
    const { agents, call } = launch();
    expect(await call()).toEqual({ ok: true, value: recovered.state });
    expect(recovered.started.host.agentAppConnections).toHaveBeenCalledTimes(1);
    await agents.close();
    lookup.resolve([{ app: 'hermes', installed: true, state: 'not-connected' }]);
    await Promise.resolve();
    expect(recovered.started.host.applyAgentAppConnect).not.toHaveBeenCalled();
  });

  it('still closes a late startup after the bounded shutdown wait expires', async () => {
    vi.useFakeTimers();
    const recovered = runtime();
    const pending = deferred<AgentHostRuntime>();
    electron.createHost.mockReturnValue(pending.promise);
    const { agents, call } = launch();
    const closing = agents.close();
    await vi.advanceTimersByTimeAsync(5_000);
    await closing;
    expect(recovered.started.close).not.toHaveBeenCalled();
    pending.resolve(recovered.value);
    await vi.advanceTimersByTimeAsync(0);
    expect(recovered.started.close).toHaveBeenCalledTimes(1);
    expect(recovered.started.hooks.listen).not.toHaveBeenCalled();
    expect(await call()).toEqual({ ok: false, error: 'The agent host is shutting down.' });
    expect(electron.createHost).toHaveBeenCalledTimes(1);
  });
});
