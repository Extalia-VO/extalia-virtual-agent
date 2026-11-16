import { describe, expect, it, vi } from 'vitest';
import { ensureHookToken } from '../src/hooks/files.js';
import { EXTALIA_MCP_TOOLS, handleMcpJsonRpc } from '../src/hooks/mcp.js';
import { runObservedCliArchiveReader } from '../src/observedCliArchiveReader.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const accessCode = `sk-extalia-context-${'a'.repeat(64)}`;
const request = (name: string, args: unknown = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

describe('caller-bound continuity-only MCP reader', () => {
  it('advertises exactly two read-only archive tools without caller identity selection', async () => {
    const result = await handleMcpJsonRpc({ id: 1, method: 'tools/list' }, { extaliaHome: await temp(), sessionId: 'bound-native-session', continuityOnly: true });
    const tools = (result?.result as { tools: typeof EXTALIA_MCP_TOOLS }).tools;
    expect(tools.map(tool => tool.name)).toEqual(['extalia_continuity_status', 'extalia_continuity_read']);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties).not.toHaveProperty('session_id');
      expect(tool.inputSchema.required).toContain('access_code');
    }
    // Narrowing one process must not mutate the general server's shared catalog.
    expect(EXTALIA_MCP_TOOLS[0]!.inputSchema.properties).toHaveProperty('session_id');
    const general = await handleMcpJsonRpc({ id: 2, method: 'tools/list' }, { extaliaHome: await temp() });
    expect((general?.result as { tools: unknown[] }).tools).toHaveLength(EXTALIA_MCP_TOOLS.length);
  });

  it.each(['poll_inbox', 'await_reply', 'report_intent', 'report_handoff', 'report_meeting', 'report_followups', 'unknown_tool'])('rejects %s before any host request', async name => {
    const fetch = vi.fn();
    const result = await handleMcpJsonRpc(request(name, { access_code: accessCode }), { extaliaHome: await temp(), continuityOnly: true, sessionId: 'bound-native-session', fetch });
    expect(result?.error).toMatchObject({ code: -32601 });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(accessCode);
  });

  it.each(['status', 'read'] as const)('forwards %s with the bound native conversation and configured app', async operation => {
    const extaliaHome = await temp(), token = await ensureHookToken(extaliaHome);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ status: 'ok', value: { retained: 'original evidence' } }));
    const args = { access_code: accessCode, ...(operation === 'read' ? { snapshot_id: 'snapshot-1', offset: 2, limit: 1 } : {}) };
    const result = await handleMcpJsonRpc(request(`extalia_continuity_${operation}`, args), { extaliaHome, continuityOnly: true, app: 'gemini', sessionId: 'bound-native-session', port: 4321, fetch });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:4321/api/hooks/gemini');
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${token}` });
    expect(JSON.parse(init!.body as string)).toEqual({ operation: 'continuity', session_id: 'bound-native-session', access_code: accessCode, request: operation,
      ...(operation === 'read' ? { snapshot_id: 'snapshot-1', offset: 2, limit: 1 } : {}) });
    expect(result?.result).toMatchObject({ content: [{ type: 'text', text: JSON.stringify({ retained: 'original evidence' }) }] });
    expect(JSON.stringify(result)).not.toContain(accessCode);
  });

  it('rejects a mismatched caller and an unbound caller without forwarding', async () => {
    const extaliaHome = await temp(); await ensureHookToken(extaliaHome);
    const fetch = vi.fn();
    const mismatch = await handleMcpJsonRpc(request('extalia_continuity_status', { access_code: accessCode, session_id: 'another-session' }), { extaliaHome, continuityOnly: true, sessionId: 'bound-native-session', fetch });
    const unbound = await handleMcpJsonRpc(request('extalia_continuity_status', { access_code: accessCode }), { extaliaHome, continuityOnly: true, fetch });
    expect(mismatch?.result).toMatchObject({ isError: true });
    expect(unbound?.result).toMatchObject({ isError: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [], ['--data', 'relative', '--app', 'codex', '--session', 'native'],
    ['--data', '/unused', '--app', 'other', '--session', 'native'],
    ['--data', '/unused', '--app', 'codex', '--session', '../other'],
    ['--data', '/unused', '--data', '/another', '--app', 'codex', '--session', 'native'],
    ['--data', '/unused', '--app', 'codex', '--session'],
    ['--unknown', 'value', '--data', '/unused', '--app', 'codex', '--session', 'native'],
  ].map(args => ({ args })))('refuses malformed archive entry arguments without entering stdio %#', async ({ args }) => {
    expect(await runObservedCliArchiveReader(args)).toBe(2);
  });
});
