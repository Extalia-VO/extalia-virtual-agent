import * as childProcess from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { chmod, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexObservedControl, createCodexObservedRpc,
  type CodexObservedRpc, type CodexObservedRpcOptions,
} from '../src/codexObservedControl.js';

const fixtureSources = vi.hoisted(() => new Map<string, string>());
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn((bin: string, args: string[], options: childProcess.SpawnOptions) => {
    const source = fixtureSources.get(bin);
    return source ? actual.spawn(process.execPath, [source, ...args], options) : actual.spawn(bin, args, options);
  }) };
});

const roots: string[] = [];
const servers: Server[] = [];
const controls: CodexObservedControl[] = [];
afterEach(async () => {
  vi.useRealTimers();
  fixtureSources.clear();
  // Intentionally failed fake cleanup owners remain latched for their lifetime.
  await Promise.allSettled(controls.splice(0).map((control) => control.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'extalia-codex-control-')); roots.push(directory); return directory;
}
async function socket(directory = ''): Promise<string> {
  const socketPath = path.join(directory || await root(), 'server.sock');
  const server = createServer(); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  return socketPath;
}
const thread = (status = 'active', id = 'native-thread', cwd = '/workspace') => ({ id, cwd, status: { type: status }, turns: status === 'active' ? [{ id: 'turn-1', status: 'inProgress', items: [] }] : [] });
async function fixture(options: { status?: string; wrongThread?: boolean; wrongCwd?: boolean; resume?: ReturnType<typeof thread>; turnsPage?: unknown; loadedIds?: string[]; factoryGate?: Promise<void>; onActivity?: () => void } = {}) {
  const socketPath = await socket();
  let callbacks!: CodexObservedRpcOptions;
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'thread/loaded/list') return { data: options.loadedIds ?? ['native-thread'] };
    if (method === 'thread/read') return { thread: thread(options.status, options.wrongThread ? 'different-thread' : undefined, options.wrongCwd ? '/elsewhere' : undefined) };
    if (method === 'thread/turns/list') return options.turnsPage ?? { data: [] };
    if (method === 'thread/resume') return { thread: options.resume ?? thread(options.status) };
    if (method === 'turn/start') return { turn: { id: 'turn-new', status: 'inProgress' } };
    return {};
  });
  const rpc: CodexObservedRpc = { request, notify: vi.fn(async () => {}), respond: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const factory = vi.fn(async (value: CodexObservedRpcOptions) => { callbacks = value; await options.factoryGate; return rpc; });
  const control = new CodexObservedControl({ sessionId: 'observed-session', threadId: 'native-thread', cwd: '/workspace', bin: 'codex', rpcFactory: factory, onActivity: options.onActivity });
  controls.push(control);
  const connect = () => control.connect(socketPath);
  return { control, connect, socketPath, rpc, request, factory, emit: (value: unknown) => callbacks.onMessage(value), disconnect: (problem?: string) => callbacks.onClose(problem) };
}
function question(id: string | number = 7, extra: Record<string, unknown> = {}) {
  return { id, method: 'item/tool/requestUserInput', params: {
    threadId: 'native-thread', turnId: 'turn-1', itemId: 'item-1', isBlocking: true,
    questions: [{ id: 'choice', header: 'Choose', question: 'Which option?', options: [{ label: 'First', description: 'The first option' }, { label: 'Second', description: 'The second option' }] }], ...extra,
  } };
}
function connection(control: CodexObservedControl): string { return control.status().connectionId!; }
function answer(control: CodexObservedControl, text = 'First') {
  return { connectionId: connection(control), requestId: control.status().requests[0]!.id, answers: { choice: text } };
}
function approval(id: string | number = 70, extra: Record<string, unknown> = {}, method = 'item/commandExecution/requestApproval') {
  const action = method === 'item/commandExecution/requestApproval' ? { command: 'printf hello', cwd: '/workspace' }
    : method === 'item/permissions/requestApproval' ? { cwd: '/workspace' } : {};
  return { id, method, params: { threadId: 'native-thread', turnId: 'turn-1', itemId: 'approval-item', startedAtMs: 1000, ...action, ...extra } };
}
function approvalAnswer(control: CodexObservedControl, decision: 'accept' | 'decline' | 'cancel' = 'accept', index = 0) {
  return { connectionId: connection(control), requestId: control.status().approvals![index]!.id, decision };
}
const fileChanges = [{ path: '/workspace/example.txt', diff: '+hello\n', kind: { type: 'add' } }];
function filePreview(changes: unknown = fileChanges, extra: Record<string, unknown> = {}) {
  return { method: 'item/started', params: { threadId: 'native-thread', turnId: 'turn-1', item: { id: 'approval-item', type: 'fileChange', changes }, ...extra } };
}

