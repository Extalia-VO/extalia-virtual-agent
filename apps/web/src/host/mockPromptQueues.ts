import type { AgentHostApi, PromptQueueStatus, SessionSummary } from '@extalia/platform';

/** In-memory preview only; production queue admission and persistence belong to the host. */
export function createMockPromptQueues(session: (id: string) => SessionSummary, dispatch: (id: string, text: string) => void,
  steer: (id: string, text: string) => void): Pick<AgentHostApi, 'promptQueueStatus' | 'changePromptQueue'> {
  const queues = new Map<string, PromptQueueStatus>();
  const read = (id: string) => {
    const summary = session(id);
    let queue = queues.get(id);
    if (!queue) {
      queue = { sessionId: id, revision: crypto.randomUUID(), supported: summary.control === 'managed', paused: true, maxTextLength: 100_000, items: [] };
      queues.set(id, queue);
    }
    queue.canSteer = queue.supported && summary.running && !summary.runtime && !summary.pendingApprovalId;
    return queue;
  };
  const wake = (id: string, queue: PromptQueueStatus) => {
    if (queue.paused || session(id).running) return;
    const item = queue.items.find(item => item.state === 'pending');
    if (item) { dispatch(id, item.text); item.state = 'sent'; queue.revision = crypto.randomUUID(); }
  };
  return {
    async promptQueueStatus(id) { const queue = read(id); wake(id, queue); return structuredClone(queue); },
    async changePromptQueue(id, input) {
      const queue = read(id);
      if (queue.revision !== input.revision) throw new Error('Queue changed.');
      const item = 'itemId' in input ? queue.items.find(item => item.id === input.itemId) : undefined;
      if (input.action === 'add') {
        if (!input.text.trim() || input.text.length > queue.maxTextLength) throw new Error('Invalid prompt.');
        queue.items.push({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), text: input.text, state: 'pending' });
        if (input.start) queue.paused = false;
      } else if (input.action === 'pause') queue.paused = input.paused;
      else if (input.action === 'reorder') {
        const pending = queue.items.filter(item => item.state === 'pending');
        if (pending.length !== input.itemIds.length || new Set(input.itemIds).size !== pending.length
          || input.itemIds.some(id => !pending.some(item => item.id === id))) throw new Error('Invalid order.');
        let index = 0;
        queue.items = queue.items.map(item => {
          if (item.state !== 'pending') return item;
          const id = input.itemIds[index++];
          return pending.find(item => item.id === id)!;
        });
      } else if (input.action === 'acknowledge') queue.items = queue.items.filter(current => current !== item || current.state !== 'sent');
      else {
        if (!item || item.state !== 'pending') throw new Error('Only waiting prompts can change.');
        if (input.action === 'edit') item.text = input.text;
        else if (input.action === 'delete') queue.items = queue.items.filter(current => current !== item);
        else if (input.action === 'steer') {
          if (!queue.canSteer) throw new Error('Steering unavailable.');
          steer(id, item.text); item.state = 'sent';
        }
      }
      queue.revision = crypto.randomUUID();
      const accepted = structuredClone(queue);
      queueMicrotask(() => wake(id, queue));
      return accepted;
    },
  };
}
