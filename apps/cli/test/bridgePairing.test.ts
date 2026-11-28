import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentHostApi, UpdateStatus } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BridgePairingStore, type BridgePairingError } from '../src/bridge/pairing';
import { startBridgeServer, TOKEN_HEADER, type BridgeServer, type BridgeServerOptions } from '../src/bridge/server';

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface SendOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  host?: string;
}

function send(port: number, { method = 'GET', path: target = '/', headers = {}, body, host = `127.0.0.1:${port}` }: SendOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path: target, headers: { host, ...headers }, setHost: false },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const sampleEvent = (n: number) => ({
  v: 'extalia.v0',
  id: `e-${n}`,
  at: '2026-01-31T12:00:00.000Z',
  sessionId: 's',
  source: { runtime: 'extalia', channel: 'stream' },
  body: { type: 'model.delta', text: `hi ${n}` },
}) as unknown as ExtaliaEvent;

class FakeHost {
  listeners = new Set<(event: ExtaliaEvent) => void>();
  calls: unknown[][] = [];

  async getState() {
    this.calls.push(['getState']);
    return { setupComplete: true };
  }

  async sendPrompt(sessionId: string, prompt: string) {
    this.calls.push(['sendPrompt', sessionId, prompt]);
    return { ok: true };
  }

  async resolveApproval(id: string, decision: string) {
    this.calls.push(['resolveApproval', id, decision]);
    return { id, decision };
  }

  async revokeApproval(id: string) {
    this.calls.push(['revokeApproval', id]);
    return { id, revoked: true };
  }

  async saveConnection(input: unknown) {
    this.calls.push(['saveConnection', input]);
    return { saved: true };
  }

