import { EventEmitter } from 'node:events';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentHostRuntime } from '@extalia/host';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBridge, type StartDeps } from '../src/start';

const bridge = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  start: vi.fn(),
}));

vi.mock('../src/bridge/server', () => ({
  BridgeRequestError: class extends Error {},
  startBridgeServer: bridge.start,
}));

afterEach(() => { vi.clearAllMocks(); });

describe('Bridge hook startup', () => {
  it.each(['not-connected', 'partial', 'stale'])('announces the hook endpoint without discovering or changing %s Hermes configuration', async state => {
    bridge.start.mockResolvedValue({ port: 4310, url: 'http://127.0.0.1:4310/', token: 'temporary-token', close: bridge.close });
    const signals = new EventEmitter();
    const announce = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const host = {
      agentAppConnections: vi.fn(async () => [{ app: 'hermes', installed: true, state }]),
      applyAgentAppConnect: vi.fn(async () => undefined),
    };
    const runtime = { host, hooks: { announce }, close, isBusy: () => false, onIdle: () => () => undefined } as unknown as AgentHostRuntime;
    const deps: StartDeps = {
      version: '1.0.0', env: {}, dataDirectory: path.join(tmpdir(), 'extalia-start-mock', 'data'), webRoot: path.join(tmpdir(), 'extalia-start-mock', 'web'),
      createAgentHost: async () => runtime,
      out: () => undefined, err: () => undefined, signals, openBrowser: () => undefined,
      updater: { status: () => ({ state: 'unsupported', current: '1.0.0', channel: 'stable' }), check: vi.fn(), install: vi.fn() },
      relaunch: { execPath: process.execPath, execArgv: [], binPath: 'unused', args: [] }, spawn: vi.fn(),
    };
    const running = startBridge({ port: 4310, open: false, updateCheck: false }, deps);
    try {
      await vi.waitFor(() => expect(announce).toHaveBeenCalledExactlyOnceWith(4310));
      expect(host.agentAppConnections).not.toHaveBeenCalled();
      expect(host.applyAgentAppConnect).not.toHaveBeenCalled();
    } finally {
      signals.emit('SIGINT');
      expect(await running).toBe(0);
    }
    expect(bridge.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
