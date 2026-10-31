import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DAEMON_OPS, createDaemonFrameReader, encodeDaemonFrame,
  type DaemonErrorCode, type DaemonFrame, type DaemonOp, type DaemonRequest,
} from '@extalia/protocol';
import {
  DaemonClient, DaemonRequestError, DaemonSidecar, DAEMON_HELLO_BASELINE, createDaemonMission, daemonPackageName, exitFailure, resolveDaemonBinary,
  type DaemonFailureCode, type DaemonProcess,
} from '../src/daemon/index.js';
import { SKILL_REGISTRY_OPS, SkillRegistry } from '../src/skillRegistry.js';

/** A scripted daemon on in-memory pipes: answers `hello` unless told otherwise, records every request. */
class FakeDaemon extends EventEmitter implements DaemonProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: DaemonRequest[] = [];
  readonly signals: (NodeJS.Signals | undefined)[] = [];
  exited = false;
  exitOnEof = true;
  private readonly reader = createDaemonFrameReader();
  constructor(private readonly answer: (request: DaemonRequest, daemon: FakeDaemon) => DaemonFrame | undefined = request => hello(request)) {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const read of this.reader.push(chunk)) {
        if (!read.ok || read.frame.kind !== 'request') throw new Error('The client sent an invalid frame.');
        this.requests.push(read.frame);
        const reply = this.answer(read.frame, this);
        if (reply) this.send(reply);
      }
    });
    this.stdin.on('finish', () => { if (this.exitOnEof) this.exit(0); });
  }
  send(frame: DaemonFrame): void { this.stdout.write(encodeDaemonFrame(frame)); }
  raw(bytes: Uint8Array): void { this.stdout.write(bytes); }
  kill(signal?: NodeJS.Signals): boolean { this.signals.push(signal); this.exit(null, signal ?? 'SIGTERM'); return true; }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    setImmediate(() => this.emit('close', code, signal));
  }
}

const respond = (request: DaemonRequest, result: unknown): DaemonFrame => ({ schemaVersion: 1, kind: 'response', requestId: request.requestId, op: request.op, result } as DaemonFrame);
const refuse = (request: DaemonRequest, code: DaemonErrorCode): DaemonFrame => ({ schemaVersion: 1, kind: 'error', requestId: request.requestId, error: { code } });
function hello(request: DaemonRequest, capabilities: readonly DaemonOp[] = DAEMON_OPS): DaemonFrame | undefined {
  return request.op === 'hello' ? respond(request, { daemonVersion: '0.0.0', capabilities: [...capabilities], maxFrameBytes: 1024 * 1024 }) : undefined;
}
const health = { status: 'ok' as const, uptimeMs: 1 };
const flush = () => new Promise(resolve => setImmediate(resolve));
const ready = async (daemon: FakeDaemon, extra: Partial<ConstructorParameters<typeof DaemonClient>[1]> = {}) => {
  const client = new DaemonClient(daemon, { clientVersion: 'test', ...extra });
  await client.handshake();
  return client;
};
const unavailable = (code: DaemonFailureCode) => expect.objectContaining({ name: 'DaemonUnavailableError', code });

afterEach(() => { vi.useRealTimers(); });

