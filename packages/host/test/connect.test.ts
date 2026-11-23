import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FORWARDER_SOURCE, FORWARD_LAUNCHER_SOURCE, createConnectService, endpointFile, ensureToken,
  forwarderPath, forwardLauncherPath, installForwarder, installForwardLauncher, nodePathFile,
  readToken, writeRecordedNodePath,
  type ConnectContext, type ConnectService,
} from '../src/index.js';
import { antigravityCommand, planAntigravityHooks } from '../src/connect/antigravity.js';
import { claudeCommand, planClaudeSettings } from '../src/connect/claude.js';
import { codexCommand, planCodexConfig } from '../src/connect/codex.js';
import { geminiCommand, planGeminiSettings } from '../src/connect/gemini.js';
import type { CodexRpc } from '../src/connect/codexAppServer.js';
import { hermesSignature } from '../src/hooks/http.js';
import { quoteArgument } from '../src/connect/util.js';

function runForwarder(script: string, app: string, stdinBody: string, event?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, app, ...(event ? [event] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(stdinBody);
  });
}

function runLauncher(
  script: string,
  args: string[],
  stdinBody: string,
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(script, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(stdinBody);
  });
}

describe('Connect service and hook forwarder', () => {
  let root: string;
  let homeDirectory: string;
  let extaliaHome: string;
  const servers: Server[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'extalia-connect-test-'));
    homeDirectory = path.join(root, 'home');
    extaliaHome = path.join(root, 'extalia-data');
    await mkdir(homeDirectory, { recursive: true });
    await mkdir(extaliaHome, { recursive: true });
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
      if (!server.listening) { resolve(); return; }
      server.close(() => resolve());
      server.closeAllConnections();
    })));
    await rm(root, { recursive: true, force: true });
  });

  function makeService(overrides: Partial<ConnectContext> = {}): ConnectService {
    return createConnectService({
      platform: process.platform,
      env: { EXTALIA_HOME: extaliaHome, HERMES_HOME: path.join(homeDirectory, '.hermes') },
      homeDirectory,
      extaliaHome,
      nodePath: process.execPath,
      now: () => new Date('2026-02-01T12:00:00.000Z'),
      findBinary: async name => `/usr/local/bin/${name}`,
      run: async bin => ({
        code: 0,
        stdout: bin.endsWith('codex')
          ? 'codex-cli 0.161.0\n'
          : bin.endsWith('gemini')
            ? 'gemini-cli 0.5.0\n'
            : bin.endsWith('hermes')
              ? 'hermes 0.4.2\n'
              : '2.1.12 (Claude Code)\n',
        stderr: '',
      }),
      fetch: async () => new Response(null, { status: 204 }),
      ...overrides,
    });
  }

  it('installs forward.mjs and forwards stdin hook JSON with Bearer token, exiting 0 when host is up, down, or slow', async () => {
    expect(await installForwarder(extaliaHome)).toBe(true);
    expect(await installForwarder(extaliaHome)).toBe(false);
    const script = forwarderPath(extaliaHome);
    expect(await readFile(script, 'utf8')).toBe(FORWARDER_SOURCE);

    const { token } = await ensureToken(extaliaHome);
    const received: Array<{ url: string; auth: string | undefined; body: string }> = [];
    const server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          url: req.url ?? '',
          auth: req.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(204);
        res.end();
      });
    });

    const bound = await new Promise<boolean>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPERM' || err.code === 'EACCES') resolve(false);
        else reject(err);
      });
      server.listen(0, '127.0.0.1', () => resolve(true));
    });

    const payload = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's-1' });
    if (bound) {
      servers.push(server);
      const port = (server.address() as AddressInfo).port;
      await writeFile(endpointFile(extaliaHome), JSON.stringify({ port, pid: process.pid, kind: 'bridge' }));

      const ok = await runForwarder(script, 'codex', payload);
      expect(ok).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(received).toEqual([{ url: '/api/hooks/codex', auth: `Bearer ${token}`, body: payload }]);

      await new Promise<void>(resolve => server.close(() => resolve()));
    } else {
      await writeFile(endpointFile(extaliaHome), JSON.stringify({ port: 4317, pid: process.pid, kind: 'bridge' }));
    }

    // Host down: verify forwarder still exits 0 with empty stdout/stderr.
    const down = await runForwarder(script, 'codex', payload);
    expect(down).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('never prints a PreToolUse decision for Antigravity ({} has no decision and Antigravity reads it as deny)', async () => {
    await installForwarder(extaliaHome);
    await ensureToken(extaliaHome);
    // Port 1 is never an Extalia host, so every run takes the host-down path.
    await writeFile(endpointFile(extaliaHome), JSON.stringify({ port: 1, pid: process.pid, kind: 'bridge' }));
    const script = forwarderPath(extaliaHome);
    const payload = JSON.stringify({ toolCall: { name: 'run_command', args: {} }, stepIdx: 1 });

    expect(await runForwarder(script, 'antigravity', payload, 'PreToolUse')).toEqual({ code: 0, stdout: '', stderr: '' });
    for (const event of ['PreInvocation', 'PostInvocation', 'PostToolUse', 'Stop']) {
      expect(await runForwarder(script, 'antigravity', payload, event)).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
    }
  });

  it('plans, applies, preserves user hooks, rotates tokens, warns on policies, and disconnects Claude Code', async () => {
    const claudeDir = path.join(homeDirectory, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.json');
    await mkdir(claudeDir, { recursive: true });
    const original = `${JSON.stringify({
      theme: 'dark',
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo custom-hook' }] },
        ],
      },
    }, null, 2)}\n`;
    await writeFile(settingsPath, original);

    const managedPolicyPath = path.join(root, 'managed-settings.json');
    await writeFile(managedPolicyPath, JSON.stringify({
      disableAllHooks: true,
      allowedHttpHookUrls: ['https://hooks.example.com/*'],
    }));

    const service = makeService({ managedClaudeSettings: [managedPolicyPath] });
    const plan = await service.plan('claude', { port: 4317 });
    expect(plan.supported).toBe(true);
    expect(plan.changes).toBe(true);
    expect(plan.diff).toContain('/api/hooks/claude');
    expect(plan.diff).toContain('<new ingest token>');
    expect(plan.warnings.some(w => w.includes('disables all hooks'))).toBe(true);
    expect(plan.warnings.some(w => w.includes('restricts HTTP hook URLs'))).toBe(true);

    const applied = await service.apply('claude', { port: 4317 });
    expect(applied.changed).toBe(true);
    expect(applied.backupPath).toBeDefined();
    const token1 = await readToken(extaliaHome);
    expect(token1).toMatch(/^[0-9a-f]{64}$/);

    const written = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      theme: string;
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command?: string; url?: string; headers?: Record<string, string> }> }>>;
    };
    expect(written.theme).toBe('dark');
    expect(written.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe('echo custom-hook');
    expect(written.hooks.PreToolUse?.[1]?.hooks[0]?.url).toBe('http://127.0.0.1:4317/api/hooks/claude');
    expect(written.hooks.SessionStart?.[0]?.hooks[0]?.type).toBe('command');

    // Idempotency: planning again reports no changes.
    const secondPlan = await service.plan('claude', { port: 4317 });
    expect(secondPlan.changes).toBe(false);

    // Token rotation replaces the token and updates Claude Code HTTP hooks.
    await service.apply('claude', { port: 4317, rotate: true });
    const token2 = await readToken(extaliaHome);
    expect(token2).toMatch(/^[0-9a-f]{64}$/);
    expect(token2).not.toBe(token1);
    expect(await readFile(settingsPath, 'utf8')).toContain(`Bearer ${token2}`);

    // Disconnect restores original byte-for-byte when untouched since Extalia wrote it.
    const disconnected = await service.disconnect('claude');
    expect(disconnected.changed).toBe(true);
    expect(disconnected.restoredExactly).toBe(true);
    expect(await readFile(settingsPath, 'utf8')).toBe(original);

    // Re-apply, then simulate user editing the file, and verify disconnect only removes Extalia entries.
    await service.apply('claude', { port: 4317 });
    const edited = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    edited.userAddedFlag = true;
    await writeFile(settingsPath, `${JSON.stringify(edited, null, 2)}\n`);

    const surgical = await service.disconnect('claude');
    expect(surgical.changed).toBe(true);
    expect(surgical.restoredExactly).toBe(false);
    const afterSurgical = JSON.parse(await readFile(settingsPath, 'utf8')) as { userAddedFlag?: boolean; hooks?: Record<string, unknown[]> };
    expect(afterSurgical.userAddedFlag).toBe(true);
    expect(afterSurgical.hooks?.PreToolUse).toHaveLength(1);
    expect(afterSurgical.hooks?.SessionStart).toBeUndefined();
  });

  it('plans, applies, preserves TOML comments and notify, approves trust via codexRpc, and disconnects Codex byte-for-byte', async () => {
    const codexDir = path.join(homeDirectory, '.codex');
    const configPath = path.join(codexDir, 'config.toml');
    await mkdir(codexDir, { recursive: true });
    const original = [
      '# User comment at the top',
      'model = "gpt-5-codex"',
      'notify = ["notify-send", "Codex finished"]',
      '',
    ].join('\n');
    await writeFile(configPath, original);

    let trustedInMock = false;
    const rpcCalls: Array<{ method: string; params: unknown }> = [];
    const mockRpcFactory = async (): Promise<CodexRpc> => ({
      call: async <T>(method: string, params: unknown): Promise<T> => {
        rpcCalls.push({ method, params });
        if (method === 'hooks/list') {
          return {
            data: [{
              hooks: [{
                key: 'user:session_start:0:0',
                eventName: 'session_start',
                handlerType: 'command',
                command: `${quoteArgument(process.execPath, process.platform)} ${quoteArgument(forwarderPath(extaliaHome), process.platform)} codex`,
                currentHash: 'hash-123',
                trustStatus: trustedInMock ? 'trusted' : 'untrusted',
                sourcePath: configPath,
              }],
            }],
          } as unknown as T;
        }
        if (method === 'config/read') {
          return { layers: [{ name: { type: 'user' }, version: 'v1' }] } as unknown as T;
        }
        if (method === 'config/batchWrite') {
          trustedInMock = true;
          const current = await readFile(configPath, 'utf8');
          await writeFile(configPath, `${current}\n[hooks.state."user:session_start:0:0"]\ntrusted_hash = "hash-123"\n`);
          return {} as unknown as T;
        }
        throw new Error(`Unexpected RPC method: ${method}`);
      },
      close() {},
    });

    const service = makeService({ codexRpc: mockRpcFactory });
    const plan = await service.plan('codex');
    expect(plan.supported).toBe(true);
    expect(plan.changes).toBe(true);
    expect(plan.needsTrust).toBe(true);
    expect(plan.diff).toContain('[[hooks.SessionStart]]');

    const applied = await service.apply('codex', { trust: true });
    expect(applied.changed).toBe(true);
    expect(applied.trust.status).toBe('trusted');
    expect(rpcCalls.some(call => call.method === 'config/batchWrite')).toBe(true);

    const written = await readFile(configPath, 'utf8');
    expect(written).toContain('# User comment at the top');
    expect(written).toContain('notify = ["notify-send", "Codex finished"]');
    expect(written).toContain('[[hooks.SessionStart]]');

    const connections = await service.connections();
    const codexConn = connections.find(c => c.app === 'codex');
    expect(codexConn?.state).toBe('connected');
    expect(codexConn?.trust.status).toBe('trusted');

    const disconnected = await service.disconnect('codex');
    expect(disconnected.changed).toBe(true);
    expect(disconnected.restoredExactly).toBe(true);
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  it('plans, applies, preserves user hooks, and disconnects Gemini CLI command hooks (2000ms timeout)', async () => {
    const geminiDir = path.join(homeDirectory, '.gemini');
    const settingsPath = path.join(geminiDir, 'settings.json');
    await mkdir(geminiDir, { recursive: true });
    const original = `${JSON.stringify({
      selectedAuthType: 'oauth-personal',
      hooks: {
        BeforeTool: [
          { matcher: 'run_shell_command', hooks: [{ type: 'command', command: 'echo user-gemini-hook', timeout: 1000 }] },
        ],
      },
    }, null, 2)}\n`;
    await writeFile(settingsPath, original);

    const service = makeService();
    const plan = await service.plan('gemini');
    expect(plan.supported).toBe(true);
    expect(plan.changes).toBe(true);
    expect(plan.diff).toContain(process.platform === 'win32' ? 'forward.mjs' : 'forward.sh');
    expect(plan.diff).toContain('"timeout": 2000');

    const applied = await service.apply('gemini');
    expect(applied.changed).toBe(true);
    expect(applied.backupPath).toBeDefined();

    const written = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      selectedAuthType: string;
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> }>>;
    };
    expect(written.selectedAuthType).toBe('oauth-personal');
    expect(written.hooks.BeforeTool?.[0]?.hooks[0]?.command).toBe('echo user-gemini-hook');
    expect(written.hooks.BeforeTool?.[1]?.hooks[0]?.timeout).toBe(2000);
    expect(written.hooks.BeforeAgent?.[0]?.hooks[0]?.command).toContain('gemini');
    expect(written.hooks.AfterAgent?.[0]?.hooks[0]?.command).toContain('gemini');

    const connections = await service.connections();
    const geminiConn = connections.find(c => c.app === 'gemini');
    expect(geminiConn?.state).toBe('connected');
    expect(geminiConn?.connected).toBe(true);

    const disconnected = await service.disconnect('gemini');
    expect(disconnected.changed).toBe(true);
    expect(disconnected.restoredExactly).toBe(true);
    expect(await readFile(settingsPath, 'utf8')).toBe(original);
  });

  it('plans, applies, preserves user hook groups, and disconnects Antigravity command hooks (~/.gemini/config/hooks.json)', async () => {
    const configDir = path.join(homeDirectory, '.gemini', 'config');
    const hooksPath = path.join(configDir, 'hooks.json');
    await mkdir(configDir, { recursive: true });
    const original = `${JSON.stringify({
      customGroup: {
        PreToolUse: [
          { matcher: 'run_command', hooks: [{ type: 'command', command: 'echo custom-agy-hook', timeout: 5 }] },
        ],
      },
    }, null, 2)}\n`;
    await writeFile(hooksPath, original);

    const service = makeService();
    const plan = await service.plan('antigravity');
    expect(plan.supported).toBe(true);
    expect(plan.changes).toBe(true);
    expect(plan.diff).toContain(process.platform === 'win32' ? 'forward.mjs' : 'forward.sh');
    expect(plan.diff).toContain('PreInvocation');
    expect(plan.diff).toContain('PostToolUse');

    const applied = await service.apply('antigravity');
    expect(applied.changed).toBe(true);
    expect(applied.backupPath).toBeDefined();

    const written = JSON.parse(await readFile(hooksPath, 'utf8')) as {
      customGroup?: Record<string, unknown>;
      extalia?: {
        PreInvocation?: Array<{ type: string; command: string; timeout: number }>;
        PostToolUse?: Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> }>;
      };
    };
    expect(written.customGroup).toBeDefined();
    expect(written.extalia?.PreInvocation?.[0]?.command).toContain('antigravity PreInvocation');
    expect(written.extalia?.PostToolUse?.[0]?.hooks[0]?.command).toContain('antigravity PostToolUse');
    expect(written.extalia?.PostToolUse?.[0]?.hooks[0]?.timeout).toBe(5);

    const connections = await service.connections();
    const agyConn = connections.find(c => c.app === 'antigravity');
    expect(agyConn?.state).toBe('connected');
    expect(agyConn?.connected).toBe(true);

    const disconnected = await service.disconnect('antigravity');
    expect(disconnected.changed).toBe(true);
    expect(disconnected.restoredExactly).toBe(true);
    expect(await readFile(hooksPath, 'utf8')).toBe(original);
  });

  it('plans, applies, preserves YAML comments across default and named profiles, signs test events with HMAC, and disconnects Hermes', async () => {
    const hermesDir = path.join(homeDirectory, '.hermes');
    const defaultConfigPath = path.join(hermesDir, 'config.yaml');
    const teamProfileDir = path.join(hermesDir, 'profiles', 'team');
    const teamConfigPath = path.join(teamProfileDir, 'config.yaml');
    await mkdir(teamProfileDir, { recursive: true });

    const originalDefault = [
      '# Hermes user config comment',
      'model: anthropic/claude-3-7-sonnet',
      'hooks:',
      '  # Keep existing outbound webhook',
      '  outbound:',
      '    - url: "http://127.0.0.1:9999/custom"',
      '      timeout: 5',
      '',
    ].join('\n');
    const originalTeam = [
      '# Team profile config',
      'model: openai/gpt-4.1',
      '',
    ].join('\n');
    await writeFile(defaultConfigPath, originalDefault);
    await writeFile(teamConfigPath, originalTeam);

    const capturedHeaders: Record<string, string>[] = [];
    const capturedBodies: string[] = [];
    const service = makeService({
      fetch: async (_url, init) => {
        capturedHeaders.push((init?.headers ?? {}) as Record<string, string>);
        capturedBodies.push(String(init?.body ?? ''));
        return new Response(null, { status: 204 });
      },
    });

    const plan = await service.plan('hermes', { port: 4317 });
    expect(plan.supported).toBe(true);
    expect(plan.changes).toBe(true);
    expect(plan.diff).toContain('http://127.0.0.1:4317/api/hooks/hermes');
    expect(plan.diff.replaceAll('\\', '/')).toContain('~/.hermes/config.yaml');
    expect(plan.diff.replaceAll('\\', '/')).toContain('~/.hermes/profiles/team/config.yaml');

    const applied = await service.apply('hermes', { port: 4317 });
    expect(applied.changed).toBe(true);
    const token = await readToken(extaliaHome);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // Verify HMAC signature header was sent on the test event
    expect(capturedHeaders).toHaveLength(1);
    expect(capturedHeaders[0]?.['x-hermes-signature-256']).toBe(hermesSignature(token!, capturedBodies[0]!));

    const writtenDefault = await readFile(defaultConfigPath, 'utf8');
    expect(writtenDefault).toContain('# Hermes user config comment');
    expect(writtenDefault).toContain('# Keep existing outbound webhook');
    expect(writtenDefault).toContain('http://127.0.0.1:9999/custom');
    expect(writtenDefault).toContain('http://127.0.0.1:4317/api/hooks/hermes');
    expect(writtenDefault).toContain(`secret: "${token}"`);

    const writtenTeam = await readFile(teamConfigPath, 'utf8');
    expect(writtenTeam).toContain('# Team profile config');
    expect(writtenTeam).toContain('http://127.0.0.1:4317/api/hooks/hermes');

    const connections = await service.connections();
    const hermesConn = connections.find(c => c.app === 'hermes');
    expect(hermesConn?.state).toBe('connected');
    expect(hermesConn?.connected).toBe(true);

    const disconnected = await service.disconnect('hermes');
    expect(disconnected.changed).toBe(true);
    expect(disconnected.restoredExactly).toBe(true);
    expect(await readFile(defaultConfigPath, 'utf8')).toBe(originalDefault);
    expect(await readFile(teamConfigPath, 'utf8')).toBe(originalTeam);
  });

  it('auto-updates an outdated forwarder script when checking connections and detects Gemini Desktop ~/.gemini/tasks for Antigravity', async () => {
    await mkdir(path.join(homeDirectory, '.gemini', 'tasks'), { recursive: true });
    const service = makeService({
      findBinary: async () => undefined,
    });

    await service.apply('gemini');
    await service.apply('antigravity');

    // Simulate an older forward.mjs (and on POSIX, outdated forward.sh + broken node-path).
    const scriptPath = forwarderPath(extaliaHome);
    await writeFile(scriptPath, '// extalia-hook-forwarder v0\n', 'utf8');
    if (process.platform !== 'win32') {
      await writeFile(forwardLauncherPath(extaliaHome), '#!/bin/sh\n# extalia-hook-launcher v0\n', { mode: 0o644 });
      await writeFile(nodePathFile(extaliaHome), '/opt/homebrew/Cellar/node/0.0.0/bin/node\n', { mode: 0o600 });
    }

    const connections = await service.connections();
    const geminiConn = connections.find(c => c.app === 'gemini');
    const agyConn = connections.find(c => c.app === 'antigravity');

    expect(geminiConn?.connected).toBe(true);
    expect(geminiConn?.warnings.some(w => w.includes('forwarder script is out of date'))).toBe(false);
    expect(agyConn?.installed).toBe(true);
    expect(agyConn?.connected).toBe(true);
    expect(agyConn?.warnings.some(w => w.includes('forwarder script is out of date'))).toBe(false);
    expect(await readFile(scriptPath, 'utf8')).toBe(FORWARDER_SOURCE);
    if (process.platform !== 'win32') {
      expect(await readFile(forwardLauncherPath(extaliaHome), 'utf8')).toBe(FORWARD_LAUNCHER_SOURCE);
      expect((await stat(forwardLauncherPath(extaliaHome))).mode & 0o777).toBe(0o755);
      expect((await stat(nodePathFile(extaliaHome))).mode & 0o777).toBe(0o600);
      expect((await readFile(nodePathFile(extaliaHome), 'utf8')).trim()).not.toContain('/Cellar/node/0.0.0/');

      // Same content but non-executable forward.sh is auto-repaired back to 0755 on connections().
      await chmod(forwardLauncherPath(extaliaHome), 0o644);
      expect((await service.connections()).find(c => c.app === 'antigravity')?.connected).toBe(true);
      expect((await stat(forwardLauncherPath(extaliaHome))).mode & 0o777).toBe(0o755);

      // Deleting forward.sh flags the connection stale until reconnected.
      await rm(forwardLauncherPath(extaliaHome));
      const missingLauncher = (await service.connections()).find(c => c.app === 'antigravity');
      expect(missingLauncher).toMatchObject({ state: 'stale', connected: false });
      expect(missingLauncher?.warnings.some(w => w.includes('launcher script is missing'))).toBe(true);
    }
  });

  it.skipIf(process.platform === 'win32')('forwards Antigravity and Gemini hooks through forward.sh across deleted Cellar, PATH, nvm, and Herd fallbacks', async () => {
    const spacedHome = path.join(root, 'Extalia Data With Spaces');
    expect(await installForwarder(spacedHome)).toBe(true);
    expect(await installForwardLauncher(spacedHome)).toBe(true);
    expect(await installForwardLauncher(spacedHome)).toBe(false);
    const launcher = forwardLauncherPath(spacedHome);
    expect((await stat(launcher)).mode & 0o777).toBe(0o755);

    // Verify pure /bin/sh syntax.
    const syntax = await new Promise<number | null>(resolve => {
      const child = spawn('/bin/sh', ['-n', launcher], { stdio: 'ignore' });
      child.on('close', resolve);
    });
    expect(syntax).toBe(0);

    const { token } = await ensureToken(spacedHome);
    const received: Array<{ url: string; auth: string | undefined; body: Record<string, unknown> }> = [];
    const server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          url: req.url ?? '',
          auth: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        });
        res.writeHead(204);
        res.end();
      });
    });
    const bound = await new Promise<boolean>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPERM' || err.code === 'EACCES') resolve(false);
        else reject(err);
      });
      server.listen(0, '127.0.0.1', () => resolve(true));
    });
    if (!bound) return;
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    await writeFile(endpointFile(spacedHome), JSON.stringify({ port, pid: process.pid, kind: 'bridge' }));

    // 1. Direct delivery using recorded node-path (Antigravity PreToolUse/PostToolUse/PreInvocation/Stop + Gemini CLI).
    await writeRecordedNodePath(spacedHome, process.execPath);
    expect((await stat(nodePathFile(spacedHome))).mode & 0o777).toBe(0o600);
    const agyPayload = JSON.stringify({ toolCall: { name: 'run_command', args: {} }, stepIdx: 1 });
    expect(await runLauncher(launcher, ['antigravity', 'PreToolUse'], agyPayload, { PATH: '', HOME: homeDirectory, EXTALIA_HOOK_SKIP_SYSTEM_NODE: '1' }))
      .toEqual({ code: 0, stdout: '', stderr: '' });
    for (const event of ['PostToolUse', 'PreInvocation', 'Stop']) {
      expect(await runLauncher(launcher, ['antigravity', event], agyPayload, { PATH: '', HOME: homeDirectory, EXTALIA_HOOK_SKIP_SYSTEM_NODE: '1' }))
        .toEqual({ code: 0, stdout: '{}\n', stderr: '' });
    }
    const geminiPayload = JSON.stringify({ hook_event_name: 'BeforeTool', session_id: 'g-1' });
    expect(await runLauncher(launcher, ['gemini'], geminiPayload, { PATH: '', HOME: homeDirectory, EXTALIA_HOOK_SKIP_SYSTEM_NODE: '1' }))
      .toEqual({ code: 0, stdout: '', stderr: '' });
    expect(received.map(entry => ({ url: entry.url, auth: entry.auth, event: entry.body.hook_event_name }))).toEqual([
      { url: '/api/hooks/antigravity', auth: `Bearer ${token}`, event: 'PreToolUse' },
      { url: '/api/hooks/antigravity', auth: `Bearer ${token}`, event: 'PostToolUse' },
      { url: '/api/hooks/antigravity', auth: `Bearer ${token}`, event: 'PreInvocation' },
      { url: '/api/hooks/antigravity', auth: `Bearer ${token}`, event: 'Stop' },
      { url: '/api/hooks/gemini', auth: `Bearer ${token}`, event: 'BeforeTool' },
    ]);

    // 2. Recorded node-path points to a deleted Homebrew Cellar path -> falls back to PATH (with spaces).
    received.length = 0;
    await writeRecordedNodePath(spacedHome, '/opt/homebrew/Cellar/node/24.0.0-deleted/bin/node');
    const pathBinDir = path.join(root, 'custom path bin');
    await mkdir(pathBinDir, { recursive: true });
    await symlink(process.execPath, path.join(pathBinDir, 'node'));
    expect(await runLauncher(launcher, ['antigravity', 'PreToolUse'], agyPayload, {
      PATH: pathBinDir,
      HOME: homeDirectory,
      EXTALIA_HOOK_SKIP_SYSTEM_NODE: '1',
    })).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(received).toHaveLength(1);
    expect(received[0]?.body.hook_event_name).toBe('PreToolUse');

    // 3. Deleted node-path + empty PATH -> falls back to Volta/fnm/nvm-bin env locations, then newest semver under nvm/Herd.
    received.length = 0;
    const voltaRoot = path.join(root, 'volta home');
    await mkdir(path.join(voltaRoot, 'bin'), { recursive: true });
    await symlink(process.execPath, path.join(voltaRoot, 'bin', 'node'));
    expect(await runLauncher(launcher, ['gemini'], geminiPayload, {
      PATH: '',
      HOME: homeDirectory,
      VOLTA_HOME: voltaRoot,
      EXTALIA_HOOK_SKIP_SYSTEM_NODE: '1',
    })).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe('/api/hooks/gemini');

    const writeFailingNode = async (file: string) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    };
    const linkRealNode = async (file: string) => {
      await mkdir(path.dirname(file), { recursive: true });
      await symlink(process.execPath, file);
    };

    received.length = 0;
    const nvmHome = path.join(root, 'nvm home');
    const nvmVersions = path.join(nvmHome, '.nvm', 'versions', 'node');
    await writeFailingNode(path.join(nvmVersions, 'v9.99.99', 'bin', 'node'));
    await writeFailingNode(path.join(nvmVersions, 'v22.9.0', 'bin', 'node'));
    await writeFailingNode(path.join(nvmVersions, 'v99.0.0-preview', 'bin', 'node'));
    await linkRealNode(path.join(nvmVersions, 'v22.12.0', 'bin', 'node'));
    expect(await runLauncher(launcher, ['gemini'], geminiPayload, {
      PATH: '',
      HOME: nvmHome,
      EXTALIA_HOOK_SKIP_SYSTEM_NODE: '1',
    })).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe('/api/hooks/gemini');

    if (process.platform === 'darwin') {
      received.length = 0;
      const herdHome = path.join(root, 'herd home');
      const herdVersions = path.join(herdHome, 'Library', 'Application Support', 'Herd', 'config', 'nvm', 'versions', 'node');
      await writeFailingNode(path.join(herdVersions, 'v9.99.99', 'bin', 'node'));
      await writeFailingNode(path.join(herdVersions, 'v22.9.0', 'bin', 'node'));
      await writeFailingNode(path.join(herdVersions, 'v99.0.0-preview', 'bin', 'node'));
      await linkRealNode(path.join(herdVersions, 'v22.12.0', 'bin', 'node'));
      expect(await runLauncher(launcher, ['antigravity', 'PostToolUse'], agyPayload, {
        PATH: '',
        HOME: herdHome,
        EXTALIA_HOOK_SKIP_SYSTEM_NODE: '1',
      })).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
      expect(received).toHaveLength(1);
      expect(received[0]?.body.hook_event_name).toBe('PostToolUse');
    }
  });

  it.skipIf(process.platform === 'win32')('fails open silently when no Node exists, when Node crashes, or when forward.mjs is missing', async () => {
    await installForwarder(extaliaHome);
    await installForwardLauncher(extaliaHome);
    const launcher = forwardLauncherPath(extaliaHome);
    const payload = JSON.stringify({ toolCall: { name: 'run_command', args: {} }, stepIdx: 1 });
    const emptyHome = path.join(root, 'empty-home');
    await mkdir(emptyHome, { recursive: true });

    // 1. No Node binary exists anywhere.
    await writeRecordedNodePath(extaliaHome, '/opt/homebrew/Cellar/node/24.0.0-gone/bin/node');
    const noNodeEnv = { PATH: '', HOME: emptyHome, EXTALIA_HOOK_SKIP_SYSTEM_NODE: '1' };
    expect(await runLauncher(launcher, ['antigravity', 'PreToolUse'], payload, noNodeEnv)).toEqual({ code: 0, stdout: '', stderr: '' });
    for (const event of ['PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop']) {
      expect(await runLauncher(launcher, ['antigravity', event], payload, noNodeEnv)).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
    }
    for (const app of ['gemini', 'codex', 'claude']) {
      expect(await runLauncher(launcher, [app], payload, noNodeEnv)).toEqual({ code: 0, stdout: '', stderr: '' });
    }

    // 2. Node exists but crashes with non-zero exit code and stderr output (for example broken dylib after upgrade).
    const brokenNode = path.join(root, 'broken-node');
    await writeFile(brokenNode, '#!/bin/sh\necho "dyld: Library not loaded: libicu" >&2\nexit 134\n', { mode: 0o755 });
    await writeRecordedNodePath(extaliaHome, brokenNode);
    expect(await runLauncher(launcher, ['antigravity', 'PreToolUse'], payload, noNodeEnv)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await runLauncher(launcher, ['antigravity', 'PostToolUse'], payload, noNodeEnv)).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
    expect(await runLauncher(launcher, ['gemini'], payload, noNodeEnv)).toEqual({ code: 0, stdout: '', stderr: '' });

    // 3. Valid Node exists, but forward.mjs is missing.
    await writeRecordedNodePath(extaliaHome, process.execPath);
    await rm(forwarderPath(extaliaHome));
    expect(await runLauncher(launcher, ['antigravity', 'PreToolUse'], payload, noNodeEnv)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await runLauncher(launcher, ['antigravity', 'Stop'], payload, noNodeEnv)).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
    expect(await runLauncher(launcher, ['gemini'], payload, noNodeEnv)).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it.skipIf(process.platform === 'win32')('recognizes legacy forward.mjs hooks, upgrades them to forward.sh, and disconnects them surgically without Node', async () => {
    const { token } = await ensureToken(extaliaHome);
    await installForwarder(extaliaHome);
    const legacyNode = process.execPath;
    const legacyScript = forwarderPath(extaliaHome);

    // Seed pre-upgrade direct-Node hooks alongside user hooks for all four command apps.
    const agyFile = path.join(homeDirectory, '.gemini', 'config', 'hooks.json');
    const geminiFile = path.join(homeDirectory, '.gemini', 'settings.json');
    const codexFile = path.join(homeDirectory, '.codex', 'config.toml');
    const claudeFile = path.join(homeDirectory, '.claude', 'settings.json');
    await Promise.all([agyFile, geminiFile, codexFile, claudeFile].map(file => mkdir(path.dirname(file), { recursive: true })));

    const agyBase = JSON.stringify({ customGroup: { Stop: [{ type: 'command', command: 'echo user-agy', timeout: 5 }] } }, null, 2) + '\n';
    const geminiBase = JSON.stringify({ hooks: { BeforeTool: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo user-gemini', timeout: 1000 }] }] } }, null, 2) + '\n';
    const codexBase = 'model = "example-model"\n';
    const claudeBase = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-claude' }] }] } }, null, 2) + '\n';

    await writeFile(agyFile, planAntigravityHooks(agyBase, agyFile, { command: antigravityCommand(legacyNode, legacyScript, process.platform) }).after);
    await writeFile(geminiFile, planGeminiSettings(geminiBase, geminiFile, { command: geminiCommand(legacyNode, legacyScript, process.platform) }).after);
    await writeFile(codexFile, planCodexConfig(codexBase, codexFile, { command: codexCommand(legacyNode, legacyScript, process.platform) }).after);
    await writeFile(claudeFile, planClaudeSettings(claudeBase, claudeFile, { port: 4317, token, command: claudeCommand(legacyNode, legacyScript, process.platform) }).after);

    const service = makeService({ findBinary: async () => undefined });
    const beforeStates = await service.connections();
    for (const app of ['antigravity', 'gemini', 'codex', 'claude'] as const) {
      const state = beforeStates.find(entry => entry.app === app);
      expect(state).toMatchObject({ state: 'stale', connected: false, nodeStatus: 'ready' });
      expect(state?.warnings.some(w => w.includes('resilient Extalia launcher'))).toBe(true);
    }

    // Upgrade antigravity, gemini, and claude to forward.sh.
    for (const app of ['antigravity', 'gemini', 'claude'] as const) {
      const plan = await service.plan(app, app === 'claude' ? { port: 4317 } : undefined);
      expect(plan.changes).toBe(true);
      expect(plan.diff).toContain('forward.sh');
      await service.apply(app, { ...(app === 'claude' ? { port: 4317 } : {}), expectedPreviewDigest: plan.previewDigest });
      expect((await service.plan(app, app === 'claude' ? { port: 4317 } : undefined)).changes).toBe(false);
    }
    expect(await readFile(agyFile, 'utf8')).toContain(forwardLauncherPath(extaliaHome));
    expect(await readFile(agyFile, 'utf8')).toContain('echo user-agy');
    expect(await readFile(geminiFile, 'utf8')).toContain(forwardLauncherPath(extaliaHome));
    expect(await readFile(geminiFile, 'utf8')).toContain('echo user-gemini');
    expect(await readFile(claudeFile, 'utf8')).toContain(forwardLauncherPath(extaliaHome));
    expect(await readFile(claudeFile, 'utf8')).toContain('echo user-claude');

    const afterStates = await service.connections();
    for (const app of ['antigravity', 'gemini', 'claude'] as const) {
      expect(afterStates.find(entry => entry.app === app)).toMatchObject({ state: 'connected', connected: true });
    }

    // Surgical disconnect of legacy Codex hooks still succeeds even with NO Node available.
    const noNodeService = makeService({ nodePath: undefined, resolveNodePath: async () => undefined, findBinary: async () => undefined });
    expect(await noNodeService.disconnect('codex')).toMatchObject({ changed: true });
    expect(await readFile(codexFile, 'utf8')).toBe(codexBase);
  });
});
