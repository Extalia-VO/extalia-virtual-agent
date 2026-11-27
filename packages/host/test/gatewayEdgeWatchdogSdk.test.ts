import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GATEWAY_ADAPTER_SDK_VERSION,
  isLoopbackHttpUrl,
  validateHostWatchdogLeaseSnapshot,
  type GatewayAdapterContract,
  type HostWatchdogAlertEvent,
  type HostWatchdogLeaseSnapshot,
} from '@extalia/platform';
import {
  createReferenceFourthProviderAdapter,
  runGatewayAdapterConformance,
  signReferenceFourthProviderPayload,
} from '../src/gateway/adapterSdk.js';
import {
  HostWatchdogMonitor,
  readHostWatchdogLease,
  writeHostWatchdogLease,
} from '../src/gateway/watchdog.js';
import {
  startGatewayWebhookEdge,
  type GatewayWebhookEdgeServer,
} from '../src/gateway/webhookEdge.js';

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    const closeFn = cleanups.pop()!;
    await closeFn().catch(() => undefined);
  }
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function startMockHostUpstream() {
  const received: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }> = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body,
      });
      res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ accepted: true, count: received.length }));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind mock upstream server.');
  }

  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      }),
  );

  return {
    url: `http://127.0.0.1:${address.port}/gateway/inbound`,
    received,
  };
}

