import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ensureHookToken } from '../src/hooks/files.js';
import { EXTALIA_MCP_TOOLS, handleMcpJsonRpc, normalizeMcpReport } from '../src/hooks/mcp.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const start = { phase: 'start', meeting_id: 'meeting-1', participants: ['primary', 'worker-1'], room_id: 'meeting-a', topic: 'Review a proposal' };

describe('explicit cooperative meeting MCP reports', () => {
  it('advertises a bounded strict phase schema and never claims to execute meetings', () => {
    const tool = EXTALIA_MCP_TOOLS.find(tool => tool.name === 'report_meeting')!;
    expect(tool.inputSchema).toMatchObject({ additionalProperties: false, required: ['phase', 'meeting_id'], properties: { participants: { maxItems: 14, uniqueItems: true }, round: { enum: [1, 2] } } });
    expect(tool.inputSchema.oneOf).toHaveLength(3);
    expect(tool.description).toContain('does not start agents');
  });
  it('refuses participant groups that cannot fit the requested room', () => {
    const participants = Array.from({ length: 14 }, (_, index) => `member-${index}`);
    expect(normalizeMcpReport('report_meeting', { ...start, room_id: 'meeting-b', participants })).toBeDefined();
    expect(normalizeMcpReport('report_meeting', { ...start, room_id: 'meeting-a', participants })).toBeUndefined();
    expect(normalizeMcpReport('report_meeting', { ...start, room_id: 'meeting-b', participants: [...participants, 'overflow'] })).toBeUndefined();
  });

  it.each([
    null,
    { ...start, phase: 'begin' },
    { ...start, meeting_id: 'x'.repeat(161) },
    { ...start, participants: ['primary', 'primary'] },
    { ...start, participants: ['foreign/id'] },
    { ...start, participants: [] },
    { ...start, participants: Array.from({ length: 33 }, (_, i) => `worker-${i}`) },
    { ...start, room_id: 'lounge' },
    { ...start, topic: 42 },
    { ...start, text: 'Unsupported for start' },
    { ...start, session_id: 'bad\nsession' },
    { ...start, app: 'claude' },
    { phase: 'contribution', meeting_id: 'meeting-1', round: 1, text: 'Missing actor' },
    { phase: 'contribution', meeting_id: 'meeting-1', agent_id: 'worker-1', round: 3, text: 'Wrong round' },
    { phase: 'contribution', meeting_id: 'meeting-1', agent_id: 'worker-1', round: 1, text: ' ' },
    { phase: 'contribution', meeting_id: 'meeting-1', agent_id: 'worker-1', round: 1, text: 'x'.repeat(20001) },
    { phase: 'complete', meeting_id: 'meeting-1', outcome: 'success' },
    { phase: 'complete', meeting_id: 'meeting-1', decisions: ['Unsupported legacy report field'] },
    { phase: 'complete', meeting_id: 'meeting-1', note_path: 'bad\npath' },
  ])('rejects malformed or phase-inappropriate arguments without forwarding %#', async input => {
    expect(normalizeMcpReport('report_meeting', input)).toBeUndefined();
    const fetch = vi.fn();
    const response = await handleMcpJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'report_meeting', arguments: input } }, { extaliaHome: await temp(), fetch });
    expect(response?.result).toMatchObject({ isError: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('forwards an authenticated source-specific report with its explicit native session and signs Hermes requests', async () => {
    const extaliaHome = await temp();
    const token = await ensureHookToken(extaliaHome);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const args = { ...start, session_id: 'native-1' };
    const response = await handleMcpJsonRpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'report_meeting', arguments: args } }, { extaliaHome, app: 'hermes', port: 4321, fetch });
    expect(response).toMatchObject({ id: 9, result: { isError: false } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:4321/api/hooks/hermes');
    expect(JSON.parse(init?.body as string)).toEqual({ hook_event_name: 'report_meeting', session_id: 'native-1', tool_name: 'report_meeting', tool_input: args });
    expect(init?.headers).toEqual({ 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-hermes-signature-256': `sha256=${createHmac('sha256', token).update(init?.body as string).digest('hex')}` });
    expect(JSON.stringify(response)).not.toContain(token);
  });
});
