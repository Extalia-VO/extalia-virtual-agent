import type { PortableMessage } from '@extalia/core';
import { describe, expect, it } from 'vitest';
import { CONTINUATION_MESSAGE_LIMIT, buildContinuation } from '../src/continuation.js';

const at = '2026-10-01T10:00:00.000Z';
const conversation = (...items: [PortableMessage['role'], string][]) => ({
  messages: items.map(([role, content], index) => ({ index, role, content, createdAt: at })),
});

describe('buildContinuation', () => {
  it('keeps user and assistant text and alternates turns for providers', () => {
    const result = buildContinuation(conversation(['system', 'rules'], ['user', 'Fix it'], ['assistant', 'Looking'], ['tool', 'output'], ['assistant', 'Patched'], ['user', 'Thanks'], ['user', 'And tests?']));
    expect(result.messages.map(message => message.text)).toEqual(['Fix it', 'Looking', 'Patched', 'Thanks', 'And tests?']);
    expect(result.history).toEqual([
      { role: 'user', text: 'Fix it' },
      { role: 'assistant', text: 'Looking\n\nPatched', toolCalls: [] },
      { role: 'user', text: 'Thanks\n\nAnd tests?' },
    ]);
    expect(result.omitted).toBe(0);
  });

  it('keeps the first request and the most recent messages within the budget', () => {
    const long = (label: string) => `${label} ${'x'.repeat(95)}`;
    const items: [PortableMessage['role'], string][] = [['user', 'Original task']];
    for (let i = 0; i < 10; i++) items.push(['assistant', long(`a${i}`)], ['user', long(`u${i}`)]);
    const result = buildContinuation(conversation(...items), 450);
    expect(result.messages[0]!.text).toBe('Original task');
    expect(result.messages.at(-1)!.text.startsWith('u9')).toBe(true);
    expect(result.omitted).toBe(21 - result.messages.length);
    expect(result.history[0]).toMatchObject({ role: 'user' });
    expect((result.history[0] as { text: string }).text).toContain(`${result.omitted} later messages are left out`);
  });

  it('shortens very long messages and starts with the user when the source does not', () => {
    const result = buildContinuation(conversation(['assistant', 'y'.repeat(CONTINUATION_MESSAGE_LIMIT * 2)]));
    expect(result.messages[0]!.text.length).toBeLessThanOrEqual(CONTINUATION_MESSAGE_LIMIT + 60);
    expect(result.messages[0]!.text).toContain('characters left out');
    expect(result.history.map(message => message.role)).toEqual(['user', 'assistant']);
  });

  it('carries nothing from a conversation without text', () => {
    expect(buildContinuation(conversation(['tool', 'x'], ['user', '   '])).messages).toEqual([]);
  });
});
