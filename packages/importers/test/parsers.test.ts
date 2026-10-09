import { decodePortableSession, type PortableSession } from '@extalia/core';
import { describe, expect, it } from 'vitest';
import { parseClaude, parseCodex, parseGemini, parseHermes, type NativeParseResult, type ParseContext } from '../src/index.js';

// Synthesized fixtures that follow each provider's shape; no real transcript is used.
const T = '2026-10-08T00:00:00.000Z';
const T1 = '2026-10-08T00:00:01.000Z';
const T2 = '2026-10-08T00:00:02.000Z';
const jsonl = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n');
const context = (sourceId: ParseContext['sourceId']): ParseContext => ({ sourceId, exportedAt: T2 });

function valid(result: NativeParseResult): PortableSession {
  expect(result.session, result.diagnostics.join('; ')).toBeDefined();
  expect(decodePortableSession(result.session).ok).toBe(true);
  return result.session!;
}

describe('Codex rollouts', () => {
  it('imports text and inert tool records, drops mirrored events and private analysis', () => {
    const session = valid(parseCodex(jsonl(
      { type: 'session_meta', payload: { id: 'codex-one', cwd: '/projects/demo', timestamp: T, instructions: 'not copied' } },
      { timestamp: T, type: 'event_msg', payload: { type: 'user_message', message: 'Create example' } },
      { timestamp: T, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Create example' }] } },
      { timestamp: T1, type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'private-analysis' }] } },
      { timestamp: T1, type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'private-summary' }] } },
      { timestamp: T1, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'tool1', arguments: '{"cmd":"printf example","api_key":"synthetic-secret"}' } },
      { timestamp: T1, type: 'response_item', payload: { type: 'function_call_output', call_id: 'tool1', output: 'example' } },
      { timestamp: T2, type: 'event_msg', payload: { type: 'agent_message', message: '```js\nconst example = 1;\n```' } },
      { timestamp: T2, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '```js\nconst example = 1;\n```' }] } },
    ), context('codex')));
    expect(session.messages.map(message => message.role)).toEqual(['user', 'tool', 'tool', 'assistant']);
    expect(session.provenance).toMatchObject({ sourceId: 'codex', sourceSessionId: 'codex-one', providerId: 'openai' });
    expect(session.workspace).toMatchObject({ name: 'demo', projectLocation: '/projects/demo' });
    expect(JSON.stringify(session)).not.toMatch(/synthetic-secret|private-analysis|private-summary|not copied/);
    expect(session.messages[1]?.content).toMatch(/printf example/);
  });

  it('keeps repeated prompts that are not mirrors', () => {
    const later = '2026-10-08T00:01:00.000Z';
    const events = valid(parseCodex(jsonl(
      { type: 'session_meta', payload: { id: 'events', timestamp: T } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Again' }, timestamp: T },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Ready' }, timestamp: T1 },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Again' }, timestamp: T2 },
    ), context('codex')));
    expect(events.messages).toHaveLength(3);
    const paired = valid(parseCodex(jsonl(
      { type: 'session_meta', payload: { id: 'repeated', timestamp: T } },
      { timestamp: T, type: 'event_msg', payload: { type: 'user_message', message: 'Again' } },
      { timestamp: later, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Again' }] } },
      { timestamp: later, type: 'event_msg', payload: { type: 'user_message', message: 'Again' } },
    ), context('codex')));
    expect(paired.messages.map(message => [message.content, message.createdAt])).toEqual([['Again', T], ['Again', later]]);
  });
});

