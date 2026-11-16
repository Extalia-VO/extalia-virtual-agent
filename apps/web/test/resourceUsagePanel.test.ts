import type * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createEvent } from '@extalia/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ResourceUsagePanel } from '../src/chat/ResourceUsagePanel';
import { ResourceUsageDiagram } from '../src/chat/ResourceUsageDiagram';
import type { ResourceUsageGraph } from '../src/chat/resourceUsageTypes';
import { MESSAGES } from '../src/i18n';
vi.mock('react', async original => ({ ...await original<typeof React>(), useMemo: (compute: () => unknown) => compute() }));
const events = [createEvent({ id: 'read', sessionId: 'session', agentId: 'primary', source: { runtime: 'codex', channel: 'transcript' },
  body: { type: 'tool.started', toolCallId: 'read', tool: 'knowledge_read', kind: 'knowledge', target: 'Note.md', label: 'Read note' } })];
const props = { events, sessionId: 'session', scopeKey: 'profile', t: MESSAGES.en, language: 'en' };
describe('live resource feed ownership', () => {
  it('shows actual activity from the existing feed and makes no host/model request', () => {
    const tree = ResourceUsagePanel(props);
    expect(tree.type).toBe(ResourceUsageDiagram);
    expect((tree.props.graph as ResourceUsageGraph).nodes[0]!.status).toBe('active');
    expect(tree.props.copy).toBe(MESSAGES.en.resourceUsage);
    expect(tree.props.visible).toBe(true);
  });
  it('hides empty, generic and preparation-only feeds rather than suggesting unreported skill usage', () => {
    const prepared = createEvent({ sessionId: 'session', source: { runtime: 'codex', channel: 'transcript' }, body: {
      type: 'skills.loaded', skills: [{ name: 'review', source: 'builtin', reason: 'current-context', status: 'loaded', characters: 10 }], characters: 10, budgetCharacters: 100,
    } });
    const generic = createEvent({ sessionId: 'session', source: { runtime: 'claude-code', channel: 'transcript' },
      body: { type: 'tool.started', tool: 'read_file', toolCallId: 'generic', kind: 'read', label: 'Read file', target: 'README.md' } });
    for (const feed of [[], [prepared], [generic]]) {
      expect(ResourceUsagePanel({ ...props, events: feed }).props.visible).toBe(false);
      expect(renderToStaticMarkup(createElement(ResourceUsagePanel, { ...props, events: feed }))).toBe('');
    }
  });
  it.each(['completed', 'failed'] as const)('hides the widget once all reported accesses are %s', outcome => {
    const terminal = createEvent({ sessionId: 'session', agentId: 'primary', source: { runtime: 'codex', channel: 'transcript' }, body: outcome === 'completed'
      ? { type: 'tool.completed', toolCallId: 'read', tool: 'knowledge_read', kind: 'knowledge', label: 'Read note', ok: true }
      : { type: 'agent.error', message: 'Worker stopped' } });
    expect(ResourceUsagePanel({ ...props, events: [...events, terminal] }).props.visible).toBe(false);
  });
  it.each(['en', 'id'] as const)('stops active animation during paused/unavailable observation without altering recorded events (%s)', language => {
    const before = JSON.stringify(events), tree = ResourceUsagePanel({ ...props, t: MESSAGES[language], language, live: false });
    expect((tree.props.graph as ResourceUsageGraph).nodes[0]!.status).toBe('unknown');
    expect(tree.props.copy.help).toBe(MESSAGES[language].resourceUsage.pausedHelp);
    expect(tree.props.visible).toBe(false);
    expect(JSON.stringify(events)).toBe(before);
    expect((ResourceUsagePanel(props).props.graph as ResourceUsageGraph).nodes[0]!.status).toBe('active');
  });
});
