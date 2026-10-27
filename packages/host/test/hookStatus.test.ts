import type { TranscriptStep } from '@extalia/importers';
import { parseEvent, type EventBody } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { hookProtocolEvents, normalizeClaudeHook, normalizeCodexHook, normalizeGeminiHook, normalizeHermesHook, type NormalizedHook } from '../src/hooks/normalize.js';
import { transcriptEvents } from '../src/transcriptEvents.js';

// v0.0.38: every status each agent app reports, from synthesized hook payloads and transcript steps.
const states = (hook: NormalizedHook | undefined) => (hook?.steps ?? []).map(step => step.body).filter((body): body is Extract<EventBody, { type: 'agent.state' }> => body.type === 'agent.state')
  .map(({ state, phase, activity }) => ({ state, ...(phase ? { phase } : {}), ...(activity ? { activity } : {}) }));
const valid = (hook: NormalizedHook | undefined) => hookProtocolEvents(hook!, { sessionId: 's_example', at: '2026-10-16T12:00:00.000Z', id: index => `e${index}` })
  .every(event => parseEvent(event).ok);

describe('Claude Code hooks → status', () => {
  const claude = (payload: Record<string, unknown>) => normalizeClaudeHook({ session_id: 'c1', ...payload });
  const cases: [string, Record<string, unknown>, ReturnType<typeof states>][] = [
    ['SessionStart startup', { hook_event_name: 'SessionStart', source: 'startup' }, [{ state: 'idle' }]],
    ['SessionStart resume', { hook_event_name: 'SessionStart', source: 'resume' }, [{ state: 'idle' }]],
    ['SessionStart clear', { hook_event_name: 'SessionStart', source: 'clear' }, [{ state: 'idle' }]],
    ['SessionStart compact (the turn goes on)', { hook_event_name: 'SessionStart', source: 'compact' }, [{ state: 'thinking' }]],
    ['UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', prompt: 'Fix it' }, [{ state: 'thinking' }]],
    ['PreToolUse Read', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/p/a.ts' } }, [{ state: 'working', activity: 'read' }]],
    ['PreToolUse Edit', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/p/a.ts' } }, [{ state: 'working', activity: 'edit' }]],
    ['PreToolUse Bash', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, [{ state: 'working', activity: 'command' }]],
    ['PreToolUse Bash tests', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pnpm vitest run' } }, [{ state: 'working', activity: 'test' }]],
    ['PreToolUse Grep', { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' } }, [{ state: 'working', activity: 'search' }]],
    ['PreToolUse WebFetch', { hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }, [{ state: 'working', activity: 'web' }]],
    ['PreToolUse Agent', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'Explore' } }, [{ state: 'delegating', activity: 'delegate' }]],
    ['PreToolUse MCP', { hook_event_name: 'PreToolUse', tool_name: 'mcp__github__create_issue', tool_input: {} }, [{ state: 'working', activity: 'tool' }]],
    ['PreToolUse TodoWrite', { hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: {} }, [{ state: 'working', phase: 'planning', activity: 'think' }]],
    ['PreToolUse ExitPlanMode', { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: {} }, [{ state: 'working', phase: 'planning', activity: 'think' }]],
    ['PreToolUse AskUserQuestion', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: {} }, [{ state: 'waiting', phase: 'input', activity: 'tool' }]],
    ['PostToolUse', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: { content: 'x' } }, []],
    ['PostToolUseFailure interrupt', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: {}, error: 'stopped', is_interrupt: true }, [{ state: 'idle', phase: 'interrupted' }]],
    ['PermissionRequest', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm x' } }, [{ state: 'waiting', phase: 'approval', activity: 'command' }]],
    ['Notification permission_prompt', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' }, [{ state: 'waiting', phase: 'approval' }]],
    ['Notification legacy permission text', { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }, [{ state: 'waiting', phase: 'approval' }]],
    ['Notification idle_prompt', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, [{ state: 'idle', phase: 'input' }]],
    ['Notification elicitation_dialog', { hook_event_name: 'Notification', notification_type: 'elicitation_dialog', message: 'Answer' }, [{ state: 'waiting', phase: 'input' }]],
    ['Notification auth_success', { hook_event_name: 'Notification', notification_type: 'auth_success', message: 'Signed in' }, []],
    ['PreCompact', { hook_event_name: 'PreCompact', trigger: 'auto' }, [{ state: 'thinking', phase: 'compacting' }]],
    ['Stop', { hook_event_name: 'Stop', last_assistant_message: 'Done' }, [{ state: 'idle' }]],
    ['StopFailure', { hook_event_name: 'StopFailure', error: { message: 'API Error: overloaded' } }, [{ state: 'idle', phase: 'error' }]],
    ['SessionEnd', { hook_event_name: 'SessionEnd', reason: 'logout' }, [{ state: 'offline' }]],
  ];
  it.each(cases)('%s', (_name, payload, expected) => {
    const hook = claude(payload);
    expect(states(hook)).toEqual(expected);
    expect(valid(hook)).toBe(true);
  });

  it('turn failures and subagent hooks keep their protocol events', () => {
    const limited = claude({ hook_event_name: 'StopFailure', error: 'rate limited' })!;
    expect(limited.steps.map(step => step.body)).toEqual([
      { type: 'turn.failed', error: 'rate limited', reason: 'rate-limit' },
      { type: 'agent.state', state: 'idle', phase: 'error', summary: 'rate limited', reason: 'rate-limit' },
    ]);
    expect(valid(limited)).toBe(true);
    expect(claude({ hook_event_name: 'StopFailure', error: 'unclassified provider failure' })!.steps.map(step => step.body)).toEqual([
      { type: 'turn.failed', error: 'unclassified provider failure' },
      { type: 'agent.state', state: 'idle', phase: 'error', summary: 'unclassified provider failure' },
    ]);
    expect(claude({ hook_event_name: 'StopFailure', error: 'the model crashed and burned' })!.steps[0]!.body).toMatchObject({ type: 'turn.failed', error: 'the model crashed and burned' });
    const inner = claude({ hook_event_name: 'PreToolUse', agent_id: 'sub1', agent_type: 'Explore', tool_name: 'Read', tool_input: {} })!;
    expect(inner.agentType).toBe('Explore');
    expect(inner.steps.every(step => step.agentId === 'sub1')).toBe(true);
    expect(claude({ hook_event_name: 'SubagentStart', agent_id: 'sub1', agent_type: 'Explore' })!.steps[0]).toMatchObject({ agentId: 'primary', body: { type: 'subagent.spawned', subagentId: 'sub1' } });
    expect(claude({ hook_event_name: 'SubagentStop', agent_id: 'sub1' })!.steps[0]!.body).toMatchObject({ type: 'subagent.state', state: 'offline' });
  });
});

describe('Codex and Gemini CLI hooks → status', () => {
  it('Codex: tools by kind, update_plan as planning, approvals, compaction, stop', () => {
    const codex = (payload: Record<string, unknown>) => states(normalizeCodexHook({ session_id: 'x1', ...payload }));
    expect(codex({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })).toEqual([{ state: 'thinking' }]);
    expect(codex({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { input: '*** Begin Patch\n*** Update File: a.ts\n*** End Patch' } })).toEqual([{ state: 'working', activity: 'edit' }]);
    expect(codex({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { cmd: 'cargo test' } })).toEqual([{ state: 'working', activity: 'test' }]);
    expect(codex({ hook_event_name: 'PreToolUse', tool_name: 'update_plan', tool_input: {} })).toEqual([{ state: 'working', phase: 'planning', activity: 'think' }]);
    expect(codex({ hook_event_name: 'PreToolUse', tool_name: 'web_search', tool_input: { query: 'x' } })).toEqual([{ state: 'working', activity: 'web' }]);
    expect(codex({ hook_event_name: 'PermissionRequest', tool_name: 'exec_command', tool_input: { cmd: 'rm x' } })).toEqual([{ state: 'waiting', phase: 'approval', activity: 'command' }]);
    expect(codex({ hook_event_name: 'PreCompact' })).toEqual([{ state: 'thinking', phase: 'compacting' }]);
    expect(codex({ hook_event_name: 'Stop' })).toEqual([{ state: 'idle' }]);
  });

  it('Gemini CLI: agent, model, tools, permission notification, compression, end', () => {
    const gemini = (payload: Record<string, unknown>) => states(normalizeGeminiHook({ session_id: 'g1', ...payload }));
    expect(gemini({ hook_event_name: 'BeforeAgent', prompt: 'go' })).toEqual([{ state: 'thinking' }]);
    expect(gemini({ hook_event_name: 'BeforeModel' })).toEqual([{ state: 'thinking' }]);
    expect(gemini({ hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: { absolute_path: '/p/a.ts' } })).toEqual([{ state: 'working', activity: 'read' }]);
    expect(gemini({ hook_event_name: 'BeforeTool', tool_name: 'write_todos', tool_input: {} })).toEqual([{ state: 'working', phase: 'planning', activity: 'think' }]);
    expect(gemini({ hook_event_name: 'AfterTool', tool_name: 'read_file', tool_input: {}, tool_response: { llmContent: 'x' } })).toEqual([]);
    expect(gemini({ hook_event_name: 'Notification', notification_type: 'ToolPermission', message: 'Allow shell?' })).toEqual([{ state: 'waiting', phase: 'approval' }]);
    expect(gemini({ hook_event_name: 'PreCompress' })).toEqual([{ state: 'thinking', phase: 'compacting' }]);
    expect(gemini({ hook_event_name: 'AfterAgent', prompt_response: 'Done' })).toEqual([{ state: 'idle' }]);
    expect(gemini({ hook_event_name: 'SessionEnd', reason: 'exit' })).toEqual([{ state: 'offline' }]);
  });
});

describe('Hermes webhooks → status', () => {
  const hermes = (event: string, extra: Record<string, unknown> = {}, more: Record<string, unknown> = {}) => normalizeHermesHook({ session_id: 'h1', hook_event_name: event, extra, ...more });
  it('maps LLM calls, tools, planning, questions, approvals, errors, interruptions and session end', () => {
    expect(states(hermes('pre_llm_call'))).toEqual([{ state: 'thinking' }]);
    expect(states(hermes('pre_tool_call', {}, { tool_name: 'terminal', tool_input: { command: 'pytest' } }))).toEqual([{ state: 'working', activity: 'test' }]);
    expect(states(hermes('pre_tool_call', {}, { tool_name: 'todo', tool_input: {} }))).toEqual([{ state: 'working', phase: 'planning', activity: 'think' }]);
    expect(states(hermes('pre_tool_call', {}, { tool_name: 'clarify', tool_input: {} }))).toEqual([{ state: 'waiting', phase: 'input', activity: 'tool' }]);
    expect(states(hermes('pre_approval_request', { command: 'rm -rf build' }))).toEqual([{ state: 'waiting', phase: 'approval' }]);
    expect(states(hermes('on_session_end', { interrupted: true }))).toEqual([{ state: 'idle', phase: 'interrupted' }]);
    expect(states(hermes('on_session_end', { error: 'provider failed' }))).toEqual([{ state: 'idle', phase: 'error' }]);
    expect(hermes('on_session_end', { error: 'provider failed' })!.steps[0]!.body).toEqual({ type: 'turn.failed', error: 'provider failed' });
    expect(states(hermes('on_session_end', { completed: true }))).toEqual([{ state: 'idle' }]);
    expect(states(hermes('on_session_finalize'))).toEqual([{ state: 'offline' }]);
    for (const event of ['pre_llm_call', 'pre_approval_request', 'on_session_end', 'on_session_finalize']) expect(valid(hermes(event, { error: 'x' }))).toBe(true);
  });
});

describe('transcript steps → status', () => {
  const T = (s: number) => new Date(Date.parse('2026-10-16T12:00:00.000Z') + s * 1000).toISOString();
  const derive = (steps: TranscriptStep[]) => transcriptEvents({ sessionId: 's_t', runtime: 'claude-code', title: 'T', createdAt: T(0), steps })
    .filter(event => event.body.type === 'agent.state' || event.body.type === 'turn.failed' || event.body.type === 'turn.completed')
    .map(event => event.body.type === 'agent.state' ? `${event.body.state}${event.body.phase ? `/${event.body.phase}` : ''}` : event.body.type);

  it('maps reasoning, plans, questions, approvals, compaction, interruption and errors', () => {
    expect(derive([
      { pos: 'L1', at: T(1), type: 'prompt', text: 'go' },
      { pos: 'L2', at: T(2), type: 'status', status: 'thinking' },
      { pos: 'L3', at: T(3), type: 'tool.call', tool: 'TodoWrite', callId: 'c1' },
      { pos: 'L4', at: T(4), type: 'tool.call', tool: 'AskUserQuestion', callId: 'c2' },
      { pos: 'L5', at: T(5), type: 'status', status: 'approval' },
      { pos: 'L6', at: T(6), type: 'status', status: 'compacting' },
      { pos: 'L7', at: T(7), type: 'tool.call', tool: 'Agent', callId: 'c3' },
      { pos: 'L8', at: T(8), type: 'turn.end', reason: 'interrupted' },
      { pos: 'L9', at: T(9), type: 'prompt', text: 'again' },
      { pos: 'L10', at: T(10), type: 'status', status: 'error' },
    ])).toEqual([
      'thinking', 'thinking', 'working/planning', 'waiting/input', 'waiting/approval', 'thinking/compacting', 'delegating',
      'turn.completed', 'idle/interrupted', 'thinking', 'turn.failed', 'idle/error',
    ]);
  });
});