describe('Claude Code transcripts', () => {
  it('imports the latest branch with tool blocks and without reasoning or progress records', () => {
    const result = parseClaude(jsonl(
      { type: 'user', uuid: 'root', parentUuid: null, sessionId: 'claude-one', cwd: '/projects/demo', timestamp: T, message: { role: 'user', content: 'Update file' } },
      { type: 'assistant', uuid: 'old', parentUuid: 'root', sessionId: 'claude-one', timestamp: T1, message: { content: [{ type: 'text', text: 'abandoned branch' }] } },
      { type: 'assistant', uuid: 'new', parentUuid: 'root', sessionId: 'claude-one', timestamp: T1, message: { content: [{ type: 'thinking', thinking: 'hidden-reasoning' }, { type: 'text', text: 'Editing now' }, { type: 'tool_use', id: 'tool1', name: 'Edit', input: { file_path: 'example.ts', credentials: { password: 'synthetic-secret' } } }] } },
      { type: 'progress', uuid: 'progress', parentUuid: 'new', data: 'progress omitted', timestamp: T1 },
      { type: 'user', uuid: 'result', parentUuid: 'progress', sessionId: 'claude-one', timestamp: T2, message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: [{ type: 'text', text: 'Changed example.ts' }] }] } },
    ), context('claude-code'));
    const session = valid(result);
    expect(session.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(result.diagnostics.join(' ')).toMatch(/latest conversation branch/);
    expect(JSON.stringify(session)).not.toMatch(/abandoned branch|hidden-reasoning|progress omitted|synthetic-secret/);
    expect(session.provenance.providerId).toBe('anthropic');
  });

  it('keeps the latest copy of a record and excludes other sessions', () => {
    const session = valid(parseClaude(jsonl(
      { type: 'user', uuid: 'u', sessionId: 's', timestamp: T, message: { content: 'Prompt' } },
      { type: 'assistant', uuid: 'a', sessionId: 's', timestamp: T1, message: { content: 'Partial' } },
      { type: 'assistant', uuid: 'a', sessionId: 's', timestamp: T1, message: { content: 'Complete' } },
      { type: 'user', uuid: 'other', sessionId: 'other-session', timestamp: T2, message: { content: 'Foreign prompt' } },
    ), { ...context('claude-code'), nativeSessionId: 's' }));
    expect(session.messages.map(message => message.content)).toEqual(['Prompt', 'Complete']);
  });
});

describe('Gemini CLI recordings', () => {
  it('reads legacy JSON without thoughts, memory or attachments', () => {
    const session = valid(parseGemini(JSON.stringify({
      sessionId: 'gemini-one', projectHash: 'hash', startTime: T, lastUpdated: T2, memoryScratchpad: { workflowSummary: 'private-memory' },
      messages: [
        { id: 'u', type: 'user', timestamp: T, content: [{ text: 'Create example' }, { inlineData: { data: 'image-not-copied' } }] },
        { id: 'a', type: 'gemini', timestamp: T1, content: [{ text: 'Done' }, { text: 'private-part', thought: true }], thoughts: [{ text: 'private-thought' }], toolCalls: [{ id: 't', name: 'read_file', args: { path: 'example.ts', token: 'synthetic-token' }, result: [{ text: 'export const x = 1' }], timestamp: T1 }] },
      ],
    }), context('gemini-cli')));
    expect(session.messages).toHaveLength(4);
    expect(JSON.stringify(session)).not.toMatch(/image-not-copied|private-memory|private-part|private-thought|synthetic-token/);
    expect(session.workspace).toBeUndefined();
  });

  it('replays JSONL patches, metadata updates and rewinds', () => {
    const session = valid(parseGemini(jsonl(
      { sessionId: 'gemini-jsonl', projectHash: 'hash', startTime: T, lastUpdated: T },
      { id: 'u', type: 'user', timestamp: T, content: 'Prompt' },
      { id: 'a', type: 'gemini', timestamp: T1, content: 'partial', toolCalls: [{ id: 't', name: 'read_file', args: { path: 'example.ts' }, timestamp: T1 }] },
      { $patch: { id: 'a', content: 'Complete', toolCalls: [{ id: 't', result: [{ text: 'contents' }] }] } },
      { id: 'rewound', type: 'user', timestamp: T2, content: 'Removed by rewind' },
      { $rewindTo: 'rewound' },
      { $set: { lastUpdated: T2 } },
    ), context('gemini-cli')));
    expect(session.messages.slice(0, 2).map(message => message.content)).toEqual(['Prompt', 'Complete']);
    expect(session.messages.at(-1)?.content).toMatch(/contents/);
    expect(JSON.stringify(session)).not.toMatch(/partial|Removed by rewind/);
  });
});

