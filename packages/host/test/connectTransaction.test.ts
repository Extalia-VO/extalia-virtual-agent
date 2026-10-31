import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentAppId } from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitConfigWrites } from '../src/connect/configTransaction.js';
import { endpointFile, hookTargetsFile, readToken } from '../src/connect/endpoint.js';
import { forwarderPath } from '../src/connect/forwarder.js';
import { createConnectService, type ConnectContext } from '../src/connect/service.js';
import { writableTarget, writeConfigFile } from '../src/connect/util.js';

let root: string;
let home: string;
let data: string;
const servers: Server[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'extalia-connect-transaction-'));
  home = path.join(root, 'home'); data = path.join(root, 'data');
  await mkdir(home);
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve()); server.closeAllConnections();
  })));
  await rm(root, { recursive: true, force: true });
});
const apps: readonly AgentAppId[] = ['codex', 'claude', 'gemini', 'antigravity', 'hermes'];
const relative: Record<AgentAppId, string> = {
  codex: '.codex/config.toml', claude: '.claude/settings.json', gemini: '.gemini/settings.json',
  antigravity: '.gemini/config/hooks.json', hermes: '.hermes/config.yaml',
};
const original = (app: AgentAppId) => app === 'hermes' ? 'model: example\n' : app === 'codex' ? 'model = "example"\n' : '{"theme":"example"}\n';
const service = (extra: Partial<ConnectContext> = {}) => createConnectService({
  platform: 'linux', env: { EXTALIA_HOME: data }, extaliaHome: data, homeDirectory: home,
  nodePath: process.execPath, findBinary: async () => undefined, managedClaudeSettings: [],
  now: () => new Date('2026-10-29T12:00:00Z'), fetch: async () => new Response(null, { status: 204 }), ...extra,
});
async function seed(app: AgentAppId) {
  const file = path.join(home, relative[app]);
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, original(app));
  return file;
}

