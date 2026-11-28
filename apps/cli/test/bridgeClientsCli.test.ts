import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentHostApi, UpdateStatus } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgePairingStore } from '../src/bridge/pairing';
import { startBridgeServer, TOKEN_HEADER, type BridgeServer } from '../src/bridge/server';
import { parseLoopbackBridgeUrl } from '../src/bridgeClients';
import { run, type CliHost } from '../src/cli';

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function sendHttp(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: { host: `127.0.0.1:${port}`, ...(options.headers ?? {}) },
        setHost: false,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

class FakeHost {
  listeners = new Set<(event: ExtaliaEvent) => void>();

  async getState() {
    return { setupComplete: true };
  }

  async sendPrompt() {
    return { ok: true };
  }

  subscribe(listener: (event: ExtaliaEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const updateStatus = (state: UpdateStatus['state']): UpdateStatus => ({
  current: '1.0.0',
  channel: 'stable',
  state,
  command: 'npm i -g extalia-vo@latest --prefer-online',
});

describe('extalia bridge CLI', () => {
  let root: string;
  let homeDirectory: string;
  let extaliaHome: string;
  let webRoot: string;
  let grantsPath: string;
  const servers: BridgeServer[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'extalia-cli-bridge-'));
    homeDirectory = path.join(root, 'home');
    extaliaHome = path.join(root, 'extalia-home');
    webRoot = path.join(root, 'web');
    grantsPath = path.join(extaliaHome, 'state', 'bridge-grants.json');
    await mkdir(homeDirectory, { recursive: true });
    await mkdir(extaliaHome, { recursive: true });
    await mkdir(webRoot, { recursive: true });
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(servers.splice(0).map(server => server.close()));
    await rm(root, { recursive: true, force: true });
  });

  function makeHost(overrides: Partial<CliHost> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const value: CliHost = {
      version: '0.0.0-test',
      out: line => out.push(line),
      err: line => err.push(line),
      readFile: file => readFile(file, 'utf8'),
      exists,
      platform: 'linux',
      arch: 'x64',
      nodeVersion: 'v24.1.0',
      env: { EXTALIA_HOME: extaliaHome },
      homeDirectory,
      start: async () => 0,
      update: async () => 0,
      ...overrides,
    };
    return { value, out, err };
  }

  async function startLiveServer(fake = new FakeHost()): Promise<{ server: BridgeServer; pairing: BridgePairingStore; fake: FakeHost }> {
    const pairing = await BridgePairingStore.open({ filePath: grantsPath });
    const server = await startBridgeServer({
      port: 0,
      webRoot,
      pairing,
      pingIntervalMs: 50,
      agents: async () => fake as unknown as AgentHostApi,
      updates: {
        status: () => updateStatus('idle'),
        check: async () => updateStatus('up-to-date'),
        install: async () => updateStatus('idle'),
      },
    });
    servers.push(server);
    return { server, pairing, fake };
  }

  it('prints help and validates loopback URLs and CLI arguments fail-closed', async () => {
    expect(parseLoopbackBridgeUrl('http://127.0.0.1:4310')?.origin).toBe('http://127.0.0.1:4310');
    expect(parseLoopbackBridgeUrl('http://localhost:4310/')?.origin).toBe('http://localhost:4310');
    expect(parseLoopbackBridgeUrl('https://127.0.0.1:4310')).toBeUndefined();
    expect(parseLoopbackBridgeUrl('http://[::1]:4310')).toBeUndefined();
    expect(parseLoopbackBridgeUrl('http://example.com:4310')).toBeUndefined();
    expect(parseLoopbackBridgeUrl('http://0.0.0.0:4310')).toBeUndefined();
    expect(parseLoopbackBridgeUrl('http://127.0.0.1:4310/extra')).toBeUndefined();
    expect(parseLoopbackBridgeUrl('http://user:pass@127.0.0.1:4310')).toBeUndefined();

    for (const helpArgs of [['bridge', 'help'], ['bridge', '--help'], ['bridge', '-h'], ['bridge', 'clients', '--help']]) {
      const io = makeHost();
      expect(await run(helpArgs, io.value)).toBe(0);
      expect(io.out.join('\n')).toContain('Usage: extalia bridge');
    }

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const masterSecret = 'f'.repeat(64);
    const invalidCases: string[][] = [
      ['bridge'],
      ['bridge', 'bogus'],
      ['bridge', 'clients', '--bogus'],
      ['bridge', 'pair', '--name', 'App', '--scopes', 'read', '--url', 'http://example.com:4310', '--token', masterSecret],
      ['bridge', 'pair', '--name', 'App', '--scopes', 'bogus', '--url', 'http://127.0.0.1:4310', '--token', masterSecret],
      ['bridge', 'pair', '--name', '   ', '--scopes', 'read', '--url', 'http://127.0.0.1:4310', '--token', masterSecret],
      ['bridge', 'pair', '--name', 'App', '--scopes', 'read', '--url', 'http://127.0.0.1:4310', '--token', ''],
      ['bridge', 'pair', '--name', 'App', '--scopes', 'read', '--url', 'http://127.0.0.1:4310', '--token', masterSecret, '--grant-ttl-ms', '0'],
      ['bridge', 'revoke', 'not-an-id', '--yes'],
      ['bridge', 'revoke', 'bc-000000000000', '--url', 'http://127.0.0.1:4310', '--yes'],
      ['bridge', 'revoke', 'bc-000000000000', '--token', masterSecret, '--yes'],
      ['bridge', 'revoke', 'bc-000000000000', '--url', 'https://127.0.0.1:4310', '--token', masterSecret, '--yes'],
    ];

    for (const args of invalidCases) {
      const io = makeHost();
      expect(await run(args, io.value), `Expected exit 2 for ${args.join(' ')}`).toBe(2);
      expect(io.out).toEqual([]);
      expect(io.err.join('\n')).not.toContain(masterSecret);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lists empty and populated clients in readable and --json formats without exposing tokenHash', async () => {
    const emptyIo = makeHost();
    expect(await run(['bridge', 'clients'], emptyIo.value)).toBe(0);
    expect(emptyIo.out).toEqual(['No scoped Bridge clients paired yet.']);

    const store = await BridgePairingStore.open({ filePath: grantsPath });
    const challenge = store.issueChallenge({ name: 'Status Viewer', scopes: ['read', 'events'] });
    const issued = await store.confirmChallenge({ challengeId: challenge.challengeId, code: challenge.code, grantTtlMs: 60_000 });
    await store.close();

    const persistedRaw = await readFile(grantsPath, 'utf8');
    const persisted = JSON.parse(persistedRaw) as { grants: Array<{ tokenHash: string }> };
    const tokenHash = persisted.grants[0]!.tokenHash;
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);

    const textIo = makeHost();
    expect(await run(['bridge', 'clients'], textIo.value)).toBe(0);
    const textOut = textIo.out.join('\n');
    expect(textOut).toContain(issued.client.clientId);
    expect(textOut).toContain('[active]');
    expect(textOut).toContain('Status Viewer');
    expect(textOut).toContain('scopes=read,events');
    expect(textOut).not.toContain(tokenHash);
    expect(textOut).not.toContain(issued.token);

    const jsonIo = makeHost();
    expect(await run(['bridge', 'clients', '--json'], jsonIo.value)).toBe(0);
    const jsonRaw = jsonIo.out.join('\n');
    expect(jsonRaw).not.toContain(tokenHash);
    expect(jsonRaw).not.toContain(issued.token);
    const parsed = JSON.parse(jsonRaw) as { clients: Array<{ clientId: string; name: string; scopes: string[]; state: string }> };
    expect(parsed.clients).toHaveLength(1);
    expect(parsed.clients[0]).toMatchObject({
      clientId: issued.client.clientId,
      name: 'Status Viewer',
      scopes: ['read', 'events'],
      state: 'active',
    });
  });

  it('supports --challenge-only and full pairing against a live Bridge with least-privilege enforcement', async () => {
    const { server, pairing } = await startLiveServer();

    // --challenge-only outputs challenge without consuming it.
    const challengeIo = makeHost();
    expect(await run([
      'bridge',
      'pair',
      '--name', 'Challenge Client',
      '--scopes', 'read',
      '--url', server.url,
      '--token', server.token,
      '--challenge-only',
    ], challengeIo.value)).toBe(0);
    const challengeOut = challengeIo.out.join('\n');
    const challengeIdMatch = /Challenge ID:\s*(bp-[0-9a-f]{12})/.exec(challengeOut);
    const codeMatch = /Code:\s*([A-Z2-9]{8})/.exec(challengeOut);
    expect(challengeIdMatch).not.toBeNull();
    expect(codeMatch).not.toBeNull();
    expect(challengeOut).toContain('Expires at:');
    expect(pairing.list()).toHaveLength(0);

    // Full pair mints a working scoped token.
    const pairIo = makeHost();
    expect(await run([
      'bridge',
      'pair',
      '--name', 'Reader CLI',
      '--scopes', 'read',
      '--url', `http://localhost:${server.port}`,
      '--token', server.token,
      '--grant-ttl-ms', '60000',
    ], pairIo.value)).toBe(0);
    const pairOut = pairIo.out.join('\n');
    const clientIdMatch = /Client ID:\s*(bc-[0-9a-f]{12})/.exec(pairOut);
    const tokenMatch = /Token:\s*(extb_bc-[0-9a-f]{12}_[0-9a-f]{64})/.exec(pairOut);
    expect(clientIdMatch).not.toBeNull();
    expect(tokenMatch).not.toBeNull();
    expect(pairOut).toContain('Scopes:       read');
    expect(pairOut).toContain('will not be shown again');

    const scopedToken = tokenMatch![1]!;
    // Permitted read RPC succeeds (200).
    const okRes = await sendHttp(server.port, {
      method: 'POST',
      path: '/api/call',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: scopedToken },
      body: JSON.stringify({ method: 'getState', args: [] }),
    });
    expect(okRes.status).toBe(200);

    // Forbidden chat RPC and admin endpoint fail closed (403).
    const chatRes = await sendHttp(server.port, {
      method: 'POST',
      path: '/api/call',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: scopedToken },
      body: JSON.stringify({ method: 'sendPrompt', args: ['s_1', 'hello'] }),
    });
    expect(chatRes.status).toBe(403);
    const adminRes = await sendHttp(server.port, {
      path: '/api/bridge/clients',
      headers: { [TOKEN_HEADER]: scopedToken },
    });
    expect(adminRes.status).toBe(403);

    // Wrong master token returns exit code 1.
    const badAuthIo = makeHost();
    expect(await run([
      'bridge',
      'pair',
      '--name', 'Denied',
      '--scopes', 'read',
      '--url', server.url,
      '--token', '0'.repeat(64),
    ], badAuthIo.value)).toBe(1);
    expect(badAuthIo.err.join('\n')).toContain('bridge pair:');
  });

  it('supports --dry-run, interactive confirmation, persisted revoke, and live HTTP revoke', async () => {
    const { server, pairing, fake } = await startLiveServer();
    const challenge = pairing.issueChallenge({ name: 'Stream Client', scopes: ['read', 'events'] });
    const issued = await pairing.confirmChallenge({ challengeId: challenge.challengeId, code: challenge.code });

    // --dry-run leaves grant active.
    const dryIo = makeHost();
    expect(await run(['bridge', 'revoke', issued.client.clientId, '--dry-run', '--reason', 'Audit'], dryIo.value)).toBe(0);
    expect(dryIo.out.join('\n')).toContain(`Would revoke Bridge client ${issued.client.clientId}`);
    expect(dryIo.out.join('\n')).toContain('Dry run complete');
    expect(pairing.list()[0]?.state).toBe('active');

    // Missing prompt without --yes cancels with exit 1 and keeps grant active.
    const noPromptIo = makeHost();
    expect(await run(['bridge', 'revoke', issued.client.clientId], noPromptIo.value)).toBe(1);
    expect(noPromptIo.err.join('\n')).toContain('Cancelled');
    expect(pairing.list()[0]?.state).toBe('active');

    // Declined prompt cancels with exit 1 and keeps grant active.
    const declinedIo = makeHost({ prompt: async () => false });
    expect(await run(['bridge', 'revoke', issued.client.clientId], declinedIo.value)).toBe(1);
    expect(declinedIo.err.join('\n')).toContain('Cancelled');
    expect(pairing.list()[0]?.state).toBe('active');

    // Live SSE stream connected with scoped token.
    const streamClosed = new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, path: `/api/events?token=${issued.token}` }, res => {
        const status = res.statusCode ?? 0;
        res.resume();
        res.on('end', () => resolve(status));
        res.on('close', () => resolve(status));
      });
      req.on('error', reject);
      req.end();
    });
    await expect.poll(() => fake.listeners.size).toBe(1);

    // Live revoke immediately drops the SSE stream and blocks future requests.
    const liveRevokeIo = makeHost();
    expect(await run([
      'bridge',
      'revoke',
      issued.client.clientId,
      '--url', server.url,
      '--token', server.token,
      '--yes',
      '--reason', 'Rotated key',
    ], liveRevokeIo.value)).toBe(0);
    expect(liveRevokeIo.out.join('\n')).toContain(`Revoked Bridge client ${issued.client.clientId}`);
    expect(liveRevokeIo.out.join('\n')).toContain('state=revoked');
    expect(await streamClosed).toBe(200);
    await expect.poll(() => fake.listeners.size).toBe(0);
    expect((await sendHttp(server.port, {
      method: 'POST',
      path: '/api/call',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: issued.token },
      body: JSON.stringify({ method: 'getState', args: [] }),
    })).status).toBe(401);

    // Persisted revoke (no --url) updates bridge-grants.json on disk.
    const c2 = pairing.issueChallenge({ name: 'Offline Revoke Target', scopes: ['read'] });
    const g2 = await pairing.confirmChallenge({ challengeId: c2.challengeId, code: c2.code });
    const offlineRevokeIo = makeHost();
    expect(await run([
      'bridge',
      'revoke',
      g2.client.clientId,
      '-y',
      '--reason', 'No longer needed',
    ], offlineRevokeIo.value)).toBe(0);
    expect(offlineRevokeIo.out.join('\n')).toContain(`Revoked Bridge client ${g2.client.clientId}`);
    expect(offlineRevokeIo.out.join('\n')).toContain('--url/--token');

    const reopened = await BridgePairingStore.open({ filePath: grantsPath });
    try {
      const updated = reopened.list().find(item => item.clientId === g2.client.clientId);
      expect(updated?.state).toBe('revoked');
      expect(updated?.revokeReason).toBe('No longer needed');
    } finally {
      await reopened.close();
    }
  });
});