// Production socket validation explicitly refuses Windows: no named-pipe capability is claimed.
describe.skipIf(process.platform === 'win32')('same-server observed Codex control', () => {
  it('initializes minimally, verifies the exact native thread and resumes without overrides', async () => {
    const f = await fixture(); const state = await f.connect();
    expect(state).toMatchObject({ sessionId: 'observed-session', state: 'connected', threadId: 'native-thread', activeTurnId: 'turn-1', canSend: true, canAnswer: false, requests: [] });
    expect(f.request.mock.calls).toEqual([
      ['initialize', { clientInfo: { name: 'extalia_observer', version: '1' }, capabilities: { experimentalApi: true } }],
      ['thread/loaded/list', { limit: 100 }], ['thread/read', { threadId: 'native-thread', includeTurns: false }],
      ['thread/resume', { threadId: 'native-thread', excludeTurns: true }],
    ]);
    expect(f.rpc.notify).toHaveBeenCalledWith('initialized', {});
  });
  it.each([{ wrongThread: true }, { wrongCwd: true }])('refuses mismatching metadata before resume: %o', async (options) => {
    const f = await fixture(options); expect(await f.connect()).toMatchObject({ state: 'unavailable', canSend: false, canAnswer: false });
    expect(f.request.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false);
    expect(f.rpc.close).toHaveBeenCalledOnce();
  });
  it('refuses a different identity in the resume response', async () => {
    const f = await fixture({ resume: thread('active', 'different-thread') });
    expect((await f.connect()).state).toBe('unavailable');
  });
  it('refuses a matching saved thread absent from the connected server loaded inventory', async () => {
    const f = await fixture({ loadedIds: ['another-thread'] });
    expect(await f.connect()).toMatchObject({ state: 'unavailable', canSend: false, canAnswer: false });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['initialize', 'thread/loaded/list']);
    expect(f.rpc.close).toHaveBeenCalledOnce();
  });
  it('allows same-server idle resume when the previously loaded target unloads before metadata read', async () => {
    const f = await fixture({ status: 'notLoaded', resume: thread('idle') });
    expect(await f.connect()).toMatchObject({ state: 'connected', canSend: true, activeTurnId: undefined });
    expect(f.request.mock.calls.some(([method]) => method === 'thread/turns/list')).toBe(false);
  });
  it('binds an active attachment through metadata-only turns when resume excludes turns', async () => {
    const f = await fixture({ resume: { ...thread('active'), turns: [] }, turnsPage: { data: [
      { id: 'turn-1', status: 'inProgress', items: [], itemsView: 'notLoaded' },
      { id: 'previous-turn', status: 'completed', items: [], itemsView: 'notLoaded' },
    ] } });
    expect(await f.connect()).toMatchObject({ state: 'connected', activeTurnId: 'turn-1', canSend: true });
    expect(f.request).toHaveBeenLastCalledWith('thread/turns/list', { threadId: 'native-thread', limit: 4, sortDirection: 'desc', itemsView: 'notLoaded' });
    f.emit(question()); expect(f.control.status().canAnswer).toBe(true);
    await f.control.answer(answer(f.control)); expect(f.rpc.respond).toHaveBeenCalledOnce();
  });
  it.each([
    { data: [] }, {}, { data: [{ status: 'inProgress', items: [], itemsView: 'notLoaded' }] },
    { data: [{ id: 'turn-1', status: 'completed', items: [], itemsView: 'notLoaded' }] },
    { data: [{ id: 'turn-1', status: 'inProgress', items: [], itemsView: 'full' }] },
    { data: [{ id: 'turn-1', status: 'inProgress', items: [{ text: 'history' }], itemsView: 'notLoaded' }] },
    { data: [{ id: 'turn-1', status: 'inProgress', items: [], itemsView: 'notLoaded' }, { id: 'turn-2', status: 'inProgress', items: [], itemsView: 'notLoaded' }] },
  ])('fails closed on missing, malformed or ambiguous active metadata: %o', async (turnsPage) => {
    const f = await fixture({ resume: { ...thread('active'), turns: [] }, turnsPage });
    expect(await f.connect()).toMatchObject({ state: 'unavailable', canSend: false, canAnswer: false, activeTurnId: undefined });
    f.emit(question()); expect(f.control.status().requests).toEqual([]);
    expect(f.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
  });
  it('replays staged events only after establishing active-turn metadata', async () => {
    const f = await fixture({ resume: { ...thread('active'), turns: [] } });
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        f.emit(question());
        return { data: [{ id: 'turn-1', status: 'inProgress', items: [], itemsView: 'notLoaded' }] };
      }
      return request(method);
    });
    expect(await f.connect()).toMatchObject({ state: 'connected', activeTurnId: 'turn-1', canAnswer: true });
    await f.control.answer(answer(f.control)); expect(f.rpc.respond).toHaveBeenCalledOnce();
  });
  it('steers only the supplied current turn and never falls back to start after rejection', async () => {
    const f = await fixture(); await f.connect();
    f.request.mockImplementation(async (method) => { if (method === 'turn/steer') throw new Error('Rejected'); return {}; });
    await expect(f.control.send({ connectionId: connection(f.control), text: 'Hello', activeTurnId: 'turn-1' })).rejects.toThrow('Rejected');
    expect(f.request).toHaveBeenLastCalledWith('turn/steer', { threadId: 'native-thread', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'Hello' }] });
    expect(f.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
    await expect(f.control.send({ connectionId: connection(f.control), text: 'Hello', activeTurnId: 'wrong' })).rejects.toThrow(/changed/);
  });
  it('freshly verifies idle status before starting on the exact thread', async () => {
    const f = await fixture({ status: 'idle' }); await f.connect();
    await f.control.send({ connectionId: connection(f.control), text: 'Hello' });
    expect(f.request.mock.calls.slice(-2)).toEqual([
      ['thread/read', { threadId: 'native-thread', includeTurns: false }],
      ['turn/start', { threadId: 'native-thread', input: [{ type: 'text', text: 'Hello' }] }],
    ]);
    expect(f.control.status().activeTurnId).toBe('turn-new');
  });
  it('refuses a start when fresh metadata is active', async () => {
    const f = await fixture({ status: 'idle' }); await f.connect();
    f.request.mockResolvedValue({ thread: thread() });
    await expect(f.control.send({ connectionId: connection(f.control), text: 'Hello' })).rejects.toThrow(/idle/);
    expect(f.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
  });
  it('answers only received native questions with the exact typed request id and no early acceptance claim', async () => {
    const f = await fixture(); await f.connect(); f.emit(question());
    expect(f.control.status()).toMatchObject({ canAnswer: true, canSend: false });
    const input = answer(f.control); expect(input.requestId).not.toBe('7');
    await f.control.answer(input);
    expect(f.rpc.respond).toHaveBeenCalledWith(7, { answers: { choice: { answers: ['First'] } } });
    expect(f.control.status()).toMatchObject({ delivery: 'submitted', canAnswer: false, requests: [{ state: 'submitted' }] });
    await expect(f.control.answer(input)).rejects.toThrow(/expired|submitted/);
    f.emit({ method: 'serverRequest/resolved', params: { threadId: 'native-thread', requestId: '7' } });
    expect(f.control.status().requests).toHaveLength(1);
    f.emit({ method: 'serverRequest/resolved', params: { threadId: 'native-thread', requestId: 7 } });
    expect(f.control.status()).toMatchObject({ delivery: 'resolved', requests: [], canAnswer: false });
    expect(JSON.stringify(f.control.status())).not.toContain('answers');
  });
  it('invalidates requests resolved by another client and ignores approvals and foreign requests', async () => {
    const f = await fixture(); await f.connect();
    f.emit({ ...question(), method: 'item/commandExecution/requestApproval' });
    f.emit(question(8, { threadId: 'foreign' })); f.emit(question(9, { turnId: 'old-turn' }));
    expect(f.control.status().requests).toEqual([]); expect(f.rpc.respond).not.toHaveBeenCalled();
    f.emit(question('native-string')); const input = answer(f.control);
    f.emit({ method: 'serverRequest/resolved', params: { threadId: 'native-thread', requestId: 'native-string' } });
    await expect(f.control.answer(input)).rejects.toThrow(/expired/);
    f.emit(question('native-string')); expect(f.control.status().requests).toEqual([]);
  });
  it('clears questions on interrupted turns and item completion', async () => {
    const f = await fixture(); await f.connect(); f.emit(question()); const input = answer(f.control);
    f.emit({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'interrupted' } } });
    await expect(f.control.answer(input)).rejects.toThrow(/expired/);
    expect(f.control.status()).toMatchObject({ requests: [], activeTurnId: undefined });
    f.emit({ method: 'turn/started', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'inProgress' } } });
    f.emit(question(8));
    f.emit({ method: 'item/completed', params: { threadId: 'native-thread', turnId: 'turn-1', item: { id: 'item-1' } } });
    expect(f.control.status().requests).toEqual([]);
  });
  it('validates all exact question ids and offered labels, allowing native free text', async () => {
    const f = await fixture(); await f.connect(); f.emit(question());
    for (const answers of [{}, { choice: '' }, { choice: 'Unlisted' }, { choice: 'First', extra: 'text' }] as Record<string, string>[]) {
      await expect(f.control.answer({ ...answer(f.control), answers })).rejects.toThrow();
    }
    expect(f.rpc.respond).not.toHaveBeenCalled();
    f.emit({ method: 'serverRequest/resolved', params: { threadId: 'native-thread', requestId: 7 } });
    f.emit(question(8, { questions: [{ id: 'choice', header: 'Answer', question: 'Your text?', isOther: true, options: [{ label: 'First', description: '' }] }] }));
    await f.control.answer(answer(f.control, 'Arbitrary text'));
    expect(f.rpc.respond).toHaveBeenCalledWith(8, { answers: { choice: { answers: ['Arbitrary text'] } } });
  });
  it('rejects malformed, duplicate and overlong questions without altering option text', async () => {
    const f = await fixture(); await f.connect();
    for (const questions of [[], [{ id: 'x' }], Array(9).fill({ id: 'x', header: 'H', question: 'Q' }), [{ id: 'x', header: 'H', question: 'Q', options: [{ label: 'x'.repeat(1025), description: '' }] }], [{ id: 'x', header: 'H', question: 'Q' }, { id: 'x', header: 'H', question: 'Q' }]]) {
      f.emit(question(1, { questions }));
    }
    expect(f.control.status().requests).toEqual([]);
    f.emit(question(2)); expect(f.control.status().requests[0]!.questions[0]!.options[0]).toEqual({ label: 'First', description: 'The first option' });
  });
  it('rejects double submissions while the socket revalidation is in flight', async () => {
    const f = await fixture(); await f.connect(); f.emit(question()); const input = answer(f.control);
    const first = f.control.answer(input); await expect(f.control.answer(input)).rejects.toThrow(/submitted/); await first;
    expect(f.rpc.respond).toHaveBeenCalledOnce();
  });
  it('clears connection authority on disconnect and rejects old generation callbacks', async () => {
    const f = await fixture(); await f.connect(); f.emit(question()); const input = answer(f.control);
    f.disconnect(); expect(f.control.status()).toMatchObject({ state: 'unavailable', requests: [], canAnswer: false });
    f.emit(question(8)); await expect(f.control.answer(input)).rejects.toThrow(/Stale/);
    await f.connect(); await expect(f.control.answer(input)).rejects.toThrow(/Stale/);
  });
  it('does not resurrect a connection or leak a late factory result after close', async () => {
    let release!: () => void;
    const f = await fixture({ factoryGate: new Promise<void>((resolve) => { release = resolve; }) });
    const connecting = f.connect();
    await vi.waitFor(() => expect(f.factory).toHaveBeenCalledOnce());
    await f.control.close(); release(); await connecting;
    expect(f.control.status().state).toBe('disconnected'); expect(f.rpc.close).toHaveBeenCalledOnce(); expect(f.request).not.toHaveBeenCalled();
  });
  it('latches late factory cleanup failure after close and blocks every subsequent close and reconnect', async () => {
    let release!: () => void;
    const f = await fixture({ factoryGate: new Promise<void>((resolve) => { release = resolve; }) });
    f.rpc.close = vi.fn(async () => { throw new Error('private late cleanup detail'); });
    const connecting = f.connect();
    await vi.waitFor(() => expect(f.factory).toHaveBeenCalledOnce());
    await f.control.close(); release();
    await expect(connecting).rejects.toThrow('Codex proxy cleanup could not be confirmed.');
    await expect(f.control.close()).rejects.toThrow('Codex proxy cleanup could not be confirmed.');
    await expect(f.control.close()).rejects.toThrow('Codex proxy cleanup could not be confirmed.');
    await expect(f.connect()).rejects.toThrow('Codex proxy cleanup could not be confirmed.');
    expect(f.factory).toHaveBeenCalledOnce(); expect(f.request).not.toHaveBeenCalled();
    expect(f.control.status()).toMatchObject({ state: 'unavailable', canSend: false, canAnswer: false, problem: 'Codex proxy cleanup could not be confirmed.' });
    expect(JSON.stringify(f.control.status())).not.toContain('private late cleanup detail');
  });
  it('latches transport cleanup diagnostics even after the RPC handle was cleared', async () => {
    const f = await fixture(); await f.connect(); await f.control.close();
    f.disconnect('private diagnostic');
    await expect(f.control.close()).rejects.toThrow('Codex proxy cleanup could not be confirmed.');
    await expect(f.connect()).rejects.toThrow('Codex proxy cleanup could not be confirmed.');
    expect(f.factory).toHaveBeenCalledOnce();
    expect(f.control.status()).toMatchObject({ state: 'unavailable', problem: 'Codex proxy cleanup could not be confirmed.' });
  });
  it('does not resurrect after close during initialize', async () => {
    const f = await fixture(); let release!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const connecting = f.connect(); await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    await f.control.close(); release({}); await connecting;
    expect(f.control.status().state).toBe('disconnected'); expect(f.rpc.close).toHaveBeenCalledOnce();
  });
  it('reports explicit and background proxy cleanup uncertainty', async () => {
    const f = await fixture(); await f.connect();
    f.rpc.close = vi.fn(async () => { throw new Error('untrusted diagnostic'); });
    f.emit({ method: 'thread/closed', params: { threadId: 'native-thread' } });
    await vi.waitFor(() => expect(f.control.status().problem).toBe('Codex proxy cleanup could not be confirmed.'));
    expect(f.control.status().state).toBe('unavailable');
    await expect(f.control.close()).rejects.toThrow('Codex proxy cleanup could not be confirmed.');
    expect(f.control.status()).toMatchObject({ state: 'unavailable', problem: 'Codex proxy cleanup could not be confirmed.' });
    expect(JSON.stringify(f.control.status())).not.toContain('untrusted diagnostic');
    await expect(f.control.close()).rejects.toThrow('Codex proxy cleanup could not be confirmed.');
    await expect(f.connect()).rejects.toThrow('Codex proxy cleanup could not be confirmed.');
    expect(f.factory).toHaveBeenCalledOnce();
  });
  it('refuses replaced sockets before mutation', async () => {
    const f = await fixture(); await f.connect(); f.emit(question()); const input = answer(f.control);
    await unlink(f.socketPath); await socket(path.dirname(f.socketPath));
    await expect(f.control.answer(input)).rejects.toThrow(/socket/); expect(f.rpc.respond).not.toHaveBeenCalled();
    expect(f.control.status().state).toBe('disconnected');
  });
  it('refuses socket symlinks, files, relative paths and writable parents before spawning', async () => {
    const f = await fixture(); const directory = await root();
    const link = path.join(directory, 'link.sock'); await symlink(f.socketPath, link);
    const file = path.join(directory, 'file.sock'); await writeFile(file, '');
    for (const endpoint of [link, file, 'relative.sock']) expect((await f.control.connect(endpoint)).state).toBe('unavailable');
    await chmod(f.socketPath, 0o777);
    expect((await f.control.connect(f.socketPath)).state).toBe('unavailable');
    await chmod(f.socketPath, 0o700);
    await chmod(path.dirname(f.socketPath), 0o777);
    expect((await f.control.connect(f.socketPath)).state).toBe('unavailable');
    expect(f.factory).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')('native observed Codex approvals', () => {
  it.each(['accept', 'decline', 'cancel'] as const)('submits only the one-action native command decision %s', async (decision) => {
    const f = await fixture(); await f.connect();
    f.emit(approval(70, { reason: 'Run the exact action', commandActions: [{ type: 'unknown', command: 'printf hello' }], availableDecisions: ['acceptForSession', 'accept', 'decline', 'cancel', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['printf'] } }] }));
    expect(f.control.status()).toMatchObject({ canSend: false, canApprove: true, canAnswer: false, approvals: [{ kind: 'commandExecution', commandKind: 'command', command: 'printf hello', cwd: '/workspace', reason: 'Run the exact action', availableDecisions: ['accept', 'decline', 'cancel'] }] });
    const input = approvalAnswer(f.control, decision); expect(input.requestId).not.toBe('70');
    await f.control.answerApproval(input);
    expect(f.rpc.respond).toHaveBeenCalledExactlyOnceWith(70, { decision });
    expect(f.control.status()).toMatchObject({ delivery: 'submitted', canApprove: false, canSend: false, approvals: [{ state: 'submitted' }] });
    await expect(f.control.answerApproval(input)).rejects.toThrow(/submitted/);
    f.emit({ method: 'serverRequest/resolved', params: { threadId: 'native-thread', requestId: 70 } });
    expect(f.control.status()).toMatchObject({ delivery: 'resolved', approvals: [], canSend: true });
  });
  it('does not offer unadvertised choices or accept session and policy amendments', async () => {
    const f = await fixture(); await f.connect(); f.emit(approval(70, { availableDecisions: ['decline', 'acceptForSession'] }));
    expect(f.control.status().approvals![0]!.availableDecisions).toEqual(['decline']);
    for (const decision of ['accept', 'cancel', 'acceptForSession', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['printf'] } }]) {
      await expect(f.control.answerApproval({ ...approvalAnswer(f.control), decision: decision as never })).rejects.toThrow(/offered/);
    }
    expect(f.rpc.respond).not.toHaveBeenCalled();
    await f.control.answerApproval(approvalAnswer(f.control, 'decline'));
    expect(f.rpc.respond).toHaveBeenCalledExactlyOnceWith(70, { decision: 'decline' });
  });
  it('preserves full stdin, network and additional permission details without persistent policy choices', async () => {
    const f = await fixture(); await f.connect();
    const additionalPermissions = { network: { enabled: true }, fileSystem: { read: ['/workspace/input'], entries: [{ access: 'write', path: { type: 'path', path: '/workspace/output' } }], globScanMaxDepth: 2 } };
    f.emit(approval(70, { kind: 'writeStdin', approvalId: 'stdin-callback', command: 'yes\n', environmentId: 'local-env', additionalPermissions, networkApprovalContext: { host: 'example.com', protocol: 'https' }, proposedNetworkPolicyAmendments: [{ host: 'example.com', action: 'allow' }] }));
    expect(f.control.status().approvals).toMatchObject([{ kind: 'commandExecution', commandKind: 'writeStdin', command: 'yes\n', environmentId: 'local-env', additionalPermissions, networkApprovalContext: { host: 'example.com', protocol: 'https' } }]);
    const snapshot = f.control.status(); snapshot.approvals![0]!.availableDecisions.length = 0;
    await f.control.answerApproval({ ...approvalAnswer(f.control), permissions: { network: { enabled: false } }, scope: 'session', strictAutoReview: false } as ReturnType<typeof approvalAnswer>);
    expect(f.rpc.respond).toHaveBeenCalledExactlyOnceWith(70, { decision: 'accept' });
    expect(JSON.stringify(f.control.status())).not.toContain('proposedNetworkPolicyAmendments');
  });
  it.each(['accept', 'decline'] as const)('returns the exact native turn-only permission grant for %s', async (decision) => {
    const f = await fixture(); await f.connect();
    const permissions = { network: { enabled: true }, fileSystem: { write: ['/workspace/output'], entries: [
      { access: 'read', path: { type: 'special', value: { kind: 'project_roots', subpath: 'docs' } } },
      { access: 'write', path: { type: 'glob_pattern', pattern: '/workspace/output/**' } },
    ] } };
    f.emit(approval('permissions-native', { permissions, environmentId: 'local-env', reason: 'Read docs and write outputs' }, 'item/permissions/requestApproval'));
    expect(f.control.status().approvals).toMatchObject([{ kind: 'permissions', permissions, cwd: '/workspace', scope: 'turn', availableDecisions: ['accept', 'decline'] }]);
    await expect(f.control.answerApproval(approvalAnswer(f.control, 'cancel'))).rejects.toThrow(/offered/);
    await f.control.answerApproval(approvalAnswer(f.control, decision));
    expect(f.rpc.respond).toHaveBeenCalledExactlyOnceWith('permissions-native', { permissions: decision === 'accept' ? permissions : {}, scope: 'turn' });
  });
  it.each([
    { network: { enabled: 'yes' } }, { network: { enabled: true, hosts: ['example.com'] } }, { futureScope: true },
    { fileSystem: { write: ['relative/file'] } }, { fileSystem: { globScanMaxDepth: 0 } },
    { fileSystem: { entries: [{ access: 'execute', path: { type: 'path', path: '/workspace' } }] } },
    { fileSystem: { entries: [{ access: 'write', path: { type: 'future', path: '/workspace' } }] } },
    { fileSystem: { entries: [{ access: 'write', path: { type: 'special', value: { kind: 'root', hiddenScope: true } } }] } },
    { fileSystem: { write: Array(129).fill('/workspace') } },
  ])('leaves malformed or unknown native scopes in the source app: %o', async (permissions) => {
    const f = await fixture(); await f.connect(); f.emit(approval(70, { permissions }, 'item/permissions/requestApproval'));
    expect(f.control.status()).toMatchObject({ approvals: [], canApprove: false, canSend: false });
    expect(f.rpc.respond).not.toHaveBeenCalled();
    f.emit({ method: 'serverRequest/resolved', params: { threadId: 'native-thread', requestId: 70 } });
    expect(f.control.status().canSend).toBe(true);
  });
  it.each(['accept', 'decline', 'cancel'] as const)('approves only fully received native file changes with %s', async (decision) => {
    const f = await fixture(); await f.connect(); f.emit(filePreview());
    f.emit(approval('files-native', { reason: 'Apply the displayed patch' }, 'item/fileChange/requestApproval'));
    expect(f.control.status().approvals).toMatchObject([{ kind: 'fileChange', changes: fileChanges, cwd: '/workspace', availableDecisions: ['accept', 'decline', 'cancel'] }]);
    await f.control.answerApproval(approvalAnswer(f.control, decision));
    expect(f.rpc.respond).toHaveBeenCalledExactlyOnceWith('files-native', { decision });
  });
  it.each(['decline', 'cancel'] as const)('offers only native denial for a potentially persistent file grant root: %s', async (decision) => {
    const f = await fixture(); await f.connect(); f.emit(filePreview());
    f.emit(approval('files-native', { grantRoot: '/workspace' }, 'item/fileChange/requestApproval'));
    expect(f.control.status().approvals).toMatchObject([{ kind: 'fileChange', changes: fileChanges, grantRoot: '/workspace', availableDecisions: ['decline', 'cancel'] }]);
    await expect(f.control.answerApproval(approvalAnswer(f.control, 'accept'))).rejects.toThrow(/offered/);
    expect(f.rpc.respond).not.toHaveBeenCalled();
    await f.control.answerApproval(approvalAnswer(f.control, decision));
    expect(f.rpc.respond).toHaveBeenCalledExactlyOnceWith('files-native', { decision });
  });
  it('allows one-action file acceptance when the native grant root is explicitly null', async () => {
    const f = await fixture(); await f.connect(); f.emit(filePreview());
    f.emit(approval('files-native', { grantRoot: null }, 'item/fileChange/requestApproval'));
    await f.control.answerApproval(approvalAnswer(f.control));
    expect(f.rpc.respond).toHaveBeenCalledExactlyOnceWith('files-native', { decision: 'accept' });
  });
  it('requires a complete exact-item file preview and ignores foreign or malformed previews', async () => {
    const f = await fixture(); await f.connect();
    f.emit(filePreview(fileChanges, { turnId: 'foreign-turn' }));
    f.emit(filePreview([{ path: '/workspace/example.txt', kind: { type: 'add' } }]));
    f.emit(approval(70, {}, 'item/fileChange/requestApproval'));
    expect(f.control.status()).toMatchObject({ approvals: [], canSend: false, canApprove: false });
    f.emit(filePreview()); expect(f.control.status().approvals).toEqual([]);
    f.emit(approval(71, {}, 'item/fileChange/requestApproval'));
    expect(f.control.status().canApprove).toBe(true);
  });
  it('invalidates an old file decision when the native diff changes and requires a fresh native callback', async () => {
    const f = await fixture(); await f.connect(); f.emit(filePreview()); f.emit(approval(70, {}, 'item/fileChange/requestApproval'));
    const input = approvalAnswer(f.control);
    const first = f.control.answerApproval(input);
    const changes = [{ path: '/workspace/other.txt', diff: '+other\n', kind: { type: 'update', move_path: '/workspace/moved.txt' } }];
    f.emit({ method: 'item/fileChange/patchUpdated', params: { threadId: 'native-thread', turnId: 'turn-1', itemId: 'approval-item', changes } });
    await expect(first).rejects.toThrow(/expired/); expect(f.rpc.respond).not.toHaveBeenCalled();
    expect(f.control.status()).toMatchObject({ approvals: [], canSend: false });
    f.emit(approval(71, {}, 'item/fileChange/requestApproval'));
    expect(f.control.status().approvals).toMatchObject([{ changes }]);
  });
  it('preserves numeric versus string native IDs and independent subcommand callbacks', async () => {
    const f = await fixture(); await f.connect();
    f.emit(approval(70, { approvalId: 'first-callback' })); f.emit(approval('70', { approvalId: 'second-callback' }));
    expect(f.control.status().approvals).toHaveLength(2);
    f.emit({ method: 'serverRequest/resolved', params: { threadId: 'foreign-thread', requestId: 70 } });
    expect(f.control.status().approvals).toHaveLength(2);
    f.emit({ method: 'serverRequest/resolved', params: { threadId: 'native-thread', requestId: 70 } });
    expect(f.control.status().approvals).toHaveLength(1);
    await f.control.answerApproval(approvalAnswer(f.control));
    expect(f.rpc.respond).toHaveBeenCalledExactlyOnceWith('70', { decision: 'accept' });
  });
  it('rejects a replaced callback after asynchronous socket validation', async () => {
    const f = await fixture(); await f.connect(); f.emit(approval()); const input = approvalAnswer(f.control);
    const first = f.control.answerApproval(input);
    f.emit(approval(71, { command: 'printf changed' }));
    await expect(first).rejects.toThrow(/expired/); expect(f.rpc.respond).not.toHaveBeenCalled();
    expect(f.control.status().approvals).toMatchObject([{ command: 'printf changed', state: 'pending' }]);
    await expect(f.control.answerApproval(input)).rejects.toThrow(/expired/);
    await f.control.answerApproval(approvalAnswer(f.control));
    expect(f.rpc.respond).toHaveBeenCalledExactlyOnceWith(71, { decision: 'accept' });
  });
  it('rejects double submissions and another-client resolution during asynchronous validation', async () => {
    const f = await fixture(); await f.connect(); f.emit(approval()); const input = approvalAnswer(f.control);
    const first = f.control.answerApproval(input);
    await expect(f.control.answerApproval(input)).rejects.toThrow(/submitted/);
    f.emit({ method: 'serverRequest/resolved', params: { threadId: 'native-thread', requestId: 70 } });
    await expect(first).rejects.toThrow(/expired/); expect(f.rpc.respond).not.toHaveBeenCalled();
    f.emit(approval()); expect(f.control.status().approvals).toEqual([]);
  });
  it('disconnects when a typed native request ID is reused with changed action contents', async () => {
    const f = await fixture(); await f.connect(); f.emit(approval()); const input = approvalAnswer(f.control);
    f.emit(approval(70, { command: 'printf changed' }));
    expect(f.control.status()).toMatchObject({ state: 'unavailable', canApprove: false, approvals: [] });
    await expect(f.control.answerApproval(input)).rejects.toThrow(/Stale/); expect(f.rpc.respond).not.toHaveBeenCalled();
  });
  it.each(['item/completed', 'turn/completed', 'thread/status/changed', 'thread/closed'])('invalidates approvals on %s', async (method) => {
    const f = await fixture(); await f.connect(); f.emit(approval()); const input = approvalAnswer(f.control);
    f.emit({ method, params: { threadId: 'native-thread', turnId: 'turn-1', item: { id: 'approval-item' }, turn: { id: 'turn-1', status: 'interrupted' }, status: { type: 'idle' } } });
    await expect(f.control.answerApproval(input)).rejects.toThrow(/expired|Stale/);
    expect(f.control.status()).toMatchObject({ approvals: [], canApprove: false }); expect(f.rpc.respond).not.toHaveBeenCalled();
  });
  it('invalidates approvals and late callbacks across connection generations', async () => {
    const f = await fixture(); await f.connect(); f.emit(approval()); const input = approvalAnswer(f.control);
    const oldCallbacks = f.factory.mock.calls[0]![0];
    f.disconnect(); await f.connect(); oldCallbacks.onMessage(approval(71));
    expect(f.control.status().approvals).toEqual([]);
    await expect(f.control.answerApproval(input)).rejects.toThrow(/Stale/); expect(f.rpc.respond).not.toHaveBeenCalled();
  });
  it('never retries an uncertain native decision or claims resolution before the native notification', async () => {
    const f = await fixture(); await f.connect(); f.emit(approval()); const input = approvalAnswer(f.control);
    f.rpc.respond = vi.fn(async () => { throw new Error('write failed'); });
    await expect(f.control.answerApproval(input)).rejects.toThrow('write failed');
    expect(f.control.status()).toMatchObject({ delivery: 'unknown', approvals: [], canSend: false, canApprove: false });
    await expect(f.control.answerApproval(input)).rejects.toThrow(/expired/); expect(f.rpc.respond).toHaveBeenCalledOnce();
  });
  it.each([
    { command: null }, { cwd: null }, { command: 'x'.repeat(65_537) }, { startedAtMs: undefined },
    { kind: 'futureKind' }, { availableDecisions: ['acceptForSession'] }, { additionalPermissions: { unknownScope: true } }, { hiddenScope: true },
    { networkApprovalContext: { host: 'example.com', protocol: 'ftp' } }, { commandActions: [{ type: 'read', command: 'cat x', path: '/workspace/x' }] },
  ])('leaves unsupported or incomplete command action details in the source app: %o', async (extra) => {
    const f = await fixture(); await f.connect(); f.emit(approval(70, extra));
    expect(f.control.status()).toMatchObject({ approvals: [], canSend: false, canApprove: false }); expect(f.rpc.respond).not.toHaveBeenCalled();
  });
  it('does not receive foreign-turn approvals or send while an exact current approval is pending', async () => {
    const f = await fixture(); await f.connect();
    f.emit(approval(70, { threadId: 'foreign' })); f.emit(approval(71, { turnId: 'old-turn' }));
    expect(f.control.status().approvals).toEqual([]); expect(f.control.status().canSend).toBe(true);
    f.emit(approval(72));
    await expect(f.control.send({ connectionId: connection(f.control), activeTurnId: 'turn-1', text: 'Change action' })).rejects.toThrow();
    expect(f.request.mock.calls.some(([method]) => method === 'turn/steer')).toBe(false);
  });
});