describe('preview and exact configuration identity', () => {
  it.each(apps)('rejects a changed %s preview before installing or rotating anything', async app => {
    const file = await seed(app), connect = service();
    const plan = await connect.plan(app, { rotate: true });
    expect(plan.previewDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await connect.plan(app, { rotate: true })).previewDigest).toBe(plan.previewDigest);
    const edited = `${original(app)}\n`;
    await writeFile(file, edited);
    await expect(connect.apply(app, { rotate: true, expectedPreviewDigest: plan.previewDigest })).rejects.toThrow('preview changed');
    expect(await readFile(file, 'utf8')).toBe(edited);
    await expect(readFile(path.join(data, 'hooks/token'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(data, 'connect/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('binds named-profile content and explicit port to the approved Hermes preview', async () => {
    await seed('hermes');
    const extra = path.join(home, '.hermes/profiles/team/config.yaml');
    await mkdir(path.dirname(extra), { recursive: true }); await writeFile(extra, 'model: team\n');
    const connect = service(), plan = await connect.plan('hermes', { port: 4517 });
    await expect(connect.apply('hermes', { port: 4518, expectedPreviewDigest: plan.previewDigest })).rejects.toThrow('preview changed');
    await writeFile(extra, 'model: changed\n');
    await expect(connect.apply('hermes', { port: 4517, expectedPreviewDigest: plan.previewDigest })).rejects.toThrow('preview changed');
    expect(await readToken(data)).toBeUndefined();
  });
  it.skipIf(process.platform === 'win32').each(apps)('refuses retargeted %s config symlinks during connect and disconnect', async app => {
    const file = path.join(home, relative[app]), first = path.join(root, 'first-config'), second = path.join(root, 'second-config');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(first, original(app)); await writeFile(second, original(app)); await symlink(first, file);
    const connect = service(); await connect.apply(app);
    const connected = await readFile(first, 'utf8'), token = await readToken(data);
    await rm(file); await symlink(second, file);
    await expect(connect.apply(app, { rotate: true })).rejects.toThrow('target changed');
    await expect(connect.disconnect(app)).rejects.toThrow('target changed');
    expect(await readFile(first, 'utf8')).toBe(connected);
    expect(await readFile(second, 'utf8')).toBe(original(app)); expect(await readToken(data)).toBe(token);
  });
  it('marks a missing forwarder stale and filters history older than the current connection', async () => {
    const connect = service(); await connect.apply('gemini');
    await writeFile(path.join(data, 'hooks/last-events.json'), JSON.stringify({ gemini: '2026-10-29T12:01:00Z', codex: 'invalid' }));
    expect((await connect.connections()).find(item => item.app === 'gemini')?.lastEventAt).toBe('2026-10-29T12:01:00Z');
    await rm(forwarderPath(data));
    expect((await connect.connections()).find(item => item.app === 'gemini')).toMatchObject({ state: 'stale', connected: false });
    await service({ now: () => new Date('2026-10-29T12:02:00Z') }).apply('gemini');
    expect((await connect.connections()).find(item => item.app === 'gemini')?.lastEventAt).toBeUndefined();
  });
});

describe('caught multi-file failure recovery', () => {
  async function writes() {
    const first = path.join(root, 'first'), second = path.join(root, 'second');
    await writeFile(first, 'original first'); await writeFile(second, 'original second');
    return Promise.all([first, second].map(async (file, index) => ({ file, target: await writableTarget(file), before: `original ${index ? 'second' : 'first'}`, after: `new ${index}` })));
  }
  it('preflights every file, including deleted expected files, before the first write', async () => {
    const entries = await writes(); await rm(entries[1]!.file);
    await expect(commitConfigWrites(entries)).rejects.toThrow('changed');
    expect(await readFile(entries[0]!.file, 'utf8')).toBe(entries[0]!.before);
  });
  it('restores earlier writes when a later write fails, including a write that throws after replacement', async () => {
    const entries = await writes();
    await expect(commitConfigWrites(entries, async (file, after, mode) => {
      await writeConfigFile(file, after, mode);
      if (file === entries[1]!.target) throw new Error('simulated write failure');
    })).rejects.toThrow('rolled back');
    for (const entry of entries) expect(await readFile(entry.file, 'utf8')).toBe(entry.before);
  });
  it('preserves concurrent edits rather than blindly restoring a backup', async () => {
    const entries = await writes();
    await expect(commitConfigWrites(entries, async (file, after, mode) => {
      if (file === entries[1]!.target) {
        await writeFile(entries[0]!.target, 'concurrent user edit'); throw new Error('simulated write failure');
      }
      await writeConfigFile(file, after, mode);
    })).rejects.toThrow('rollback is incomplete');
    expect(await readFile(entries[0]!.file, 'utf8')).toBe('concurrent user edit');
    expect(await readFile(entries[1]!.file, 'utf8')).toBe(entries[1]!.before);
  });
  it('refuses alias targets before changing anything', async () => {
    const entries = await writes(); entries[1]!.target = entries[0]!.target;
    await expect(commitConfigWrites(entries)).rejects.toThrow('same target');
    expect(await readFile(entries[0]!.file, 'utf8')).toBe(entries[0]!.before);
  });
});

it('uses the explicit app port for tests and real forwarder events, and clips UTF-8 bytes', async () => {
  const received: { app: string; bytes: number; payload: Record<string, unknown> }[] = [];
  const listen = async (app: string) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        received.push({ app, bytes: body.length, payload: JSON.parse(body.toString()) as Record<string, unknown> });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    servers.push(server); return (server.address() as AddressInfo).port;
  };
  const wrong = await listen('wrong'), selected = await listen('selected');
  await mkdir(path.join(data, 'hooks'), { recursive: true });
  await writeFile(endpointFile(data), JSON.stringify({ port: wrong, pid: process.pid, kind: 'bridge' }));
  const connect = service({ fetch });
  const plan = await connect.plan('gemini', { port: selected });
  const result = await connect.apply('gemini', { port: selected, expectedPreviewDigest: plan.previewDigest });
  expect(result.test.ok).toBe(true);
  expect(JSON.parse(await readFile(hookTargetsFile(data), 'utf8'))).toEqual({ gemini: selected });
  expect(JSON.parse(await readFile(endpointFile(data), 'utf8')).port).toBe(wrong);
  expect((await connect.plan('gemini')).port).toBe(selected);
  const payload = JSON.stringify({ hook_event_name: 'BeforeAgent', session_id: 'session-example', prompt: '文'.repeat(30_000) });
  expect(payload.length).toBeLessThan(60_000); expect(Buffer.byteLength(payload)).toBeGreaterThan(60_000);
  const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [forwarderPath(data), 'gemini'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.on('error', reject); child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(payload);
  });
  expect(output).toEqual({ code: 0, stdout: '', stderr: '' });
  expect(received).toHaveLength(2); expect(received.every(item => item.app === 'selected')).toBe(true);
  expect(received[1]!.bytes).toBeLessThan(60_000); expect(String(received[1]!.payload.prompt).length).toBeLessThan(30_000);
});
