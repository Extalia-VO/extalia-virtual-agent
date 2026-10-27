import { describe, expect, it } from 'vitest';
import { parseClaude, parseCodex, parseGemini, type ParseContext } from '../src/index.js';

// Synthesized rows that follow each provider's usage shape; no real transcript is used.
const T = '2026-10-08T00:00:00.000Z';
const T1 = '2026-10-08T00:00:01.000Z';
const T2 = '2026-10-08T00:00:02.000Z';
const jsonl = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n');

describe('Claude Code context usage', () => {
  const claude: ParseContext = { sourceId: 'claude-code', nativeSessionId: 'claude-ctx', exportedAt: T2 };
  const usage = (input: number, read: number, write: number) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 9 });

  it('takes the lead agent latest request as the context in use, cache included, and counts compactions', () => {
    const result = parseClaude(jsonl(
      { type: 'user', uuid: 'u1', sessionId: 'claude-ctx', timestamp: T, message: { role: 'user', content: 'Summarize the example' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'claude-ctx', timestamp: T1, message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'First' }], usage: usage(3, 1000, 200), stop_reason: 'end_turn' } },
      { type: 'system', subtype: 'compact_boundary', uuid: 's1', sessionId: 'claude-ctx', timestamp: T1, compactMetadata: { trigger: 'auto', preTokens: 150000 } },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: 'claude-ctx', timestamp: T2, message: { role: 'user', content: 'Continue' } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u2', sessionId: 'claude-ctx', timestamp: T2, message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Second' }], usage: usage(4, 5000, 0), stop_reason: 'end_turn' } },
      // A sub-agent's request is its own context, never the lead's.
      { type: 'assistant', uuid: 'sc1', parentUuid: 'u2', sessionId: 'claude-ctx', timestamp: T2, isSidechain: true, agentId: 'sub1', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'Sub' }], usage: usage(90000, 0, 0), stop_reason: 'end_turn' } },
      // A failed request reports zero usage and does not reset the reading.
      { type: 'assistant', uuid: 'a3', parentUuid: 'a2', sessionId: 'claude-ctx', timestamp: T2, isApiErrorMessage: true, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }], usage: usage(0, 0, 0), stop_reason: 'stop_sequence' } },
      { type: 'system', subtype: 'compact_boundary', uuid: 's2', sessionId: 'claude-ctx', timestamp: T2, compactMetadata: { trigger: 'manual' } },
    ), claude);
    expect(result.session).toBeDefined();
    expect(result.context).toEqual({ usedTokens: 5004, compactions: 2 });
    expect(result.model).toBe('claude-sonnet-4-5');
  });

  it('reports no context when the transcript carries no usage', () => {
    const result = parseClaude(jsonl(
      { type: 'user', uuid: 'u1', sessionId: 'claude-ctx', timestamp: T, message: { role: 'user', content: 'Hello example' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'claude-ctx', timestamp: T1, message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } },
    ), claude);
    expect(result.session).toBeDefined();
    expect(result.context).toBeUndefined();
  });

  it('ignores malformed counts instead of trusting them', () => {
    const result = parseClaude(jsonl(
      { type: 'user', uuid: 'u1', sessionId: 'claude-ctx', timestamp: T, message: { role: 'user', content: 'Hello example' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'claude-ctx', timestamp: T1, message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }], usage: { input_tokens: -4, cache_read_input_tokens: '9' } } },
    ), claude);
    expect(result.context).toBeUndefined();
  });
});

describe('Codex context usage', () => {
  const codex: ParseContext = { sourceId: 'codex', exportedAt: T2 };
  const count = (input: number) => ({ type: 'event_msg', timestamp: T1, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 3, total_tokens: input + 3 }, total_token_usage: { input_tokens: input * 4 }, model_context_window: 258400 } } });

  it('reads the latest request input and the window the rollout states, and counts compactions once per compaction', () => {
    const result = parseCodex(jsonl(
      { type: 'session_meta', payload: { id: 'codex-ctx', cwd: '/projects/demo', timestamp: T } },
      { type: 'turn_context', payload: { model: 'gpt-5-codex' } },
      { timestamp: T, type: 'event_msg', payload: { type: 'user_message', message: 'Hello example' } },
      count(12000),
      // Rate-limit-only reports carry no usage info and keep the last reading.
      { type: 'event_msg', timestamp: T1, payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 4 } } } },
      { timestamp: T1, type: 'event_msg', payload: { type: 'agent_message', message: 'Hi' } },
      count(15000),
      { type: 'compacted', timestamp: T2, payload: { message: 'summary' } },
      { type: 'event_msg', timestamp: T2, payload: { type: 'context_compacted' } },
    ), codex);
    expect(result.session).toBeDefined();
    expect(result.context).toEqual({ usedTokens: 15000, windowTokens: 258400, compactions: 1 });
    expect(result.model).toBe('gpt-5-codex');
  });

  it('never uses the cumulative thread total as the context', () => {
    const result = parseCodex(jsonl(
      { type: 'session_meta', payload: { id: 'codex-total', cwd: '/projects/demo', timestamp: T } },
      { timestamp: T, type: 'event_msg', payload: { type: 'user_message', message: 'Hello example' } },
      { type: 'event_msg', timestamp: T1, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 90000 } } } },
      { timestamp: T1, type: 'event_msg', payload: { type: 'agent_message', message: 'Hi' } },
    ), codex);
    expect(result.context).toBeUndefined();
  });

  it('reports no context for a rollout without token counts', () => {
    const result = parseCodex(jsonl(
      { type: 'session_meta', payload: { id: 'codex-none', cwd: '/projects/demo', timestamp: T } },
      { timestamp: T, type: 'event_msg', payload: { type: 'user_message', message: 'Hello example' } },
      { timestamp: T1, type: 'event_msg', payload: { type: 'agent_message', message: 'Hi' } },
    ), codex);
    expect(result.context).toBeUndefined();
  });
});

describe('Gemini CLI recordings', () => {
  it('states no context: the recording format carries no usage this reader counts', () => {
    const result = parseGemini(JSON.stringify({ sessionId: 'gem-ctx', projectHash: 'hash-example', startTime: T, messages: [{ id: 'm1', type: 'user', timestamp: T, content: 'Hello example' }, { id: 'm2', type: 'gemini', timestamp: T1, content: 'Hi', tokens: { input: 900, output: 4 } }] }), { sourceId: 'gemini-cli', exportedAt: T2 });
    expect(result.session).toBeDefined();
    expect(result.context).toBeUndefined();
  });
});
