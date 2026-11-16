import { describe, expect, it } from 'vitest';
import type { ModelMessage } from '@extalia/runtime';
import { replaceHandoverHistory } from '../src/handoverHistory.js';

describe('bounded repeated handover context', () => {
  it('keeps conversation/tool history and only one generated capsule across repeated transfers', () => {
    const original: ModelMessage[] = [{ role: 'user', text: 'Original user objective' },
      { role: 'assistant', text: 'Verified earlier work', toolCalls: [] },
      { role: 'tool', results: [{ name: 'read_file', toolCallId: 'read', content: 'Original evidence', isError: false }] }];
    let history = original;
    for (let index = 0; index < 100; index++) history = replaceHandoverHistory(history, `Current packet ${index}`, `transfer-${index}`);
    expect(history.slice(0, original.length)).toEqual(original);
    expect(history).toHaveLength(original.length + 1);
    expect(history.at(-1)).toMatchObject({ role: 'user', text: 'Current packet 99' });
  });
  it('does not strip a genuine user quote of the packet format or a damaged host marker', () => {
    const quote: ModelMessage = { role: 'user', text: 'EXTALIA CONTINUITY CAPSULE v1\nUser-authored discussion of a packet' };
    const damaged = { role: 'user' as const, text: 'Actual user text', extaliaHandover: { operationId: 'old', digest: 'wrong-digest' } };
    expect(replaceHandoverHistory([quote, damaged], 'New context', 'new').slice(0, 2)).toEqual([quote, damaged]);
  });
});
