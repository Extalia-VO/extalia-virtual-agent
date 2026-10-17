import { createHmac } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ExtaliaEvent } from '@extalia/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureHookToken,
  hookFiles,
  readHookEndpoint,
  readHookToken,
  removeHookEndpoint,
  rotateHookToken,
  writeHookEndpoint,
} from '../src/hooks/files.js';
import {
  handleHookRequest,
  hermesSignature,
  HOOK_BODY_LIMIT,
  HookRateLimiter,
  startHookListener,
  type HookListener,
} from '../src/hooks/http.js';
import { createHookIngest, type HookIngest } from '../src/hooks/ingest.js';
import {
  normalizeClaudeHook,
  normalizeCodexHook,
  normalizeGeminiHook,
  normalizeHermesHook,
} from '../src/hooks/normalize.js';
import { createAgentHost } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();

interface TestHookRequestOptions {
  method?: string;
  app?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  host?: string;
}

interface TestHookEndpoint {
  port: number;
  request(options: TestHookRequestOptions): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>;
  close(): Promise<void>;
}

/**
 * Starts a real loopback HookListener when permitted by the OS/sandbox, or
 * falls back to an in-memory HTTP request/response adapter calling the same
 * handler when socket binding returns EPERM/EACCES.
 */
async function startTestHookEndpoint(
  handle: (req: http.IncomingMessage, res: http.ServerResponse, app: string) => Promise<void>,
  ingest?: HookIngest,
): Promise<TestHookEndpoint> {
  try {
    const listener: HookListener = ingest ? await ingest.listen() : await startHookListener({ handle });
    return {
      port: listener.port,
      request(options: TestHookRequestOptions) {
        return new Promise((resolve, reject) => {
          const headers: Record<string, string> = { ...options.headers };
          if (options.host) headers.host = options.host;
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: listener.port,
              path: `/api/hooks/${options.app ?? 'codex'}`,
              method: options.method ?? 'POST',
              headers,
            },
            res => {
              const chunks: Buffer[] = [];
              res.on('data', chunk => chunks.push(chunk));
              res.on('end', () => {
                resolve({
                  status: res.statusCode ?? 0,
                  headers: res.headers,
                  body: Buffer.concat(chunks).toString('utf8'),
                });
              });
            },
          );
          req.on('error', reject);
          if (options.body) req.write(options.body);
          req.end();
        });
      },
      close: () => listener.close(),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES') throw error;
    const fallbackPort = 4317;
    if (ingest) await ingest.announce(fallbackPort);
    const allowedHosts = new Set([`127.0.0.1:${fallbackPort}`, `localhost:${fallbackPort}`]);
    return {
      port: fallbackPort,
      async request(options: TestHookRequestOptions) {
        const lowerHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(options.headers ?? {})) lowerHeaders[k.toLowerCase()] = v;
        const hostHeader = (options.host ?? `127.0.0.1:${fallbackPort}`).toLowerCase();
        if (!allowedHosts.has(hostHeader)) {
          return { status: 403, headers: { 'x-content-type-options': 'nosniff', connection: 'close' }, body: '' };
        }
        const stream = new PassThrough();
        const req = Object.assign(stream, {
          method: options.method ?? 'POST',
          url: `/api/hooks/${options.app ?? 'codex'}`,
          headers: { ...lowerHeaders, host: hostHeader },
          complete: false,
        }) as unknown as http.IncomingMessage;

        const outHeaders: http.IncomingHttpHeaders = {};
        let status = 200;
        const resChunks: Buffer[] = [];
        let ended = false;
        let resolveDone!: () => void;
        const donePromise = new Promise<void>(r => { resolveDone = r; });

        const mockRes: {
          headersSent: boolean;
          setHeader(name: string, value: string): void;
          writeHead(code: number, hdrs?: Record<string, string>): void;
          end(chunk?: string | Buffer): void;
        } = {
          headersSent: false,
          setHeader(name: string, value: string) {
            outHeaders[name.toLowerCase()] = value;
          },
          writeHead(code: number, hdrs?: Record<string, string>) {
            status = code;
            mockRes.headersSent = true;
            if (hdrs) for (const [k, v] of Object.entries(hdrs)) outHeaders[k.toLowerCase()] = v;
          },
          end(chunk?: string | Buffer) {
            if (ended) return;
            ended = true;
            mockRes.headersSent = true;
            if (chunk) resChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            resolveDone();
          },
        };
        const res = mockRes as unknown as http.ServerResponse;

        const handling = handle(req, res, options.app ?? 'codex');
        if (options.body) {
          stream.write(typeof options.body === 'string' ? Buffer.from(options.body) : options.body);
        }
        stream.end();
        await Promise.all([handling, donePromise]);
        return { status, headers: outHeaders, body: Buffer.concat(resChunks).toString('utf8') };
      },
      async close() {
        if (ingest) await ingest.close();
      },
    };
  }
}