describe('daemon frame client', () => {
  it('handshakes, correlates out-of-order replies by request id and sends each deadline', async () => {
    const held: DaemonRequest[] = [];
    const daemon = new FakeDaemon(request => hello(request) ?? (held.push(request), undefined));
    const client = await ready(daemon);
    expect(daemon.requests[0]).toMatchObject({ op: 'hello', params: { clientVersion: 'test', capabilities: [...DAEMON_HELLO_BASELINE] } });
    const first = client.request('health', {}, 1_000), second = client.request('permission.check', { access: 'read', mode: 'workspace', workspacePermissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: [] });
    await flush();
    expect(held.map(request => [request.op, request.deadlineMs])).toEqual([['health', 1_000], ['permission.check', 5_000]]);
    daemon.send(respond(held[1]!, { decision: 'allow' }));
    daemon.send(respond(held[0]!, health));
    await expect(second).resolves.toEqual({ decision: 'allow' });
    await expect(first).resolves.toEqual(health);
    expect(client.usable).toBe(true);
  });

  it('carries read-only mission snapshots through the frame client with recorded lease times', async () => {
    const missionId = '00000000-0000-4000-8000-000000000001', workspaceId = '00000000-0000-4000-8000-000000000002';
    const taskId = '00000000-0000-4000-8000-000000000003', agentId = '00000000-0000-4000-8000-000000000004';
    const snapshot = { missionId, workspaceId, version: 2, sequence: 3, state: 'running', updatedAt: '2026-10-27T00:00:00.000Z',
      tasks: [{ taskId, assignedAgentId: agentId, state: 'running', attempt: 1 }],
      leases: [{ leaseId: '00000000-0000-4000-8000-000000000005', taskId, holderAgentId: agentId, acquiredAt: '2026-10-27T00:00:00.000Z', expiresAt: '2026-10-27T00:01:00.000Z' }] };
    const daemon = new FakeDaemon(request => hello(request) ?? respond(request, snapshot));
    const client = await ready(daemon);
    await expect(client.request('mission.snapshot', { missionId })).resolves.toEqual(snapshot);
    expect(daemon.requests.at(-1)).toMatchObject({ op: 'mission.snapshot', params: { missionId } });
    expect(daemon.requests.every(request => ['hello', 'mission.snapshot'].includes(request.op))).toBe(true);
    await client.close();
  });

  it('keeps answering other requests while a long knowledge sync is in flight, and correlates its late reply', async () => {
    const held: DaemonRequest[] = [];
    const daemon = new FakeDaemon(request => hello(request)
      ?? (request.op.startsWith('knowledge.') ? (held.push(request), undefined) : respond(request, request.op === 'health' ? health : { decision: 'allow' })));
    const client = await ready(daemon);
    const settled: string[] = [];
    const track = <T>(label: string, promise: Promise<T>) => promise.then(result => { settled.push(label); return result; });
    const report = { mode: 'incremental', at: '2026-10-24T10:00:00.000Z', generation: 1, notes: 2, added: 2, updated: 0, removed: 0, unchanged: 0, unresolvedLinks: 0, renamed: [], renamedTotal: 0, skipped: [], skippedTotal: 0, vaultCreated: false };
    const status = { vaultRoot: 'vaults/default', vaultPresent: true, state: 'unavailable', reason: 'index_locked', generation: 0 };
    vi.useFakeTimers();
    const sync = track('knowledge.sync', client.request('knowledge.sync', { mode: 'incremental' }, 300_000));
    const queued = track('knowledge.status', client.request('knowledge.status', {}, 60_000));
    // Twenty seconds into the sync: requests on the default 5 s deadline are answered ahead of it.
    vi.advanceTimersByTime(20_000);
    await expect(track('health', client.request('health', {}))).resolves.toEqual(health);
    await expect(track('permission.check', client.request('permission.check', { access: 'read', mode: 'workspace', workspacePermissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: [] })))
      .resolves.toEqual({ decision: 'allow' });
    expect(client.usable).toBe(true);
    expect(held.map(request => [request.op, request.deadlineMs])).toEqual([['knowledge.sync', 300_000], ['knowledge.status', 60_000]]);
    daemon.send(respond(held[0]!, report));
    daemon.send(respond(held[1]!, status));
    await expect(sync).resolves.toEqual(report);
    await expect(queued).resolves.toEqual(status);
    expect(settled).toEqual(['health', 'permission.check', 'knowledge.sync', 'knowledge.status']);
    expect(client.usable).toBe(true);
  });

  it('rejects one request on its error frame and keeps the connection', async () => {
    const daemon = new FakeDaemon(request => hello(request) ?? (request.op === 'event.commit' ? refuse(request, 'conflict') : respond(request, health)));
    const client = await ready(daemon);
    const event = { schemaVersion: 1, id: '00000000-0000-4000-8000-000000000001', workspaceId: '00000000-0000-4000-8000-000000000002', sessionId: '00000000-0000-4000-8000-000000000003', missionId: '00000000-0000-4000-8000-000000000004', agentId: '00000000-0000-4000-8000-000000000005', source: { runtime: 'extalia-native', channel: 'system' }, observedAt: '2026-10-22T00:00:00.000Z', sequence: 0, confidence: 'reported', body: { type: 'mission.state', state: 'running' } } as const;
    await expect(client.request('event.commit', { event })).rejects.toEqual(new DaemonRequestError('conflict'));
    await expect(client.request('health', {})).resolves.toEqual(health);
    // An invalid request of our own is never sent and does not end the connection.
    await expect(client.request('health', { extra: true } as never)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(daemon.requests.filter(request => request.op === 'health')).toHaveLength(1);
    expect(client.usable).toBe(true);
  });

  it('fails closed on a missed deadline: kills the daemon and rejects pending and later requests', async () => {
    const daemon = new FakeDaemon();
    const ends: (DaemonFailureCode | undefined)[] = [];
    const client = await ready(daemon, { onEnd: failure => ends.push(failure) });
    vi.useFakeTimers();
    const slow = client.request('health', {}, 50), queued = client.request('health', {}, 5_000);
    vi.advanceTimersByTime(50);
    await expect(slow).rejects.toEqual(unavailable('timeout'));
    await expect(queued).rejects.toEqual(unavailable('timeout'));
    vi.useRealTimers();
    await expect(client.request('health', {})).rejects.toEqual(unavailable('timeout'));
    expect(daemon.signals).toEqual(['SIGKILL']);
    expect(ends).toEqual(['timeout']);
    expect(client.failure).toBe('timeout');
  });

  it.each([
    ['an unparsable payload', (daemon: FakeDaemon) => daemon.raw(Uint8Array.from([0, 0, 0, 2, 123, 125])), 'malformed_reply'],
    ['a reply to no request', (daemon: FakeDaemon) => daemon.send({ schemaVersion: 1, kind: 'response', requestId: '00000000-0000-4000-8000-0000000000ff', op: 'health', result: health }), 'malformed_reply'],
    ['a reply of another operation', (daemon: FakeDaemon, request: DaemonRequest) => daemon.send(respond({ ...request, op: 'permission.check' } as DaemonRequest, { decision: 'allow' })), 'malformed_reply'],
    ['a request from the daemon', (daemon: FakeDaemon) => daemon.send({ schemaVersion: 1, kind: 'request', requestId: '00000000-0000-4000-8000-0000000000fe', op: 'health', params: {} }), 'malformed_reply'],
    ['an uncorrelated error', (daemon: FakeDaemon) => daemon.send({ schemaVersion: 1, kind: 'error', error: { code: 'internal' } }), 'protocol_error'],
    ['an oversize frame header', (daemon: FakeDaemon) => daemon.raw(Uint8Array.from([0xff, 0xff, 0xff, 0xff])), 'malformed_reply'],
    ['a newer schema version', (daemon: FakeDaemon, request: DaemonRequest) => daemon.raw(rawFrame({ schemaVersion: 2, kind: 'response', requestId: request.requestId, op: 'health', result: health })), 'schema_mismatch'],
  ] as const)('ends the connection on %s', async (_name, misbehave, code) => {
    let pending: DaemonRequest | undefined;
    const daemon = new FakeDaemon(request => hello(request) ?? (pending = request, undefined));
    const client = await ready(daemon);
    const request = client.request('health', {});
    await flush();
    misbehave(daemon, pending!);
    await expect(request).rejects.toEqual(unavailable(code));
    expect(client.usable).toBe(false);
    expect(daemon.signals).toEqual(['SIGKILL']);
  });

  it('maps a crash mid-request and the daemon exit statuses to stable codes', async () => {
    const daemon = new FakeDaemon();
    const client = await ready(daemon);
    const request = client.request('health', {});
    daemon.exit(null, 'SIGSEGV');
    await expect(request).rejects.toEqual(unavailable('crashed'));
    expect(daemon.signals).toEqual([]); // Already gone: nothing to kill.
    expect([0, 1, 2, 3, 4, null].map(exitFailure)).toEqual(['crashed', 'protocol_error', 'invalid_arguments', 'store_unavailable', 'locked', 'crashed']);
    const locked = new FakeDaemon(() => undefined);
    const handshake = new DaemonClient(locked, { clientVersion: 'test' }).handshake();
    locked.exit(4);
    await expect(handshake).rejects.toEqual(unavailable('locked'));
  });

  it('rejects a daemon of another schema or without a required operation at the handshake', async () => {
    const newer = new FakeDaemon(request => refuse(request, 'unsupported_schema_version'));
    await expect(new DaemonClient(newer, { clientVersion: 'test' }).handshake()).rejects.toEqual(unavailable('schema_mismatch'));
    const partial = new FakeDaemon(request => hello(request, ['hello', 'health', 'permission.check']));
    const client = new DaemonClient(partial, { clientVersion: 'test' });
    await expect(client.handshake()).rejects.toEqual(unavailable('missing_capability'));
    await expect(client.request('health', {})).rejects.toEqual(unavailable('missing_capability'));
  });

  it('logs bounded, redacted stderr lines only', async () => {
    const daemon = new FakeDaemon();
    const log: string[] = [];
    await ready(daemon, { log: line => log.push(line), redact: text => text.split('/private/profile').join('<data>') });
    daemon.stderr.write('extalia-daemon: opened /private/profile/state/core.sqlite\n');
    daemon.stderr.write(`${'x'.repeat(1_000)}\npartial`);
    for (let n = 0; n < 150; n++) daemon.stderr.write(`line ${n}\u0007\n`);
    await flush();
    expect(log[0]).toBe('extalia-daemon: opened <data>/state/core.sqlite');
    expect(log[1]).toHaveLength(300);
    expect(log[2]).toBe('partialline 0');
    expect(log).toHaveLength(101);
    expect(log.at(-1)).toBe('extalia-daemon: further output suppressed');
  });

  it('shuts down by closing stdin, and kills a daemon that does not exit in time', async () => {
    const daemon = new FakeDaemon(request => hello(request));
    const client = await ready(daemon);
    const pending = client.request('health', {}).catch((error: unknown) => error);
    await client.close();
    expect(await pending).toEqual(unavailable('shutting_down'));
    expect(daemon.signals).toEqual([]);
    expect(client.failure).toBeUndefined();
    const stuck = new FakeDaemon();
    stuck.exitOnEof = false;
    const other = await ready(stuck);
    await other.close(10);
    expect(stuck.signals).toEqual(['SIGKILL']);
  });
});

function rawFrame(value: unknown): Uint8Array {
  const payload = Buffer.from(JSON.stringify(value));
  const bytes = Buffer.alloc(4 + payload.length);
  bytes.writeUInt32BE(payload.length, 0);
  payload.copy(bytes, 4);
  return bytes;
}

describe('daemon sidecar lifecycle', () => {
  function harness(script: (index: number) => (request: DaemonRequest, daemon: FakeDaemon) => DaemonFrame | undefined, binary: string | null = '/opt/extalia-daemon') {
    let clock = 1_000;
    const spawned: { daemon: FakeDaemon; args: string[]; env: Record<string, string> }[] = [];
    const sidecar = new DaemonSidecar({
      binary: () => binary ?? undefined, dataDirectory: '/data', profile: 'default', clientVersion: 'test', now: () => clock,
      env: { PROVIDER_KEY: 'opaque', TMPDIR: '/tmp' }, maxFailures: 3, backoffBaseMs: 100, backoffMaxMs: 1_000,
      spawn: (_binary, args, options) => { const daemon = new FakeDaemon(script(spawned.length)); spawned.push({ daemon, args, env: options.env }); return daemon; },
    });
    return { sidecar, spawned, advance: (ms: number) => { clock += ms; } };
  }

  it('starts lazily once with the data directory and profile and a minimal environment', async () => {
    const { sidecar, spawned } = harness(() => request => hello(request));
    expect(sidecar.status()).toEqual({ state: 'off' });
    const [first, second] = await Promise.all([sidecar.connect(), sidecar.connect()]);
    expect(first).toBe(second);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toEqual(['--data-dir', '/data', '--profile', 'default']);
    expect(spawned[0]!.env).toEqual({ TMPDIR: '/tmp' });
    expect(sidecar.status()).toEqual({ state: 'ready' });
    await sidecar.stop();
    expect(spawned[0]!.daemon.exited).toBe(true);
    expect(sidecar.status()).toEqual({ state: 'off' });
    await expect(sidecar.connect()).rejects.toEqual(unavailable('shutting_down'));
  });

  it('restarts after a crash only once the backoff has passed, and gives up after repeated failures', async () => {
    const { sidecar, spawned, advance } = harness(index => index === 0 ? request => hello(request) : () => undefined);
    await sidecar.connect();
    spawned[0]!.daemon.exit(null, 'SIGKILL');
    await flush();
    expect(sidecar.status()).toEqual({ state: 'unavailable', lastError: 'crashed' });
    await expect(sidecar.connect()).rejects.toEqual(unavailable('crashed'));
    expect(spawned).toHaveLength(1);
    advance(100);
    // The second daemon never answers hello: it exits during the handshake.
    const second = sidecar.connect();
    await flush();
    spawned[1]!.daemon.exit(1);
    await expect(second).rejects.toEqual(unavailable('protocol_error'));
    advance(150);
    await expect(sidecar.connect()).rejects.toEqual(unavailable('protocol_error')); // 200 ms backoff.
    advance(50);
    const third = sidecar.connect();
    await flush();
    spawned[2]!.daemon.exit(3);
    await expect(third).rejects.toEqual(unavailable('store_unavailable'));
    expect(sidecar.status()).toEqual({ state: 'unavailable', lastError: 'restart_limit' });
    advance(60_000);
    await expect(sidecar.connect()).rejects.toEqual(unavailable('restart_limit'));
    expect(spawned).toHaveLength(3);
  });

  it('never retries a locked store or a missing binary', async () => {
    const locked = harness(() => () => undefined);
    const attempt = locked.sidecar.connect();
    await flush();
    locked.spawned[0]!.daemon.exit(4);
    await expect(attempt).rejects.toEqual(unavailable('locked'));
    locked.advance(3_600_000);
    await expect(locked.sidecar.connect()).rejects.toEqual(unavailable('locked'));
    expect(locked.spawned).toHaveLength(1);
    const missing = harness(() => request => hello(request), null);
    await expect(missing.sidecar.connect()).rejects.toEqual(unavailable('binary_missing'));
    expect(missing.spawned).toHaveLength(0);
    expect(missing.sidecar.status()).toEqual({ state: 'unavailable', lastError: 'binary_missing' });
  });
});

describe('daemon mission port', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const plan = {
    mission: { schemaVersion: 1, id: id(1), workspaceId: id(2), leadAgentId: id(3), budgetId: id(4), state: 'queued', createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', version: 1 },
    graph: { schemaVersion: 1, missionId: id(1), tasks: [{ schemaVersion: 1, id: id(10), missionId: id(1), assignedAgentId: id(11), state: 'queued', attempt: 0, dependsOn: [], requirements: ['Read'], evidenceIds: [] }] },
  } as const;
  const event = (n: number, body: Record<string, unknown>, taskId?: string) => ({ schemaVersion: 1, id: id(100 + n), workspaceId: id(2), sessionId: id(5), missionId: id(1), ...(taskId ? { taskId } : {}), agentId: taskId ? id(11) : id(3), source: { runtime: 'extalia-native', channel: 'system' }, observedAt: '2026-10-22T00:00:01.000Z', sequence: n, confidence: 'reported', body }) as never;

  const transitionReply = (request: Extract<DaemonRequest, { op: 'task.transition' }>, sequence: number) => {
    const admission = request.params.supervisorId ? {
      missionId: id(1), workspaceId: id(2), taskId: request.params.taskId, leaseId: request.params.eventId,
      holderAgentId: id(11), supervisorId: request.params.supervisorId, attempt: 1, missionVersion: 2,
      taskDigest: 'a'.repeat(64), graphDigest: 'b'.repeat(64), admissionDigest: 'c'.repeat(64), admittedAt: '2026-10-22T00:00:01.000Z',
    } : undefined;
    return { missionId: id(1), taskId: request.params.taskId, state: request.params.to, sequence, ...(admission ? { admission } : {}) };
  };

  const heartbeatReply = (request: Extract<DaemonRequest, { op: 'mission.heartbeat' }>) => ({ missionId: request.params.missionId,
    leases: request.params.leases.map(lease => ({ ...lease, acquiredAt: '2026-10-22T00:00:01.000Z', expiresAt: new Date(Date.now() + 600_000).toISOString() })) });
  const leaseFixture = async (heartbeat: (request: Extract<DaemonRequest, { op: 'mission.heartbeat' }>) => DaemonFrame | undefined) => {
    let sequence = 1;
    const daemon = new FakeDaemon(request => hello(request) ?? (
      request.op === 'mission.create' ? respond(request, { missionId: id(1), version: 1 })
        : request.op === 'task.transition' ? respond(request, transitionReply(request, ++sequence))
          : request.op === 'mission.heartbeat' ? heartbeat(request) : request.op === 'permission.check' ? respond(request, { decision: 'allow' }) : undefined));
    const client = await ready(daemon);
    const mission = await createDaemonMission(client, plan as never);
    return { daemon, client, mission };
  };

  it('renews silent admitted work independently, and stops heartbeats after the last task settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { daemon, client, mission } = await leaseFixture(request => respond(request, heartbeatReply(request)));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(daemon.requests.some(request => request.op === 'mission.heartbeat')).toBe(false);
    await mission.commit(event(2, { type: 'task.state', state: 'running' }, id(10)));
    await vi.advanceTimersByTimeAsync(60_000);
    const beats = daemon.requests.filter(request => request.op === 'mission.heartbeat');
    expect(beats).toHaveLength(2);
    expect(beats[0]!.params).toEqual({ missionId: id(1), leases: [{ taskId: id(10), leaseId: id(102), holderAgentId: id(11) }] });
    expect(mission.authoritySignal.aborted).toBe(false);
    await mission.commit(event(3, { type: 'task.state', state: 'completed' }, id(10)));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(daemon.requests.filter(request => request.op === 'mission.heartbeat')).toHaveLength(2);
    mission.dispose(); await client.close();
  });

  it('latches a refused heartbeat and denies commits and tools without local fallback', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { daemon, client, mission } = await leaseFixture(request => refuse(request, 'conflict'));
    await mission.commit(event(2, { type: 'task.state', state: 'running' }, id(10)));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mission.authoritySignal.aborted).toBe(true);
    const count = daemon.requests.length;
    await expect(mission.commit(event(3, { type: 'task.state', state: 'completed' }, id(10)))).rejects.toThrow(/authority/);
    expect(await mission.checkPermission({ access: 'read', mode: 'workspace', permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: [] })).toEqual({ decision: 'deny', reason: 'policy_unavailable' });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(daemon.requests).toHaveLength(count);
    mission.dispose(); await client.close();
  });

  it.each(['mission', 'holder', 'epoch', 'missing', 'expired'] as const)('rejects %s mismatches in heartbeat acknowledgements', async kind => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { client, mission } = await leaseFixture(request => {
      const ack = heartbeatReply(request);
      if (kind === 'mission') ack.missionId = id(999);
      if (kind === 'holder') ack.leases[0]!.holderAgentId = id(999);
      if (kind === 'epoch') ack.leases[0]!.leaseId = id(999);
      if (kind === 'missing') ack.leases[0]!.taskId = id(999);
      if (kind === 'expired') ack.leases[0]!.expiresAt = '2026-10-22T00:00:02.000Z';
      return respond(request, ack);
    });
    await mission.commit(event(2, { type: 'task.state', state: 'running' }, id(10)));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mission.authoritySignal.aborted).toBe(true);
    mission.dispose(); await client.close();
  });

  it('serializes a terminal transition behind renewal and ignores a late renewal after disposal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let held: Extract<DaemonRequest, { op: 'mission.heartbeat' }> | undefined;
    const { daemon, client, mission } = await leaseFixture(request => { held = request; return undefined; });
    await mission.commit(event(2, { type: 'task.state', state: 'running' }, id(10)));
    await vi.advanceTimersByTimeAsync(30_000);
    const completed = mission.commit(event(3, { type: 'task.state', state: 'completed' }, id(10)));
    expect(daemon.requests.filter(request => request.op === 'task.transition')).toHaveLength(1);
    daemon.send(respond(held!, heartbeatReply(held!)));
    await completed;
    mission.dispose(); await client.close();
    const next = await leaseFixture(request => { held = request; return undefined; });
    await next.mission.commit(event(2, { type: 'task.state', state: 'running' }, id(10)));
    await vi.advanceTimersByTimeAsync(30_000);
    next.mission.dispose();
    next.daemon.send(refuse(held!, 'conflict'));
    await vi.advanceTimersByTimeAsync(1);
    expect(next.mission.authoritySignal.aborted).toBe(false);
    await next.client.close();
  });

  it('refuses Rust mission admission before creation if independent heartbeat is unsupported', async () => {
    const daemon = new FakeDaemon(request => hello(request, DAEMON_OPS.filter(op => op !== 'mission.heartbeat')));
    const client = await ready(daemon);
    await expect(createDaemonMission(client, plan as never)).rejects.toEqual(unavailable('missing_capability'));
    expect(daemon.requests.map(request => request.op)).toEqual(['hello']);
    await client.close();
  });

  it('checks leases before permission and refuses an allow reply received after the acknowledged expiry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let policy: DaemonRequest | undefined;
    let sequence = 1;
    const daemon = new FakeDaemon(request => hello(request) ?? (
      request.op === 'mission.create' ? respond(request, { missionId: id(1), version: 1 })
        : request.op === 'task.transition' ? respond(request, transitionReply(request, ++sequence))
          : request.op === 'mission.heartbeat' ? respond(request, heartbeatReply(request))
            : request.op === 'permission.check' ? (policy = request, undefined) : undefined));
    const client = await ready(daemon), mission = await createDaemonMission(client, plan as never);
    await mission.commit(event(2, { type: 'task.state', state: 'running' }, id(10)));
    const deciding = mission.checkPermission({ access: 'read', mode: 'workspace', permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: [] });
    await flush();
    expect(daemon.requests.slice(-2).map(request => request.op)).toEqual(['mission.heartbeat', 'permission.check']);
    // Jump the wall clock as after suspension, without processing the heartbeat timer.
    vi.setSystemTime(Date.now() + 600_000);
    daemon.send(respond(policy!, { decision: 'allow' }));
    expect(await deciding).toEqual({ decision: 'deny', reason: 'policy_unavailable' });
    expect(mission.authoritySignal.aborted).toBe(true);
    mission.dispose(); await client.close();
  });

  it('creates the mission, routes task states to compare-and-set transitions and other events to commits', async () => {
    let sequence = 1;
    const daemon = new FakeDaemon(request => hello(request) ?? (
      request.op === 'mission.create' ? respond(request, { missionId: id(1), version: 1 })
        : request.op === 'task.transition' ? respond(request, transitionReply(request, ++sequence))
          : request.op === 'event.commit' ? respond(request, { eventId: request.params.event.id, missionId: id(1), sequence: ++sequence, duplicate: false })
            : request.op === 'mission.heartbeat' ? respond(request, heartbeatReply(request))
            : request.op === 'permission.check' ? respond(request, { decision: request.params.access === 'read' ? 'allow' : 'ask' }) : undefined));
    const client = await ready(daemon);
    const mission = await createDaemonMission(client, plan as never);
    expect(await mission.commit(event(0, { type: 'mission.state', state: 'running' }))).toBe(2);
    expect(await mission.commit(event(1, { type: 'task.assigned', assigneeAgentId: id(11) }, id(10)))).toBe(3);
    expect(await mission.commit(event(2, { type: 'task.state', state: 'running' }, id(10)))).toBe(4);
    const request = { access: 'read' as const, mode: 'workspace' as const, permissions: { fileWrite: 'ask' as const, commands: 'ask' as const }, sessionGrants: [] };
    expect(await mission.checkPermission(request)).toEqual({ decision: 'allow' });
    expect(await mission.checkPermission({ ...request, access: 'write' })).toEqual({ decision: 'ask' });
    expect(await mission.commit(event(3, { type: 'task.state', state: 'completed' }, id(10)))).toBe(5);
    expect(daemon.requests.filter(request => request.op === 'task.transition').map(request => request.params)).toEqual([
      { missionId: id(1), taskId: id(10), eventId: id(102), from: 'queued', to: 'running', supervisorId: mission.supervisorId },
      { missionId: id(1), taskId: id(10), eventId: id(103), from: 'running', to: 'completed' },
    ]);
    await mission.cancelUnstarted(id(5));
    expect(daemon.requests.at(-1)).toMatchObject({ op: 'event.commit', params: { event: { missionId: id(1), sessionId: id(5), agentId: id(3), body: { type: 'mission.state', state: 'cancelled' } } } });
    daemon.exit(null, 'SIGKILL');
    await flush();
    expect(await mission.checkPermission(request)).toEqual({ decision: 'deny', reason: 'policy_unavailable' });
    await expect(mission.commit(event(4, { type: 'mission.state', state: 'completed' }))).rejects.toThrow(/authority/);
  });
});

