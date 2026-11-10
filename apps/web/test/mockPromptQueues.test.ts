import { expect, it, vi } from 'vitest';
import type { SessionSummary } from '@extalia/platform';
import { createMockPromptQueues } from '../src/host/mockPromptQueues';

it('keeps preview prompts intact during a nontrivial drag permutation and promotes only the selected text', async () => {
  const session = { id: 'session', control: 'managed', running: true } as SessionSummary;
  const dispatch = vi.fn(), steer = vi.fn();
  const api = createMockPromptQueues(() => session, dispatch, steer);
  let queue = await api.promptQueueStatus!('session');
  for (const text of ['first', 'second', 'third']) queue = await api.changePromptQueue!('session', { revision: queue.revision, action: 'add', text, start: true });
  const [first, second, third] = queue.items;
  queue = await api.changePromptQueue!('session', { revision: queue.revision, action: 'reorder', itemIds: [third!.id, first!.id, second!.id] });
  expect((await api.promptQueueStatus!('session')).items.map(item => item.text)).toEqual(['third', 'first', 'second']);
  queue = await api.changePromptQueue!('session', { revision: queue.revision, action: 'steer', itemId: third!.id });
  expect(steer).toHaveBeenCalledExactlyOnceWith('session', 'third');
  expect(queue.items.map(item => item.state)).toEqual(['sent', 'pending', 'pending']);
  expect(dispatch).not.toHaveBeenCalled();
});
