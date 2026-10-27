import { describe, expect, it } from 'vitest';
import type { PendingApproval } from '../src/approvals/model';
import { freshApprovals, notificationContent, shouldNotify } from '../src/approvals/notify';

const make = (id: string, agentName: string, action = 'Run npm test'): PendingApproval => ({
  id, source: 'native', sessionId: 's1', agentName, sessionTitle: 'Title', action, risk: 'medium', requestedAt: '2026-10-18T10:00:00.000Z', choices: ['allow-once', 'deny'],
});

describe('approval notification gating', () => {
  it('notifies only when turned on, the window is not in front, and something is new', () => {
    expect(shouldNotify({ enabled: true, attentive: false, fresh: 1 })).toBe(true);
    expect(shouldNotify({ enabled: false, attentive: false, fresh: 1 })).toBe(false);
    expect(shouldNotify({ enabled: true, attentive: true, fresh: 1 })).toBe(false);
    expect(shouldNotify({ enabled: true, attentive: false, fresh: 0 })).toBe(false);
  });

  it('reports only approvals that were not seen before', () => {
    const seen = new Set(['s1/a1']);
    const fresh = freshApprovals(seen, [make('a1', 'Ada'), { ...make('a2', 'Grace'), sessionId: 's2' }]);
    expect(fresh.map(item => item.id)).toEqual(['a2']);
  });
});

describe('approval notification copy', () => {
  const copy = { one: (name: string) => `${name} needs your approval`, many: (count: number) => `${count} agents need your approval`, unnamed: 'Agent' };

  it('names the agent and the action for one request', () => {
    expect(notificationContent([make('a1', 'Ada')], copy)).toEqual({ title: 'Ada needs your approval', body: 'Run npm test' });
    expect(notificationContent([make('a1', '')], copy).title).toBe('Agent needs your approval');
  });

  it('summarises several requests without repeating secrets or long lists', () => {
    const content = notificationContent([make('a1', 'Ada'), make('a2', 'Grace'), make('a3', 'Linus'), make('a4', 'Ken')], copy);
    expect(content.title).toBe('4 agents need your approval');
    expect(content.body).toBe('Ada, Grace, Linus');
  });
});