describe('resolveDaemonBinary', () => {
  const files = (...present: string[]) => (file: string) => present.includes(file);
  const repo = path.resolve('/repo'), resources = path.resolve('/app/resources'), cli = path.resolve('/cli/dist/bin.js');
  const debug = path.join(repo, 'target', 'debug', 'extalia-daemon'), release = path.join(repo, 'target', 'release', 'extalia-daemon');
  const crate = path.join(repo, 'crates', 'extalia-daemon', 'Cargo.toml');
  const packaged = path.join(resources, 'daemon', 'extalia-daemon');
  const fromPackage = path.resolve('/cli/node_modules/@extalia/daemon-linux-x64/extalia-daemon');
  const base = { platform: 'linux' as const, arch: 'x64', env: {} };

  it('prefers the environment, then packaged resources, the npm package and a development build', () => {
    const custom = path.resolve('/custom/extalia-daemon');
    const all = files(custom, packaged, fromPackage, debug, release, crate);
    const loadPackage = (name: string) => name === '@extalia/daemon-linux-x64' ? fromPackage : undefined;
    const options = { ...base, resourcesPath: resources, packageFrom: cli, repoRoot: repo, isFile: all, loadPackage };
    expect(resolveDaemonBinary({ ...options, env: { EXTALIA_DAEMON_PATH: custom } })).toEqual({ path: custom, source: 'env' });
    expect(resolveDaemonBinary(options)).toEqual({ path: packaged, source: 'resources' });
    expect(resolveDaemonBinary({ ...options, resourcesPath: undefined })).toEqual({ path: fromPackage, source: 'package' });
    expect(resolveDaemonBinary({ ...options, resourcesPath: undefined, loadPackage: () => ({ path: fromPackage }) })).toEqual({ path: fromPackage, source: 'package' });
    expect(resolveDaemonBinary({ ...options, resourcesPath: undefined, packageFrom: undefined })).toEqual({ path: debug, source: 'debug' });
    expect(resolveDaemonBinary({ ...base, repoRoot: repo, isFile: files(release, crate) })).toEqual({ path: release, source: 'release' });
  });

  it('falls back cleanly and never guesses', () => {
    // An explicit path that is missing or relative is final: no silent fallback to another binary.
    expect(resolveDaemonBinary({ ...base, env: { EXTALIA_DAEMON_PATH: '/missing' }, repoRoot: repo, isFile: files(debug, crate) })).toBeUndefined();
    expect(resolveDaemonBinary({ ...base, env: { EXTALIA_DAEMON_PATH: 'relative/daemon' }, isFile: () => true })).toBeUndefined();
    // Not installed, throwing, or exporting something else: skipped.
    for (const loadPackage of [() => undefined, () => { throw new Error('broken'); }, () => 42, () => 'relative/daemon']) {
      expect(resolveDaemonBinary({ ...base, packageFrom: cli, isFile: () => true, loadPackage })).toBeUndefined();
    }
    // A folder that is not a checkout of this repository is not probed.
    expect(resolveDaemonBinary({ ...base, repoRoot: repo, isFile: files(debug) })).toBeUndefined();
    expect(resolveDaemonBinary({ ...base, packageFrom: path.join(import.meta.dirname, 'daemonClient.test.ts') })).toBeUndefined();
    expect(daemonPackageName('win32', 'x64')).toBe('@extalia/daemon-win32-x64');
    expect(resolveDaemonBinary({ ...base, platform: 'win32', resourcesPath: resources, isFile: files(path.join(resources, 'daemon', 'extalia-daemon.exe')) })?.path).toMatch(/extalia-daemon\.exe$/);
  });
});


