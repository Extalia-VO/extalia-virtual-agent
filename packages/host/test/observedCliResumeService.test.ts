import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObservedCliFamily } from '@extalia/platform';
import { ObservedCliResumeService, type ObservedCliResumeTarget } from '../src/observedCliResumeService.js';

class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  input = ''; kill = vi.fn(() => true);
  constructor() { super(); this.stdin.on('data', chunk => { this.input += chunk.toString(); }); }
  send(value: unknown) { this.stdout.write(`${JSON.stringify(value)}\n`); }
  close(code = 0) { this.stdout.end(); this.stderr.end(); this.emit('close', code, null); }
}
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(work => work())); });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const settled = async (service: ObservedCliResumeService) => { await expect.poll(() => service.isBusy(), { timeout: 5000 }).toBe(false); };
async function fixture(family: ObservedCliFamily = 'codex') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'extalia-resume-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'official-cli');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  let target: ObservedCliResumeTarget | undefined = { family, sourceId: family, nativeSessionId: 'original-native-id', fingerprint: 'original-source', revision: 'generation-one', watching: true, idle: true, cwd: directory, profilePath: path.join(directory, '.profile'), model: 'original-model' };
  const children: FakeChild[] = [];
  let failSpawn = false;
  const spawnMock = vi.fn((_command: string, args: readonly string[]) => {
    if (failSpawn && !args.includes('--version')) throw new Error('secret transport error');
    const child = new FakeChild();
    if (args.includes('--version')) queueMicrotask(() => { child.emit('spawn'); child.stdout.write(`${family} 1.2.3\n`); child.close(); });
    else { children.push(child); queueMicrotask(() => child.emit('spawn')); }
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const options = { file: path.join(directory, 'resume.json'), homeDirectory: directory,
    env: { PATH: '', [`EXTALIA_${family.toUpperCase()}_BIN`]: executable, CODEX_API_KEY: 'codex-secret', ANTHROPIC_AUTH_TOKEN: 'claude-secret', GEMINI_API_KEY: 'gemini-secret', EXTALIA_SECRET: 'unrelated-secret' },
    target: async () => target, archiveCommand: async () => ({ command: executable, args: ['archive-reader'] }), spawn: spawnMock as unknown as typeof spawn };
  const service = new ObservedCliResumeService(options);
  const pair = async () => { const preview = await service.preview('observed-one'); return service.pair('observed-one', { reviewId: preview.reviewId, exclusiveOwnerConfirmed: true }); };
  const dispatch = async (operationId = 'operation-one') => service.dispatch('observed-one', { action: 'start', text: 'Continue exactly where work stopped.', operationId }, (await service.driverStatus('observed-one'))!);
  return { service, options, pair, dispatch, children, spawnMock, executable, target: () => target!, setTarget: (value: ObservedCliResumeTarget | undefined) => { target = value; }, failSpawn: () => { failSpawn = true; } };
}

describe('reviewed official CLI resumes', () => {
  it('reviews configured request model separately and refuses a changed selection before pairing', async () => {
    const f = await fixture('claude');
    f.setTarget({ ...f.target(), model: 'canonical-reply-name', resumeModel: 'example-route/configured-model', resumeModelSource: 'profile' });
    const preview = await f.service.preview('observed-one');
    expect(preview).toMatchObject({ model: 'canonical-reply-name', resumeModel: 'example-route/configured-model', resumeModelSource: 'profile' });
    expect(preview.arguments).toContain('example-route/configured-model');
    expect(preview.arguments).not.toContain('canonical-reply-name');
    f.setTarget({ ...f.target(), resumeModel: 'example-route/changed-model' });
    await expect(f.service.pair('observed-one', { reviewId: preview.reviewId, exclusiveOwnerConfirmed: true })).rejects.toThrow();
    expect(f.children).toHaveLength(0);
    await f.service.close();
  });

  it('status is read-only and pairing requires the exact reviewed idle source', async () => {
    const f = await fixture();
    expect((await f.service.status('observed-one')).state).toBe('disconnected');
    expect(f.spawnMock).not.toHaveBeenCalled();
    const preview = await f.service.preview('observed-one');
    await expect(f.service.pair('observed-one', { reviewId: preview.reviewId, exclusiveOwnerConfirmed: false })).rejects.toThrow();
    f.setTarget({ ...f.target(), revision: 'replacement' });
    await expect(f.service.pair('observed-one', { reviewId: preview.reviewId, exclusiveOwnerConfirmed: true })).rejects.toThrow();
    expect(f.children).toHaveLength(0);
  });
  it('journals before spawn, resumes only the exact ID, and deduplicates while retaining ownership', async () => {
    const f = await fixture(); await f.pair();
    const snapshot = (await f.service.driverStatus('observed-one'))!;
    const input = { action: 'start' as const, text: 'Continue exactly where work stopped.', operationId: 'operation-one' };
    expect(await f.service.dispatch('observed-one', input, snapshot)).toEqual({ state: 'queued' });
    await tick();
    expect(JSON.parse(await readFile(f.options.file, 'utf8')).bindings[0].journals[0].state).toBe('inflight');
    expect(await f.service.dispatch('observed-one', input, snapshot)).toEqual({ state: 'queued' });
    await expect(f.service.dispatch('observed-one', { ...input, operationId: 'different-operation' }, snapshot)).rejects.toThrow();
    expect(f.children).toHaveLength(1); expect(f.service.isBusy()).toBe(true);
    const invocation = f.spawnMock.mock.calls.at(-1)!;
    expect(invocation[1]).toContain('original-native-id'); expect(invocation[1]).not.toContain('--last');
    const child = f.children[0]!;
    child.send({ type: 'thread.started', thread_id: 'original-native-id' }); child.send({ type: 'turn.completed' });
    expect(f.service.isBusy()).toBe(true);
    child.close(); await settled(f.service);
    expect(f.service.isBusy()).toBe(false);
    expect((await f.service.status('observed-one')).lastOutcome).toBe('completed');
    expect(await f.service.dispatch('observed-one', input, snapshot)).toEqual({ state: 'resolved' });
  });
  it('refuses stale executable and generation before spawning a resume', async () => {
    const f = await fixture(); await f.pair();
    const snapshot = (await f.service.driverStatus('observed-one'))!;
    f.setTarget({ ...f.target(), revision: 'replacement' });
    await expect(f.service.dispatch('observed-one', { action: 'start', text: 'Continue', operationId: 'operation-one' }, snapshot)).rejects.toThrow();
    f.setTarget({ ...f.target(), revision: 'generation-one' });
    await writeFile(f.executable, '#!/bin/sh\nexit 1\n');
    await expect(f.dispatch()).rejects.toThrow('executable changed');
    expect(f.children).toHaveLength(0);
  });
  it('records positive failure before effect and never exposes raw spawn errors', async () => {
    const f = await fixture(); await f.pair(); f.failSpawn();
    await expect(f.dispatch()).rejects.toThrow('could not be started');
    expect((await f.service.status('observed-one')).lastOutcome).toBe('failed');
    expect(JSON.stringify(await f.service.status('observed-one'))).not.toContain('secret transport');
    expect(f.service.isBusy()).toBe(false);
  });
  it('marks wrong native identity uncertain; dropping cannot bypass reconciliation', async () => {
    const f = await fixture(); await f.pair(); await f.dispatch(); await tick();
    const child = f.children[0]!;
    child.send({ type: 'thread.started', thread_id: 'wrong-native-id' }); child.send({ type: 'turn.completed' });
    expect(child.kill).toHaveBeenCalled(); child.close(); await settled(f.service);
    expect((await f.service.status('observed-one')).state).toBe('uncertain');
    await f.service.drop('observed-one');
    await expect(f.service.preview('observed-one')).rejects.toThrow();
    await expect(f.service.reconcile('observed-one', { operationId: 'operation-one', inspected: false })).rejects.toThrow();
    f.setTarget({ ...f.target(), revision: 'new-history-after-failed-turn', model: 'updated-model' });
    await f.service.reconcile('observed-one', { operationId: 'operation-one', inspected: true });
    expect(await f.service.status('observed-one')).toMatchObject({ state: 'disconnected', lastOutcome: 'unknown' });
    const restored = new ObservedCliResumeService(f.options);
    expect(await restored.status('observed-one')).toMatchObject({ state: 'disconnected', lastOutcome: 'unknown' });
    const input = { action: 'start' as const, text: 'Continue exactly where work stopped.', operationId: 'operation-one' };
    expect(await restored.dispatch('observed-one', input, { bindingId: 'old', generation: 'old', actions: ['start'] })).toEqual({ state: 'unknown' });
    const preview = await restored.preview('observed-one');
    await restored.pair('observed-one', { reviewId: preview.reviewId, exclusiveOwnerConfirmed: true });
    expect(await restored.dispatch('observed-one', input, (await restored.driverStatus('observed-one'))!)).toEqual({ state: 'unknown' });
    expect(f.children).toHaveLength(1);
  });
  it('fences aliases of the same native conversation while running and after uncertainty', async () => {
    const f = await fixture(); await f.pair();
    const second = await f.service.preview('observed-alias');
    await f.service.pair('observed-alias', { reviewId: second.reviewId, exclusiveOwnerConfirmed: true });
    await f.dispatch(); await tick();
    expect((await f.service.status('observed-alias')).state).toBe('unavailable');
    await expect(f.service.preview('observed-alias')).rejects.toThrow();
    f.children[0]!.close(1); await settled(f.service);
    expect((await f.service.status('observed-alias')).state).toBe('uncertain');
    await expect(f.service.preview('observed-alias')).rejects.toThrow();
  });
  it('restores an unfinished journal as uncertain without spawning or replaying', async () => {
    const f = await fixture(); await f.pair(); await f.dispatch(); await tick();
    const restored = new ObservedCliResumeService(f.options);
    expect((await restored.status('observed-one')).state).toBe('uncertain');
    await expect(restored.preview('observed-one')).rejects.toThrow();
    expect(f.children).toHaveLength(1);
    const close = f.service.close(); await tick(); f.children[0]!.close(); await close;
  });
  it.each(['drop', 'close'] as const)('holds the owned-child lock until actual close during %s', async method => {
    const f = await fixture(); await f.pair(); await f.dispatch(); await tick();
    let done = false;
    const shutdown = (method === 'drop' ? f.service.drop('observed-one') : f.service.close()).then(() => { done = true; });
    await tick(); expect(done).toBe(false); expect(f.service.isBusy()).toBe(true); expect(f.children[0]!.kill).toHaveBeenCalled();
    f.children[0]!.close(); await shutdown; expect(f.service.isBusy()).toBe(false);
  });
  it('loads Gemini through ACP using the same session and cancels unsupported native approval requests', async () => {
    const f = await fixture('gemini'); await f.pair(); await f.dispatch(); await tick();
    const child = f.children[0]!;
    expect(child.input).toContain('initialize');
    child.send({ jsonrpc: '2.0', id: 1, result: { agentCapabilities: { loadSession: true } } });
    const load = child.input.trim().split('\n').map(v => JSON.parse(v)).find(v => v.method === 'session/load');
    expect(load.params).toMatchObject({ sessionId: 'original-native-id', cwd: f.target().cwd, mcpServers: [{ name: 'extalia_handover' }] });
    expect(child.input).not.toContain('session/new');
    child.send({ jsonrpc: '2.0', id: 2, result: {} });
    expect(child.input).toContain('session/prompt');
    child.send({ jsonrpc: '2.0', id: 42, method: 'session/request_permission', params: { sessionId: 'original-native-id', options: [{ optionId: 'allow', kind: 'allow_once' }] } });
    expect(child.input).toContain('"outcome":{"outcome":"cancelled"}');
    child.send({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } }); child.close(); await settled(f.service);
    expect((await f.service.status('observed-one')).lastOutcome).toBe('completed');
  });
  it('does not accept a success event without native identity or malformed stream', async () => {
    const f = await fixture('claude'); await f.pair(); await f.dispatch(); await tick();
    const child = f.children[0]!;
    child.send({ type: 'result', subtype: 'success', is_error: false }); child.stdout.write('not-json\n'); child.close(); await settled(f.service);
    expect((await f.service.status('observed-one')).state).toBe('uncertain');
  });
});
