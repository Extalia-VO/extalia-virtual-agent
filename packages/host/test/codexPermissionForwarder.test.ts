import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_PERMISSION_FORWARDER_SOURCE, codexPermissionEndpointFile, codexPermissionForwarderPath, codexPermissionTokenFile } from '../src/connect/codexPermissionForwarder.js';

const payload = { hook_event_name: 'PermissionRequest', session_id: '11111111-1111-4111-8111-111111111111', turn_id: 'native-turn', tool_name: 'Bash', tool_input: { command: 'echo example', description: 'Example action' } };

describe('standalone Codex permission forwarder', () => {
  let home: string;
  let server: Server | undefined;
  let received: Array<{ requestId: string; payload: typeof payload }>;
  let response: (request: { requestId: string; payload: typeof payload }) => unknown;
  let status: number;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'extalia-codex-permission-'));
    await mkdir(path.join(home, 'hooks'));
    await writeFile(codexPermissionForwarderPath(home), CODEX_PERMISSION_FORWARDER_SOURCE, { mode: 0o600 });
    await writeFile(codexPermissionTokenFile(home), 'a'.repeat(64), { mode: 0o600 });
    received = [];
    status = 200;
    response = request => ({ decision: 'allow', confirmed: true, requestId: request.requestId, nativeSessionId: request.payload.session_id, turnId: request.payload.turn_id, toolName: request.payload.tool_name });
    server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += String(chunk); });
      req.on('end', () => {
        expect(req.url).toBe('/api/permissions/codex');
        expect(req.headers.authorization).toBe(`Bearer ${'a'.repeat(64)}`);
        const value = JSON.parse(body) as { requestId: string; payload: typeof payload };
        received.push(value);
        const answer = response(value);
        if (answer === undefined) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof answer === 'string' ? answer : JSON.stringify(answer));
      });
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    await writeFile(codexPermissionEndpointFile(home), JSON.stringify({ port: (server.address() as AddressInfo).port, pid: process.pid }), { mode: 0o600 });
  });
  afterEach(async () => {
    await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections(); });
    await rm(home, { recursive: true, force: true });
  });

  async function run(body = JSON.stringify(payload), signal?: NodeJS.Signals, closeInput = true, args = ['--session', payload.session_id], auditPrivateReads = false) {
    const probe = path.join(home, 'probe.mjs');
    const startupReady = path.join(home, 'signal-handler-ready');
    if (auditPrivateReads) await writeFile(probe, `
      import fs from 'node:fs';
      import path from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      const privateFiles = ['codex-permission-token', 'endpoint.json'];
      for (const method of ['lstatSync', 'readFileSync']) {
        const original = fs[method];
        fs[method] = function(file, ...args) {
          if (privateFiles.includes(path.basename(String(file)))) fs.appendFileSync(${JSON.stringify(path.join(home, 'private-reads'))}, method + ':' + path.basename(String(file)) + '\\n');
          return original.call(fs, file, ...args);
        };
      }
      syncBuiltinESMExports();
    `);
    if (signal && !closeInput) await writeFile(probe, `
      import fs from 'node:fs';
      const marker = ${JSON.stringify(startupReady)};
      const original = process.on;
      process.on = function(event, listener) {
        const result = original.call(this, event, listener);
        if (event === 'SIGINT') fs.writeFileSync(marker, 'ready');
        return result;
      };
    `);
    const child = spawn(process.execPath, [...(auditPrivateReads || (signal && !closeInput) ? ['--import', pathToFileURL(probe).href] : []), codexPermissionForwarderPath(home), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const result = new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => child.on('close', code => resolve({ code, stdout, stderr })));
    child.stdin.on('error', () => undefined);
    if (closeInput) child.stdin.end(body); else child.stdin.write(body);
    if (signal) {
      // Wait for the outstanding request, rather than racing process startup.
      if (closeInput) await vi.waitFor(() => expect(received).toHaveLength(1));
      if (!closeInput) await vi.waitFor(async () => expect(await readFile(startupReady, 'utf8')).toBe('ready'));
      child.kill(signal);
    }
    return result;
  }
  const nativeDecision = (decision: string) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: decision } } });

  it.each([
    { name: 'unmatched session', args: ['--session', '22222222-2222-4222-8222-222222222222'] },
    { name: 'missing scope', args: [] },
    { name: 'invalid scope', args: ['--session', 'not-a-uuid'] },
    { name: 'extra scope arguments', args: ['--session', payload.session_id, '--global'] },
  ])('returns the native prompt for $name before touching private files', async ({ args }) => {
    expect(await run(JSON.stringify(payload), undefined, true, args, true)).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
    expect(received).toHaveLength(0);
    await expect(stat(path.join(home, 'private-reads'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reads token and endpoint only for the exact matching session', async () => {
    const result = await run(JSON.stringify(payload), undefined, true, ['--session', payload.session_id], true);
    expect(JSON.parse(result.stdout)).toEqual(nativeDecision('allow'));
    const audit = await readFile(path.join(home, 'private-reads'), 'utf8');
    expect(audit).toContain('readFileSync:codex-permission-token');
    expect(audit).toContain('readFileSync:endpoint.json');
  });

  it.each(['allow', 'deny'])('returns only the exact confirmed native %s decision', async decision => {
    const base = response;
    response = request => ({ ...(base(request) as object), decision });
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(nativeDecision(decision));
    expect(received[0]?.payload).toEqual(payload);
    expect(received[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    ['confirmed', false], ['requestId', 'other-request'], ['nativeSessionId', 'other-session'], ['turnId', 'other-turn'], ['toolName', 'apply_patch'], ['decision', 'allow-always'],
  ])('defers mismatched or nonexplicit %s', async (field, value) => {
    const base = response;
    response = request => ({ ...(base(request) as object), [String(field)]: value });
    expect(await run()).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
  });

  it.each(['{}', 'not json', 'x'.repeat(9000)])('defers malformed or excessive response', async value => {
    response = () => value;
    expect(await run()).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
  });

  it.each(['', '{}', `${JSON.stringify(payload)}\n{}`, 'x'.repeat(65537), JSON.stringify({ ...payload, turn_id: '' }), JSON.stringify({ ...payload, hook_event_name: 'PreToolUse' })])('never forwards invalid, oversized or different-event stdin', async body => {
    expect(await run(body)).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
    expect(received).toHaveLength(0);
  });

  it('enforces the bound on the HTTP envelope as well as stdin', async () => {
    const base = JSON.stringify({ ...payload, extra: '' });
    const large = JSON.stringify({ ...payload, extra: 'x'.repeat(65500 - Buffer.byteLength(base)) });
    expect(Buffer.byteLength(large)).toBeLessThan(65536);
    expect(await run(large)).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
    expect(received).toHaveLength(0);
  });

  it('defers host errors', async () => {
    status = 503;
    expect(await run()).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
  });

  it('does not fall back to another port when the endpoint is absent', async () => {
    await rm(codexPermissionEndpointFile(home));
    expect(await run()).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
    expect(received).toHaveLength(0);
  });

  it('refuses stale endpoint processes', async () => {
    await writeFile(codexPermissionEndpointFile(home), JSON.stringify({ port: (server!.address() as AddressInfo).port, pid: 2147483647 }));
    expect(await run()).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
    expect(received).toHaveLength(0);
  });

  it('refuses unsafe token permissions', async () => {
    if (process.platform === 'win32') return;
    await chmod(codexPermissionTokenFile(home), 0o644);
    expect(await run()).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
    expect(received).toHaveLength(0);
  });

  // Windows force-terminates these signals; it cannot run the POSIX cleanup handler.
  const cancelled = process.platform === 'win32'
    ? { code: null, stdout: '', stderr: '' } : { code: 0, stdout: '{}\n', stderr: '' };

  it('aborts an outstanding host request on SIGTERM', async () => {
    response = () => undefined;
    expect(await run(JSON.stringify(payload), 'SIGTERM')).toEqual(cancelled);
    expect(received).toHaveLength(1);
  });

  it('aborts bounded unfinished stdin without forwarding it', async () => {
    expect(await run('{', 'SIGINT', false)).toEqual(cancelled);
    expect(received).toHaveLength(0);
  });
});
