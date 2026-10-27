import { describe, expect, it } from 'vitest';
import { commandHead, mergeSubagentSteps, parseAntigravity, parseClaude, parseCodex, parseGemini, parseHermes, toolHints, type ParseContext, type TranscriptStep } from '../src/index.js';

// Synthesized fixtures that follow each provider's shape; no real transcript is used.
const T = '2026-10-08T00:00:00.000Z';
const T1 = '2026-10-08T00:00:01.000Z';
const T2 = '2026-10-08T00:00:02.000Z';
const jsonl = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n');
const context = (sourceId: ParseContext['sourceId']): ParseContext => ({ sourceId, exportedAt: T2 });
const shape = (steps: TranscriptStep[] | undefined) => (steps ?? []).map(step => {
  const { at: _at, text: _text, output: _output, ...rest } = step as TranscriptStep & { text?: string; output?: string };
  return rest;
});

describe('transcript steps', () => {
  it('Codex: prompts, tool calls with targets and exit status, final answers and turn markers; injected context is dropped', () => {
    const result = parseCodex(jsonl(
      { type: 'session_meta', payload: { id: 'codex-steps', cwd: '/projects/demo', timestamp: T } },
      { timestamp: T, type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sandbox rules' }] } },
      { timestamp: T, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/projects/demo</cwd>\n</environment_context>' }] } },
      { timestamp: T, type: 'event_msg', payload: { type: 'user_message', message: 'Fix the test' } },
      { timestamp: T, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the test' }] } },
      { timestamp: T, type: 'turn_context', payload: { model: 'example-model' } },
      { timestamp: T1, type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Running the tests.' }] } },
      { timestamp: T1, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"cmd":"cd app && pnpm test --run","token":"synthetic-secret"}' } },
      { timestamp: T1, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Chunk ID: 1\nProcess exited with code 1\nOutput:\nfailed' } },
      { timestamp: T1, type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: src/app/main.ts\n@@\n-a\n+b\n*** End Patch' } },
      { timestamp: T1, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: '{"output":"Success. Updated the following files:\\nM src/app/main.ts","metadata":{"exit_code":0}}' } },
      { timestamp: T2, type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Fixed.' }] } },
      { timestamp: T2, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Fixed.' } },
    ), context('codex'));
    expect(result.session?.messages.map(message => message.content)).not.toContain(expect.stringContaining('environment_context'));
    expect(result.session?.messages[0]).toMatchObject({ role: 'user', content: 'Fix the test' });
    expect(shape(result.steps)).toEqual([
      { pos: 'L4', type: 'prompt' },
      { pos: 'L6', type: 'reply', model: 'example-model' },
      { pos: 'L7', type: 'tool.call', tool: 'exec_command', callId: 'c1', command: 'pnpm test --run', target: 'pnpm test --run' },
      { pos: 'L8', type: 'tool.result', callId: 'c1', ok: false },
      { pos: 'L9', type: 'tool.call', tool: 'apply_patch', callId: 'c2', target: 'main.ts' },
      { pos: 'L10', type: 'tool.result', callId: 'c2', ok: true },
      { pos: 'L11', type: 'reply', final: true, model: 'example-model' },
      { pos: 'L12', type: 'turn.end', reason: 'completed' },
    ]);
    expect(result.steps?.[5]).toMatchObject({ output: expect.stringContaining('Success.') });
    expect(JSON.stringify(result.steps)).not.toContain('synthetic-secret');
  });

  it('Claude Code: tool_use / tool_result with errors, end_turn, interruptions and meta rows', () => {
    const row = (index: number, type: string, message: unknown, extra: Record<string, unknown> = {}) => ({ type, uuid: `u${index}`, parentUuid: index ? `u${index - 1}` : null, sessionId: 'claude-steps', cwd: '/projects/demo', timestamp: T1, message, ...extra });
    const result = parseClaude(jsonl(
      row(0, 'user', { role: 'user', content: '<command-name>/init</command-name>' }, { isMeta: true }),
      row(1, 'user', { role: 'user', content: 'Read the config' }),
      row(2, 'assistant', { role: 'assistant', model: 'example-model', stop_reason: null, content: [{ type: 'thinking', thinking: 'private' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/projects/demo/config/settings.json' } }] }),
      row(3, 'user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'File not found' }] }),
      row(4, 'assistant', { role: 'assistant', model: 'example-model', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The file is missing.' }] }),
      row(5, 'user', { role: 'user', content: 'Search instead' }),
      row(6, 'assistant', { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'settings' } }] }),
      row(7, 'user', { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }),
    ), context('claude-code'));
    expect(shape(result.steps)).toEqual([
      { pos: 'L1', type: 'prompt' },
      { pos: 'L2.0', type: 'status', status: 'thinking' },
      { pos: 'L2.1', type: 'tool.call', tool: 'Read', callId: 't1', target: 'settings.json' },
      { pos: 'L3.0', type: 'tool.result', callId: 't1', ok: false },
      { pos: 'L4.0', type: 'reply', final: true, model: 'example-model' },
      { pos: 'L5', type: 'prompt' },
      { pos: 'L6.0', type: 'tool.call', tool: 'Grep', callId: 't2', target: 'settings' },
      { pos: 'L7.0', type: 'turn.end', reason: 'interrupted' },
    ]);
    expect(JSON.stringify(result.steps)).not.toContain('private');
  });

  it('Gemini CLI: tool calls with status, final reply without calls', () => {
    const result = parseGemini(JSON.stringify({
      sessionId: 'gemini-steps', projectHash: 'hash', startTime: T,
      messages: [
        { id: 'm1', type: 'user', timestamp: T, content: 'List files' },
        { id: 'm2', type: 'gemini', timestamp: T1, content: 'Listing.', model: 'example-model', toolCalls: [
          { id: 'g1', name: 'run_shell_command', args: { command: 'ls -la src' }, status: 'success', result: [{ functionResponse: { response: { output: 'a.ts' } } }] },
          { id: 'g2', name: 'read_file', args: { absolute_path: '/projects/demo/b.ts' }, status: 'error', result: [{ functionResponse: { response: { error: 'missing' } } }] },
        ] },
        { id: 'm3', type: 'gemini', timestamp: T2, content: 'Done.' },
      ],
    }), context('gemini-cli'));
    expect(shape(result.steps)).toEqual([
      { pos: 'G:m1', type: 'prompt' },
      { pos: 'G:m2', type: 'reply', model: 'example-model' },
      { pos: 'G:m2:c0', type: 'tool.call', tool: 'run_shell_command', callId: 'g1', command: 'ls -la src', target: 'ls -la src' },
      { pos: 'G:m2:r0', type: 'tool.result', tool: 'run_shell_command', callId: 'g1', ok: true },
      { pos: 'G:m2:c1', type: 'tool.call', tool: 'read_file', callId: 'g2', target: 'b.ts' },
      { pos: 'G:m2:r1', type: 'tool.result', tool: 'read_file', callId: 'g2', ok: false },
      { pos: 'G:m3', type: 'reply', final: true },
    ]);
  });

  it('Antigravity: planner steps, PascalCase tool args, tool outputs and final reply', () => {
    const result = parseAntigravity(jsonl(
      { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: T, content: 'Run tests' },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T1, thinking: 'private', tool_calls: [
        { id: 'a1', name: 'default_api:run_command', args: { CommandLine: '"pnpm test"', Cwd: '"/projects/demo"' } },
      ] },
      { step_index: 3, source: 'SYSTEM', type: 'TOOL_RESPONSE', status: 'DONE', created_at: T1, content: ['The command exited with code 0.\nOutput:\npassed'] },
      { step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: T2, content: 'All passed.' },
    ), context('antigravity'));
    expect(shape(result.steps)).toEqual([
      { pos: 'A:1:0', type: 'prompt' },
      { pos: 'A:2:1:t', type: 'status', status: 'thinking' },
      { pos: 'A:2:1:c0', type: 'tool.call', tool: 'run_command', callId: 'a1', command: 'pnpm test', target: 'pnpm test' },
      { pos: 'A:3:2:r0', type: 'tool.result', tool: 'run_command', callId: 'a1', ok: true },
      { pos: 'A:4:3', type: 'reply', final: true },
    ]);
  });

  it('Hermes: assistant tool calls and tool rows keyed by message id', () => {
    const result = parseHermes({ id: 'hermes-steps', title: 'Demo', started_at: Date.parse(T) / 1000 }, [
      { id: 1, session_id: 'hermes-steps', role: 'user', content: 'Check status', timestamp: Date.parse(T) / 1000 },
      { id: 2, session_id: 'hermes-steps', role: 'assistant', content: '', tool_calls: JSON.stringify([{ id: 'h1', function: { name: 'terminal', arguments: '{"command":"git status"}' } }]), timestamp: Date.parse(T1) / 1000 },
      { id: 3, session_id: 'hermes-steps', role: 'tool', tool_call_id: 'h1', tool_name: 'terminal', content: '{"output":"clean","exit_code":0}', timestamp: Date.parse(T1) / 1000 },
      { id: 4, session_id: 'hermes-steps', role: 'assistant', content: 'Clean.', timestamp: Date.parse(T2) / 1000 },
    ], context('hermes'));
    expect(shape(result.steps)).toEqual([
      { pos: 'H:1', type: 'prompt' },
      { pos: 'H:2:c0', type: 'tool.call', tool: 'terminal', callId: 'h1', command: 'git status', target: 'git status' },
      { pos: 'H:3', type: 'tool.result', callId: 'h1', tool: 'terminal', ok: true },
      { pos: 'H:4', type: 'reply', final: true },
    ]);
  });

  it('Claude: a synthetic API failure never turns a stop sequence into a successful final reply', () => {
    const row = {
      type: 'assistant', uuid: 'failure-reply', sessionId: 'claude-failure', cwd: '/projects/demo', timestamp: T,
      message: { role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: 529 overloaded' }] },
    };
    const failed = parseClaude(jsonl({ ...row, isApiErrorMessage: true }), context('claude-code'));
    expect(shape(failed.steps)).toEqual([
      { pos: 'L0.0', type: 'reply' },
      { pos: 'L0.error', type: 'status', status: 'error', reason: 'overloaded' },
    ]);
    const successful = parseClaude(jsonl({ ...row, message: { ...row.message, content: [{ type: 'text', text: 'Done.' }] } }), context('claude-code'));
    expect(shape(successful.steps)).toEqual([{ pos: 'L0.0', type: 'reply', final: true }]);
  });

  it('v0.0.38: states without a message or tool call (reasoning, approvals, compaction, errors)', () => {
    const codex = parseCodex(jsonl(
      { type: 'session_meta', payload: { id: 'codex-status', cwd: '/projects/demo', timestamp: T } },
      { timestamp: T, type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: T, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Deploy' }] } },
      { timestamp: T1, type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'hidden' } },
      { timestamp: T1, type: 'response_item', payload: { type: 'function_call', name: 'update_plan', call_id: 'p1', arguments: '{}' } },
      { timestamp: T1, type: 'event_msg', payload: { type: 'exec_approval_request', command: ['rm', '-rf', 'dist'] } },
      { timestamp: T1, type: 'event_msg', payload: { type: 'apply_patch_approval_request' } },
      { timestamp: T1, type: 'compacted', payload: { message: 'summary' } },
      { timestamp: T2, type: 'event_msg', payload: { type: 'error', message: 'stream failed' } },
      { timestamp: T2, type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } },
    ), context('codex'));
    expect(shape(codex.steps).map(step => step.type === 'status' ? `status:${step.status}` : step.type)).toEqual([
      'status:thinking', 'prompt', 'status:thinking', 'tool.call', 'status:approval', 'status:approval', 'status:compacting', 'status:error', 'turn.end',
    ]);
    expect(JSON.stringify(codex.steps)).not.toContain('hidden');

    const row = (index: number, type: string, message: unknown, extra: Record<string, unknown> = {}) => ({ type, uuid: `u${index}`, parentUuid: index ? `u${index - 1}` : null, sessionId: 'claude-status', cwd: '/projects/demo', timestamp: T1, message, ...extra });
    const claude = parseClaude(jsonl(
      row(0, 'user', { role: 'user', content: 'Refactor' }),
      row(1, 'assistant', { role: 'assistant', model: 'example-model', content: [{ type: 'redacted_thinking', data: 'x' }, { type: 'tool_use', id: 't1', name: 'TodoWrite', input: {} }] }),
      { type: 'system', subtype: 'compact_boundary', sessionId: 'claude-status', timestamp: T1, compactMetadata: { trigger: 'auto' } },
      row(2, 'user', { role: 'user', content: 'This session is being continued from a previous conversation.' }, { isCompactSummary: true }),
      row(3, 'user', { role: 'user', content: '<local-command-stdout>Set model</local-command-stdout>' }),
      row(4, 'assistant', { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: 529 overloaded' }] }, { isApiErrorMessage: true }),
      { type: 'system', subtype: 'compact_boundary', sessionId: 'claude-status', timestamp: T2, compactMetadata: { trigger: 'manual' } },
    ), context('claude-code'));
    expect(shape(claude.steps)).toEqual([
      { pos: 'L0', type: 'prompt' },
      { pos: 'L1.0', type: 'status', status: 'thinking' },
      { pos: 'L1.1', type: 'tool.call', tool: 'TodoWrite', callId: 't1' },
      { pos: 'L2', type: 'status', status: 'compacting' },
      // v0.0.43: a failed request's synthetic reply does not finish the turn; its error says why.
      { pos: 'L5.0', type: 'reply' },
      { pos: 'L5.error', type: 'status', status: 'error', reason: 'overloaded' },
      { pos: 'L6', type: 'turn.end', reason: 'completed' },
    ]);

    const gemini = parseGemini(JSON.stringify({
      sessionId: 'gemini-status', projectHash: 'hash', startTime: T,
      messages: [
        { id: 'm1', type: 'user', timestamp: T, content: 'Plan' },
        { id: 'm2', type: 'gemini', timestamp: T1, content: 'Done.', thoughts: [{ subject: 'hidden', description: 'hidden' }] },
        { id: 'm3', type: 'error', timestamp: T2, content: 'Quota exceeded' },
      ],
    }), context('gemini-cli'));
    expect(shape(gemini.steps)).toEqual([
      { pos: 'G:m1', type: 'prompt' }, { pos: 'G:m2:t', type: 'status', status: 'thinking' }, { pos: 'G:m2', type: 'reply', final: true }, { pos: 'G:m3', type: 'status', status: 'error', reason: 'quota' },
    ]);
    expect(JSON.stringify(gemini.steps)).not.toContain('hidden');
  });

  it('derives short targets only from well-known arguments', () => {
    expect(commandHead('cd /projects/demo && npm run build -- --watch')).toBe('npm run build');
    expect(toolHints('shell', { command: ['bash', '-lc', 'git log -5'] })).toEqual({ command: 'git log -5', target: 'git log -5' });
    expect(toolHints('view_file', { AbsolutePath: '"/projects/demo/src/index.ts"' })).toEqual({ target: 'index.ts' });
    expect(toolHints('WebFetch', { url: 'https://user:pw@example.com/path?q=1' })).toEqual({ target: 'example.com' });
    expect(toolHints('apply_patch', '*** Begin Patch\n*** Add File: a/one.ts\n*** Delete File: b/two.ts\n*** End Patch')).toEqual({ target: 'one.ts +1' });
    expect(toolHints('custom', { anything: 'value' })).toEqual({});
  });
});

describe('sub-agent step merge', () => {
  const lead: TranscriptStep[] = [
    { pos: 'L1', at: '2026-10-08T00:00:00.000Z', type: 'prompt', text: 'Plan the work' },
    { pos: 'L2', at: '2026-10-08T00:00:01.000Z', type: 'tool.call', tool: 'Agent', callId: 'toolu_example' },
    { pos: 'L3', at: '2026-10-08T00:00:05.000Z', type: 'reply', text: 'All done.', final: true },
  ];
  const child: TranscriptStep[] = [
    { pos: 'L0', at: '2026-10-08T00:00:02.000Z', type: 'prompt', text: 'Explore the repo', agentId: 'other' },
    { pos: 'L1', at: '2026-10-08T00:00:03.000Z', type: 'reply', text: 'Found it.', model: 'model-example' },
  ];

  it('announces each sub-agent at its start, re-attributes its steps and keeps positions unique and stable', () => {
    const merged = mergeSubagentSteps(lead, [{ id: 'a1', label: 'Explore the repo', role: 'explorer', steps: child }]);
    expect(merged.map(step => step.pos)).toEqual(['L1', 'L2', 'S:a1:spawn', 'S:a1:L0', 'S:a1:L1', 'L3']);
    expect(merged[2]).toMatchObject({ type: 'subagent.spawn', subagentId: 'a1', label: 'Explore the repo', role: 'explorer', model: 'model-example', at: '2026-10-08T00:00:02.000Z' });
    expect(merged[2]!.agentId).toBeUndefined();
    expect(merged.slice(3, 5).every(step => step.agentId === 'a1')).toBe(true);
    expect(mergeSubagentSteps(lead, [{ id: 'a1', label: 'Explore the repo', role: 'explorer', steps: child }])).toEqual(merged);
    // The cached source steps are not modified.
    expect(child[0]!.agentId).toBe('other');
  });

  it('spawns nested sub-agents from their parent and keeps a stated model', () => {
    const merged = mergeSubagentSteps(lead, [
      { id: 'a1', steps: child },
      { id: 'a2', parentId: 'a1', model: 'stated-model', at: '2026-10-08T00:00:04.000Z', steps: [] },
      { id: 'primary', steps: child },
    ]);
    const nested = merged.find(step => step.type === 'subagent.spawn' && step.subagentId === 'a2');
    expect(nested).toMatchObject({ agentId: 'a1', model: 'stated-model' });
    expect(merged.filter(step => step.type === 'subagent.spawn')).toHaveLength(2);
  });
});
