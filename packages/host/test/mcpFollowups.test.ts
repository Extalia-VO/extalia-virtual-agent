import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureHookToken } from '../src/hooks/files.js';
import { EXTALIA_MCP_TOOLS, handleMcpJsonRpc, normalizeMcpReport } from '../src/hooks/mcp.js';
import { normalizeHook, type HookApp } from '../src/hooks/normalize.js';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const report = { prompts: ['Review the changes', 'Document the result'] };
const payload = (extra: Record<string, unknown> = {}) => ({ session_id: 'native-one', hook_event_name: 'report_followups', tool_input: report, ...extra });

describe('transient cooperative follow-up reports', () => {
  it('advertises bounded lead-only reports and keeps them out of protocol steps', () => {
    expect(EXTALIA_MCP_TOOLS.find(tool => tool.name === 'report_followups')?.inputSchema).toMatchObject({ additionalProperties: false, required: ['prompts'], properties: { agent_id: { const: 'primary' }, prompts: { maxItems: 3, uniqueItems: true } } });
    expect(normalizeMcpReport('report_followups', report)).toEqual({ steps: [], followupPrompts: report.prompts });
    expect(normalizeMcpReport('report_followups', { prompts: [] })).toEqual({ steps: [], followupPrompts: [] });
    expect(normalizeMcpReport('report_followups', report, { labelsOnly: true })).toEqual({ steps: [] });
    expect(normalizeMcpReport('report_followups', { prompts: ['Check api_key=example-secret-value'] })).toEqual({ steps: [], followupPrompts: ['Check api_key=[redacted]'] });
  });
  it.each([null, {}, { prompts: [''] }, { prompts: ['a', ' a '] }, { prompts: ['a\nb'] }, { prompts: ['a\u2028b'] }, { prompts: ['x'.repeat(241)] }, { prompts: ['a', 'b', 'c', 'd'] }, { prompts: ['a'], agent_id: 'worker' }, { prompts: ['a'], surprise: true }])('rejects malformed reports without forwarding %#', async input => {
    expect(normalizeMcpReport('report_followups', input)).toBeUndefined();
    const fetch = vi.fn();
    const response = await handleMcpJsonRpc({ id: 1, method: 'tools/call', params: { name: 'report_followups', arguments: input } }, { extaliaHome: await temp(), fetch });
    expect(response?.result).toMatchObject({ isError: true }); expect(fetch).not.toHaveBeenCalled();
  });
  it.each<HookApp>(['codex', 'claude', 'gemini', 'antigravity', 'hermes'])('normalizes %s metadata, without fake tool activity, and enforces source and actor', app => {
    expect(normalizeHook(app, payload())).toMatchObject({ steps: [], followupPrompts: report.prompts });
    expect(normalizeHook(app, payload({ tool_input: { ...report, session_id: 'foreign' } }))?.followupPrompts).toBeUndefined();
    expect(normalizeHook(app, payload({ agent_id: 'worker' }))?.followupPrompts).toBeUndefined();
    expect(normalizeHook(app, payload(), { labelsOnly: true })?.followupPrompts).toBeUndefined();
    const event = app === 'hermes' ? 'pre_tool_call' : 'PreToolUse';
    const hook = normalizeHook(app, payload({ hook_event_name: event, tool_name: 'mcp__extalia__report_followups', tool_input: { prompts: ['invalid\ntext'] } }));
    expect(hook?.steps).toEqual([]);
  });
  it('forwards authenticated reports only for the configured calling session', async () => {
    const extaliaHome = await temp(); const token = await ensureHookToken(extaliaHome);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const call = (args: unknown) => handleMcpJsonRpc({ id: 1, method: 'tools/call', params: { name: 'report_followups', arguments: args } }, { extaliaHome, sessionId: 'native-one', fetch });
    expect((await call({ ...report, session_id: 'foreign' }))?.result).toMatchObject({ isError: true });
    expect(fetch).not.toHaveBeenCalled();
    expect((await call(report))?.result).toMatchObject({ isError: false });
    const init = fetch.mock.calls[0]![1]!;
    expect(init.headers).toMatchObject({ authorization: `Bearer ${token}` });
    expect(JSON.parse(init.body as string)).toMatchObject({ session_id: 'native-one', hook_event_name: 'report_followups', tool_input: report });
  });
  it('accepts only existing watched lead sources without creating activity or durable text', async () => {
    const root = await temp(); const homeDirectory = path.join(root, 'home'); await mkdir(homeDirectory);
    const source = await NativeImportService.create({ homeDirectory, env: {} });
    const emitted = vi.fn(), onFollowups = vi.fn();
    const observer = await Observations.create(path.join(root, 'state'), source, emitted, 60_000, { onFollowups });
    const send = (extra: Record<string, unknown> = {}) => observer.receiveHook(normalizeHook('codex', payload(extra))!);
    try {
      await send(); expect(observer.summaries()).toEqual([]); expect(onFollowups).not.toHaveBeenCalled();
      await observer.receiveHook(normalizeHook('codex', { session_id: 'native-one', hook_event_name: 'SessionStart' })!);
      const id = observer.summaries()[0]!.id; const before = observer.events(id); emitted.mockClear();
      const saved = await readFile(path.join(root, 'state', 'observations.json'), 'utf8').catch(() => '');
      await send(); expect(onFollowups).toHaveBeenCalledExactlyOnceWith(id, report.prompts); expect(emitted).not.toHaveBeenCalled();
      expect(observer.events(id)).toEqual(before);
      expect(await readFile(path.join(root, 'state', 'observations.json'), 'utf8').catch(() => '')).toBe(saved);
      await send({ session_id: 'foreign' }); expect(observer.summaries()).toHaveLength(1); expect(onFollowups).toHaveBeenCalledTimes(1);
      await observer.setWatching(id, false); await send(); expect(onFollowups).toHaveBeenCalledTimes(1);
      await observer.setWatching(id, true); await observer.setPrivacy({ labelsOnly: true }); await send(); expect(onFollowups).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(observer.events(id))).not.toContain(report.prompts[0]);
    } finally { await observer.close(); }
  });
});
