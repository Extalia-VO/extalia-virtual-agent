import * as childProcess from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexQueueError, queueCodexMessage } from '../src/codexQueue.js';

const fixtureSources = vi.hoisted(() => new Map<string, string>());
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn((bin: string, args: string[], options: childProcess.SpawnOptions) => {
    const source = fixtureSources.get(bin);
    return source ? actual.spawn(process.execPath, [source, ...args], options) : actual.spawn(bin, args, options);
  }) };
});

const roots: string[] = [];
const threadId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';
afterEach(async () => {
  fixtureSources.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(body = `process.stdout.write('Queued message ${messageId} for thread ${threadId}.\\n');`) {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-codex-queue-')); roots.push(root);
  const bin = path.join(root, 'codex-fixture');
  const source = path.join(root, 'fixture.mjs');
  const capture = path.join(root, 'capture.json');
  const ready = path.join(root, 'ready');
  await writeFile(source, `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.CAPTURE, JSON.stringify({ args:process.argv.slice(2), home:process.env.HOME, codexHome:process.env.CODEX_HOME, pid:process.pid }));\n${body}\n`);
  // Run the actual Node child on every OS; only substitute the fixture launcher.
  fixtureSources.set(bin, source);
  return { bin, capture, ready, env: { HOME: root, CODEX_HOME: root, CAPTURE: capture, READY: ready }, threadId, text: 'hello' };
}

describe('public Codex text queue', () => {
  it('uses exact literal queue arguments and the supplied profile without resume or a shell', async () => {
    const f = await fixture();
    const text = 'hello\n$(touch /tmp/should-not-run) `echo no` --resume "quoted"';
    expect(await queueCodexMessage({ ...f, text })).toEqual({ state: 'queued', messageId });
    expect(childProcess.spawn).toHaveBeenLastCalledWith(f.bin, ['queue', '--thread', threadId, '--message', text], expect.objectContaining({ shell: false, env: f.env }));
    const captured = JSON.parse(await readFile(f.capture, 'utf8'));
    expect(captured).toMatchObject({ args: ['queue', '--thread', threadId, '--message', text], home: f.env.HOME, codexHome: f.env.CODEX_HOME });
  });
  it.each(['name', '--resume', '../thread', `${threadId}\n`, ''])('rejects non-UUID targets before execution: %j', async (value) => {
    const f = await fixture();
    await expect(queueCodexMessage({ ...f, threadId: value })).rejects.toThrow(/UUID/);
    await expect(readFile(f.capture)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['', ' ', 'x'.repeat(16_001), 'before\0after'])('rejects invalid text before execution', async (text) => {
    const f = await fixture();
    await expect(queueCodexMessage({ ...f, text })).rejects.toThrow(/text/);
    await expect(readFile(f.capture)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    `Queued message ${messageId} for thread 33333333-3333-4333-8333-333333333333.`,
    `Queued message not-a-uuid for thread ${threadId}.`,
    'success', '', `queued message ${messageId} for thread ${threadId}.`,
    `Queued message ${messageId} for thread ${threadId}.\nUnexpected extra output`,
  ])('preserves unknown delivery for a noncanonical successful response', async (output) => {
    const f = await fixture(`process.stdout.write(${JSON.stringify(output)});`);
    expect(await queueCodexMessage(f)).toEqual({ state: 'unknown' });
  });
  it('sanitizes nonzero failure even after a success-shaped acknowledgment', async () => {
    const f = await fixture(`process.stdout.write('Queued message ${messageId} for thread ${threadId}.'); process.stderr.write('private-provider-detail'); process.exitCode=1;`);
    await expect(queueCodexMessage(f)).rejects.toMatchObject({ name: 'CodexQueueError', state: 'unknown', message: expect.not.stringContaining('private-provider-detail') });
  });
  it('sanitizes spawn failure and never falls back to another command', async () => {
    const f = await fixture();
    await expect(queueCodexMessage({ ...f, bin: path.join(f.env.HOME, 'missing') })).rejects.toBeInstanceOf(CodexQueueError);
    await expect(readFile(f.capture)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['stdout', 'stderr'])('bounds %s output and reaps the owned child', async (stream) => {
    const f = await fixture(`process.${stream}.write('x'.repeat(8193)); setInterval(()=>{},1000);`);
    await expect(queueCodexMessage(f)).rejects.toMatchObject({ state: 'unknown' });
    const { pid } = JSON.parse(await readFile(f.capture, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('does not launch when already cancelled', async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    await expect(queueCodexMessage({ ...f, signal: controller.signal })).rejects.toThrow(/before submission/);
    await expect(readFile(f.capture)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('cancels an unresponsive owned child and confirms its exit', async () => {
    const f = await fixture(`process.on('SIGTERM',()=>{}); writeFileSync(process.env.READY,'signal-handler-installed'); setInterval(()=>{},1000);`);
    const controller = new AbortController();
    const result = queueCodexMessage({ ...f, signal: controller.signal }).catch((error: unknown) => error);
    await vi.waitFor(async () => expect(await readFile(f.ready, 'utf8')).toBe('signal-handler-installed'));
    const kill = vi.spyOn(vi.mocked(childProcess.spawn).mock.results.at(-1)!.value, 'kill');
    controller.abort();
    expect(await result).toMatchObject({ state: 'unknown', cleanupUnconfirmed: false });
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    if (process.platform !== 'win32') expect(kill).toHaveBeenCalledWith('SIGKILL');
    const { pid } = JSON.parse(await readFile(f.capture, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('times out, reaps the owned command, and does not retry', async () => {
    const f = await fixture('setInterval(()=>{},1000);');
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockClear();
    await expect(queueCodexMessage(f, { timeoutMs: 500 })).rejects.toMatchObject({ state: 'unknown', cleanupUnconfirmed: false });
    expect(spawn).toHaveBeenCalledOnce();
    // Node may time out before fixture JS writes capture.json. The actual
    // spawned handle still identifies the owned command and its observed exit.
    const child = spawn.mock.results[0]!.value;
    expect(child.pid).toBeGreaterThan(0);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });
});