it.runIf(process.platform === 'win32')('refuses observed socket control on Windows before launching a proxy', async () => {
  const factory = vi.fn();
  const control = new CodexObservedControl({ sessionId: 'observed-session', threadId: 'native-thread', cwd: '/workspace', bin: 'codex', rpcFactory: factory });
  controls.push(control);
  expect(await control.connect(path.join(await root(), 'server.sock'))).toMatchObject({ state: 'unavailable', canSend: false, canAnswer: false });
  expect(factory).not.toHaveBeenCalled();
});

async function executable(script: string): Promise<string> {
  const directory = await root(); const file = path.join(directory, 'fake-codex');
  const source = path.join(directory, 'fake.cjs'); await writeFile(source, script);
  // Keep framing and child-lifecycle coverage portable without a shell wrapper.
  fixtureSources.set(file, source); return file;
}
// The real CLI is a raw byte proxy: fixtures require HTTP Upgrade and masked
// RFC6455 client messages, rather than accepting a decoded JSONL stand-in.
async function webSocketProxy(options: { upgrade?: string; onOpen?: string; onMessage?: string } = {}): Promise<string> {
  return executable(`
const fs = require('node:fs'); const crypto = require('node:crypto');
if (process.env.ARGS) fs.writeFileSync(process.env.ARGS, JSON.stringify(process.argv.slice(2)));
process.on('SIGTERM', () => setTimeout(() => process.exit(), 25));
let buffer = Buffer.alloc(0), upgraded = false;
function frame(opcode, payload, fin = true) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  const extra = payload.length < 126 ? 0 : payload.length < 65536 ? 2 : 8;
  const out = Buffer.alloc(2 + extra + payload.length); out[0] = (fin ? 128 : 0) | opcode;
  out[1] = extra === 0 ? payload.length : extra === 2 ? 126 : 127;
  if (extra === 2) out.writeUInt16BE(payload.length, 2);
  if (extra === 8) out.writeBigUInt64BE(BigInt(payload.length), 2);
  payload.copy(out, 2 + extra); return out;
}
function send(message) { process.stdout.write(frame(1, JSON.stringify(message))); }
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  if (!upgraded) {
    const end = buffer.indexOf('\\r\\n\\r\\n'); if (end < 0) return;
    const header = buffer.subarray(0, end).toString(); buffer = buffer.subarray(end + 4);
    if (!header.startsWith('GET / HTTP/1.1\\r\\n') || !/Sec-WebSocket-Version: 13/i.test(header)) process.exit(90);
    const key = /Sec-WebSocket-Key: ([^\\r\\n]+)/i.exec(header)[1].trim();
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    ${options.upgrade ?? "process.stdout.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');"}
    upgraded = true;
    ${options.onOpen ?? ''}
  }
  while (buffer.length >= 2) {
    const opcode = buffer[0] & 15; if (!(buffer[1] & 128) || !(buffer[0] & 128)) process.exit(91);
    let size = buffer[1] & 127, header = 2;
    if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); header = 4; }
    if (size === 127) { if (buffer.length < 10) return; size = Number(buffer.readBigUInt64BE(2)); header = 10; }
    if (buffer.length < header + 4 + size) return;
    const mask = buffer.subarray(header, header + 4), clientPayload = Buffer.from(buffer.subarray(header + 4, header + 4 + size));
    for (let i = 0; i < size; i++) clientPayload[i] ^= mask[i % 4];
    buffer = buffer.subarray(header + 4 + size);
    if (process.env.FRAMES) fs.appendFileSync(process.env.FRAMES, JSON.stringify({ opcode, payload: clientPayload.toString(), masked: true }) + '\\n');
    if (opcode !== 1) continue;
    const message = JSON.parse(clientPayload.toString());
    ${options.onMessage ?? "if (message.method && message.id !== undefined) send({ id: message.id, result: { ok: true } }); else if (!message.method && process.env.RESPONSE) fs.writeFileSync(process.env.RESPONSE, JSON.stringify(message));"}
  }
});
`);
}
const rpcOptions = (bin: string, additions: Partial<CodexObservedRpcOptions> = {}): CodexObservedRpcOptions => ({
  bin, socketPath: '/explicit/server.sock', onMessage: () => {}, onClose: () => {}, ...additions,
});
describe('bounded observed Codex WebSocket proxy transport', () => {
  it('upgrades the explicit byte proxy and sends masked text with exact typed response ids', async () => {
    const directory = await root(); const args = path.join(directory, 'args.json'); const frames = path.join(directory, 'frames.jsonl');
    const bin = await webSocketProxy(); const response = path.join(directory, 'response.json');
    const rpc = await createCodexObservedRpc(rpcOptions(bin, { env: { ARGS: args, RESPONSE: response, FRAMES: frames } }));
    try {
      expect(await rpc.request('initialize', {})).toEqual({ ok: true });
      expect(JSON.parse(await readFile(args, 'utf8'))).toEqual(['app-server', 'proxy', '--sock', '/explicit/server.sock']);
      await rpc.respond('7', { answers: { choice: { answers: ['First'] } } });
      await vi.waitFor(async () => expect(JSON.parse(await readFile(response, 'utf8'))).toEqual({ id: '7', result: { answers: { choice: { answers: ['First'] } } } }));
      expect((await readFile(frames, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).masked)).toEqual([true, true]);
    } finally { await rpc.close(); }
  });
  it('fails a missing proxy without launching any fallback', async () => {
    const onClose = vi.fn(); const rpc = await createCodexObservedRpc(rpcOptions(path.join(await root(), 'missing'), { onClose }));
    await expect(rpc.request('initialize', {})).rejects.toThrow(/disconnected/); await rpc.close(); expect(onClose).toHaveBeenCalledOnce();
  });
  it.each([
    "process.stdout.write('HTTP/1.1 200 OK\\r\\n\\r\\n');",
    "process.stdout.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: wrong\\r\\n\\r\\n');",
    "process.stdout.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');",
    "process.stdout.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');",
    "process.stdout.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\nSec-WebSocket-Extensions: permessage-deflate\\r\\n\\r\\n');",
    "process.stdout.write('x'.repeat(8193));",
  ])('rejects bad or oversized Upgrade responses', async (upgrade) => {
    const onClose = vi.fn(); const rpc = await createCodexObservedRpc(rpcOptions(await webSocketProxy({ upgrade }), { onClose }));
    await expect(rpc.request('initialize', {})).rejects.toThrow(/disconnected/); await rpc.close(); expect(onClose).toHaveBeenCalledOnce();
  });
  it('accepts fragmented UTF8 text with interleaved ping/pong and coalesced notifications', async () => {
    const frames = path.join(await root(), 'frames.jsonl'); const onMessage = vi.fn();
    const bin = await webSocketProxy({ onMessage: `
      const payload = Buffer.from(JSON.stringify({ id: message.id, result: { text: '😀' } }));
      const cut = payload.indexOf(Buffer.from('😀')) + 1;
      process.stdout.write(Buffer.concat([frame(1, payload.subarray(0, cut), false), frame(9, 'ping'), frame(0, payload.subarray(cut)), frame(10, 'unsolicited'), frame(1, JSON.stringify({ method: 'notice', params: {} }))]));
    ` });
    const rpc = await createCodexObservedRpc(rpcOptions(bin, { onMessage, env: { FRAMES: frames } }));
    try {
      expect(await rpc.request('initialize', {})).toEqual({ text: '😀' });
      await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith({ method: 'notice', params: {} }));
      await vi.waitFor(async () => expect((await readFile(frames, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))).toContainEqual({ opcode: 10, payload: 'ping', masked: true }));
    } finally { await rpc.close(); }
  });
  it('handles split Upgrade/frame headers and both extended-length encodings in each direction', async () => {
    const bin = await webSocketProxy({
      upgrade: "const upgrade = Buffer.from('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n'); process.stdout.write(upgrade.subarray(0, 20)); setTimeout(() => process.stdout.write(upgrade.subarray(20)), 10);",
      onMessage: `const outgoing = frame(1, JSON.stringify({id:message.id,result:{text:message.params.text}})); process.stdout.write(outgoing.subarray(0,1)); setTimeout(() => process.stdout.write(outgoing.subarray(1,6)),10); setTimeout(() => process.stdout.write(outgoing.subarray(6)),20);`,
    });
    const rpc = await createCodexObservedRpc(rpcOptions(bin));
    try {
      for (const length of [200, 70000]) {
        const text = 'x'.repeat(length);
        expect(await rpc.request('echo', { text })).toEqual({ text });
      }
    } finally { await rpc.close(); }
  });
  it('correlates multiple responses coalesced in one byte write', async () => {
    const bin = await webSocketProxy({ onOpen: 'global.messages = [];', onMessage: `
      global.messages.push(message); if (global.messages.length === 2) process.stdout.write(Buffer.concat(global.messages.reverse().map(x => frame(1, JSON.stringify({id:x.id,result:{method:x.method}})))));
    ` });
    const rpc = await createCodexObservedRpc(rpcOptions(bin));
    try { expect(await Promise.all([rpc.request('first', {}), rpc.request('second', {})])).toEqual([{ method: 'first' }, { method: 'second' }]); }
    finally { await rpc.close(); }
  });
  it.each([
    "const x=frame(1,'{}'); x[1]|=128; process.stdout.write(x);", // masked server
    "const x=frame(1,'{}'); x[0]|=64; process.stdout.write(x);", // unnegotiated RSV
    "process.stdout.write(frame(2,'{}'));", // binary
    "process.stdout.write(frame(0,'{}'));", // unexpected continuation
    "process.stdout.write(frame(9,'ping',false));", // fragmented control
    "process.stdout.write(frame(9,Buffer.alloc(126)));", // oversized control
    "process.stdout.write(Buffer.from([129,126,0,1,123]));", // non-canonical length
    "const x=Buffer.alloc(10); x[0]=129; x[1]=127; x.writeBigUInt64BE(1048577n,2); process.stdout.write(x);", // oversized before payload
    "process.stdout.write(frame(1,Buffer.from([255])));", // invalid UTF8
    "process.stdout.write(Buffer.concat([frame(1,'{',false),frame(1,'{}')]));", // interleaving
    "process.stdout.write(Buffer.concat([frame(1,Buffer.alloc(600000),false),frame(0,Buffer.alloc(600000))]));", // fragmented aggregate bound
    "process.stdout.write(Buffer.concat(Array.from({length:1025},(_,i)=>frame(i===0?1:0,'',false))));", // fragment count
    "process.stdout.write(frame(8,Buffer.from([0])));", // invalid close payload
  ])('rejects invalid, unsupported or oversized WebSocket frames', async (onMessage) => {
    const onClose = vi.fn(); const rpc = await createCodexObservedRpc(rpcOptions(await webSocketProxy({ onMessage }), { onClose }));
    await expect(rpc.request('initialize', {})).rejects.toThrow(/disconnected/); await rpc.close(); expect(onClose).toHaveBeenCalledOnce();
  });
  it('handles a server close and returns a masked close acknowledgment', async () => {
    const frames = path.join(await root(), 'frames.jsonl'); const onClose = vi.fn();
    const bin = await webSocketProxy({ onMessage: "process.stdout.write(frame(8,Buffer.from([3,232])));" });
    const rpc = await createCodexObservedRpc(rpcOptions(bin, { onClose, env: { FRAMES: frames } }));
    const child = vi.mocked(childProcess.spawn).mock.results.at(-1)!.value;
    const writes = vi.spyOn(child.stdin!, 'write');
    await expect(rpc.request('initialize', {})).rejects.toThrow(/disconnected/); await rpc.close(); expect(onClose).toHaveBeenCalledOnce();
    const acknowledgment = writes.mock.calls.map(([bytes]) => bytes as Buffer).find(bytes => bytes[0] === 0x88)!;
    expect(acknowledgment).toBeDefined();
    expect(acknowledgment.length).toBe(8);
    expect(acknowledgment[1]).toBe(0x82);
    expect([acknowledgment[6]! ^ acknowledgment[2]!, acknowledgment[7]! ^ acknowledgment[3]!]).toEqual([3, 232]);
    // Windows terminates the child immediately. Its receipt cannot be observed
    // after termination; POSIX lets this fixture flush its peer-side audit.
    if (process.platform !== 'win32') expect((await readFile(frames, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).opcode)).toContain(8);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
  it('bounds outbound payloads and queued writes', async () => {
    const bin = await webSocketProxy({ onMessage: "send({id:message.id,result:{ok:true}}); process.stdin.pause();" });
    const rpc = await createCodexObservedRpc(rpcOptions(bin));
    expect(await rpc.request('initialize', {})).toEqual({ ok: true });
    await expect(rpc.respond('native', { text: 'x'.repeat(1024 * 1024) })).rejects.toThrow(/limit/);
    const first = rpc.notify('notice', { text: 'x'.repeat(700000) }); const firstResult = first.catch((error: Error) => error);
    await expect(rpc.notify('notice', { text: 'x'.repeat(700000) })).rejects.toThrow(/limit/);
    await rpc.close(); await firstResult;
  });
  it('times out unanswered RPC and closes its owned proxy', async () => {
    const bin = await webSocketProxy({ onMessage: '' }); const onClose = vi.fn();
    const rpc = await createCodexObservedRpc(rpcOptions(bin, { onClose }));
    // Ensure Upgrade finishes before advancing only the RPC deadline.
    await rpc.notify('initialized', {}); vi.useFakeTimers();
    const request = rpc.request('initialize', {}); const rejection = expect(request).rejects.toThrow(/disconnected/);
    await vi.advanceTimersByTimeAsync(10_000); await rejection; vi.useRealTimers(); await rpc.close(); expect(onClose).toHaveBeenCalledOnce();
  });
  it('times out Upgrade and allows close during an incomplete handshake', async () => {
    const bin = await executable('process.stdin.resume();'); const onClose = vi.fn();
    const rpc = await createCodexObservedRpc(rpcOptions(bin, { onClose }));
    vi.useFakeTimers(); const request = rpc.request('initialize', {}); const rejection = expect(request).rejects.toThrow(/disconnected/);
    await vi.advanceTimersByTimeAsync(10_000); await rejection; vi.useRealTimers(); await rpc.close(); expect(onClose).toHaveBeenCalledOnce();
    const early = await createCodexObservedRpc(rpcOptions(bin)); await early.close();
    await expect(early.request('initialize', {})).rejects.toThrow(/unavailable/);
  });
});

describe.skipIf(process.platform === 'win32')('observed Codex native predictions', () => {
  const finish = (f: Awaited<ReturnType<typeof fixture>>, status = 'completed') => f.emit({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status } } });
  const prediction = (text: unknown, extra: Record<string, unknown> = {}) => ({ method: 'thread/prediction/updated', params: { threadId: 'native-thread', sourceTurnId: 'turn-1', result: { type: 'completed', text }, ...extra } });
  it('harvests an existing native prediction for the exact successful completed turn without another RPC', async () => {
    const f = await fixture(); await f.connect(); finish(f);
    const count = f.request.mock.calls.length;
    f.emit(prediction('  Inspect the final diff  '));
    const ready = f.control.suggestions();
    expect(ready).toMatchObject({ state: 'ready', prompts: ['Inspect the final diff'], origin: 'harness', canRequest: false });
    await f.control.requestSuggestions(ready.anchor!);
    expect(f.request.mock.calls).toHaveLength(count);
    f.emit(prediction('A duplicate result'));
    expect(f.control.suggestions()).toEqual(ready);
  });
  it('harvests native failure as unavailable and does not retry the same completed turn', async () => {
    const f = await fixture(); await f.connect(); finish(f);
    f.emit(prediction(undefined, { result: { type: 'failed' } }));
    const state = f.control.suggestions();
    expect(state).toMatchObject({ state: 'unavailable', prompts: [], canRequest: false });
    await f.control.requestSuggestions(state.anchor!);
    expect(f.request.mock.calls.some(([method]) => method === 'thread/prediction/request')).toBe(false);
  });
  it('ignores unsolicited unknown, foreign, stale, active and private predictions', async () => {
    const f = await fixture(); await f.connect();
    f.emit(prediction('Still active')); expect(f.control.suggestions().prompts).toEqual([]);
    finish(f);
    f.emit(prediction('Foreign source', { threadId: 'another-thread' }));
    f.emit(prediction('Unknown turn', { sourceTurnId: 'unknown-turn' }));
    expect(f.control.suggestions()).toMatchObject({ state: 'unavailable', canRequest: true, prompts: [] });
    f.control.setSuggestionsPrivacy(true); f.emit(prediction('Private source'));
    expect(f.control.suggestions()).toMatchObject({ state: 'private', canRequest: false, prompts: [] });
    f.control.setSuggestionsPrivacy(false);
    expect(f.control.suggestions()).toMatchObject({ state: 'unavailable', canRequest: true, prompts: [] });
    f.emit({ method: 'turn/started', params: { threadId: 'native-thread', turn: { id: 'turn-2' } } });
    f.emit({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-2', status: 'completed' } } });
    f.emit(prediction('Old turn'));
    expect(f.control.suggestions()).toMatchObject({ state: 'unavailable', canRequest: true, prompts: [] });
    expect(f.request.mock.calls.some(([method]) => method === 'thread/prediction/request')).toBe(false);
  });
  it('requires an existing attachment and a successful completed turn, with one exact request per anchor', async () => {
    const f = await fixture();
    expect(await f.control.requestSuggestions('unknown')).toMatchObject({ state: 'unavailable', canRequest: false });
    expect(f.factory).not.toHaveBeenCalled();
    await f.connect(); expect(f.control.suggestions()).toMatchObject({ canRequest: false, prompts: [] });
    finish(f); const before = f.request.mock.calls.length;
    const anchor = f.control.suggestions().anchor!;
    const first = f.control.requestSuggestions(anchor);
    expect(f.control.suggestions()).toMatchObject({ anchor, state: 'pending', canRequest: false });
    await f.control.requestSuggestions(anchor); await first;
    expect(f.request.mock.calls.slice(before)).toEqual([['thread/prediction/request', { threadId: 'native-thread', sourceTurnId: 'turn-1' }]]);
    f.emit(prediction('  Review the resulting changes  '));
    expect(f.control.suggestions()).toMatchObject({ state: 'ready', prompts: ['Review the resulting changes'], origin: 'harness', canRequest: false });
    finish(f); await f.control.requestSuggestions(anchor);
    expect(f.request.mock.calls.slice(before)).toHaveLength(1);
  });
  it('ignores foreign sources, new-turn updates and late callbacks from an old connection', async () => {
    const f = await fixture(); await f.connect(); finish(f);
    await f.control.requestSuggestions(f.control.suggestions().anchor!);
    f.emit(prediction('Foreign', { threadId: 'another-thread' })); f.emit(prediction('Old', { sourceTurnId: 'another-turn' }));
    expect(f.control.suggestions().state).toBe('pending');
    const old = f.factory.mock.calls[0]![0];
    f.emit({ method: 'turn/started', params: { threadId: 'native-thread', turn: { id: 'turn-2' } } });
    f.emit(prediction('Stale')); expect(f.control.suggestions()).toMatchObject({ state: 'unavailable', prompts: [], canRequest: false });
    await f.connect(); old.onMessage(prediction('Old connection'));
    expect(f.control.suggestions().prompts).toEqual([]);
  });
  it.each(['failed', 'interrupted'])('does not predict %s turns', async status => {
    const f = await fixture(); await f.connect(); finish(f, status);
    expect(f.control.suggestions()).toMatchObject({ state: 'unavailable', canRequest: false });
    expect(f.request.mock.calls.some(([method]) => method === 'thread/prediction/request')).toBe(false);
  });
  it.each([null, '', 'x'.repeat(241), 'Two\nlines', 'A\u2028line', 1])('drops malformed or oversized prediction text without truncation %#', async text => {
    const f = await fixture(); await f.connect(); finish(f); await f.control.requestSuggestions(f.control.suggestions().anchor!);
    f.emit(prediction(text)); expect(f.control.suggestions()).toMatchObject({ state: 'unavailable', prompts: [], canRequest: false });
  });
  it('redacts credential-like content, supports failed results and invalidates on thread close', async () => {
    const f = await fixture(); await f.connect(); finish(f); await f.control.requestSuggestions(f.control.suggestions().anchor!);
    f.emit(prediction('Rotate api_key=example-secret-value'));
    expect(f.control.suggestions().prompts).toEqual(['Rotate api_key=[redacted]']);
    f.emit({ method: 'thread/closed', params: { threadId: 'native-thread' } });
    expect(f.control.suggestions()).toMatchObject({ state: 'unavailable', prompts: [], canRequest: false });
  });
  it('fails unsupported requests once and bounds notification waits', async () => {
    const f = await fixture(); await f.connect(); finish(f);
    const original = f.rpc.request;
    f.rpc.request = vi.fn(async (method, params) => { if (method === 'thread/prediction/request') throw new Error('Method not found'); return original(method, params); });
    const anchor = f.control.suggestions().anchor!;
    expect(await f.control.requestSuggestions(anchor)).toMatchObject({ state: 'unsupported', canRequest: false });
    await f.control.requestSuggestions(anchor); expect(f.rpc.request).toHaveBeenCalledOnce();
    const g = await fixture(); await g.connect(); finish(g);
    await g.control.requestSuggestions(g.control.suggestions().anchor!); vi.useFakeTimers();
    // Install the timer while fake timers are active on a second completed turn.
    g.emit({ method: 'turn/started', params: { threadId: 'native-thread', turn: { id: 'turn-2' } } });
    g.emit({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-2', status: 'completed' } } });
    await g.control.requestSuggestions(g.control.suggestions().anchor!); await vi.advanceTimersByTimeAsync(10_000);
    expect(g.control.suggestions()).toMatchObject({ state: 'unavailable', canRequest: false, prompts: [] });
  });
});

describe.skipIf(process.platform === 'win32')('prediction-only privacy', () => {
  it('drops late prediction text and blocks requests without changing control or active approvals', async () => {
    const f = await fixture(); await f.connect();
    f.emit({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
    const anchor = f.control.suggestions().anchor!;
    await f.control.requestSuggestions(anchor);
    f.control.setSuggestionsPrivacy(true);
    f.emit({ method: 'thread/prediction/updated', params: { threadId: 'native-thread', sourceTurnId: 'turn-1', result: { type: 'completed', text: 'Private late text' } } });
    expect(await f.control.requestSuggestions(anchor)).toMatchObject({ state: 'private', prompts: [], canRequest: false });
    expect(f.control.status()).toMatchObject({ state: 'connected', canSend: true });
    expect(f.rpc.close).not.toHaveBeenCalled();
    f.control.setSuggestionsPrivacy(false);
    expect(f.control.suggestions()).toMatchObject({ state: 'unavailable', prompts: [], canRequest: false });
    f.emit({ method: 'turn/started', params: { threadId: 'native-thread', turn: { id: 'turn-1' } } }); f.emit(approval());
    const before = f.control.status(); f.control.setSuggestionsPrivacy(true);
    expect(f.control.status()).toEqual(before);
  });
});

describe.skipIf(process.platform === 'win32')('observed native activity invalidation', () => {
  it('reports attached active work once and repeats only for newly verified work', async () => {
    const onActivity = vi.fn(); const f = await fixture({ onActivity }); await f.connect();
    expect(onActivity).toHaveBeenCalledOnce();
    const status = (type: string) => f.emit({ method: 'thread/status/changed', params: { threadId: 'native-thread', status: { type } } });
    const start = (id: string) => f.emit({ method: 'turn/started', params: { threadId: 'native-thread', turn: { id } } });
    status('active'); start('turn-1'); status('active');
    f.emit({ method: 'item/started', params: { threadId: 'native-thread', turnId: 'turn-1', item: { id: 'read-item', type: 'commandExecution' } } });
    expect(onActivity).toHaveBeenCalledOnce();
    start('turn-2'); expect(onActivity).toHaveBeenCalledTimes(2);
    f.emit({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-2', status: 'completed' } } });
    status('active'); expect(onActivity).toHaveBeenCalledTimes(3);
    start('turn-3'); status('active'); expect(onActivity).toHaveBeenCalledTimes(3);
  });
  it('reports a successful idle turn admission without requiring a source notification', async () => {
    const onActivity = vi.fn(); const f = await fixture({ status: 'idle', onActivity }); await f.connect();
    expect(onActivity).not.toHaveBeenCalled();
    await f.control.send({ connectionId: connection(f.control), text: 'Inspect the current result' });
    expect(onActivity).toHaveBeenCalledOnce();
    f.emit({ method: 'turn/started', params: { threadId: 'native-thread', turn: { id: 'turn-new' } } });
    expect(onActivity).toHaveBeenCalledOnce();
  });
});
