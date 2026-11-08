import { describe, expect, it } from 'vitest';
import { parseAntigravity, parseClaude, parseCodex, parseGemini, parseHermes, type ParseContext, type TranscriptStep } from '../src/index.js';

const T = '2026-10-08T00:00:00.000Z';
const T1 = '2026-10-08T00:00:01.000Z';
const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n');
const context = (sourceId: ParseContext['sourceId']): ParseContext => ({ sourceId, exportedAt: T2 });
const T2 = '2026-10-08T00:00:02.000Z';
const calls = (steps: TranscriptStep[] | undefined) => (steps ?? []).filter((step): step is Extract<TranscriptStep, { type: 'tool.call' }> => step.type === 'tool.call');
const results = (steps: TranscriptStep[] | undefined) => (steps ?? []).filter((step): step is Extract<TranscriptStep, { type: 'tool.result' }> => step.type === 'tool.result');

describe('observed file candidates in native transcript formats', () => {
  it('Codex retains multi-file patch paths and successful matched result', () => {
    const parsed = parseCodex(jsonl(
      { type: 'session_meta', payload: { id: 'codex-files', cwd: '/projects/demo' } },
      { timestamp: T, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Move and update files' }] } },
      { timestamp: T1, type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c1', input: '*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: lib/new.ts\n*** Update File: tests/a.ts\n*** End Patch' } },
      { timestamp: T1, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: '{"success":true,"exit_code":0}' } },
    ), context('codex'));
    expect(calls(parsed.steps)[0]).toMatchObject({ callId: 'c1', files: [
      { path: 'src/old.ts', change: 'delete' }, { path: 'lib/new.ts', change: 'add' }, { path: 'tests/a.ts', change: 'update' },
    ] });
    expect(results(parsed.steps)[0]).toMatchObject({ callId: 'c1', ok: true });
    const failed = parseCodex(jsonl(
      { type: 'session_meta', payload: { id: 'codex-failed' } },
      { timestamp: T, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Patch file' }] } },
      { timestamp: T1, type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'cf', input: '*** Begin Patch\n*** Update File: src/file.ts\n*** End Patch' } },
      { timestamp: T1, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'cf', output: 'Failed to apply patch: permission denied' } },
    ), context('codex'));
    expect(results(failed.steps)[0]).toMatchObject({ ok: false, writesConfirmed: false });
  });

  it('Claude retains Write, Edit and MultiEdit paths, and marks structured tool errors as failed', () => {
    const row = (uuid: string, type: string, message: unknown, timestamp = T) => ({ uuid, type, sessionId: 'claude-files', cwd: '/projects/demo', timestamp, message });
    const parsed = parseClaude(jsonl(
      row('u', 'user', { role: 'user', content: 'Edit files' }),
      row('a', 'assistant', { role: 'assistant', content: [
        { type: 'tool_use', id: 'w', name: 'Write', input: { file_path: 'src/new.ts' } },
        { type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: 'src/existing.ts' } },
        { type: 'tool_use', id: 'm', name: 'MultiEdit', input: { edits: [{ file_path: 'tests/one.ts' }, { file_path: 'tests/two.ts' }] } },
      ] }, T1),
      row('r', 'user', { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'w', content: '{"success":true}' },
        { type: 'tool_result', tool_use_id: 'e', content: '{"error":"write failed"}' },
        { type: 'tool_result', tool_use_id: 'm', content: 'done' },
      ] }, T2),
    ), context('claude-code'));
    expect(calls(parsed.steps).map(step => [step.callId, step.files])).toEqual([
      ['w', [{ path: 'src/new.ts', change: 'update' }]], ['e', [{ path: 'src/existing.ts', change: 'update' }]],
      ['m', [{ path: 'tests/one.ts', change: 'update' }, { path: 'tests/two.ts', change: 'update' }]],
    ]);
    expect(results(parsed.steps).map(step => [step.callId, step.ok])).toEqual([['w', true], ['e', false], ['m', true]]);
    expect(results(parsed.steps).find(step => step.callId === 'e')?.writesConfirmed).toBe(false);
    const pending = parseClaude(jsonl(row('u2', 'user', { role: 'user', content: 'Create file' }), row('a2', 'assistant', { role: 'assistant', content: [{ type: 'tool_use', id: 'pending', name: 'Write', input: { file_path: 'src/pending.ts' } }] }, T1)), context('claude-code'));
    expect(calls(pending.steps)[0]?.files).toEqual([{ path: 'src/pending.ts', change: 'update' }]);
    expect(results(pending.steps)).toEqual([]);
  });

  it('Gemini retains write_file and replace paths and lets structured failure override success status', () => {
    const parsed = parseGemini(JSON.stringify({ sessionId: 'gemini-files', projectHash: 'hash', messages: [
      { id: 'u', type: 'user', timestamp: T, content: 'Update files' },
      { id: 'a', type: 'gemini', timestamp: T1, content: '', toolCalls: [
        { id: 'w', name: 'write_file', args: { file_path: '/projects/demo/docs/a.md' }, status: 'success', result: [{ functionResponse: { response: { success: true, files_modified: ['/projects/demo/docs/a.md'] } } }] },
        { id: 'r', name: 'replace', args: { path: 'src/b.ts' }, status: 'success', result: [{ functionResponse: { response: { success: false, error: 'replace failed', files_modified: ['src/b.ts'] } } }] },
        { id: 'p', name: 'write_file', args: { path: 'src/pending.ts' }, status: 'success' },
      ] },
    ] }), { ...context('gemini-cli'), projectPath: '/projects/demo' });
    expect(calls(parsed.steps).map(step => [step.callId, step.files])).toEqual([
      ['w', [{ path: 'docs/a.md', change: 'update' }]], ['r', [{ path: 'src/b.ts', change: 'update' }]],
      ['p', [{ path: 'src/pending.ts', change: 'update' }]],
    ]);
    expect(results(parsed.steps).map(step => [step.callId, step.ok])).toEqual([['w', true], ['r', false]]);
    expect(results(parsed.steps).find(step => step.callId === 'r')?.writesConfirmed).toBe(false);
    expect(calls(parsed.steps).find(step => step.callId === 'p')?.files).toEqual([{ path: 'src/pending.ts', change: 'update' }]);
  });

  it('Hermes maps result files through call IDs when the result omits tool_name', () => {
    const seconds = Date.parse(T) / 1000;
    const parsed = parseHermes({ id: 'hermes-files', cwd: '/projects/demo', started_at: seconds }, [
      { id: 1, role: 'user', content: 'Write a file', timestamp: seconds },
      { id: 2, role: 'assistant', timestamp: seconds + 1, content: '', tool_calls: '[{"id":"h1","function":{"name":"write_file","arguments":"{\\"path\\":\\"src/new.ts\\"}"}}]' },
      { id: 3, role: 'tool', timestamp: seconds + 1, tool_call_id: 'h1', content: '\u0000json:{"success":true,"files_created":["src/new.ts"],"files_modified":["tests/a.ts"]}' },
    ], context('hermes'));
    expect(calls(parsed.steps)[0]).toMatchObject({ callId: 'h1', files: [{ path: 'src/new.ts', change: 'update' }] });
    expect(results(parsed.steps)[0]).toMatchObject({ callId: 'h1', tool: 'write_file', ok: true, files: [
      { path: 'src/new.ts', change: 'add' }, { path: 'tests/a.ts', change: 'update' },
    ] });
    const failed = parseHermes({ id: 'hermes-failed', cwd: '/projects/demo', started_at: seconds }, [
      { id: 1, role: 'user', content: 'Write a file', timestamp: seconds },
      { id: 2, role: 'assistant', timestamp: seconds + 1, content: '', tool_calls: '[{"id":"h2","function":{"name":"write_file","arguments":"{\\"path\\":\\"src/fail.ts\\"}"}}]' },
      { id: 3, role: 'tool', timestamp: seconds + 1, tool_call_id: 'h2', content: '\u0000json:{"success":false,"files_created":["src/fail.ts"],"error":"write failed"}' },
    ], context('hermes'));
    expect(results(failed.steps)[0]).toMatchObject({ ok: false, writesConfirmed: false, files: [{ path: 'src/fail.ts', change: 'add' }] });
  });

  it('Antigravity retains replacement paths, matches results, and leaves pending calls uncompleted', () => {
    const parsed = parseAntigravity(jsonl(
      { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: T, content: 'Replace files' },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T1, tool_calls: [
        { id: 'a1', name: 'default_api:replace_file_content', args: { TargetFile: '/projects/demo/src/a.ts' } },
        { id: 'a2', name: 'default_api:multi_replace_file_content', args: { operations: [{ TargetFile: '/projects/demo/tests/a.ts' }] } },
      ] },
      { step_index: 3, source: 'SYSTEM', type: 'TOOL_RESPONSE', status: 'DONE', created_at: T1, content: ['changed'] },
      { step_index: 4, source: 'SYSTEM', type: 'TOOL_RESPONSE', status: 'DONE', created_at: T1, content: ['changed'] },
      { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T2, tool_calls: [
        { id: 'a3', name: 'default_api:replace_file_content', args: { TargetFile: '/projects/demo/src/fail.ts' } },
      ] },
      { step_index: 6, source: 'SYSTEM', type: 'TOOL_RESPONSE', status: 'ERROR', created_at: T2, content: ['Error: failed'] },
    ), { ...context('antigravity'), nativeSessionId: 'antigravity-files', projectPath: '/projects/demo' });
    expect(calls(parsed.steps).map(step => [step.callId, step.files])).toEqual([
      ['a1', [{ path: 'src/a.ts', change: 'update' }]], ['a2', [{ path: 'tests/a.ts', change: 'update' }]], ['a3', [{ path: 'src/fail.ts', change: 'update' }]],
    ]);
    expect(results(parsed.steps).map(step => [step.callId, step.ok, step.writesConfirmed])).toEqual([['a1', true, true], ['a2', true, true], ['a3', false, false]]);
  });
});