describe('baseline hello compatibility with strict legacy peers', () => {
  it('keeps legacy registry reads ready and sends no unsupported preflight', async () => {
    const legacyOps: readonly DaemonOp[] = ([...DAEMON_HELLO_BASELINE, ...SKILL_REGISTRY_OPS, 'skill.scanner'] as const).filter((op, index, all) => all.indexOf(op) === index);
    const daemon = new FakeDaemon(request => {
      if (request.op === 'hello') {
        if (request.params.capabilities.some(op => !legacyOps.includes(op))) return refuse(request, 'invalid_request');
        return hello(request, legacyOps);
      }
      if (request.op === 'skill.list') return respond(request, { revisions: [], indexGeneration: 1 });
      if (request.op === 'skill.scanner') return respond(request, { scannerId: 'unavailable', pinned: false, policyVersion: 'extalia.skill-policy.v1', status: 'unavailable' });
      throw new Error(`unexpected legacy request ${request.op}`);
    });
    const client = await ready(daemon);
    const sidecar = { connect: async () => client } as unknown as DaemonSidecar;
    const registry = new SkillRegistry({ daemon: sidecar, dataDirectory: '/unused', profile: 'default', workspaceRoot: () => '' });
    expect(await registry.report()).toMatchObject({ mode: 'registry', status: 'ready', preflight: false, revisions: [] });
    await expect(registry.preflight({ rootRevisionId: `skr_${'a'.repeat(64)}`, pins: {} })).rejects.toThrow('not supported');
    expect(daemon.requests.map(request => request.op)).toEqual(['hello', 'skill.list', 'skill.scanner']);
    await client.close();
  });
  it('discovers and uses new operations from a modern server despite baseline advertisement', async () => {
    const root = `skr_${'a'.repeat(64)}`;
    const daemon = new FakeDaemon(request => hello(request) ?? respond(request, { rootRevisionId: root, dispatchEligible: false, status: 'blocked', truncated: false, issues: [{ code: 'root_unavailable' }] }));
    const client = await ready(daemon);
    expect(client.capabilities).toContain('skill.preflight');
    expect(daemon.requests[0]).toMatchObject({ params: { capabilities: [...DAEMON_HELLO_BASELINE] } });
    await expect(client.request('skill.preflight', { rootRevisionId: root, pins: {} })).resolves.toMatchObject({ dispatchEligible: false, status: 'blocked' });
    await client.close();
  });
});
