import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createAgentHost, createConnectService, type AgentHostRuntime } from '@extalia/host';
import type { AgentHostApi, UpdateStatus } from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startBridgeServer, type BridgeServer } from '../src/bridge/server';
import { run, type CliHost } from '../src/cli';

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }

function postHook(port: number, app: string, body: string, authorization?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      host: `127.0.0.1:${port}`,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    };
    if (authorization) headers.authorization = authorization;
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: `/api/hooks/${app}`, headers, setHost: false }, res => {
      const parts: Buffer[] = [];
      res.on('data', (chunk: Buffer) => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const idleUpdate: UpdateStatus = {
  current: '1.0.0',
  channel: 'stable',
  state: 'idle',
  command: 'npm i -g extalia-vo@latest --prefer-online',
};

describe('extalia connect / disconnect / connections CLI and Bridge hook route', () => {
  let root: string;
  let homeDirectory: string;
  let extaliaHome: string;
  const servers: BridgeServer[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'extalia-cli-connect-'));
    homeDirectory = path.join(root, 'home');
    extaliaHome = path.join(root, 'extalia-home');
    await mkdir(homeDirectory, { recursive: true });
    await mkdir(extaliaHome, { recursive: true });
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(s => s.close()));
    await rm(root, { recursive: true, force: true });
  });

  function makeHost(overrides: Partial<CliHost> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const env = { EXTALIA_HOME: extaliaHome };
    const service = createConnectService({
      platform: 'linux',
      env,
      homeDirectory,
      extaliaHome,
      nodePath: process.execPath,
      findBinary: async name => `/usr/local/bin/${name}`,
      run: async bin => ({
        code: 0,
        stdout: bin.endsWith('codex') ? 'codex-cli 0.161.0\n' : '2.1.12 (Claude Code)\n',
        stderr: '',
      }),
      fetch: async () => new Response(null, { status: 204 }),
      codexRpc: async () => ({
        call: async <T>(method: string): Promise<T> => {
          if (method === 'hooks/list') return { data: [] } as unknown as T;
          return {} as unknown as T;
        },
        close() {},
      }),
    });
    const value: CliHost = {
      version: '0.0.0-test',
      out: line => out.push(line),
      err: line => err.push(line),
      readFile: file => readFile(file, 'utf8'),
      exists: file => access(file).then(() => true, () => false),
      platform: 'linux',
      arch: 'x64',
      nodeVersion: 'v24.1.0',
      env,
      homeDirectory,
      start: async () => 0,
      update: async () => 0,
      connectService: async () => service,
      ...overrides,
    };
    return { value, out, err };
  }

  it('runs extalia connect codex --dry-run without writing files', async () => {
    const io = makeHost();
    const code = await run(['connect', 'codex', '--dry-run'], io.value);
    expect(code).toBe(0);
    expect(io.out.join('\n')).toContain('Codex 0.161.0');
    expect(io.out.join('\n')).toContain('[[hooks.SessionStart]]');
    expect(io.out.join('\n')).toContain('Dry run complete. No files were changed.');
    await expect(access(path.join(homeDirectory, '.codex', 'config.toml'))).rejects.toThrow();
  });

  it('runs extalia connect claude, gemini and hermes --yes and writes hooks', async () => {
    const io = makeHost();
    const code = await run(['connect', 'claude', '--yes', '--port', '4317'], io.value);
    expect(code).toBe(0);
    const output = io.out.join('\n');
    expect(output).toContain('Updated:');
    expect(output).toContain('Undo:');
    const settingsPath = path.join(homeDirectory, '.claude', 'settings.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { hooks?: Record<string, unknown> };
    expect(settings.hooks?.PreToolUse).toBeDefined();
    expect(settings.hooks?.SessionStart).toBeDefined();

    const geminiIo = makeHost();
    expect(await run(['connect', 'gemini', '--yes'], geminiIo.value)).toBe(0);
    const geminiSettings = JSON.parse(await readFile(path.join(homeDirectory, '.gemini', 'settings.json'), 'utf8')) as { hooks?: Record<string, unknown> };
    expect(geminiSettings.hooks?.BeforeAgent).toBeDefined();
    expect(geminiSettings.hooks?.BeforeTool).toBeDefined();

    const agyIo = makeHost();
    expect(await run(['connect', 'antigravity', '--yes'], agyIo.value)).toBe(0);
    const agyHooks = JSON.parse(await readFile(path.join(homeDirectory, '.gemini', 'config', 'hooks.json'), 'utf8')) as { extalia?: Record<string, unknown> };
    expect(agyHooks.extalia?.PreInvocation).toBeDefined();
    expect(agyHooks.extalia?.PostToolUse).toBeDefined();

    const hermesIo = makeHost();
    expect(await run(['connect', 'hermes', '--yes', '--port', '4317'], hermesIo.value)).toBe(0);
    const hermesConfig = await readFile(path.join(homeDirectory, '.hermes', 'config.yaml'), 'utf8');
    expect(hermesConfig).toContain('http://127.0.0.1:4317/api/hooks/hermes');
    expect(hermesConfig).toContain('pre_tool_call');
  });

  it('handles interactive confirmation rejection and acceptance, disconnect, and connections', async () => {
    const rejected = makeHost({ prompt: async () => false });
    expect(await run(['connect', 'codex'], rejected.value)).toBe(1);
    expect(rejected.err.join('\n')).toContain('Cancelled. Nothing was written');
    await expect(access(path.join(homeDirectory, '.codex', 'config.toml'))).rejects.toThrow();

    const accepted = makeHost({ prompt: async () => true });
    expect(await run(['connect', 'codex'], accepted.value)).toBe(0);
    expect(accepted.out.join('\n')).toContain('Updated:');
    expect(await readFile(path.join(homeDirectory, '.codex', 'config.toml'), 'utf8')).toContain('[[hooks.SessionStart]]');

    const connectionsIo = makeHost();
    expect(await run(['connections'], connectionsIo.value)).toBe(0);
    const report = connectionsIo.out.join('\n');
    expect(report).toContain('Codex 0.161.0: connected');
    expect(report).toContain('Claude Code 2.1.12: not-connected');
    expect(report).toContain('Gemini CLI: not-connected');
    expect(report).toContain('Antigravity: not-connected');
    expect(report).toContain('Hermes: not-connected');

    const disconnectIo = makeHost();
    expect(await run(['disconnect', 'codex'], disconnectIo.value)).toBe(0);
    expect(disconnectIo.out.join('\n')).toContain('restored');
    await expect(access(path.join(homeDirectory, '.codex', 'config.toml'))).rejects.toThrow();
  });

  it('forwards POST /api/hooks/<app> on BridgeServer to the hooks handler without requiring x-extalia-token', async () => {
    const webRoot = path.join(root, 'web');
    await mkdir(webRoot, { recursive: true });
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><html><head></head><body></body></html>');

    const received: Array<{ app: string; auth: string | undefined; body: string }> = [];
    let server: BridgeServer;
    try {
      server = await startBridgeServer({
        port: 0,
        webRoot,
        agents: async () => ({} as unknown as AgentHostApi),
        updates: {
          status: () => idleUpdate,
          check: async () => idleUpdate,
          install: async () => idleUpdate,
        },
        hooks: async (req, res, app) => {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          await new Promise<void>(resolve => req.on('end', resolve));
          received.push({
            app,
            auth: req.headers.authorization,
            body: Buffer.concat(chunks).toString('utf8'),
          });
          res.writeHead(204);
          res.end();
        },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') return;
      throw error;
    }
    servers.push(server);

    const payload = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'codex-1' });
    const reply = await postHook(server.port, 'codex', payload, 'Bearer test-ingest-token');
    expect(reply.status).toBe(204);
    expect(received).toEqual([{ app: 'codex', auth: 'Bearer test-ingest-token', body: payload }]);
  });

  it('enables transcript auto-watch on connect and forwards extalia mcp stdio tool calls end-to-end into the running Bridge host', async () => {
    const webRoot = path.join(root, 'web');
    await mkdir(webRoot, { recursive: true });
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
    await mkdir(path.join(homeDirectory, '.codex', 'sessions'), { recursive: true });
    await mkdir(path.join(homeDirectory, '.codex', 'archived_sessions'), { recursive: true });

    const runtime: AgentHostRuntime = await createAgentHost({
      kind: 'bridge',
      version: '0.0.19',
      dataDirectory: extaliaHome,
      importHome: homeDirectory,
      env: { EXTALIA_HOME: extaliaHome, EXTALIA_SECRET_STORE: 'memory', CODEX_HOME: path.join(homeDirectory, '.codex') },
      observationIntervalMs: 60_000,
    });
    try {
      let server: BridgeServer;
      try {
        server = await startBridgeServer({
          port: 0,
          webRoot,
          agents: async () => runtime.host,
          updates: { status: () => idleUpdate, check: async () => idleUpdate, install: async () => idleUpdate },
          hooks: runtime.hooks ? (req, res, app) => runtime.hooks!.handle(req, res, app) : undefined,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') return;
        throw error;
      }
      servers.push(server);
      await runtime.hooks?.announce(server.port);

      const connectIo = makeHost({
        env: { EXTALIA_HOME: extaliaHome, CODEX_HOME: path.join(homeDirectory, '.codex') },
      });
      expect(await run(['connect', 'codex', '--yes', '--port', String(server.port)], connectIo.value)).toBe(0);

      // Connecting Codex automatically enables autoWatch for the primary Codex location (excluding archived_sessions).
      const locations = await runtime.host.importLocations();
      const codexPrimary = locations.find(loc => loc.sourceId === 'codex' && !loc.label.toLowerCase().includes('archived'));
      const codexArchived = locations.find(loc => loc.sourceId === 'codex' && loc.label.toLowerCase().includes('archived'));
      expect(codexPrimary?.autoWatch).toBe(true);
      expect(codexArchived?.autoWatch).toBe(false);

      // Run `extalia mcp --app codex --session mcp-live-1 --port <port>` over stdio JSON-RPC.
      const rpcLines = [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'report_intent', arguments: { intent: 'Auditing hook pipeline', activity: 'search', target: 'hooks/mcp.ts' } },
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'report_handoff', arguments: { subagent_id: 'worker-audit', role: 'SecurityReviewer', summary: 'Verify loopback rules', state: 'working' } },
        }),
      ].join('\n') + '\n';

      const mcpIo = makeHost({
        mcpInput: Readable.from([rpcLines]),
      });
      expect(await run(['mcp', '--app', 'codex', '--session', 'mcp-live-1', '--port', String(server.port)], mcpIo.value)).toBe(0);
      const responses = mcpIo.out.map(line => JSON.parse(line) as { id: number; result?: Record<string, unknown> });
      expect(responses.map(r => r.id)).toEqual([1, 2, 3, 4]);
      expect((responses[1]?.result?.tools as Array<{ name: string }>).map(t => t.name)).toEqual(['report_intent', 'report_handoff']);

      // Wait briefly for the async hook queue in Observations to flush
      await new Promise(resolve => setTimeout(resolve, 60));
      const state = await runtime.host.getState();
      const mcpSession = state.sessions.find(s => s.observation?.nativeSessionId === 'mcp-live-1');
      expect(mcpSession).toBeDefined();
      expect(mcpSession?.observation?.hook).toBe(true);
      const events = await runtime.host.sessionEvents(mcpSession!.id);
      expect(events.some(e => e.body.type === 'agent.state' && e.body.summary === 'Auditing hook pipeline')).toBe(true);
      expect(events.some(e => e.body.type === 'subagent.spawned' && e.body.subagentId === 'worker-audit')).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
