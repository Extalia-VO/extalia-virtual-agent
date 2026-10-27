import type { SessionContextUsage, SessionSummary } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { projectOfficePresence } from '../src/office/presence';
import { contextLabel, formatTokenCount } from '../src/office/overlay/contextLabel';
import { createEvent, type ExtaliaEvent } from '@extalia/protocol';

const AT = '2026-10-08T00:00:00.000Z';
const usage = (overrides: Partial<SessionContextUsage> = {}): SessionContextUsage => ({ usedTokens: 124_000, windowTokens: 200_000, estimated: false, compactions: 0, updatedAt: AT, ...overrides });

describe('context figures', () => {
  it('shortens token counts', () => {
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(124_000)).toBe('124k');
    expect(formatTokenCount(124_400)).toBe('124k');
    expect(formatTokenCount(1_000_000)).toBe('1M');
    expect(formatTokenCount(1_047_576)).toBe('1M');
    expect(formatTokenCount(1_250_000)).toBe('1.3M');
    expect(formatTokenCount(12_000_000)).toBe('12M');
  });

  it('shows the share and the window, with the tone at 80% and 95%', () => {
    const label = contextLabel(usage(), MESSAGES.en);
    expect(label).toMatchObject({ value: '62% · 124k / 200k', tone: 'normal', percent: 62, title: '' });
    expect(contextLabel(usage({ usedTokens: 160_000 }), MESSAGES.en)).toMatchObject({ value: '80% · 160k / 200k', tone: 'warning' });
    expect(contextLabel(usage({ usedTokens: 190_000 }), MESSAGES.en)).toMatchObject({ value: '95% · 190k / 200k', tone: 'danger' });
    expect(contextLabel(usage({ usedTokens: 190_000 }), MESSAGES.en).title).toBe('Almost at the context limit');
  });

  it('shows tokens alone without a window, and marks estimates with ≈', () => {
    expect(contextLabel(usage({ windowTokens: undefined }), MESSAGES.en)).toMatchObject({ value: '124k tokens', tone: 'normal' });
    expect(contextLabel(usage({ windowTokens: undefined }), MESSAGES.en).title).toBe('The window size of this model is not known');
    const estimate = contextLabel(usage({ estimated: true }), MESSAGES.en);
    expect(estimate.value).toBe('≈62% · ≈124k / 200k');
    expect(estimate.title).toBe('Estimated from the text sent, because the model reported no usage');
    expect(contextLabel(usage({ windowTokens: undefined, estimated: true }), MESSAGES.en).value).toBe('≈124k tokens');
  });

  it('notes compactions in the tooltip', () => {
    expect(contextLabel(usage({ compactions: 1 }), MESSAGES.en).title).toBe('Compacted once');
    expect(contextLabel(usage({ compactions: 3 }), MESSAGES.en).title).toBe('Compacted 3 times');
  });

  it('has Indonesian copy for the same figures', () => {
    const label = contextLabel(usage({ usedTokens: 192_400, compactions: 2 }), MESSAGES.id);
    expect(label.value).toBe('96% · 192k / 200k');
    expect(label.title).toBe('Hampir penuh di batas konteks · Dipadatkan 2 kali');
    expect(contextLabel(usage({ windowTokens: undefined }), MESSAGES.id).value).toBe('124k token');
  });
});

describe('context on the Office presence', () => {
  const session = (overrides: Partial<SessionSummary>): SessionSummary => ({
    id: 's-ctx', workspaceId: 'ws', connectionId: 'connection', title: 'Context', control: 'managed',
    createdAt: AT, lastActiveAt: AT, running: false, ...overrides,
  });
  const delegated: ExtaliaEvent[] = [
    createEvent({ id: 'e1', at: AT, seq: 1, sessionId: 's-ctx', agentId: 'primary', source: { runtime: 'test', channel: 'stream' }, body: { type: 'subagent.spawned', subagentId: 'worker-1', label: 'Reader' } }),
  ];

  it('gives the lead its context and leaves subagents without one', () => {
    const agents = projectOfficePresence([session({ context: usage() })], delegated);
    expect(agents.find(agent => agent.agentId === 'primary')?.context).toEqual(usage());
    expect(agents.find(agent => agent.agentId === 'worker-1')).toBeDefined();
    expect(agents.find(agent => agent.agentId === 'worker-1')?.context).toBeUndefined();
  });

  it('leaves the context absent when the session reports none', () => {
    const agents = projectOfficePresence([session({})], []);
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.every(agent => agent.context === undefined)).toBe(true);
  });
});
