import * as childProcess from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexNativeQueueError, readCodexNativeQueue } from '../src/codexNativeQueue.js';

const fixtureSources = vi.hoisted(() => new Map<string, string>());
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn((bin: string, args: string[], options: childProcess.SpawnOptions) => {
    const source = fixtureSources.get(bin);
    return source ? actual.spawn(process.execPath, [source, ...args], options) : actual.spawn(bin, args, options);
  }) };
});
const roots: string[] = [], threadId = '11111111-1111-4111-8111-111111111111';
afterEach(async () => { fixtureSources.clear(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const row = (input: unknown[] = [{ type: 'text', text: 'waiting prompt' }], id = 'queue-one') => ({ id, clientUserMessageId: `message-${id}`, input });
async function fixture(reply = `send({id:2,result:{data:[${JSON.stringify(row())}]}});`, setup = '') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'extalia-native-queue-'))); roots.push(root);
  await mkdir(path.join(root, 'trusted-profile'));
  const bin = path.join(root, 'fixture-codex'), source = path.join(root, 'fixture.mjs'), capture = path.join(root, 'capture.jsonl');
  await writeFile(source, `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
appendFileSync(process.env.CAPTURE,JSON.stringify({pid:process.pid,args:process.argv.slice(2),home:process.env.HOME,codexHome:process.env.CODEX_HOME,cwd:process.cwd()})+'\\n');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
${setup}
createInterface({input:process.stdin}).on('line',line=>{
const message=JSON.parse(line); appendFileSync(process.env.CAPTURE,JSON.stringify(message)+'\\n');
if(message.method==='initialize')send({id:1,result:{userAgent:'fixture'}});
if(message.method==='thread/queue/list'){${reply}}
});`);
  fixtureSources.set(bin, source);
  return { bin, codexHome: path.join(root, 'trusted-profile'), env: { HOME: root, CODEX_HOME: path.join(root, 'wrong-profile'), CAPTURE: capture }, cwd: root, threadId, capture };
}
async function captured(file: string) { return (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
function expectReaped(pid: number) { expect(() => process.kill(pid, 0)).toThrow(); }

describe('read-only public native Codex queue', () => {
  it('uses only initialize/initialized/queue-list and the exact supplied profile, then reaps the client', async () => {
    const f = await fixture();
    expect(await readCodexNativeQueue(f)).toEqual({ items: [{ id: 'queue-one', text: 'waiting prompt', nonTextItems: 0 }] });
    const [launch, ...messages] = await captured(f.capture);
    expect(launch).toMatchObject({ args: ['app-server', '--listen', 'stdio://'], home: f.env.HOME, codexHome: f.codexHome, cwd: f.cwd });
    expect(messages.map(message => message.method)).toEqual(['initialize', 'initialized', 'thread/queue/list']);
    expect(messages[0].params.capabilities).toEqual({ experimentalApi: true });
    expect(messages[2].params).toEqual({ threadId, limit: 50 });
    expectReaped(launch.pid);
  });
  it('joins text safely and counts attachments without exposing attachment metadata', async () => {
    const inputs = [{ type: 'text', text: '<b>first</b>', text_elements: [{ placeholder: 'hidden' }] }, { type: 'text', text: 'second' },
      { type: 'localImage', path: '/private/image.png' }, { type: 'image', fileId: 'private-file' }, { type: 'audio', url: 'https://example.com/private' },
      { type: 'localAudio', path: '/private/audio' }, { type: 'skill', name: 'private-name', path: '/private/skill' }, { type: 'mention', name: 'private-person', path: '/private/mention' },
      { type: 'image' }, { type: 'audio' }];
    const f = await fixture(`send({id:2,result:${JSON.stringify({ data: [row(inputs)] })}});`);
    expect(await readCodexNativeQueue(f)).toEqual({ items: [{ id: 'queue-one', text: '<b>first</b>\nsecond', nonTextItems: 8 }] });
  });
  it('uses the exact profile directory as cwd when the observed source has no workspace', async () => {
    const f = await fixture();
    await readCodexNativeQueue({ ...f, cwd: undefined });
    expect((await captured(f.capture))[0].cwd).toBe(f.codexHome);
  });
  it('bounds entries, text length and aggregate UTF-8 bytes, and marks hidden remaining pages', async () => {
    const data = Array.from({ length: 50 }, (_, index) => row([{ type: 'text', text: '😀'.repeat(8001) }], `queue-${index}`));
    const f = await fixture(`send({id:2,result:${JSON.stringify({ data, nextCursor: 'more' })}});`);
    const result = await readCodexNativeQueue(f);
    expect(result.items).toHaveLength(50); expect(result.truncated).toBe(true);
    expect(result.items[0]?.text).toHaveLength(16_000);
    expect(result.items.every(item => item.text.length <= 16_000 && !item.text.endsWith('\ud83d'))).toBe(true);
    expect(result.items.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0)).toBeLessThanOrEqual(256 * 1024);
    expect(result.items.at(-1)).toMatchObject({ text: '', truncated: true });
  });
  it.each([-32601, -32602])('distinguishes unsupported method/params without exposing error text (%i)', async code => {
    const f = await fixture(`send({id:2,error:{code:${code},message:'/private/provider-secret'}});`);
    await expect(readCodexNativeQueue(f)).rejects.toMatchObject({ state: 'unsupported', message: expect.not.stringContaining('provider-secret') });
    expectReaped((await captured(f.capture))[0].pid);
  });
  it.each([
    `send({id:2,result:{data:[{id:'x',clientUserMessageId:'m',input:[{type:'text'}]}]}});`,
    `send({id:2,result:{data:[${JSON.stringify(row())},${JSON.stringify(row())}]}});`,
    `send({id:2,result:{data:[],nextCursor:123}});`,
    `send({id:2,result:{data:Array(51).fill(${JSON.stringify(row())})}});`,
    `send({id:99,result:{data:[]}});`,
    `process.stdout.write('invalid-json\\n');`,
    `process.stdout.write(Buffer.from([255,10]));`,
  ])('fails closed on malformed responses without returning partial queue text', async reply => {
    const f = await fixture(reply);
    await expect(readCodexNativeQueue(f)).rejects.toBeInstanceOf(CodexNativeQueueError);
  });
  it('does not answer native callbacks or issue any follow-up request', async () => {
    const f = await fixture(`send({id:'approval',method:'item/permissions/requestApproval',params:{}}); setInterval(()=>{},1000);`);
    await expect(readCodexNativeQueue(f)).rejects.toMatchObject({ state: 'unavailable' });
    expect((await captured(f.capture)).slice(1).map(message => message.method)).toEqual(['initialize', 'initialized', 'thread/queue/list']);
  });
  it.each(['stdout', 'stderr'])('bounds %s and confirms watchdog cleanup', async stream => {
    const f = await fixture(`process.${stream}.write('x'.repeat(${stream === 'stdout' ? 2 * 1024 * 1024 + 1 : 64 * 1024 + 1})); setInterval(()=>{},1000);`);
    await expect(readCodexNativeQueue(f)).rejects.toMatchObject({ state: 'unavailable', cleanupUnconfirmed: false });
    expectReaped((await captured(f.capture))[0].pid);
  });
  it('times out an unresponsive reader without retrying and observes actual child exit', async () => {
    const f = await fixture('setInterval(()=>{},1000);');
    const spawn = vi.mocked(childProcess.spawn); spawn.mockClear();
    await expect(readCodexNativeQueue(f, { timeoutMs: 300 })).rejects.toMatchObject({ state: 'unavailable', cleanupUnconfirmed: false });
    expect(spawn).toHaveBeenCalledOnce(); expectReaped(spawn.mock.results[0]!.value.pid!);
  });
  it('aborts an admitted read and drains its exact child', async () => {
    const f = await fixture('setInterval(()=>{},1000);'), abort = new AbortController();
    const result = readCodexNativeQueue({ ...f, signal: abort.signal }).catch(error => error);
    await vi.waitFor(async () => expect((await captured(f.capture)).some(message => message.method === 'thread/queue/list')).toBe(true));
    abort.abort(); expect(await result).toMatchObject({ state: 'unavailable', cleanupUnconfirmed: false });
    expectReaped((await captured(f.capture))[0].pid);
  });
  it('rejects invalid or already-aborted inputs before spawn and never substitutes another profile', async () => {
    const f = await fixture(), abort = new AbortController(); abort.abort();
    const spawn = vi.mocked(childProcess.spawn); spawn.mockClear();
    for (const override of [{ threadId: '../wrong' }, { codexHome: 'relative' }, { cwd: 'relative' }, { signal: abort.signal }]) {
      await expect(readCodexNativeQueue({ ...f, ...override })).rejects.toBeInstanceOf(CodexNativeQueueError);
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});
