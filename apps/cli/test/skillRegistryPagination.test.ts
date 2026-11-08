import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentHostApi, SkillRegistryPage, UpdateStatus } from '@extalia/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBridgeServer, TOKEN_HEADER, type BridgeServer } from '../src/bridge/server';

const cursor = `example-skill/skr_${'a'.repeat(64)}`;
const status: UpdateStatus = { current: '1.0.0', channel: 'stable', state: 'unsupported' };
const servers: BridgeServer[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(host: Partial<AgentHostApi>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'extalia-catalog-page-')); directories.push(directory);
  const server = await startBridgeServer({ port: 0, webRoot: directory, agents: async () => host as AgentHostApi,
    updates: { status: () => status, check: async () => status, install: async () => status } });
  servers.push(server);
  const call = (args: unknown[]) => fetch(`${server.url}api/call`, { method: 'POST', headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: server.token },
    body: JSON.stringify({ method: 'skillRegistryPage', args }) });
  return { call };
}

describe('registry metadata continuation over Bridge', () => {
  it('forwards valid pages and rejects malformed requests before host invocation', async () => {
    const page: SkillRegistryPage = { revisions: [], indexGeneration: 7, nextCursor: cursor };
    const skillRegistryPage = vi.fn(async () => page);
    const { call } = await fixture({ skillRegistryPage });
    const response = await call([{ cursor }]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: page });
    expect(skillRegistryPage).toHaveBeenCalledExactlyOnceWith({ cursor });
    for (const args of [[], [{ cursor }, {}], [{ cursor: '' }], [{ cursor, profile: 'other' }], [{ cursor, limit: 1000 }]]) {
      expect((await call(args)).status).toBe(400);
    }
    expect(skillRegistryPage).toHaveBeenCalledOnce();
  });

  it('keeps older hosts compatible by reporting the optional method as unsupported', async () => {
    const { call } = await fixture({});
    const response = await call([{ cursor }]);
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: 'This host does not support this action.' });
  });
});
