import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TranscriptStep } from '@extalia/importers';
import { normalizeAntigravityHook, normalizeClaudeHook, normalizeCodexHook, normalizeGeminiHook, normalizeHermesHook } from '../src/hooks/normalize.js';
import { transcriptEvents } from '../src/transcriptEvents.js';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const cwd = '/projects/example';
const at = '2026-11-08T00:00:00.000Z';
const files = (steps: ReturnType<typeof normalizeCodexHook>) => steps?.steps.map(step => step.body).filter(body => body.type === 'file.written');

describe('observed changed-file evidence', () => {
  it.each([
    ['Codex', normalizeCodexHook, 'PostToolUse', 'apply_patch', { diff: '*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@\n-a\n+b\n*** Update File: tests/a.ts\n@@\n-a\n+b\n*** End Patch' }, { success: true }, [
      { path: 'src/old.ts', change: 'delete' }, { path: 'src/new.ts', change: 'add' }, { path: 'tests/a.ts', change: 'update' },
    ]],
    ['Claude Code', normalizeClaudeHook, 'PostToolUse', 'Edit', { file_path: `${cwd}/src/same.ts` }, { success: true }, [{ path: 'src/same.ts', change: 'update' }]],
    ['Gemini CLI', normalizeGeminiHook, 'AfterTool', 'write_file', { file_path: `${cwd}/docs/guide.txt`, content: 'example' }, { success: true }, [{ path: 'docs/guide.txt', change: 'update' }]],
  ] as const)('%s reports confirmed paths from its completion hook', (_label, normalize, event, tool, input, response, expected) => {
    const result = normalize({ session_id: 'file-session', hook_event_name: event, cwd, tool_name: tool, tool_input: input, tool_response: response, tool_use_id: 'edit-1' });
    expect(files(result)).toEqual(expected.map(file => ({ type: 'file.written', ...file, toolCallId: 'edit-1' })));
  });

  it('recalls Antigravity input by step and reports the same explicit path', () => {
    normalizeAntigravityHook({ conversationId: 'ag-files', hook_event_name: 'PreToolUse', stepIdx: 4, workspacePaths: [cwd], toolCall: { name: 'default_api:replace_file_content', args: { TargetFile: `${cwd}/src/a.ts` } } });
    const result = normalizeAntigravityHook({ conversationId: 'ag-files', hook_event_name: 'PostToolUse', stepIdx: 4, workspacePaths: [cwd], toolOutput: { success: true } });
    expect(files(result)).toEqual([{ type: 'file.written', path: 'src/a.ts', change: 'update', toolCallId: 'step-4' }]);
  });

  it('tracks Antigravity write_file and edit_file hooks with Path and multiple parallel tool calls in one stepIdx', () => {
    normalizeAntigravityHook({
      conversationId: 'ag-parallel',
      hook_event_name: 'PreToolUse',
      stepIdx: 7,
      workspacePaths: [cwd],
      toolCall: { name: 'default_api:write_file', args: { Path: `${cwd}/src/created.ts`, Content: 'export const x = 1;\n' } },
    });
    normalizeAntigravityHook({
      conversationId: 'ag-parallel',
      hook_event_name: 'PreToolUse',
      stepIdx: 7,
      workspacePaths: [cwd],
      toolCall: { name: 'default_api:edit_file', args: { Path: `${cwd}/src/updated.ts`, Target: 'old', Replacement: 'new' } },
    });
    const firstPost = normalizeAntigravityHook({
      conversationId: 'ag-parallel',
      hook_event_name: 'PostToolUse',
      stepIdx: 7,
      toolOutput: 'Created file',
    });
    const secondPost = normalizeAntigravityHook({
      conversationId: 'ag-parallel',
      hook_event_name: 'PostToolUse',
      stepIdx: 7,
      toolOutput: 'Made 1 replacement',
    });
    expect(files(firstPost)).toEqual([{ type: 'file.written', path: 'src/created.ts', change: 'add', toolCallId: 'step-7' }]);
    expect(files(secondPost)).toEqual([{ type: 'file.written', path: 'src/updated.ts', change: 'update', toolCallId: 'step-7-2' }]);
  });

  it('recalls Gemini CLI BeforeTool input when AfterTool omits tool_input or cwd', () => {
    normalizeGeminiHook({
      session_id: 'gem-recall',
      hook_event_name: 'BeforeTool',
      cwd,
      tool_name: 'replace',
      tool_call_id: 'gem-call-1',
      tool_input: { file_path: `${cwd}/src/geminiEdited.ts`, old_string: 'a', new_string: 'b' },
    });
    const after = normalizeGeminiHook({
      session_id: 'gem-recall',
      hook_event_name: 'AfterTool',
      tool_call_id: 'gem-call-1',
      tool_response: { success: true },
    });
    expect(files(after)).toEqual([{ type: 'file.written', path: 'src/geminiEdited.ts', change: 'update', toolCallId: 'gem-call-1' }]);
  });

  it('supports Hermes structured output and labels-only privacy without leaking file content', () => {
    const result = normalizeHermesHook({ session_id: 'hermes-files', hook_event_name: 'post_tool_call', cwd, tool_name: 'write_file', tool_input: { path: `${cwd}/src/a.ts`, content: 'private-content' }, extra: { tool_call_id: 'h1', result: JSON.stringify({ success: true, files_modified: [`${cwd}/src/a.ts`, `${cwd}/tests/a.ts`] }) } }, { labelsOnly: true });
    expect(files(result)).toEqual([
      { type: 'file.written', path: 'src/a.ts', change: 'update', toolCallId: 'h1' },
      { type: 'file.written', path: 'tests/a.ts', change: 'update', toolCallId: 'h1' },
    ]);
    expect(JSON.stringify(result)).not.toContain('private-content');
  });

  it.each([normalizeCodexHook, normalizeClaudeHook, normalizeGeminiHook])('never reports pending, failed or read calls as writes', normalize => {
    const base = { session_id: 'no-files', cwd, tool_input: { file_path: `${cwd}/a.ts` } };
    expect(files(normalize({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit' }))).toEqual([]);
    expect(files(normalize({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_response: { success: false } }))).toEqual([]);
    expect(files(normalize({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_response: 'Error: permission denied' }))).toEqual([]);
    expect(files(normalize({ ...base, hook_event_name: 'AfterTool', tool_name: 'Edit', tool_response: { llmContent: 'Failed to write: permission denied' } }))).toEqual([]);
    expect(files(normalize({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: { success: true } }))).toEqual([]);
  });

  it('does not turn failed Hermes or Antigravity edits into write evidence', () => {
    expect(files(normalizeHermesHook({ session_id: 'hermes-failed', hook_event_name: 'post_tool_call', cwd, tool_name: 'write_file', tool_input: { path: 'failed.txt' }, extra: { result: JSON.stringify({ success: false, error: 'Permission denied' }) } }))).toEqual([]);
    expect(files(normalizeHermesHook({ session_id: 'hermes-plain-failed', hook_event_name: 'post_tool_call', cwd, tool_name: 'write_file', tool_input: { path: 'failed.txt' }, extra: { result: 'Error: permission denied' } }))).toEqual([]);
    const input = { conversationId: 'ag-failed', stepIdx: 9, cwd, toolCall: { name: 'write_to_file', args: { TargetFile: 'failed.txt' } } };
    normalizeAntigravityHook({ ...input, hook_event_name: 'PreToolUse' });
    expect(files(normalizeAntigravityHook({ ...input, hook_event_name: 'PostToolUse', error: 'Permission denied' }))).toEqual([]);
    expect(files(normalizeAntigravityHook({ ...input, hook_event_name: 'PostToolUse', toolOutput: 'Failed to write: permission denied' }))).toEqual([]);
  });

  it('projects successful results once, keeps paths distinct, and scopes identical call IDs to their agents', () => {
    const steps: TranscriptStep[] = [
      { pos: '1', type: 'tool.call', tool: 'Edit', callId: 'same', files: [{ path: `${cwd}/src/a.ts`, change: 'update' }] },
      { pos: '2', type: 'tool.call', tool: 'Edit', callId: 'same', agentId: 'worker', files: [{ path: `${cwd}/tests/a.ts`, change: 'update' }] },
      { pos: '3', type: 'tool.result', callId: 'same', agentId: 'worker', ok: false },
      { pos: '4', type: 'tool.result', callId: 'same', ok: true },
      { pos: '5', type: 'tool.result', callId: 'same', ok: true },
      { pos: '6', type: 'tool.call', tool: 'Write', callId: 'pending', files: [{ path: 'pending.ts', change: 'add' }] },
      { pos: '7', type: 'tool.call', tool: 'Write', callId: 'unknown', files: [{ path: 'unknown.ts', change: 'update' }] },
      { pos: '8', type: 'tool.result', callId: 'unknown', ok: true, writesConfirmed: false, output: 'Unrecognized tool result' },
    ];
    const input = { sessionId: 'observed-files', runtime: 'claude', title: 'Example', createdAt: at, cwd, steps };
    const result = transcriptEvents(input);
    expect(result.filter(event => event.body.type === 'file.written').map(event => [event.agentId, event.body])).toEqual([
      ['primary', { type: 'file.written', path: 'src/a.ts', change: 'update', toolCallId: 'same' }],
    ]);
    expect(transcriptEvents(input).map(event => event.id)).toEqual(result.map(event => event.id));
  });

  it('merges hook and transcript file evidence once in the original observed session', async () => {
    const root = await temp(), home = path.join(root, 'home');
    const folder = path.join(home, '.codex', 'sessions');
    await mkdir(folder, { recursive: true });
    const transcript = path.join(folder, 'rollout.jsonl');
    const input = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch';
    const rows = [
      { type: 'session_meta', payload: { id: 'native-files', cwd, timestamp: at } },
      { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix a file' }] } },
      { type: 'response_item', timestamp: at, payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch-1', input } },
      { type: 'response_item', timestamp: at, payload: { type: 'custom_tool_call_output', call_id: 'patch-1', output: 'Success. Updated the following files:\nM src/a.ts' } },
    ];
    await writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const source = await NativeImportService.create({ homeDirectory: home, env: {} });
    const observer = await Observations.create(path.join(root, 'state'), source, () => {}, 60_000);
    try {
      const scan = source.scan(['codex']);
      await observer.observe(scan.scanId, [scan.sessions[0]!.id]);
      const id = observer.summaries()[0]!.id;
      await observer.receiveHook(normalizeCodexHook({ session_id: 'native-files', transcript_path: transcript, cwd, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: input, tool_call_id: 'patch-1', tool_response: { success: true } })!);
      await observer.refresh();
      expect(observer.summaries()).toHaveLength(1);
      const written = observer.events(id).filter(event => event.body.type === 'file.written');
      expect(written.map(event => event.body)).toEqual([{ type: 'file.written', path: 'src/a.ts', change: 'update', toolCallId: 'patch-1' }]);
      expect(written[0]?.sessionId).toBe(id);
    } finally { await observer.close(); }
  });
});
