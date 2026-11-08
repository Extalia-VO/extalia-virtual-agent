import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createHermesObservedRpc, HermesObservedControl, type HermesObservedRpc, type HermesObservedRpcOptions } from '../src/hermesObservedControl.js';

const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function fixture() {
  let channel!: HermesObservedRpcOptions;
  const snapshot = {
    session_id: 'native-one', stored_session_id: 'native-one', authority_epoch: 7,
    replay_epoch: 'replay-one', last_sequence: 4, subscription_id: 'viewer-one', execution_generation: 3,
    running: false, pending: [] as unknown[], prompts: [] as unknown[],
    info: { desktop_protocol: 'hermes-gateway-v1', profile_id: 'profile-one', cwd: '/projects/example' },
  };
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'runtime.describe') return { profile_id: 'profile-one', instance_id: 'owner-one', authority_epoch: 7, capabilities: ['durable-admission-v1'] };
    if (method === 'session.list') return { scope: 'live', sessions: [{ session_id: 'native-one', running: snapshot.running }] };
    if (method === 'session.resume') return snapshot;
    if (method === 'prompt.submit') return { ref: { profile_id: 'profile-one', session_id: 'native-one' }, admission_id: 'admission-one', sequence: 1, status: 'queued', authority_epoch: 7, execution_generation: null };
    if (method === 'session.steer') return { status: 'queued', execution_generation: 3, authority_epoch: 7 };
    if (method.endsWith('.respond')) return { status: 'resolved', prompt_id: 'question-one' };
    return {};
  });
  const rpc: HermesObservedRpc = { profileId: 'profile-one', instanceId: 'owner-one', request, close: vi.fn(async () => {}) };
  const factory = vi.fn(async (options: HermesObservedRpcOptions) => { channel = options; return rpc; });
  const control = new HermesObservedControl({ sessionId: 'observed-one', nativeSessionId: 'native-one', cwd: '/projects/example', bin: '/tools/hermes', rpcFactory: factory });
  const event = (type: string, payload: unknown, sequence = 5, extra = {}) => channel.onMessage({ jsonrpc: '2.0', method: 'event', params: { type, session_id: 'native-one', payload, seq: sequence, replay_epoch: 'replay-one', authority_epoch: 7, execution_generation: 3, ...extra } });
  return { control, snapshot, rpc, request, factory, channel: () => channel, event };
}
const approval = { kind: 'approval', prompt_id: 'question-one', execution_generation: 3, command: 'remove owned build directory', description: 'Clear generated files', choices: ['once', 'deny', 'session', 'always'] };
const clarify = { kind: 'clarify', prompt_id: 'question-one', execution_generation: 3, question: 'Choose a colour', choices: ['Green', 'Blue'], multi_select: false };