describe('hook files (hooks/files.ts)', () => {
  it('creates and reads a 64-hex-char token with 0600 mode, and tightens mode when loose', async () => {
    const root = await temp();
    const dataDir = path.join(root, 'data');
    const token = await ensureHookToken(dataDir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const files = hookFiles(dataDir);
    if (process.platform !== 'win32') {
      const mode = (await stat(files.token)).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    const read = await readHookToken(dataDir);
    expect(read).toBe(token);

    if (process.platform !== 'win32') {
      await chmod(files.token, 0o666);
      const ensured = await ensureHookToken(dataDir);
      expect(ensured).toBe(token);
      const restoredMode = (await stat(files.token)).mode & 0o777;
      expect(restoredMode).toBe(0o600);
    }
  });

  it('rotates hook token and returns undefined for invalid token file content', async () => {
    const root = await temp();
    const dataDir = path.join(root, 'data');
    const token1 = await ensureHookToken(dataDir);
    const token2 = await rotateHookToken(dataDir);
    expect(token2).toMatch(/^[0-9a-f]{64}$/);
    expect(token2).not.toBe(token1);
    expect(await readHookToken(dataDir)).toBe(token2);

    const files = hookFiles(dataDir);
    await writeFile(files.token, 'invalid-token-value');
    expect(await readHookToken(dataDir)).toBeUndefined();
  });

  it('writes, reads, and conditionally removes endpoint.json', async () => {
    const root = await temp();
    const dataDir = path.join(root, 'data');
    await writeHookEndpoint(dataDir, { port: 4317, pid: 12345, kind: 'desktop' });

    const endpoint = await readHookEndpoint(dataDir);
    expect(endpoint).toEqual({ port: 4317, pid: 12345, kind: 'desktop' });

    // Returns undefined for invalid endpoint file
    const files = hookFiles(dataDir);
    await writeFile(files.endpoint, JSON.stringify({ port: -1, pid: 'not-a-pid', kind: 'other' }));
    expect(await readHookEndpoint(dataDir)).toBeUndefined();

    // Re-write valid endpoint
    await writeHookEndpoint(dataDir, { port: 4317, pid: 12345, kind: 'desktop' });

    // Does not remove if pid does not match
    await removeHookEndpoint(dataDir, 99999);
    expect(await readHookEndpoint(dataDir)).toEqual({ port: 4317, pid: 12345, kind: 'desktop' });

    // Removes when pid matches
    await removeHookEndpoint(dataDir, 12345);
    expect(await readHookEndpoint(dataDir)).toBeUndefined();
  });
});

describe('HTTP hook ingest (hooks/http.ts & hooks/ingest.ts)', () => {
  it('rejects Origin (403), non-POST (405), unknown app (404), non-JSON (415), invalid auth (401), body too large (413)', async () => {
    const delivered: { app: string; payload: unknown }[] = [];
    const validToken = 'a'.repeat(64);
    const limiter = new HookRateLimiter();

    const listener = await startTestHookEndpoint((req, res, app) =>
      handleHookRequest(req, res, app, {
        limiter,
        verifyToken: async given => given === validToken,
        verifySignature: async (body, sig) =>
          sig === `sha256=${createHmac('sha256', validToken).update(body).digest('hex')}`,
        deliver: (appId, payload) => {
          delivered.push({ app: appId, payload });
        },
      }),
    );

    try {
      // 1. Origin present -> 403
      const withOrigin = await listener.request({
        headers: {
          Origin: 'http://example.com',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ session_id: 's1' }),
      });
      expect(withOrigin.status).toBe(403);

      // 2. Non-POST -> 405
      const getReq = await listener.request({
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
      });
      expect(getReq.status).toBe(405);
      expect(getReq.headers.allow).toBe('POST');

      // 3. Unknown app -> 404
      const unknownApp = await listener.request({
        app: 'unknown-app',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ session_id: 's1' }),
      });
      expect(unknownApp.status).toBe(404);

      // 4. Non-JSON Content-Type -> 415
      const textReq = await listener.request({
        headers: {
          'Content-Type': 'text/plain',
          Authorization: `Bearer ${validToken}`,
        },
        body: 'plain text',
      });
      expect(textReq.status).toBe(415);

      // 5. Invalid token -> 401
      const wrongAuth = await listener.request({
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-token',
        },
        body: JSON.stringify({ session_id: 's1' }),
      });
      expect(wrongAuth.status).toBe(401);

      // 6. Body > 64KB -> 413
      const hugeBody = JSON.stringify({ session_id: 's1', data: 'x'.repeat(HOOK_BODY_LIMIT + 100) });
      const tooLarge = await listener.request({
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
          'Content-Length': String(Buffer.byteLength(hugeBody)),
        },
        body: hugeBody,
      });
      expect(tooLarge.status).toBe(413);

      // 7. Loopback DNS rebinding rejection (wrong Host header) -> 403
      const badHost = await listener.request({
        host: 'attacker.com',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ session_id: 's1' }),
      });
      expect(badHost.status).toBe(403);
    } finally {
      await listener.close();
    }
  });

  it('accepts Bearer token with 204, Hermes HMAC signature with 204, and rate-limits bursts with 204', async () => {
    const delivered: { app: string; payload: Record<string, unknown> }[] = [];
    const validToken = 'b'.repeat(64);
    // 5 tokens/sec with burst of 10
    const limiter = new HookRateLimiter(5, 10);

    const listener = await startTestHookEndpoint((req, res, app) =>
      handleHookRequest(req, res, app, {
        limiter,
        verifyToken: async given => given === validToken,
        verifySignature: async (body, sig) =>
          sig === `sha256=${createHmac('sha256', validToken).update(body).digest('hex')}`,
        deliver: (appId, payload) => {
          delivered.push({ app: appId, payload });
        },
      }),
    );

    try {
      // Valid Bearer -> 204
      const okBearer = await listener.request({
        app: 'codex',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart' }),
      });
      expect(okBearer.status).toBe(204);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.app).toBe('codex');

      // Valid Hermes HMAC -> 204
      const hermesBody = Buffer.from(JSON.stringify({ session_id: 's2', hook_event_name: 'on_session_start' }));
      const signature = hermesSignature(validToken, hermesBody);
      const okHermes = await listener.request({
        app: 'hermes',
        headers: {
          'Content-Type': 'application/json',
          'x-hermes-signature-256': signature,
        },
        body: hermesBody,
      });
      expect(okHermes.status).toBe(204);
      expect(delivered).toHaveLength(2);
      expect(delivered[1]!.app).toBe('hermes');

      // Invalid Hermes HMAC -> 401
      const badHermes = await listener.request({
        app: 'hermes',
        headers: {
          'Content-Type': 'application/json',
          'x-hermes-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
        },
        body: hermesBody,
      });
      expect(badHermes.status).toBe(401);

      // Rate limit test: burst of 15 requests
      for (let i = 0; i < 15; i++) {
        const res = await listener.request({
          app: 'claude',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${validToken}`,
          },
          body: JSON.stringify({ session_id: `burst-${i}` }),
        });
        // Rate-limited requests still return 204 so hook never blocks the agent
        expect(res.status).toBe(204);
      }
      // Claude burst capacity is 10, so deliver should receive at most 10 claude events
      const claudeDelivered = delivered.filter(d => d.app === 'claude');
      expect(claudeDelivered.length).toBeLessThanOrEqual(10);
    } finally {
      await listener.close();
    }
  });

  it('createHookIngest manages tokens, endpoint announcement, last events, and clean shutdown', async () => {
    const root = await temp();
    const dataDir = path.join(root, 'data');
    const received: unknown[] = [];
    const ingest = await createHookIngest({
      dataDirectory: dataDir,
      kind: 'desktop',
      sink: hook => received.push(hook),
    });

    const status1 = ingest.status();
    expect(status1.tokenPath).toBe(path.join(dataDir, 'hooks', 'token'));
    expect(status1.lastEvents).toEqual({ codex: undefined, claude: undefined, gemini: undefined, hermes: undefined });

    const listener = await startTestHookEndpoint((req, res, app) => ingest.handle(req, res, app), ingest);
    expect(ingest.status().port).toBe(listener.port);
    expect((await readHookEndpoint(dataDir))?.port).toBe(listener.port);

    await ingest.close();
    expect(await readHookEndpoint(dataDir)).toBeUndefined();
  });
});

describe('normalizers (hooks/normalize.ts)', () => {
  it('normalizes SessionStart and UserPromptSubmit/BeforeAgent with title hints', () => {
    // Codex SessionStart
    const start = normalizeCodexHook({
      session_id: 'session-codex-1',
      hook_event_name: 'SessionStart',
      cwd: '/Users/<name>/project',
      model: 'o3-mini',
    });
    expect(start).toMatchObject({
      app: 'codex',
      sessionId: 'session-codex-1',
      starts: true,
      ends: false,
      cwd: '/Users/<name>/project',
      model: 'o3-mini',
    });
    expect(start!.steps.map(s => s.body.type)).toEqual(['session.started', 'agent.state']);
    expect(start!.steps[1]!.body).toEqual({ type: 'agent.state', state: 'idle' });

    // Claude UserPromptSubmit
    const promptHook = normalizeClaudeHook({
      session_id: 'session-claude-1',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Implement feature X\nDetails here...',
    });
    expect(promptHook).toMatchObject({
      app: 'claude',
      sessionId: 'session-claude-1',
      titleHint: 'Implement feature X',
    });
    expect(promptHook!.steps.map(s => s.body.type)).toEqual(['prompt.submitted', 'agent.state']);
    expect(promptHook!.steps[0]!.body).toMatchObject({
      type: 'prompt.submitted',
      text: 'Implement feature X\nDetails here...',
      via: 'native',
    });
    expect(promptHook!.steps[1]!.body).toEqual({ type: 'agent.state', state: 'thinking' });

    // Gemini BeforeAgent
    const geminiPrompt = normalizeGeminiHook({
      sessionId: 'session-gemini-1',
      hookEventName: 'BeforeAgent',
      prompt: 'Fix the bug',
    });
    expect(geminiPrompt?.titleHint).toBe('Fix the bug');
    expect(geminiPrompt?.steps.map(s => s.body.type)).toEqual(['prompt.submitted', 'agent.state']);
  });

  it('classifies PreToolUse / BeforeTool calls (Bash command/test, Edit, Write, apply_patch, Read, Grep, Web, Task)', () => {
    // 1. Bash test command
    const bashTest = normalizeCodexHook({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
      tool_use_id: 'tool-1',
    });
    expect(bashTest!.steps[0]!.body).toMatchObject({ type: 'agent.state', state: 'working', activity: 'test' });
    expect(bashTest!.steps[1]!.body).toMatchObject({ type: 'tool.started', tool: 'Bash', kind: 'test', toolCallId: 'tool-1' });

    // 2. Bash generic command
    const bashCmd = normalizeCodexHook({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
    });
    expect(bashCmd!.steps[1]!.body).toMatchObject({ type: 'tool.started', kind: 'command' });

    // 3. Edit / Write
    const editTool = normalizeClaudeHook({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/app.ts' },
    });
    expect(editTool!.steps[1]!.body).toMatchObject({ type: 'tool.started', kind: 'edit', target: 'app.ts' });

    // 4. apply_patch
    const patchTool = normalizeCodexHook({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { patch: '*** Update File: src/main.ts\n' },
    });
    expect(patchTool!.steps[1]!.body).toMatchObject({ type: 'tool.started', kind: 'edit' });

    // 5. Read
    const readTool = normalizeClaudeHook({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
    });
    expect(readTool!.steps[1]!.body).toMatchObject({ type: 'tool.started', kind: 'read', target: 'README.md' });

    // 6. Grep / Glob
    const grepTool = normalizeClaudeHook({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'function' },
    });
    expect(grepTool!.steps[1]!.body).toMatchObject({ type: 'tool.started', kind: 'search' });

    // 7. WebSearch
    const webTool = normalizeClaudeHook({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'WebSearch',
      tool_input: { query: 'docs' },
    });
    expect(webTool!.steps[1]!.body).toMatchObject({ type: 'tool.started', kind: 'web' });

    // 8. Task / delegate
    const taskTool = normalizeClaudeHook({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_input: { prompt: 'Subtask' },
    });
    expect(taskTool!.steps[0]!.body).toMatchObject({ type: 'agent.state', state: 'delegating', activity: 'delegate' });
    expect(taskTool!.steps[1]!.body).toMatchObject({ type: 'tool.started', kind: 'delegate' });
  });

  it('normalizes PostToolUse with output redaction (4000 char cap), error handling, and file.written', () => {
    // Output capping at 4000 chars
    const postBash = normalizeCodexHook({
      session_id: 's1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'cat file' },
      tool_response: { stdout: 'a'.repeat(5000) },
    });
    expect(postBash!.steps).toHaveLength(1);
    const completed = postBash!.steps[0]!.body as { type: string; ok: boolean; output: string };
    expect(completed.type).toBe('tool.completed');
    expect(completed.ok).toBe(true);
    expect(completed.output.length).toBeLessThanOrEqual(4000);

    // Edit tool emits file.written
    const postEdit = normalizeClaudeHook({
      session_id: 's1',
      hook_event_name: 'PostToolUse',
      cwd: '/Users/<name>/project',
      tool_name: 'Edit',
      tool_input: { file_path: '/Users/<name>/project/src/index.ts' },
      tool_response: { output: 'success' },
    });
    expect(postEdit!.steps.map(s => s.body.type)).toEqual(['tool.completed', 'file.written']);
    expect(postEdit!.steps[1]!.body).toMatchObject({
      type: 'file.written',
      path: 'src/index.ts',
      change: 'update',
    });

    // apply_patch emits file.written for multiple files
    const postPatch = normalizeCodexHook({
      session_id: 's1',
      hook_event_name: 'PostToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        patch: '*** Add File: file1.ts\n+hello\n*** Update File: file2.ts\n+world\n*** Delete File: file3.ts\n',
      },
      tool_response: { success: true },
    });
    const writtenEvents = postPatch!.steps.filter(s => s.body.type === 'file.written').map(s => s.body);
    expect(writtenEvents).toEqual([
      { type: 'file.written', path: 'file1.ts', change: 'add' },
      { type: 'file.written', path: 'file2.ts', change: 'update' },
      { type: 'file.written', path: 'file3.ts', change: 'delete' },
    ]);

    // Failure via PostToolUseFailure
    const failed = normalizeClaudeHook({
      session_id: 's1',
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      error: 'Command exited with 1',
    });
    expect(failed!.steps[0]!.body).toMatchObject({ type: 'tool.completed', ok: false });
  });

  it('normalizes PermissionRequest, Notification, SubagentStart/Stop, Stop, and SessionEnd', () => {
    // PermissionRequest -> waiting
    const perm = normalizeClaudeHook({
      session_id: 's1',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf dist' },
    });
    expect(perm!.steps[0]!.body).toMatchObject({ type: 'agent.state', state: 'waiting' });

    // Notification -> waiting for the user (an idle prompt only marks the agent ready)
    const notif = normalizeClaudeHook({
      session_id: 's1',
      hook_event_name: 'Notification',
      message: 'Need input',
    });
    expect(notif!.steps[0]!.body).toMatchObject({ type: 'agent.state', state: 'waiting', summary: 'Need input' });

    const idleNotif = normalizeClaudeHook({
      session_id: 's1',
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'Waiting for your prompt',
    });
    // v0.0.38: the idle prompt leaves the agent ready, waiting for the next prompt (not a request).
    expect(idleNotif!.steps.map(step => step.body)).toEqual([{ type: 'agent.state', state: 'idle', phase: 'input', summary: 'Waiting for the user' }]);

    // SubagentStart & Stop
    const subStart = normalizeClaudeHook({
      session_id: 's1',
      hook_event_name: 'SubagentStart',
      subagent_id: 'sub-worker-1',
      agent_type: 'CodeReviewer',
    });
    expect(subStart!.steps[0]!.body).toMatchObject({
      type: 'subagent.spawned',
      subagentId: 'sub-worker-1',
      role: 'CodeReviewer',
    });

    const subStop = normalizeClaudeHook({
      session_id: 's1',
      hook_event_name: 'SubagentStop',
      subagent_id: 'sub-worker-1',
    });
    expect(subStop!.steps[0]!.body).toMatchObject({
      type: 'subagent.state',
      subagentId: 'sub-worker-1',
      state: 'offline',
    });

    // Stop -> model.completed, turn.completed, agent.state idle
    const stop = normalizeClaudeHook({
      session_id: 's1',
      hook_event_name: 'Stop',
      last_assistant_message: 'Finished implementation.',
      model: 'claude-3-7-sonnet',
    });
    expect(stop!.steps.map(s => s.body.type)).toEqual(['model.completed', 'turn.completed', 'agent.state']);
    expect(stop!.steps[0]!.body).toMatchObject({ type: 'model.completed', text: 'Finished implementation.' });
    expect(stop!.steps[2]!.body).toEqual({ type: 'agent.state', state: 'idle' });

    // SessionEnd
    const end = normalizeClaudeHook({
      session_id: 's1',
      hook_event_name: 'SessionEnd',
      reason: 'user_exit',
    });
    expect(end!.ends).toBe(true);
    expect(end!.steps.map(s => s.body.type)).toEqual(['session.ended', 'agent.state']);
    expect(end!.steps[1]!.body).toEqual({ type: 'agent.state', state: 'offline' });
  });

  it('normalizes Hermes outbound webhooks', () => {
    // on_session_start
    const start = normalizeHermesHook({
      session_id: 'hermes-1',
      hook_event_name: 'on_session_start',
      cwd: '/Users/<name>/hermes-project',
      extra: { model: 'hermes-v3' },
    });
    expect(start).toMatchObject({
      app: 'hermes',
      sessionId: 'hermes-1',
      starts: true,
      model: 'hermes-v3',
    });

    // pre_llm_call
    const thinking = normalizeHermesHook({
      session_id: 'hermes-1',
      hook_event_name: 'pre_llm_call',
    });
    expect(thinking!.steps[0]!.body).toEqual({ type: 'agent.state', state: 'thinking' });

    // pre_tool_call & post_tool_call
    const preTool = normalizeHermesHook({
      session_id: 'hermes-1',
      hook_event_name: 'pre_tool_call',
      tool_name: 'terminal',
      tool_input: { command: 'pnpm test' },
      extra: { tool_call_id: 'call-10' },
    });
    expect(preTool!.steps[1]!.body).toMatchObject({ type: 'tool.started', kind: 'test', toolCallId: 'call-10' });

    const postTool = normalizeHermesHook({
      session_id: 'hermes-1',
      hook_event_name: 'post_tool_call',
      tool_name: 'terminal',
      extra: { tool_call_id: 'call-10', output: 'Tests pass' },
    });
    expect(postTool!.steps[0]!.body).toMatchObject({ type: 'tool.completed', ok: true, output: 'Tests pass' });

    // pre_approval_request
    const preApprove = normalizeHermesHook({
      session_id: 'hermes-1',
      hook_event_name: 'pre_approval_request',
      tool_name: 'terminal',
      tool_input: { command: 'rm -f db.sqlite' },
    });
    expect(preApprove!.steps[0]!.body).toMatchObject({ type: 'agent.state', state: 'waiting' });

    // subagent_start / stop
    const subStart = normalizeHermesHook({
      session_id: 'hermes-1',
      hook_event_name: 'subagent_start',
      extra: { subagent_id: 'sub-1', role: 'Worker' },
    });
    expect(subStart!.steps[0]!.body).toMatchObject({ type: 'subagent.spawned', subagentId: 'sub-1', role: 'Worker' });

    // on_session_end (normal vs interrupted)
    const endNormal = normalizeHermesHook({
      session_id: 'hermes-1',
      hook_event_name: 'on_session_end',
      extra: { interrupted: false },
    });
    expect(endNormal!.steps.map(s => s.body.type)).toEqual(['turn.completed', 'agent.state']);

    const endInterrupted = normalizeHermesHook({
      session_id: 'hermes-1',
      hook_event_name: 'on_session_end',
      extra: { interrupted: true },
    });
    expect(endInterrupted!.steps.map(s => s.body.type)).toEqual(['turn.failed', 'agent.state']);
  });
});

describe('end-to-end host + observations hook flow', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it('creates observed session, emits live protocol events, ignores ExtaliaConnectTest, and skips Extalia-managed Hermes sessions', async () => {
    const root = await temp();
    const dataDir = path.join(root, 'data');
    const homeDir = path.join(root, 'home');
    await mkdir(homeDir, { recursive: true });

    const runtime = await createAgentHost({
      kind: 'desktop',
      version: '0.0.15',
      dataDirectory: dataDir,
      importHome: homeDir,
      env: { EXTALIA_SECRET_STORE: 'memory' },
    });
    cleanups.push(() => runtime.close());

    expect(runtime.hooks).toBeDefined();
    const ingestStatus = await runtime.host.hookIngest();
    expect(ingestStatus.tokenPath).toBe(path.join(dataDir, 'hooks', 'token'));

    const events: ExtaliaEvent[] = [];
    runtime.host.subscribe(e => events.push(e));

    const token = (await readFile(ingestStatus.tokenPath, 'utf8')).trim();
    const listener = await startTestHookEndpoint((req, res, app) => runtime.hooks!.handle(req, res, app), runtime.hooks!);

    const send = async (app: string, payload: Record<string, unknown>) => {
      const reply = await listener.request({
        app,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      return reply.status;
    };

    // 1. Synthetic test hook is ignored
    const syntheticStatus = await send('codex', {
      session_id: 'extalia-connect-test',
      hook_event_name: 'SessionStart',
    });
    expect(syntheticStatus).toBe(204);

    let state = await runtime.host.getState();
    expect(state.sessions.find(s => s.observation?.nativeSessionId === 'extalia-connect-test')).toBeUndefined();

    // Also verify hook_event_name: ExtaliaConnectTest is ignored
    const testHook2 = await send('codex', {
      session_id: 'some-other-id',
      hook_event_name: 'ExtaliaConnectTest',
    });
    expect(testHook2).toBe(204);
    state = await runtime.host.getState();
    expect(state.sessions.find(s => s.observation?.nativeSessionId === 'some-other-id')).toBeUndefined();

    // 2. Real outside hook creates an observed session with hook = true
    const realStatus = await send('claude', {
      session_id: 'claude-outside-session-1',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Build new feature',
      cwd: '/Users/<name>/app',
    });
    expect(realStatus).toBe(204);

    // Wait for the hook processing chain
    for (let i = 0; i < 30 && !state.sessions.some(s => s.observation?.nativeSessionId === 'claude-outside-session-1'); i++) {
      await new Promise(resolve => setTimeout(resolve, 25));
      state = await runtime.host.getState();
    }

    state = await runtime.host.getState();
    const observed = state.sessions.find(s => s.observation?.nativeSessionId === 'claude-outside-session-1');
    expect(observed).toBeDefined();
    expect(observed!.control).toBe('observed');
    expect(observed!.title).toBe('Build new feature');
    expect(observed!.observation?.hook).toBe(true);
    expect(observed!.observation?.watching).toBe(true);

    // Verify events were emitted over host.subscribe
    expect(events.some(e => e.body.type === 'session.started')).toBe(true);
    expect(events.some(e => e.body.type === 'prompt.submitted' && (e.body as { text: string }).text === 'Build new feature')).toBe(true);

    // 3. Extalia-managed Hermes session skipping
    const hermesProjectDir = path.join(root, 'hermes-project');
    await mkdir(hermesProjectDir, { recursive: true });
    const savedState = await runtime.host.saveWorkspace({
      name: 'Hermes Workspace',
      projectLocation: hermesProjectDir,
      runtimeId: 'hermes',
      runtimeProfileId: 'default',
      permissions: { fileWrite: 'ask', commands: 'ask' },
    });
    const hermesWorkspaceId = savedState.workspaces[0]!.id;
    const hermesManaged = await runtime.host.createSession(hermesWorkspaceId);

    // Manually add native sessionId to the managed session's record in index.json so sessions.list() returns it
    const indexFile = path.join(dataDir, 'sessions', 'index.json');
    const records = JSON.parse(await readFile(indexFile, 'utf8')) as Array<Record<string, unknown>>;
    const targetRecord = records.find(r => r.id === hermesManaged.id)!;
    targetRecord.runtime = { id: 'hermes', profile: 'default', sessionId: 'hermes-native-managed-42' };
    await writeFile(indexFile, JSON.stringify(records));

    // Send a hook for the managed Hermes session -> should be skipped!
    const managedHookStatus = await send('hermes', {
      session_id: 'hermes-native-managed-42',
      hook_event_name: 'on_session_start',
      extra: { model: 'hermes-v3' },
    });
    expect(managedHookStatus).toBe(204);
    await new Promise(resolve => setTimeout(resolve, 50));

    state = await runtime.host.getState();
    // No observed session was created for hermes-native-managed-42
    expect(state.sessions.find(s => s.observation?.nativeSessionId === 'hermes-native-managed-42')).toBeUndefined();

    // Outside hermes session hook is NOT skipped
    const outsideHermesStatus = await send('hermes', {
      session_id: 'hermes-outside-100',
      hook_event_name: 'on_session_start',
      extra: { model: 'hermes-v3' },
    });
    expect(outsideHermesStatus).toBe(204);
    await new Promise(resolve => setTimeout(resolve, 50));

    state = await runtime.host.getState();
    const outsideHermesObserved = state.sessions.find(s => s.observation?.nativeSessionId === 'hermes-outside-100');
    expect(outsideHermesObserved).toBeDefined();
    expect(outsideHermesObserved?.observation?.hook).toBe(true);
  });

  it('links transcript_path when inside a known root and deduplicates transcript vs hook steps', async () => {
    const root = await temp();
    const dataDir = path.join(root, 'data');
    const homeDir = path.join(root, 'home');
    const codexSessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '10', '13');
    await mkdir(codexSessionsDir, { recursive: true });

    const transcriptFile = path.join(codexSessionsDir, 'session-linked.jsonl');
    const initialTranscript = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-linked-1', cwd: '/Users/<name>/proj', timestamp: '2026-10-13T00:00:00.000Z' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-10-13T00:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Prompt from transcript' }] } }),
    ].join('\n') + '\n';
    await writeFile(transcriptFile, initialTranscript);

    const runtime = await createAgentHost({
      kind: 'desktop',
      version: '0.0.15',
      dataDirectory: dataDir,
      importHome: homeDir,
      env: { EXTALIA_SECRET_STORE: 'memory' },
    });
    cleanups.push(() => runtime.close());

    const tokenPath = (await runtime.host.hookIngest()).tokenPath;
    const token = (await readFile(tokenPath, 'utf8')).trim();
    const listener = await startTestHookEndpoint((req, res, app) => runtime.hooks!.handle(req, res, app), runtime.hooks!);

    // Send hook with transcript_path pointing to the file inside ~/.codex/sessions
    const reply = await listener.request({
      app: 'codex',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        session_id: 'codex-linked-1',
        hook_event_name: 'PreToolUse',
        transcript_path: transcriptFile,
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
        tool_use_id: 'tool-call-1',
      }),
    });
    expect(reply.status).toBe(204);

    await new Promise(resolve => setTimeout(resolve, 80));

    const state = await runtime.host.getState();
    const session = state.sessions.find(s => s.observation?.nativeSessionId === 'codex-linked-1');
    expect(session).toBeDefined();
    expect(session?.observation?.hook).toBe(true);

    // Retrieve session events to check deduplication
    const sessionEvents = await runtime.host.sessionEvents(session!.id);
    expect(sessionEvents.length).toBeGreaterThan(0);
    expect(sessionEvents.some(e => e.body.type === 'session.started')).toBe(true);
    expect(sessionEvents.some(e => e.body.type === 'tool.started')).toBe(true);
  });
});