describe('Hermes databases', () => {
  it('uses active messages, the multimodal marker and drops private fields', () => {
    const seconds = Date.parse(T) / 1000;
    const session = valid(parseHermes({ id: 'hermes-one', started_at: seconds, title: 'Demo', cwd: '/projects/demo', system_prompt: 'private-system' }, [
      { id: 1, session_id: 'hermes-one', role: 'user', timestamp: seconds, content: '\u0000json:[{"type":"text","text":"Question"},{"type":"image_url","image_url":{"url":"image-not-copied"}}]' },
      { id: 2, role: 'assistant', timestamp: seconds + 1, content: 'Answer', reasoning: 'private-reasoning', tool_calls: '[{"id":"t","type":"function","function":{"name":"terminal","arguments":"{\\"command\\":\\"printf demo\\",\\"authorization\\":\\"synthetic-secret\\"}"}}]' },
      { id: 3, role: 'tool', timestamp: seconds + 1, content: 'demo' },
      { id: 4, role: 'assistant', timestamp: seconds + 1, active: 0, content: 'rewound hidden' },
      { id: 5, role: 'assistant', timestamp: seconds + 2, session_id: 'foreign', content: 'foreign' },
    ], context('hermes')));
    expect(session.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(session.messages[0]?.content).toBe('Question');
    expect(session.title).toBe('Demo');
    expect(JSON.stringify(session)).not.toMatch(/synthetic-secret|private-system|private-reasoning|image-not-copied|rewound hidden|foreign/);
  });

  it('keeps profile identities apart and normalizes timestamps without changing the input', () => {
    const row = { id: 'same', title: 'Demo', started_at: Date.parse(T) / 1000 };
    const messages = [{ role: 'user', content: 'Question', timestamp: T1 }, { role: 'assistant', content: 'Answer', timestamp: T }, { role: 'assistant', content: 'Followup' }];
    const before = JSON.stringify({ row, messages });
    const one = parseHermes(row, messages, context('hermes'));
    const two = parseHermes(row, messages, { ...context('hermes'), profile: 'team', importMode: 'linked' });
    expect(valid(one).provenance.sourceSessionId).toBe('same');
    expect(valid(two).provenance.sourceSessionId).toBe('profile:team:same');
    expect(valid(two).importMode).toBe('linked');
    expect(valid(one).messages.map(message => message.createdAt)).toEqual([T1, T1, T1]);
    expect(one.diagnostics.join(' ')).toMatch(/normalized/);
    expect(JSON.stringify({ row, messages })).toBe(before);
  });
});

describe('safety and limits', () => {
  it('masks credentials in text while keeping code readable', () => {
    const session = valid(parseHermes({ id: 'secrets', started_at: Date.parse(T) / 1000 }, [{ role: 'user', timestamp: T, content: 'const answer = 42;\napi_key=synthetic-secret\nhttps://user:password@example.com/' }], context('hermes')));
    expect(session.messages[0]?.content).toMatch(/const answer = 42/);
    expect(session.messages[0]?.content).not.toMatch(/synthetic-secret|user:password/);
  });

  it('reports unsupported or empty formats instead of inventing a conversation', () => {
    const results = [
      parseCodex('{"type":"mystery","payload":{"content":"not a conversation"}}', context('codex')),
      parseCodex('{"type":"session_meta","payload":{"id":"empty"}}', context('codex')),
      parseClaude('{"type":"file-history-snapshot","sessionId":"empty"}', context('claude-code')),
      parseGemini('{"sessionId":"empty","messages":[]}', context('gemini-cli')),
      parseHermes({ id: 'empty' }, [], context('hermes')),
    ];
    for (const result of results) {
      expect(result.session).toBeUndefined();
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
    expect(parseCodex(' '.repeat(16 * 1024 * 1024 + 1), context('codex')).diagnostics.join(' ')).toMatch(/limit/);
  });
});