describe('observed Hermes exact-owner controls', () => {
  it('does no discovery until explicitly connected and submits only into the exact live native identity', async () => {
    const f = fixture();
    expect(f.control.status()).toMatchObject({ state: 'disconnected', canSend: false });
    expect(f.factory).not.toHaveBeenCalled();
    const state = await f.control.connect();
    expect(state).toMatchObject({ state: 'connected', nativeSessionId: 'native-one', executionGeneration: 3, canSend: true });
    await f.control.send({ connectionId: state.connectionId!, executionGeneration: 3, text: 'Continue this existing session' });
    expect(f.request).toHaveBeenCalledWith('session.list', { scope: 'live', limit: 200 });
    expect(f.request).toHaveBeenCalledWith('session.resume', { session_id: 'native-one', omit_messages: true });
    expect(f.request).toHaveBeenCalledWith('prompt.submit', { session_id: 'native-one', text: 'Continue this existing session', submission_id: expect.any(String) });
    expect(f.request.mock.calls.some(([method]) => ['session.create', 'session.branch', 'session.activate'].includes(method))).toBe(false);
    await f.control.close();
  });

  it('never resumes a stored-only or missing session', async () => {
    const f = fixture();
    f.request.mockImplementation(async method => method === 'runtime.describe'
      ? { profile_id: 'profile-one', instance_id: 'owner-one', authority_epoch: 7, capabilities: ['durable-admission-v1'] }
      : { scope: 'live', sessions: [{ session_id: 'unrelated' }] });
    expect(await f.control.connect()).toMatchObject({ state: 'unavailable', canSend: false });
    expect(f.request).not.toHaveBeenCalledWith('session.resume', expect.anything());
    expect(f.rpc.close).toHaveBeenCalledOnce();
  });

  it.each(['profile', 'owner', 'canonical'])('refuses a mismatched %s before inspecting sessions', async mismatch => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ profile_id: mismatch === 'profile' ? 'foreign-profile' : 'profile-one', instance_id: mismatch === 'owner' ? 'replacement-owner' : 'owner-one', authority_epoch: 7, capabilities: mismatch === 'canonical' ? [] : ['durable-admission-v1'] });
    expect(await f.control.connect()).toMatchObject({ state: 'unavailable', requests: [] });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['runtime.describe']);
  });

  it.each(['session', 'cwd', 'unknown', 'generation', 'question-limit'])('refuses unsafe native %s snapshots', async mismatch => {
    const f = fixture();
    if (mismatch === 'session') f.snapshot.session_id = 'rewritten-session';
    if (mismatch === 'cwd') f.snapshot.info.cwd = '/projects/unrelated';
    if (mismatch === 'unknown') f.snapshot.pending = [{ status: 'unknown' }];
    if (mismatch === 'generation') f.snapshot.prompts = [{ ...approval, execution_generation: 2 }];
    if (mismatch === 'question-limit') f.snapshot.prompts = Array.from({ length: 33 }, (_, index) => ({ ...approval, prompt_id: `q-${index}` }));
    expect(await f.control.connect()).toMatchObject({ state: 'unavailable', canAnswer: false, requests: [] });
  });

  it('answers a native approval once with its exact prompt and generation, excluding permanent configuration changes', async () => {
    const f = fixture(); f.snapshot.running = true; f.snapshot.prompts = [approval];
    const state = await f.control.connect();
    expect(state.requests).toEqual([{ id: 'question-one', kind: 'approval', executionGeneration: 3, question: 'Clear generated files', command: approval.command, description: approval.description, choices: ['once', 'deny', 'session'] }]);
    await expect(f.control.answer({ connectionId: state.connectionId!, requestId: 'question-one', executionGeneration: 3, choice: 'always' })).rejects.toThrow('explicit native reply');
    expect(await f.control.answer({ connectionId: state.connectionId!, requestId: 'question-one', executionGeneration: 3, choice: 'once' })).toMatchObject({ delivery: 'resolved', requests: [] });
    expect(f.request).toHaveBeenCalledWith('approval.respond', { session_id: 'native-one', execution_generation: 3, prompt_id: 'question-one', choice: 'once' });
    await expect(f.control.answer({ connectionId: state.connectionId!, requestId: 'question-one', executionGeneration: 3, choice: 'deny' })).rejects.toThrow();
    expect(f.request.mock.calls.filter(([method]) => method === 'approval.respond')).toHaveLength(1);
    await f.control.close();
  });

  it('returns explicit clarification text to the original waiter without submitting a user turn', async () => {
    const f = fixture(); f.snapshot.running = true; f.snapshot.prompts = [clarify];
    const state = await f.control.connect();
    await f.control.answer({ connectionId: state.connectionId!, requestId: 'question-one', executionGeneration: 3, answer: 'Green' });
    expect(f.request).toHaveBeenCalledWith('clarify.respond', { session_id: 'native-one', execution_generation: 3, prompt_id: 'question-one', answer: 'Green' });
    expect(f.request).not.toHaveBeenCalledWith('prompt.submit', expect.anything());
    await f.control.close();
  });

  it('requires a matching native generation to steer a running turn', async () => {
    const f = fixture(); f.snapshot.running = true;
    const state = await f.control.connect();
    await expect(f.control.send({ connectionId: state.connectionId!, text: 'stale', executionGeneration: 2 })).rejects.toThrow();
    await expect(f.control.send({ connectionId: state.connectionId!, text: 'missing generation' })).rejects.toThrow();
    expect(await f.control.send({ connectionId: state.connectionId!, text: 'Adjust the current work', executionGeneration: 3 })).toMatchObject({ delivery: 'submitted' });
    expect(f.request).toHaveBeenCalledWith('session.steer', { session_id: 'native-one', text: 'Adjust the current work', execution_generation: 3 });
    expect(f.request).not.toHaveBeenCalledWith('prompt.submit', expect.anything());
    await f.control.close();
  });

  it('revokes pending questions on native settlement and ignores another session', async () => {
    const f = fixture(); const state = await f.control.connect();
    f.event('approval.request', approval, 5, { session_id: 'another-session' });
    expect(f.control.status().requests).toEqual([]);
    f.event('approval.request', approval);
    expect(f.control.status().canAnswer).toBe(true);
    f.event('approval.settled', { prompt_id: 'question-one' }, 6);
    await expect(f.control.answer({ connectionId: state.connectionId!, requestId: 'question-one', executionGeneration: 3, choice: 'once' })).rejects.toThrow();
    await f.control.close();
  });

  it.each(['gap', 'epoch', 'generation'])('fails closed on an event %s without replaying anything', async mismatch => {
    const f = fixture(); await f.control.connect();
    f.event('approval.request', approval, mismatch === 'gap' ? 6 : 5, mismatch === 'epoch' ? { authority_epoch: 8 } : mismatch === 'generation' ? { execution_generation: 2 } : {});
    expect(f.control.status()).toMatchObject({ state: 'unavailable', canSend: false, requests: [] });
    expect(f.rpc.close).toHaveBeenCalled();
    await f.control.close();
  });

  it('does not mistake a queued cancellation for completion of the running turn', async () => {
    const f = fixture(); f.snapshot.running = true; await f.control.connect();
    f.event('message.complete', { outcome: 'cancelled' }, 5, { execution_generation: undefined });
    expect(f.control.status().running).toBe(true);
    f.event('session.info', { stored_session_id: 'native-one', authority_epoch: 7, execution_generation: 4, running: true, pending: [] }, 6, { execution_generation: undefined });
    expect(f.control.status()).toMatchObject({ running: true, executionGeneration: 4 });
    await f.control.close();
  });

  it('retires an ambiguous reply and never retries it', async () => {
    const f = fixture(); f.snapshot.running = true; f.snapshot.prompts = [clarify];
    const state = await f.control.connect();
    f.request.mockRejectedValueOnce(new Error('sensitive upstream diagnostics'));
    expect(await f.control.answer({ connectionId: state.connectionId!, requestId: 'question-one', executionGeneration: 3, answer: 'Green' })).toMatchObject({ state: 'unavailable', delivery: 'unknown', requests: [] });
    expect(f.control.status().problem).not.toContain('sensitive');
    await expect(f.control.answer({ connectionId: state.connectionId!, requestId: 'question-one', executionGeneration: 3, answer: 'Blue' })).rejects.toThrow();
    expect(f.request.mock.calls.filter(([method]) => method === 'clarify.respond')).toHaveLength(1);
    await f.control.close();
  });

  it('does not claim this answer was accepted when another native viewer already resolved the question', async () => {
    const f = fixture(); f.snapshot.running = true; f.snapshot.prompts = [clarify];
    const state = await f.control.connect();
    f.request.mockResolvedValueOnce({ status: 'already_resolved', prompt_id: 'question-one' });
    const result = await f.control.answer({ connectionId: state.connectionId!, requestId: 'question-one', executionGeneration: 3, answer: 'Green' });
    expect(result).toMatchObject({ state: 'connected', requests: [], problem: expect.stringContaining('not accepted') });
    expect(result.delivery).toBeUndefined(); await f.control.close();
  });

  it('drains a late attachment after close and makes no native requests', async () => {
    const f = fixture(); let resolve!: (rpc: HermesObservedRpc) => void;
    f.factory.mockImplementationOnce(async () => new Promise(yes => { resolve = yes; }));
    const connecting = f.control.connect();
    const closed = f.control.close();
    resolve(f.rpc); await closed; await connecting;
    expect(f.rpc.close).toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.control.status()).toMatchObject({ state: 'disconnected', canSend: false });
  });

  it.each(['multi-select', 'unsupported-approval'])('refuses a native %s question without exposing or answering it', async unsupported => {
    const f = fixture(); f.snapshot.running = true;
    f.snapshot.prompts = [unsupported === 'multi-select' ? { ...clarify, multi_select: true } : { ...approval, choices: ['always', 'future-allow'] }];
    expect(await f.control.connect()).toMatchObject({ state: 'unavailable', canAnswer: false, requests: [] });
    expect(f.request.mock.calls.some(([method]) => method.endsWith('.respond') || method === 'prompt.submit')).toBe(false);
    await f.control.close();
  });

  it('revokes an attached view when a new multi-select question arrives', async () => {
    const f = fixture(); await f.control.connect();
    f.event('clarify.request', { ...clarify, multi_select: true }); await settle();
    expect(f.control.status()).toMatchObject({ state: 'unavailable', canAnswer: false, requests: [] });
    expect(f.request.mock.calls.some(([method]) => method.endsWith('.respond'))).toBe(false);
    await f.control.close();
  });

  it('keeps failed attachment cleanup sticky through later close, disconnect and connect', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ profile_id: 'foreign-profile', instance_id: 'owner-one', authority_epoch: 7, capabilities: ['durable-admission-v1'] });
    vi.mocked(f.rpc.close).mockRejectedValueOnce(new Error('private cleanup diagnostic'));
    await expect(f.control.connect()).rejects.toThrow('cleanup');
    await expect(f.control.disconnect()).rejects.toThrow('cleanup');
    await expect(f.control.connect()).rejects.toThrow('cleanup');
    await expect(f.control.close()).rejects.toThrow('cleanup');
    expect(f.control.status()).toMatchObject({ state: 'unavailable', canSend: false, requests: [], problem: expect.stringContaining('cleanup') });
    expect(f.control.status().problem).not.toContain('private');
    expect(f.rpc.close).toHaveBeenCalledOnce(); expect(f.factory).toHaveBeenCalledOnce();
  });

  it('does not clear a failed disconnect by closing the emptied RPC field again', async () => {
    const f = fixture(); await f.control.connect();
    vi.mocked(f.rpc.close).mockRejectedValueOnce(new Error('unconfirmed cleanup'));
    await expect(f.control.disconnect()).rejects.toThrow('cleanup');
    await expect(f.control.close()).rejects.toThrow('cleanup');
    await expect(f.control.connect()).rejects.toThrow('cleanup');
    expect(f.rpc.close).toHaveBeenCalledOnce(); expect(f.factory).toHaveBeenCalledOnce();
  });

  it('observes background cleanup rejection and refuses later recovery', async () => {
    const f = fixture(); await f.control.connect();
    vi.mocked(f.rpc.close).mockRejectedValueOnce(new Error('unconfirmed cleanup'));
    f.event('session.replay_gap', {}); await settle();
    expect(f.control.status()).toMatchObject({ state: 'unavailable', canSend: false, problem: expect.stringContaining('cleanup') });
    await expect(f.control.close()).rejects.toThrow('cleanup');
    expect(f.rpc.close).toHaveBeenCalledOnce();
  });

  it('retains a late factory cleanup failure after close has already taken the empty RPC field', async () => {
    const f = fixture(); let resolve!: (rpc: HermesObservedRpc) => void;
    f.factory.mockImplementationOnce(async () => new Promise(yes => { resolve = yes; }));
    vi.mocked(f.rpc.close).mockRejectedValueOnce(new Error('unconfirmed late cleanup'));
    const connecting = f.control.connect(); const connectedResult = connecting.catch(error => error);
    const closing = f.control.close(); const closedResult = closing.catch(error => error);
    resolve(f.rpc);
    expect(await connectedResult).toBeInstanceOf(Error); expect(await closedResult).toBeInstanceOf(Error);
    await expect(f.control.close()).rejects.toThrow('cleanup');
    await expect(f.control.connect()).rejects.toThrow('cleanup');
    expect(f.rpc.close).toHaveBeenCalledOnce(); expect(f.request).not.toHaveBeenCalled();
  });
});

function serverFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x81; header[1] = payload.length < 126 ? payload.length : 126;
  if (header.length === 4) header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

async function transportFixture(mode: 'normal' | 'oversize' | 'wrong-owner' = 'normal') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'extalia-hermes-observed-'));
  const sockets = new Set<Socket>();
  const seen: unknown[] = [];
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let upgraded = false, buffered: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!upgraded) {
        const end = buffered.indexOf('\r\n\r\n'); if (end < 0) return;
        const headers = buffered.subarray(0, end).toString();
        seen.push(headers.includes('hermes-gateway-ticket.ticket-fixture'));
        const key = /Sec-WebSocket-Key: ([^\r\n]+)/i.exec(headers)?.[1];
        const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: hermes-gateway-v1\r\n\r\n`);
        upgraded = true; buffered = buffered.subarray(end + 4);
      }
      while (buffered.length >= 6) {
        let length = buffered[1]! & 127, offset = 2;
        if (length === 126) { if (buffered.length < 8) return; length = buffered.readUInt16BE(2); offset = 4; }
        if (length === 127) throw new Error('Fixture received unexpectedly large data.');
        if (buffered.length < offset + 4 + length) return;
        const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length)), mask = buffered.subarray(offset, offset + 4);
        for (let index = 0; index < payload.length; index++) payload[index] = payload[index]! ^ mask[index % 4]!;
        buffered = buffered.subarray(offset + 4 + length);
        const message = JSON.parse(payload.toString()); seen.push(message);
        if (mode === 'oversize') { const frame = Buffer.alloc(10); frame[0] = 0x81; frame[1] = 127; frame.writeBigUInt64BE(1048577n, 2); socket.write(frame); }
        else {
          let result: unknown = { pong: true };
          if (message.method === 'runtime.describe') result = { profile_id: 'profile-one', instance_id: mode === 'wrong-owner' ? 'replacement-owner' : 'owner-one', authority_epoch: 7, capabilities: ['durable-admission-v1'] };
          if (message.method === 'session.list') result = { scope: 'live', sessions: [{ session_id: 'native-one', running: true }] };
          if (message.method === 'session.resume') result = { session_id: 'native-one', stored_session_id: 'native-one', authority_epoch: 7, replay_epoch: 'replay-one', last_sequence: 4, subscription_id: 'viewer-one', execution_generation: 3, running: true, pending: [], prompts: [clarify], info: { desktop_protocol: 'hermes-gateway-v1', profile_id: 'profile-one', cwd: '/projects/example' } };
          if (message.method === 'clarify.respond') result = { status: 'resolved', prompt_id: 'question-one' };
          socket.write(serverFrame({ jsonrpc: '2.0', id: message.id, result }));
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  const bin = path.join(root, 'hermes.mjs');
  const value = { url: `ws://127.0.0.1:${address.port}/api/ws`, protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.ticket-fixture'], endpoint: { profile_id: 'profile-one', instance_id: 'owner-one' } };
  const writeBootstrap = (body: string) => writeFile(bin, `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
  await writeBootstrap(`if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['gateway','attach','--json'])) process.exit(4); process.stdout.write(${JSON.stringify(JSON.stringify(value))});`);
  const abort = new AbortController(), onClose = vi.fn();
  const options = { bin, env: { PATH: process.env.PATH }, signal: abort.signal, onMessage: vi.fn(), onClose };
  const cleanup = async () => { abort.abort(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); };
  return { options, seen, onClose, writeBootstrap, cleanup };
}

describe.skipIf(process.platform === 'win32')('public Hermes attach loopback transport', () => {
  it('binds the production bootstrap and wire to the owner, exact live session and original native question', async () => {
    const f = await transportFixture();
    const control = new HermesObservedControl({ sessionId: 'observed-one', nativeSessionId: 'native-one', cwd: '/projects/example', bin: f.options.bin, env: f.options.env });
    try {
      const state = await control.connect();
      expect(state).toMatchObject({ state: 'connected', canAnswer: true, executionGeneration: 3 });
      expect(await control.answer({ connectionId: state.connectionId!, requestId: 'question-one', executionGeneration: 3, answer: 'Green' })).toMatchObject({ delivery: 'resolved' });
      expect(f.seen).toContain(true);
      expect(f.seen).toContainEqual({ jsonrpc: '2.0', id: expect.any(Number), method: 'clarify.respond', params: { session_id: 'native-one', execution_generation: 3, prompt_id: 'question-one', answer: 'Green' } });
      expect(f.seen.some(value => typeof value === 'object' && value !== null && ['session.create', 'session.branch'].includes(String((value as { method?: unknown }).method)))).toBe(false);
    } finally { await control.close(); await f.cleanup(); }
  });

  it('refuses a replacement owner over the production wire before listing or attaching any session', async () => {
    const f = await transportFixture('wrong-owner');
    const control = new HermesObservedControl({ sessionId: 'observed-one', nativeSessionId: 'native-one', bin: f.options.bin, env: f.options.env });
    try {
      expect(await control.connect()).toMatchObject({ state: 'unavailable', canSend: false });
      expect(f.seen.filter(value => typeof value === 'object')).toEqual([{ jsonrpc: '2.0', id: 1, method: 'runtime.describe', params: {} }]);
    } finally { await control.close(); await f.cleanup(); }
  });

  it('uses only discover-only attach, redeems the ticket privately and carries bounded RPC frames', async () => {
    const f = await transportFixture();
    try {
      const rpc = await createHermesObservedRpc(f.options);
      expect(rpc.profileId).toBe('profile-one'); expect(rpc.instanceId).toBe('owner-one');
      expect(await rpc.request('ping', {})).toEqual({ pong: true });
      expect(f.seen).toContain(true);
      expect(f.seen).toContainEqual({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });
      expect(JSON.stringify(rpc)).not.toContain('ticket-fixture');
      await rpc.close(); expect(f.onClose).toHaveBeenCalledOnce();
    } finally { await f.cleanup(); }
  });

  it('rejects an oversized wire length before receiving or allocating its body', async () => {
    const f = await transportFixture('oversize');
    try {
      const rpc = await createHermesObservedRpc(f.options);
      await expect(rpc.request('ping', {})).rejects.toThrow('disconnected');
      expect(f.onClose).toHaveBeenCalledOnce(); await rpc.close();
    } finally { await f.cleanup(); }
  });

  it.each(['localhost', 'remote', 'query', 'protocol'])('refuses unsafe bootstrap %s without connecting', async invalid => {
    const f = await transportFixture();
    try {
      const value = { url: invalid === 'localhost' ? 'ws://localhost:5678/api/ws' : invalid === 'remote' ? 'ws://192.0.2.1:5678/api/ws' : invalid === 'query' ? 'ws://127.0.0.1:5678/api/ws?ticket=private' : 'ws://127.0.0.1:5678/api/ws', protocols: invalid === 'protocol' ? ['hermes-gateway-v1', 'private-secret'] : ['hermes-gateway-v1', 'hermes-gateway-ticket.ticket-fixture'], profile_id: 'profile-one', instance_id: 'owner-one' };
      await f.writeBootstrap(`process.stdout.write(${JSON.stringify(JSON.stringify(value))});`);
      await expect(createHermesObservedRpc(f.options)).rejects.toThrow('authenticated loopback');
      expect(f.seen).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it('does not expose bootstrap credentials or retry a CLI that lacks the public command', async () => {
    const f = await transportFixture();
    try {
      await f.writeBootstrap('process.stdout.write("private-ticket-output");process.stderr.write("private-ticket-error");process.exit(2);');
      await expect(createHermesObservedRpc(f.options)).rejects.toThrow('public gateway attach');
      expect(f.seen).toEqual([]);
      await settle();
    } finally { await f.cleanup(); }
  });
});
