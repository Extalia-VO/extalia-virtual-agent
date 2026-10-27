import { stopReasonOf } from '@extalia/core';
import { parseClaude, parseCodex, parseGemini, type ParseContext, type TranscriptStep } from '@extalia/importers';
import { createEvent, parseEvent, PROTOCOL_VERSION, type EventBody } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { normalizeClaudeHook, normalizeHermesHook } from '../src/hooks/normalize.js';
import { transcriptEvents } from '../src/transcriptEvents.js';

// v0.0.43: why an agent stopped, per source. Synthesized payloads and rows that follow each app's shape; no real transcript.
const T = '2026-10-16T12:00:00.000Z';
const T1 = '2026-10-16T12:00:01.000Z';
const T2 = '2026-10-16T12:00:02.000Z';
const jsonl = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n');
const context = (sourceId: ParseContext['sourceId']): ParseContext => ({ sourceId, exportedAt: T2 });
const errors = (steps: readonly TranscriptStep[] | undefined) => (steps ?? []).filter(step => step.type === 'status' && step.status === 'error');
const failures = (steps: readonly TranscriptStep[] | undefined) => transcriptEvents({ sessionId: 's_r', runtime: 'x', title: 'R', createdAt: T, steps: steps ?? [] })
  .map(event => event.body)
  .filter(body => body.type === 'turn.failed' || (body.type === 'agent.state' && body.phase === 'error'));

describe('stopReasonOf', () => {
  it.each([
    ["You've hit your session limit · resets 11:30am", 'rate_limit', 'quota'],
    ["You've hit your usage limit. Upgrade to Pro or try again at 3:00 PM.", undefined, 'quota'],
    ['Claude AI usage limit reached|1760000000', undefined, 'quota'],
    ['Credit balance is too low', undefined, 'quota'],
    ['You exceeded your current quota, please check your plan and billing details.', undefined, 'quota'],
    ['[API Error: You have exhausted your capacity on this model.]', undefined, 'quota'],
    ['', 'billing_error', 'quota'],
    ['', 'usage_limit_exceeded', 'quota'],
    ['Prompt is too long', 'invalid_request', 'context'],
    ['', 'context_window_exceeded', 'context'],
    ['Invalid API key · Please run /login', undefined, 'auth'],
    ['OAuth token has expired. Please obtain a new token.', undefined, 'auth'],
    ['', 'authentication_failed', 'auth'],
    ['Rate limit reached for requests', undefined, 'rate-limit'],
    ['429 Too Many Requests', undefined, 'rate-limit'],
    ['', 'rate_limit', 'rate-limit'],
    ['API Error: 529 {"type":"overloaded_error"}', undefined, 'overloaded'],
    ['API Error: 503 Service Unavailable', 'server_error', 'overloaded'],
    ['API Error: Connection lost mid-response.', 'server_error', 'crash'],
    ['', { http_connection_failed: { http_status_code: null } }, 'crash'],
    ['[Request interrupted by user]', undefined, 'interrupted'],
    ["There's an issue with the selected model.", 'model_not_found', undefined],
    ['boom', undefined, undefined],
  ] as const)('%s / %s → %s', (text, code, expected) => {
    expect(stopReasonOf(text, code)).toBe(expected);
  });
});

describe('transcripts → stop reasons', () => {
  it('Claude Code: an API error row closes the turn as failed with its reason', () => {
    const row = (index: number, type: string, message: unknown, extra: Record<string, unknown> = {}) =>
      ({ type, uuid: `u${index}`, parentUuid: index ? `u${index - 1}` : null, sessionId: 'claude-r', cwd: '/projects/demo', timestamp: T1, message, ...extra });
    const parsed = parseClaude(jsonl(
      row(0, 'user', { role: 'user', content: 'Refactor' }),
      row(1, 'assistant', { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: "You've hit your session limit · resets 4:40pm" }] },
        { isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429 }),
    ), context('claude-code'));
    expect(errors(parsed.steps)).toEqual([expect.objectContaining({ reason: 'quota' })]);
    expect(failures(parsed.steps)).toEqual([
      { type: 'turn.failed', error: 'Out of tokens or quota', reason: 'quota' },
      { type: 'agent.state', state: 'idle', phase: 'error', reason: 'quota' },
    ]);
  });

  it('Codex: an error event (usage limit) and an aborted turn', () => {
    const parsed = parseCodex(jsonl(
      { type: 'session_meta', payload: { id: 'codex-r', cwd: '/projects/demo', timestamp: T } },
      { timestamp: T, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Deploy' }] } },
      { timestamp: T1, type: 'event_msg', payload: { type: 'error', message: "You've hit your usage limit. Upgrade to Pro, or try again later.", codex_error_info: 'usage_limit_exceeded' } },
      { timestamp: T2, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Again' }] } },
      { timestamp: T2, type: 'event_msg', payload: { type: 'error', message: 'stream disconnected before completion', codex_error_info: { response_stream_disconnected: {} } } },
    ), context('codex'));
    expect(errors(parsed.steps).map(step => (step as { reason?: string }).reason)).toEqual(['quota', 'crash']);
    expect(failures(parsed.steps).filter(body => body.type === 'turn.failed')).toEqual([
      { type: 'turn.failed', error: 'Out of tokens or quota', reason: 'quota' },
      { type: 'turn.failed', error: 'Stopped unexpectedly', reason: 'crash' },
    ]);
  });

  it('Gemini CLI: an error message, and a generic one without a reason', () => {
    const parsed = parseGemini(JSON.stringify({
      sessionId: 'gemini-r', projectHash: 'hash', startTime: T,
      messages: [
        { id: 'm1', type: 'user', timestamp: T, content: 'Plan' },
        { id: 'm2', type: 'error', timestamp: T1, content: '[API Error: Quota exceeded for quota metric. Please try again later.]' },
        { id: 'm3', type: 'user', timestamp: T2, content: 'Again' },
        { id: 'm4', type: 'error', timestamp: T2, content: 'Something odd happened' },
      ],
    }), context('gemini-cli'));
    expect(errors(parsed.steps).map(step => (step as { reason?: string }).reason)).toEqual(['quota', undefined]);
    expect(failures(parsed.steps).filter(body => body.type === 'turn.failed')).toEqual([
      { type: 'turn.failed', error: 'Out of tokens or quota', reason: 'quota' },
      { type: 'turn.failed', error: 'The turn failed.' },
    ]);
  });
});