describe('Gateway M5 contracts, webhook edge, watchdog & adapter SDK', () => {
  it('validates loopback HTTP(S) URLs and watchdog lease snapshots strictly', () => {
    expect(isLoopbackHttpUrl('http://127.0.0.1:4100/hooks/conn-1')).toBe(true);
    expect(isLoopbackHttpUrl('https://localhost:8443/gateway')).toBe(true);
    expect(isLoopbackHttpUrl('http://[::1]:9000/inbound')).toBe(true);

    expect(isLoopbackHttpUrl('http://0.0.0.0:4100/hooks')).toBe(false);
    expect(isLoopbackHttpUrl('http://192.168.1.25:4100/hooks')).toBe(false);
    expect(isLoopbackHttpUrl('https://example.com/hooks')).toBe(false);
    expect(isLoopbackHttpUrl('file:///tmp/lease.json')).toBe(false);
    expect(isLoopbackHttpUrl('not a url')).toBe(false);

    const validLease: HostWatchdogLeaseSnapshot = {
      schemaVersion: 1,
      ownerId: 'host-primary-1',
      pid: 4242,
      startedAt: '2026-11-26T10:00:00.000Z',
      heartbeatAt: '2026-11-26T10:01:00.000Z',
      fencingToken: ['lease', 'fence', '001'].join('-'),
      activeConnectors: 2,
    };
    expect(validateHostWatchdogLeaseSnapshot(validLease).ok).toBe(true);
    expect(validateHostWatchdogLeaseSnapshot({ ...validLease, schemaVersion: 2 }).ok).toBe(false);
    expect(validateHostWatchdogLeaseSnapshot({ ...validLease, pid: 0 }).ok).toBe(false);
  });

  it('refuses non-loopback edge bind hosts or non-loopback hostTargetUrl', async () => {
    const forwardToken = ['edge', 'forward', 'token', 'abc'].join('-');
    const route = {
      connectorId: 'conn-1',
      verify: () => ({ ok: true as const, verifiedAt: '2026-11-26T10:00:00.000Z' }),
    };

    await expect(
      startGatewayWebhookEdge({
        host: '0.0.0.0',
        hostTargetUrl: 'http://127.0.0.1:4999/inbound',
        scopedForwardToken: forwardToken,
        routes: [route],
      }),
    ).rejects.toThrow(/loopback/i);

    await expect(
      startGatewayWebhookEdge({
        host: '127.0.0.1',
        hostTargetUrl: 'https://example.com/inbound',
        scopedForwardToken: forwardToken,
        routes: [route],
      }),
    ).rejects.toThrow(/loopback/i);
  });

  it('enforces signature fail-closed, body cap (413), rate limit (429), and scoped loopback forwarding', async () => {
    const upstream = await startMockHostUpstream();
    const signingSecret = ['edge', 'hmac', 'secret', '9876'].join('-');
    const forwardToken = ['scoped', 'host', 'bearer', '54321'].join('-');
    let nowMs = Date.parse('2026-11-26T12:00:00.000Z');

    const edge: GatewayWebhookEdgeServer = await startGatewayWebhookEdge({
      host: '127.0.0.1',
      hostTargetUrl: upstream.url,
      scopedForwardToken: forwardToken,
      now: () => nowMs,
      routes: [
        {
          connectorId: 'conn-relay-1',
          maxBodyBytes: 128,
          rateLimitMax: 2,
          rateLimitWindowMs: 10_000,
          verify: (rawBody, headers) => {
            const sig = headers['x-relay-signature-256'];
            const expected = signReferenceFourthProviderPayload(
              rawBody.toString('utf8'),
              signingSecret,
            );
            if (!sig || sig !== expected) {
              return { ok: false, reason: 'Invalid edge HMAC signature.' };
            }
            return {
              ok: true,
              verifiedAt: new Date(nowMs).toISOString(),
              providerEventId: headers['x-relay-event-id'],
            };
          },
        },
      ],
    });
    cleanups.push(() => edge.close());

    const hookUrl = `${edge.url}/hooks/conn-relay-1`;

    // 1. Invalid signature -> 401 and 0 upstream calls
    const badBody = JSON.stringify({ event: 'ping', seq: 1 });
    const badSigRes = await fetch(hookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relay-signature-256': 'sha256=' + '0'.repeat(64),
      },
      body: badBody,
    });
    expect(badSigRes.status).toBe(401);
    expect(upstream.received).toHaveLength(0);

    // 2. Valid signed request -> forwarded with scoped bearer & verification headers
    const goodBody = JSON.stringify({ event: 'message', seq: 2 });
    const goodSig = signReferenceFourthProviderPayload(goodBody, signingSecret);
    const okRes = await fetch(hookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relay-signature-256': goodSig,
        'x-relay-event-id': 'evt-2',
      },
      body: goodBody,
    });
    expect(okRes.status).toBe(202);
    expect(await okRes.json()).toEqual({ accepted: true, count: 1 });
    expect(upstream.received).toHaveLength(1);
    expect(upstream.received[0]?.headers.authorization).toBe(`Bearer ${forwardToken}`);
    expect(upstream.received[0]?.headers['x-extalia-edge-verified']).toBe('1');
    expect(upstream.received[0]?.headers['x-extalia-connector-id']).toBe('conn-relay-1');
    expect(upstream.received[0]?.headers['x-extalia-provider-event-id']).toBe('evt-2');
    expect(upstream.received[0]?.body).toBe(goodBody);

    // 3. Exceeded rateLimitMax (2 calls already consumed in window) -> 429 with Retry-After
    const rateLimitedRes = await fetch(hookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relay-signature-256': goodSig,
      },
      body: goodBody,
    });
    expect(rateLimitedRes.status).toBe(429);
    expect(Number(rateLimitedRes.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(upstream.received).toHaveLength(1);

    // Advance past rate-limit window so oversized-body test can run cleanly
    nowMs += 11_000;

    // 4. Oversized body (> 128 bytes) -> 413 and 0 additional upstream calls
    const oversizedBody = JSON.stringify({ pad: 'x'.repeat(200) });
    const oversizedRes = await fetch(hookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relay-signature-256': signReferenceFourthProviderPayload(oversizedBody, signingSecret),
      },
      body: oversizedBody,
    });
    expect(oversizedRes.status).toBe(413);
    expect(upstream.received).toHaveLength(1);

    const auditDecisions = edge.getAuditLog().map(entry => entry.decision);
    expect(auditDecisions).toEqual([
      'rejected_signature',
      'forwarded',
      'rejected_rate_limited',
      'rejected_body_too_large',
    ]);
  });

  it('tracks HostWatchdogMonitor lifecycle and deduplicates host_down / recovered alerts', async () => {
    const dir = await makeTempDir('extalia-watchdog-');
    const leasePath = path.join(dir, 'nested', 'host-lease.json');
    let nowMs = Date.parse('2026-11-26T14:00:00.000Z');
    const alerts: HostWatchdogAlertEvent[] = [];

    const monitor = new HostWatchdogMonitor({
      leaseFilePath: leasePath,
      staleAfterMs: 5_000,
      downAfterMs: 15_000,
      now: () => nowMs,
      onAlert: event => {
        alerts.push(event);
      },
    });

    // Missing lease -> unknown, no alerts
    const missingStatus = await monitor.evaluate();
    expect(missingStatus.state).toBe('unknown');
    expect(alerts).toHaveLength(0);

    // Corrupt lease -> unknown, no alerts
    await writeHostWatchdogLease(leasePath, {
      schemaVersion: 1,
      ownerId: 'host-1',
      pid: 1001,
      startedAt: new Date(nowMs).toISOString(),
      heartbeatAt: new Date(nowMs).toISOString(),
      fencingToken: ['fence', 'token', '1'].join('-'),
    });
    await writeFile(leasePath, '{not-valid-json', 'utf8');
    const corruptStatus = await monitor.evaluate();
    expect(corruptStatus.state).toBe('unknown');
    expect((await readHostWatchdogLease(leasePath)).ok).toBe(false);
    expect(alerts).toHaveLength(0);

    // Healthy lease
    const baseTime = nowMs;
    await writeHostWatchdogLease(leasePath, {
      schemaVersion: 1,
      ownerId: 'host-1',
      pid: 1001,
      startedAt: new Date(baseTime).toISOString(),
      heartbeatAt: new Date(baseTime).toISOString(),
      fencingToken: ['fence', 'token', '2'].join('-'),
      activeConnectors: 3,
    });
    expect((await monitor.evaluate()).state).toBe('healthy');
    expect(alerts).toHaveLength(0);

    // Stale (6s >= 5s) -> suspected_stalled, still no host_down alert
    nowMs = baseTime + 6_000;
    expect((await monitor.evaluate()).state).toBe('suspected_stalled');
    expect(alerts).toHaveLength(0);

    // Down (16s >= 15s) -> host_down, emits exactly ONE alert
    nowMs = baseTime + 16_000;
    expect((await monitor.evaluate()).state).toBe('host_down');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe('host_down');

    // Repeat polls while still down -> ZERO duplicate host_down alerts
    nowMs = baseTime + 25_000;
    expect((await monitor.evaluate()).state).toBe('host_down');
    nowMs = baseTime + 40_000;
    expect((await monitor.evaluate()).state).toBe('host_down');
    expect(alerts).toHaveLength(1);

    // Host recovers -> emits exactly ONE recovered alert
    await writeHostWatchdogLease(leasePath, {
      schemaVersion: 1,
      ownerId: 'host-1',
      pid: 1002,
      startedAt: new Date(nowMs).toISOString(),
      heartbeatAt: new Date(nowMs).toISOString(),
      fencingToken: ['fence', 'token', '3'].join('-'),
    });
    expect((await monitor.evaluate()).state).toBe('healthy');
    expect(alerts).toHaveLength(2);
    expect(alerts[1]?.kind).toBe('recovered');

    // Repeat healthy poll -> no duplicate recovery alert
    nowMs += 1_000;
    expect((await monitor.evaluate()).state).toBe('healthy');
    expect(alerts).toHaveLength(2);
  });

  it('passes 6/6 conformance checks on reference 4th provider and fails broken adapters', async () => {
    const signingSecret = ['fourth', 'provider', 'secret', 'xyz'].join('-');
    const endpointUrl = 'http://127.0.0.1:49999/relay/send';
    const rawBody = JSON.stringify({ eventId: 'evt-relay-100', text: '/status' });
    const signature = signReferenceFourthProviderPayload(rawBody, signingSecret);

    const createAdapter = (fetchImpl?: typeof fetch) =>
      createReferenceFourthProviderAdapter({
        connectorId: 'conn-fourth-1',
        outboundEndpointUrl: endpointUrl,
        signingSecret,
        fetch: fetchImpl,
      });

    const passingReport = await runGatewayAdapterConformance(createAdapter(), {
      validSignedRequest: {
        rawBody,
        headers: {
          'x-relay-signature-256': signature,
          'x-relay-event-id': 'evt-relay-100',
        },
      },
      createAdapterWithFetch: fetchImpl => createAdapter(fetchImpl),
    });

    expect(passingReport.sdkVersion).toBe(GATEWAY_ADAPTER_SDK_VERSION);
    expect(passingReport.provider).toBe('webhook-relay');
    expect(passingReport.checks).toHaveLength(6);
    expect(passingReport.passed).toBe(true);
    expect(passingReport.checks.every(check => check.passed)).toBe(true);

    // Broken adapter 1: accepts unsigned inbound & leaks secrets in outbound body
    const baseAdapter = createAdapter();
    let capturedRawLeak = '';
    const brokenAdapter: GatewayAdapterContract = {
      ...baseAdapter,
      verifyInbound: () => ({ ok: true, verifiedAt: '2026-11-26T15:00:00.000Z' }),
      sendOutbound: async request => {
        capturedRawLeak = JSON.stringify({ text: request.text });
        return { kind: 'accepted', remoteMessageId: 'msg-leak-1' };
      },
    };

    const brokenReport = await runGatewayAdapterConformance(brokenAdapter, {
      validSignedRequest: {
        rawBody,
        headers: { 'x-relay-signature-256': signature },
      },
      getLastTransmittedBody: () => capturedRawLeak,
    });

    expect(brokenReport.passed).toBe(false);
    expect(
      brokenReport.checks.find(c => c.id === 'inbound-signature-fail-closed')?.passed,
    ).toBe(false);
    expect(
      brokenReport.checks.find(c => c.id === 'outbound-sanitization-and-redaction')?.passed,
    ).toBe(false);
  });
});
