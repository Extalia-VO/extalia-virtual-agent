import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectService } from '../src/connect/service.js';
import type * as ConnectModule from '../src/connect/index.js';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const connect = vi.hoisted(() => ({ resolve: vi.fn(), create: vi.fn() }));
vi.mock('../src/connect/index.js', async importOriginal => ({
  ...await importOriginal<typeof ConnectModule>(),
  resolveNodePath: connect.resolve,
  createConnectService: connect.create,
}));

const temp = useTempDirs();
let runtime: AgentHostRuntime | undefined;
afterEach(async () => { await runtime?.close(); runtime = undefined; vi.resetAllMocks(); });

describe('agent-app discovery recovery', () => {
  it('keeps diagnostics available without Node and retries discovery with one shared service', async () => {
    const root = await temp('extalia-agent-app-discovery-');
    const homeDirectory = path.join(root, 'home');
    const dataDirectory = path.join(root, 'data');
    const nodePath = process.execPath;
    await mkdir(homeDirectory);
    connect.resolve.mockResolvedValueOnce(undefined).mockResolvedValue(nodePath);
    connect.create.mockImplementation(createConnectService);
    runtime = await createAgentHost({
      kind: 'desktop', version: '0.0.0-test', homeDirectory, importHome: homeDirectory, dataDirectory,
      env: { EXTALIA_SECRET_STORE: 'memory', PATH: '' },
    });

    const missing = await runtime.host.agentAppConnections();
    expect(missing.find(app => app.app === 'codex')?.nodeStatus).toBe('missing');
    expect(missing.find(app => app.app === 'hermes')?.nodeStatus).toBe('not-required');
    const refreshed = await Promise.all([runtime.host.agentAppConnections(), runtime.host.agentAppConnections()]);
    expect(refreshed.every(apps => apps.filter(app => app.app !== 'hermes').every(app => app.nodeStatus === 'ready'))).toBe(true);
    expect(connect.resolve).toHaveBeenCalledTimes(2);
    expect(connect.create).toHaveBeenCalledTimes(1);
    expect(connect.resolve).toHaveBeenLastCalledWith(expect.objectContaining({ homeDirectory }));
    expect(connect.create).toHaveBeenCalledWith(expect.objectContaining({
      homeDirectory, extaliaHome: dataDirectory, resolveNodePath: expect.any(Function),
      env: expect.objectContaining({ PATH: '' }),
    }));
  });
});