describe('hooks → stop reasons', () => {
  const claude = (payload: Record<string, unknown>) => normalizeClaudeHook({ session_id: 'c1', hook_event_name: 'StopFailure', ...payload })!.steps.map(step => step.body);
  it('Claude Code StopFailure: the error type and its details', () => {
    expect(claude({ error: 'rate_limit', error_details: "You've hit your session limit · resets 11:30am" })).toEqual([
      { type: 'turn.failed', error: "You've hit your session limit · resets 11:30am", reason: 'quota' },
      { type: 'agent.state', state: 'idle', phase: 'error', summary: "You've hit your session limit · resets 11:30am", reason: 'quota' },
    ]);
    expect(claude({ error: 'rate_limit' })[0]).toMatchObject({ reason: 'rate-limit' });
    expect(claude({ error: 'billing_error' })[0]).toMatchObject({ reason: 'quota' });
    expect(claude({ error: 'authentication_failed', last_assistant_message: 'Invalid API key · Please run /login' })[0]).toMatchObject({ reason: 'auth' });
    expect(claude({ error: 'server_error', error_details: 'API Error: 529 overloaded' })[0]).toMatchObject({ reason: 'overloaded' });
    expect(claude({ error: 'unknown' })[0]).toEqual({ type: 'turn.failed', error: 'unknown' });
  });

  it('Claude Code: an interrupted tool says why', () => {
    const steps = normalizeClaudeHook({ session_id: 'c1', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: {}, error: 'stopped', is_interrupt: true })!.steps.map(step => step.body);
    expect(steps.at(-1)).toEqual({ type: 'agent.state', state: 'idle', phase: 'interrupted', reason: 'interrupted' });
  });

  it('Hermes on_session_end: quota, interruption and a generic failure', () => {
    const hermes = (extra: Record<string, unknown>) => normalizeHermesHook({ session_id: 'h1', hook_event_name: 'on_session_end', extra })!.steps.map(step => step.body);
    expect(hermes({ error: 'Insufficient credits: out of credits for this key' })).toEqual([
      { type: 'turn.failed', error: 'Insufficient credits: out of credits for this key', reason: 'quota' },
      { type: 'agent.state', state: 'idle', phase: 'error', summary: 'Insufficient credits: out of credits for this key', reason: 'quota' },
    ]);
    expect(hermes({ interrupted: true })[0]).toEqual({ type: 'turn.failed', error: 'Interrupted', reason: 'interrupted' });
    expect(hermes({ error: 'provider failed' })[0]).toEqual({ type: 'turn.failed', error: 'provider failed' });
  });
});

describe('protocol: stop reason field', () => {
  const base = { v: PROTOCOL_VERSION, id: 'e1', at: T, sessionId: 's1', agentId: 'primary', source: { runtime: 'demo', channel: 'hook' } };
  it('accepts a known reason on turn.failed, agent.state and subagent.state, and rejects others', () => {
    for (const body of [
      { type: 'turn.failed', error: 'x', reason: 'quota' },
      { type: 'agent.state', state: 'idle', phase: 'error', reason: 'rate-limit' },
      { type: 'subagent.state', subagentId: 'sub', state: 'idle', phase: 'error', reason: 'auth' },
    ] as EventBody[]) expect(parseEvent({ ...base, body }).ok).toBe(true);
    expect(parseEvent({ ...base, body: { type: 'turn.failed', error: 'x', reason: 'tired' } }).ok).toBe(false);
    // Older events without a reason stay valid.
    expect(createEvent({ sessionId: 's1', source: { runtime: 'demo', channel: 'hook' }, body: { type: 'turn.failed', error: 'x' } }).body).toEqual({ type: 'turn.failed', error: 'x' });
  });
});