  subscribe(listener: (event: ExtaliaEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: ExtaliaEvent) {
    for (const listener of this.listeners) listener(value);
  }
}

const updateStatus = (state: UpdateStatus['state']): UpdateStatus => ({
  current: '1.0.0',
  channel: 'stable',
  state,
  command: 'npm i -g extalia-vo@latest --prefer-online',
});

describe('Bridge pairing store and scoped enforcement', () => {
  let dir: string;
  let webRoot: string;
  let grantsPath: string;
  let fake: FakeHost;
  const servers: BridgeServer[] = [];

  async function start(overrides: Partial<BridgeServerOptions> = {}): Promise<BridgeServer> {
    const server = await startBridgeServer({
      port: 0,
      webRoot,
      agents: async () => fake as unknown as AgentHostApi,
      updates: {
        status: () => updateStatus('idle'),
        check: async () => updateStatus('up-to-date'),
        install: async () => updateStatus('idle'),
      },
      ...overrides,
    });
    servers.push(server);
    return server;
  }

  async function pairClient(server: BridgeServer, name: string, scopes: string[], grantTtlMs?: number): Promise<{ clientId: string; token: string }> {
    const challengeRes = await send(server.port, {
      method: 'POST',
      path: '/api/bridge/pair/challenge',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: server.token },
      body: JSON.stringify({ name, scopes }),
    });
    expect(challengeRes.status).toBe(201);
    const { challenge } = JSON.parse(challengeRes.body) as { challenge: { challengeId: string; code: string } };
    const confirmRes = await send(server.port, {
      method: 'POST',
      path: '/api/bridge/pair/confirm',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: server.token },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        code: challenge.code,
        ...(grantTtlMs !== undefined ? { grantTtlMs } : {}),
      }),
    });
    expect(confirmRes.status).toBe(201);
    const confirmed = JSON.parse(confirmRes.body) as { client: { clientId: string }; token: string };
    return { clientId: confirmed.client.clientId, token: confirmed.token };
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'extalia-pairing-'));
    webRoot = path.join(dir, 'web');
    grantsPath = path.join(dir, 'state', 'bridge-grants.json');
    await mkdir(webRoot, { recursive: true });
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
    fake = new FakeHost();
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()));
    await rm(dir, { recursive: true, force: true });
  });

  it('pairs a client via challenge/confirm without storing plaintext secrets and enforces single-use and 5-strike lockout', async () => {
    const pairing = await BridgePairingStore.open({ filePath: grantsPath });
    const server = await start({ pairing });

    const challengeRes = await send(server.port, {
      method: 'POST',
      path: '/api/bridge/pair/challenge',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: server.token },
      body: JSON.stringify({ name: 'Companion App', scopes: ['read', 'events'] }),
    });
    expect(challengeRes.status).toBe(201);
    const { challenge } = JSON.parse(challengeRes.body) as {
      challenge: { challengeId: string; clientName: string; requestedScopes: string[]; code: string; expiresAt: string };
    };
    expect(challenge.challengeId).toMatch(/^bp-[0-9a-f]{12}$/);
    expect(challenge.clientName).toBe('Companion App');
    expect(challenge.requestedScopes).toEqual(['read', 'events']);
    expect(challenge.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);

    // Confirm succeeds with case-insensitive / whitespace-padded code.
    const confirmRes = await send(server.port, {
      method: 'POST',
      path: '/api/bridge/pair/confirm',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: server.token },
      body: JSON.stringify({ challengeId: challenge.challengeId, code: `  ${challenge.code.toLowerCase()}  ` }),
    });
    expect(confirmRes.status).toBe(201);
    const confirmed = JSON.parse(confirmRes.body) as { client: { clientId: string; state: string; scopes: string[] }; token: string };
    expect(confirmed.client.clientId).toMatch(/^bc-[0-9a-f]{12}$/);
    expect(confirmed.client.state).toBe('active');
    expect(confirmed.client.scopes).toEqual(['read', 'events']);
    expect(confirmed.token).toMatch(new RegExp(`^extb_${confirmed.client.clientId}_[0-9a-f]{64}$`));

    // Plaintext token & code are never persisted; file mode is 0600 on POSIX.
    const persistedRaw = await readFile(grantsPath, 'utf8');
    expect(persistedRaw).not.toContain(confirmed.token);
    expect(persistedRaw).not.toContain(challenge.code);
    const persisted = JSON.parse(persistedRaw) as { schema: string; grants: Array<{ tokenHash: string; clientId: string }> };
    expect(persisted.schema).toBe('extalia.bridge-grants.v1');
    expect(persisted.grants).toHaveLength(1);
    expect(persisted.grants[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') {
      const info = await stat(grantsPath);
      expect(info.mode & 0o777).toBe(0o600);
    }

    // List endpoint omits tokenHash.
    const listRes = await send(server.port, {
      path: '/api/bridge/clients',
      headers: { [TOKEN_HEADER]: server.token },
    });
    expect(listRes.status).toBe(200);
    expect(listRes.body).not.toContain(persisted.grants[0]!.tokenHash);
    expect(JSON.parse(listRes.body).clients).toHaveLength(1);

    // Challenge is single-use.
    const replayRes = await send(server.port, {
      method: 'POST',
      path: '/api/bridge/pair/confirm',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: server.token },
      body: JSON.stringify({ challengeId: challenge.challengeId, code: challenge.code }),
    });
    expect(replayRes.status).toBe(410);

    // 5-strike lockout.
    const secondChallengeRes = await send(server.port, {
      method: 'POST',
      path: '/api/bridge/pair/challenge',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: server.token },
      body: JSON.stringify({ name: 'Brute Test', scopes: ['read'] }),
    });
    const { challenge: c2 } = JSON.parse(secondChallengeRes.body) as { challenge: { challengeId: string; code: string } };
    for (let attempt = 0; attempt < 5; attempt++) {
      const wrong = await send(server.port, {
        method: 'POST',
        path: '/api/bridge/pair/confirm',
        headers: { 'content-type': 'application/json', [TOKEN_HEADER]: server.token },
        body: JSON.stringify({ challengeId: c2.challengeId, code: 'ZZZZZZZZ' }),
      });
      expect(wrong.status).toBe(401);
    }
    // Even the right code is now locked (429).
    const locked = await send(server.port, {
      method: 'POST',
      path: '/api/bridge/pair/confirm',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: server.token },
      body: JSON.stringify({ challengeId: c2.challengeId, code: c2.code }),
    });
    expect(locked.status).toBe(429);
  });

  it('enforces least-privilege scopes across RPC, SSE, update, and pairing routes', async () => {
    const pairing = await BridgePairingStore.open({ filePath: grantsPath });
    const server = await start({ pairing });

    const readClient = await pairClient(server, 'ReadOnly', ['read']);
    const chatClient = await pairClient(server, 'ChatClient', ['read', 'events', 'chat']);
    const approvalsClient = await pairClient(server, 'ApprovalsClient', ['approvals']);

    // Read-only client: getState allowed (200), mutating/SSE/admin rejected (403).
    expect((await send(server.port, {
      method: 'POST',
      path: '/api/call',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: readClient.token },
      body: JSON.stringify({ method: 'getState', args: [] }),
    })).status).toBe(200);
    expect((await send(server.port, {
      method: 'POST',
      path: '/api/call',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: readClient.token },
      body: JSON.stringify({ method: 'sendPrompt', args: ['s_1', 'hello'] }),
    })).status).toBe(403);
    expect((await send(server.port, {
      path: `/api/events?token=${readClient.token}`,
    })).status).toBe(403);
    expect((await send(server.port, {
      path: '/api/update',
      headers: { [TOKEN_HEADER]: readClient.token },
    })).status).toBe(403);
    expect((await send(server.port, {
      path: '/api/bridge/clients',
      headers: { [TOKEN_HEADER]: readClient.token },
    })).status).toBe(403);

    // Chat+events+read client: SSE allowed (200), sendPrompt allowed (200), approvals & admin rejected (403).
    const sseStatus = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, path: `/api/events?token=${chatClient.token}` }, res => {
        const statusCode = res.statusCode ?? 0;
        req.destroy();
        resolve(statusCode);
      });
      req.on('error', error => {
        if (!req.destroyed) reject(error);
      });
      req.end();
    });
    expect(sseStatus).toBe(200);
    expect((await send(server.port, {
      method: 'POST',
      path: '/api/call',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: chatClient.token },
      body: JSON.stringify({ method: 'sendPrompt', args: ['s_1', 'hi'] }),
    })).status).toBe(200);
    expect((await send(server.port, {
      method: 'POST',
      path: '/api/call',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: chatClient.token },
      body: JSON.stringify({ method: 'resolveApproval', args: ['a_1', 'allow'] }),
    })).status).toBe(403);
    expect((await send(server.port, {
      method: 'POST',
      path: '/api/call',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: chatClient.token },
      body: JSON.stringify({ method: 'saveConnection', args: [{}] }),
    })).status).toBe(403);

    // Approvals client: resolveApproval & revokeApproval allowed (200), sendPrompt rejected (403).
    expect((await send(server.port, {
      method: 'POST',
      path: '/api/call',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: approvalsClient.token },
      body: JSON.stringify({ method: 'resolveApproval', args: ['a_1', 'allow'] }),
    })).status).toBe(200);
    expect((await send(server.port, {
      method: 'POST',
      path: '/api/call',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: approvalsClient.token },
      body: JSON.stringify({ method: 'revokeApproval', args: ['a_1'] }),
    })).status).toBe(200);
    expect((await send(server.port, {
      method: 'POST',
      path: '/api/call',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: approvalsClient.token },
      body: JSON.stringify({ method: 'sendPrompt', args: ['s_1', 'nope'] }),
    })).status).toBe(403);

    // Ensure rejected calls never reached FakeHost.
    expect(fake.calls).toEqual([
      ['getState'],
      ['sendPrompt', 's_1', 'hi'],
      ['resolveApproval', 'a_1', 'allow'],
      ['revokeApproval', 'a_1'],
    ]);
  });

  it('immediately terminates active SSE streams and rejects future calls upon revocation', async () => {
    const pairing = await BridgePairingStore.open({ filePath: grantsPath });
    const server = await start({ pairing, pingIntervalMs: 50 });
    const client = await pairClient(server, 'StreamViewer', ['read', 'events']);

    const streamClosed = new Promise<{ status: number; received: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, path: `/api/events?token=${client.token}` }, res => {
        const status = res.statusCode ?? 0;
        let received = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          received += chunk;
          if (fake.listeners.size > 0 && !received.includes('e-1')) {
            fake.emit(sampleEvent(1));
          }
        });
        res.on('end', () => resolve({ status, received }));
        res.on('close', () => resolve({ status, received }));
      });
      req.on('error', reject);
      req.end();
    });

    await expect.poll(() => fake.listeners.size).toBe(1);

    const revokeRes = await send(server.port, {
      method: 'POST',
      path: '/api/bridge/clients/revoke',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: server.token },
      body: JSON.stringify({ clientId: client.clientId, reason: 'User revoked access' }),
    });
    expect(revokeRes.status).toBe(200);
    expect(JSON.parse(revokeRes.body).client).toMatchObject({
      clientId: client.clientId,
      state: 'revoked',
      revokeReason: 'User revoked access',
    });

    const streamOutcome = await streamClosed;
    expect(streamOutcome.status).toBe(200);
    await expect.poll(() => fake.listeners.size).toBe(0);

    // Subsequent HTTP RPC & SSE requests return 401.
    expect((await send(server.port, {
      method: 'POST',
      path: '/api/call',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: client.token },
      body: JSON.stringify({ method: 'getState', args: [] }),
    })).status).toBe(401);
    expect((await send(server.port, {
      path: `/api/events?token=${client.token}`,
    })).status).toBe(401);
  });

  it('persists grants across store reopens and fails closed on corrupt JSON without modifying the file', async () => {
    const nowMs = 1_700_000_000_000;
    const store1 = await BridgePairingStore.open({ filePath: grantsPath, now: () => nowMs });
    const c1 = store1.issueChallenge({ name: 'Persistent', scopes: ['read'] });
    const g1 = await store1.confirmChallenge({ challengeId: c1.challengeId, code: c1.code });
    const c2 = store1.issueChallenge({ name: 'Expiring', scopes: ['read'] });
    const g2 = await store1.confirmChallenge({ challengeId: c2.challengeId, code: c2.code, grantTtlMs: 5_000 });

    // Reopen before expiry: g1 & g2 valid.
    const store2 = await BridgePairingStore.open({ filePath: grantsPath, now: () => nowMs + 1_000 });
    expect(store2.verifyToken(g1.token)).toEqual({ ok: true, clientId: g1.client.clientId, scopes: ['read'] });
    expect(store2.verifyToken(g2.token)).toEqual({ ok: true, clientId: g2.client.clientId, scopes: ['read'] });

    // Reopen past g2 expiry: g2 fails with expired, g1 remains valid.
    const store3 = await BridgePairingStore.open({ filePath: grantsPath, now: () => nowMs + 10_000 });
    expect(store3.verifyToken(g1.token)).toMatchObject({ ok: true });
    expect(store3.verifyToken(g2.token)).toMatchObject({ ok: false, status: 401, reason: 'expired' });
    await store3.revoke(g1.client.clientId);

    // Revocation survives reopen.
    const store4 = await BridgePairingStore.open({ filePath: grantsPath, now: () => nowMs + 10_000 });
    expect(store4.verifyToken(g1.token)).toMatchObject({ ok: false, status: 401, reason: 'revoked' });

    // Corrupt file: open fails closed with BridgePairingError('corrupt') and preserves disk content.
    const corruptContent = '{not valid json';
    await writeFile(grantsPath, corruptContent, 'utf8');
    await expect(BridgePairingStore.open({ filePath: grantsPath })).rejects.toMatchObject({
      name: 'BridgePairingError',
      code: 'corrupt',
    } satisfies Partial<BridgePairingError>);
    expect(await readFile(grantsPath, 'utf8')).toBe(corruptContent);
  });

  it('rejects foreign Host and Origin headers on /api/bridge/* routes', async () => {
    const pairing = await BridgePairingStore.open({ filePath: grantsPath });
    const server = await start({ pairing });

    const routes: Array<{ method: 'GET' | 'POST'; path: string; body?: string }> = [
      { method: 'GET', path: '/api/bridge/clients' },
      { method: 'POST', path: '/api/bridge/pair/challenge', body: JSON.stringify({ name: 'X', scopes: ['read'] }) },
      { method: 'POST', path: '/api/bridge/pair/confirm', body: JSON.stringify({ challengeId: 'bp-000000000000', code: 'ABCDEFGH' }) },
      { method: 'POST', path: '/api/bridge/clients/revoke', body: JSON.stringify({ clientId: 'bc-000000000000' }) },
    ];

    for (const route of routes) {
      const badHost = await send(server.port, {
        method: route.method,
        path: route.path,
        host: `evil.example.com:${server.port}`,
        headers: { 'content-type': 'application/json', [TOKEN_HEADER]: server.token },
        body: route.body,
      });
      expect(badHost.status, `Host check for ${route.path}`).toBe(403);

      const badOrigin = await send(server.port, {
        method: route.method,
        path: route.path,
        headers: {
          'content-type': 'application/json',
          [TOKEN_HEADER]: server.token,
          origin: 'http://evil.example.com',
        },
        body: route.body,
      });
      expect(badOrigin.status, `Origin check for ${route.path}`).toBe(403);
    }
  });

  it('enforces challenge expiry, pending cap eviction, and 501 when pairing is disabled', async () => {
    let nowMs = 1_700_000_000_000;
    const store = await BridgePairingStore.open({ filePath: grantsPath, now: () => nowMs });
    const expiring = store.issueChallenge({ name: 'ShortLived', scopes: ['read'], ttlMs: 1_000 });
    nowMs += 1_000;
    await expect(store.confirmChallenge({ challengeId: expiring.challengeId, code: expiring.code })).rejects.toMatchObject({
      code: 'expired',
    });

    // Pending challenge cap (64): issuing 65 evicts the oldest.
    const first = store.issueChallenge({ name: 'First', scopes: ['read'] });
    for (let i = 0; i < 64; i++) {
      store.issueChallenge({ name: `Client-${i}`, scopes: ['read'] });
    }
    await expect(store.confirmChallenge({ challengeId: first.challengeId, code: first.code })).rejects.toMatchObject({
      code: 'not_found',
    });

    // Server without pairing returns 501 for /api/bridge/* to master token.
    const disabledServer = await start();
    expect((await send(disabledServer.port, {
      path: '/api/bridge/clients',
      headers: { [TOKEN_HEADER]: disabledServer.token },
    })).status).toBe(501);
  });
});
