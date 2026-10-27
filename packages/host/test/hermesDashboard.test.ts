import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ExtaliaEvent } from '@extalia/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAgentHost,
  DEFAULT_HERMES_DASHBOARD_URL,
  EXTALIA_MCP_INSTRUCTION,
  EXTALIA_MCP_TOOLS,
  HermesDashboardClient,
  normalizeMcpReport,
  parseHermesDashboardUrl,
} from '../src/index.js';
import { normalizeClaudeHook, normalizeCodexHook, normalizeHermesHook } from '../src/hooks/normalize.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();

describe('Hermes dashboard read source (D3)', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it('accepts only plain-HTTP loopback URLs and rejects remote hosts, credentials, and paths', () => {
    expect(parseHermesDashboardUrl('http://127.0.0.1:9119')).toBe('http://127.0.0.1:9119');
    expect(parseHermesDashboardUrl('http://localhost:9119/')).toBe('http://localhost:9119');
    expect(parseHermesDashboardUrl('http://[::1]:9119')).toBe('http://[::1]:9119');
    expect(parseHermesDashboardUrl('http://127.0.0.1')).toBe(DEFAULT_HERMES_DASHBOARD_URL);

    expect(() => parseHermesDashboardUrl('')).toThrow(/Enter the local Hermes dashboard URL/);
    expect(() => parseHermesDashboardUrl('https://127.0.0.1:9119')).toThrow(/must use http:\/\//);
    expect(() => parseHermesDashboardUrl('http://example.com:9119')).toThrow(/must point to this computer/);
    expect(() => parseHermesDashboardUrl('http://user:pass@127.0.0.1:9119')).toThrow(/must not include credentials/);
    expect(() => parseHermesDashboardUrl('http://127.0.0.1:9119/api')).toThrow(/root Hermes dashboard URL/);
  });

  it('reads /api/sessions and incrementally polls /api/sessions/{id}/timeline with after_row_id', async () => {
    const requestedUrls: string[] = [];
    const timelineRows = [
      { row_id: 1, role: 'user', content: 'Inspect the repository structure', timestamp: '2026-10-15T01:00:00.000Z' },
      {
        row_id: 2,
        role: 'assistant',
        content: 'Checking files now.',
        timestamp: '2026-10-15T01:00:02.000Z',
        tool_calls: [{ id: 'call-1', function: { name: 'terminal', arguments: JSON.stringify({ command: 'ls -la' }) } }],
      },
      {
        row_id: 3,
        role: 'tool',
        tool_call_id: 'call-1',
        tool_name: 'terminal',
        content: 'README.md\npackage.json',
        timestamp: '2026-10-15T01:00:03.000Z',
      },
    ];

    const client = new HermesDashboardClient({
      baseUrl: 'http://127.0.0.1:9119',
      now: () => Date.parse('2026-10-15T01:05:00.000Z'),
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        requestedUrls.push(url);
        const parsed = new URL(url);
        if (parsed.pathname === '/api/sessions') {
          return new Response(
            JSON.stringify({
              sessions: [
                {
                  id: 'hermes-dash-1',
                  title: 'Audit workspace',
                  cwd: '/Users/<name>/project',
                  profile: 'default',
                  started_at: '2026-10-15T01:00:00.000Z',
                  last_activity_at: '2026-10-15T01:00:05.000Z',
                  message_count: 3,
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (parsed.pathname === '/api/sessions/hermes-dash-1/timeline') {
          const after = Number(parsed.searchParams.get('after_row_id') ?? '0');
          const rows = timelineRows.filter(row => row.row_id > after);
          return new Response(JSON.stringify({ timeline: rows, last_row_id: timelineRows.at(-1)?.row_id ?? after }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      }) as typeof fetch,
    });

    const sessions = await client.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'hermes-dash-1',
      title: 'Audit workspace',
      cwd: '/Users/<name>/project',
      profile: 'default',
      messageCount: 3,
    });

    // First read fetches the full timeline without after_row_id
    const firstRead = await client.readSession('hermes-dash-1');
    expect(firstRead.cursor).toBe(3);
    expect(firstRead.session.title).toBe('Audit workspace');
    expect(firstRead.session.messages).toHaveLength(4); // user, assistant, tool call, tool result
    expect(firstRead.steps.map(step => step.type)).toEqual(['prompt', 'reply', 'tool.call', 'tool.result']);
    expect(requestedUrls).toContain('http://127.0.0.1:9119/api/sessions/hermes-dash-1/timeline');

    // Append a final reply row and poll again -> uses ?after_row_id=3
    timelineRows.push({
      row_id: 4,
      role: 'assistant',
      content: 'Repository structure looks clean.',
      timestamp: '2026-10-15T01:00:06.000Z',
    });

    const secondRead = await client.readSession('hermes-dash-1');
    expect(secondRead.cursor).toBe(4);
    expect(requestedUrls.at(-1)).toBe('http://127.0.0.1:9119/api/sessions/hermes-dash-1/timeline?after_row_id=3');
    expect(secondRead.session.messages.at(-1)?.content).toBe('Repository structure looks clean.');
  });

  it('integrates setHookPrivacy (labelsOnly and hermesDashboardUrl) end-to-end with AgentHost and Observations', async () => {
    const root = await temp();
    const dataDir = path.join(root, 'data');
    const homeDir = path.join(root, 'home');
    await mkdir(homeDir, { recursive: true });

    const nowIso = new Date().toISOString();
    const runtime = await createAgentHost({
      kind: 'bridge',
      version: '0.0.17',
      dataDirectory: dataDir,
      importHome: homeDir,
      env: { EXTALIA_SECRET_STORE: 'memory' },
      fetch: async (url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/sessions') {
          return new Response(
            JSON.stringify({
              sessions: [
                {
                  id: 'dash-live-session',
                  title: 'Dashboard task',
                  cwd: '/Users/<name>/dash-app',
                  started_at: nowIso,
                  last_activity_at: nowIso,
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (parsed.pathname === '/api/sessions/dash-live-session/timeline') {
          return new Response(
            JSON.stringify({
              timeline: [
                { row_id: 1, role: 'user', content: 'Sensitive prompt via dashboard', timestamp: nowIso },
                {
                  row_id: 2,
                  role: 'assistant',
                  content: 'Running build',
                  timestamp: nowIso,
                  tool_calls: [{ id: 'c1', function: { name: 'terminal', arguments: JSON.stringify({ command: 'pnpm build' }) } }],
                },
              ],
              last_row_id: 2,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('Not found', { status: 404 });
      },
    });
    cleanups.push(() => runtime.close());

    const emitted: ExtaliaEvent[] = [];
    runtime.host.subscribe(event => emitted.push(event));

    // Configure labelsOnly: true and hermesDashboardUrl via host.setHookPrivacy
    const ingest = await runtime.host.setHookPrivacy({
      labelsOnly: true,
      hermesDashboardUrl: 'http://127.0.0.1:9119',
    });
    expect(ingest.labelsOnly).toBe(true);
    expect(ingest.hermesDashboardUrl).toBe('http://127.0.0.1:9119');

    const state = await runtime.host.getState();
    const dashSession = state.sessions.find(s => s.observation?.nativeSessionId === 'dash-live-session');
    expect(dashSession).toBeDefined();
    expect(dashSession?.title).toBe('Dashboard task');

    const events = await runtime.host.sessionEvents(dashSession!.id);
    // Because labelsOnly is true, prompt.submitted and model.completed are omitted while tool.started is kept
    expect(events.some(e => e.body.type === 'prompt.submitted')).toBe(false);
    expect(events.some(e => e.body.type === 'model.completed')).toBe(false);
    expect(events.some(e => e.body.type === 'tool.started')).toBe(true);
    expect(emitted.some(e => e.sessionId === dashSession!.id && e.body.type === 'tool.started')).toBe(true);
  });
});

describe('MCP reporting (Phase E) and labelsOnly privacy option', () => {
  it('exposes report_intent and report_handoff MCP tool definitions and normalizes their payloads', () => {
    expect(EXTALIA_MCP_TOOLS.map(t => t.name)).toEqual(['report_intent', 'report_handoff']);
    expect(EXTALIA_MCP_INSTRUCTION).toContain('report_intent');
    expect(EXTALIA_MCP_INSTRUCTION).toContain('report_handoff');

    const intent = normalizeMcpReport('report_intent', {
      intent: 'Refactoring authentication middleware',
      activity: 'edit',
      target: 'src/auth.ts',
    });
    expect(intent?.steps).toEqual([
      {
        agentId: 'primary',
        body: {
          type: 'agent.state',
          state: 'working',
          activity: 'edit',
          summary: 'Refactoring authentication middleware',
          target: 'src/auth.ts',
        },
      },
    ]);

    const handoff = normalizeMcpReport('report_handoff', {
      subagent_id: 'worker-review-1',
      role: 'SecurityReviewer',
      summary: 'Audit token verification',
      state: 'working',
    });
    expect(handoff?.steps.map(s => s.body.type)).toEqual(['subagent.spawned', 'subagent.state']);

    // Also works when invoked as an MCP PreToolUse hook in Codex/Claude/Hermes
    const hookIntent = normalizeCodexHook({
      session_id: 'codex-mcp-1',
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__extalia__report_intent',
      tool_input: { intent: 'Running test suite', activity: 'test', target: 'vitest' },
    });
    expect(hookIntent?.steps).toEqual([
      {
        agentId: 'primary',
        body: {
          type: 'agent.state',
          state: 'working',
          activity: 'test',
          summary: 'Running test suite',
          target: 'vitest',
        },
      },
    ]);
  });

  it('drops prompt text, reply text, and tool output when labelsOnly is true', () => {
    const promptHook = normalizeClaudeHook(
      {
        session_id: 'claude-privacy-1',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Sensitive user prompt text',
      },
      { labelsOnly: true },
    );
    expect(promptHook?.titleHint).toBeUndefined();
    expect(promptHook?.steps).toEqual([{ agentId: 'primary', body: { type: 'agent.state', state: 'thinking' } }]);

    const postTool = normalizeClaudeHook(
      {
        session_id: 'claude-privacy-1',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
        tool_response: { stdout: 'secret output line' },
      },
      { labelsOnly: true },
    );
    expect(postTool?.steps).toHaveLength(1);
    expect((postTool?.steps[0]?.body as { output?: string }).output).toBeUndefined();

    const stopHook = normalizeClaudeHook(
      {
        session_id: 'claude-privacy-1',
        hook_event_name: 'Stop',
        last_assistant_message: 'Private assistant reply',
      },
      { labelsOnly: true },
    );
    expect(stopHook?.steps.map(s => s.body.type)).toEqual(['turn.completed', 'agent.state']);

    const hermesPost = normalizeHermesHook(
      {
        session_id: 'hermes-privacy-1',
        hook_event_name: 'post_tool_call',
        tool_name: 'terminal',
        extra: { output: 'secret hermes output' },
      },
      { labelsOnly: true },
    );
    expect((hermesPost?.steps[0]?.body as { output?: string }).output).toBeUndefined();
  });
});
