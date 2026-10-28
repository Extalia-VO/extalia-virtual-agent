import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('retries failed Node detection and shares the successful service with concurrent refreshes', async () => {
    const root = await temp('extalia-agent-app-discovery-');
    const homeDirectory = path.join(root, 'home');
    const dataDirectory = path.join(root, 'data');
    const nodePath = path.join(homeDirectory, 'node', 'bin', 'node');
    await mkdir(homeDirectory);
    const connections = vi.fn(async () => []);
    connect.resolve.mockResolvedValueOnce(undefined).mockResolvedValue(nodePath);
    connect.create.mockReturnValue({ connections });
    runtime = await createAgentHost({
      kind: 'desktop', version: '0.0.0-test', homeDirectory, importHome: homeDirectory, dataDirectory,
      env: { EXTALIA_SECRET_STORE: 'memory', PATH: '' },
    });

    await expect(runtime.host.agentAppConnections()).rejects.toThrow('Node.js was not found');
    expect(connect.create).not.toHaveBeenCalled();
    await expect(Promise.all([runtime.host.agentAppConnections(), runtime.host.agentAppConnections()])).resolves.toEqual([[], []]);
    expect(connect.resolve).toHaveBeenCalledTimes(2);
    expect(connect.create).toHaveBeenCalledTimes(1);
    expect(connect.resolve).toHaveBeenLastCalledWith(expect.objectContaining({ homeDirectory }));
    expect(connect.create).toHaveBeenCalledWith(expect.objectContaining({
      homeDirectory, extaliaHome: dataDirectory, nodePath,
      env: expect.objectContaining({ PATH: path.dirname(nodePath) }),
    }));
  });
});
