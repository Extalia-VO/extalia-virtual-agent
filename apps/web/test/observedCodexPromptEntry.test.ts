import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { ObserverPage } from '../src/pages/ObserverPage';
import { ChatPage } from '../src/chat/ChatPage';
import { CharacterConversation } from '../src/office/CharacterConversation';
import type { OfficeAgent } from '../src/office/presence';

const session = {
  id: 'observed-example', title: 'Original Codex conversation', workspaceId: 'workspace', connectionId: 'observed', control: 'observed', running: false,
  createdAt: '2026-11-08T10:00:00Z',
  lastActiveAt: '2026-11-08T10:00:00Z', messageCount: 1,
  observation: { sourceId: 'codex', nativeSessionId: '11111111-1111-4111-8111-111111111111', projectPath: '/projects/example', watching: true, status: 'watching' },
} as SessionSummary;
const state = {
  sessions: [session], connections: [], profile: { id: 'example' },
  workspaces: [{ id: 'workspace', name: 'Example', runtimeId: 'extalia-native', projectLocation: '/projects/example' }],
} as unknown as HostState;
const callbacks = { onState: vi.fn(), onOpenSettings: vi.fn() };

it.each(['en', 'id'] as const)('shows the normal Codex prompt outside collapsed connection panels in Observe, Office and Chat (%s)', language => {
  const t = MESSAGES[language];
  const host = {
    createSession: vi.fn(), sendPrompt: vi.fn(), queueObservedCodexMessage: vi.fn(),
    setObservedCodexQueue: vi.fn(), observedCodexQueueStatus: vi.fn(),
  } as unknown as AgentHostApi;
  const common = { t, language, agents: host, state, ...callbacks };
  const views = [
    createElement(ObserverPage, { ...common, onContinued: vi.fn() }),
    createElement(CharacterConversation, { ...common, session, agent: {
      id: 'observed-example:primary', sessionId: session.id, agentId: 'primary', displayName: 'Observed agent',
      control: 'observed', status: 'observing', running: false,
    } as OfficeAgent }),
    createElement(ChatPage, { ...common, selection: { workspaceId: 'workspace', sessionId: session.id }, onSelect: vi.fn(), onReviewSkills: vi.fn() }),
  ];
  for (const view of views) {
    const markup = renderToStaticMarkup(view);
    const visible = markup.replace(/<details\b[\s\S]*?<\/details>/g, '');
    expect(visible).toContain('composer observed-codex-prompt');
    expect(visible).toContain(t.observedCodexPrompt.placeholder);
    expect(visible.match(/<textarea\b/g)).toHaveLength(1);
    expect(markup.match(/composer observed-codex-prompt/g)).toHaveLength(1);
  }
  expect(host.createSession).not.toHaveBeenCalled();
  expect(host.sendPrompt).not.toHaveBeenCalled();
  expect(host.queueObservedCodexMessage).not.toHaveBeenCalled();
  expect(host.setObservedCodexQueue).not.toHaveBeenCalled();
});

it('keeps observed worker characters and ended Office dialogs without a prompt sender', () => {
  const props = { t: MESSAGES.en, language: 'en', agents: {} as AgentHostApi, state, session, ...callbacks };
  const agent = { id: 'worker', sessionId: session.id, agentId: 'worker', displayName: 'Observed worker', control: 'observed', status: 'observing', running: false } as OfficeAgent;
  expect(renderToStaticMarkup(createElement(CharacterConversation, { ...props, agent }))).not.toContain('composer observed-codex-prompt');
  expect(renderToStaticMarkup(createElement(CharacterConversation, { ...props, agent: { ...agent, agentId: 'primary' }, readOnlyReason: 'Ended' }))).not.toContain('composer observed-codex-prompt');
});

it.each(['gemini-cli', 'antigravity', 'claude-code'] as const)('shows the observed prompt composer in Observe, Office and Chat for watched %s sessions', sourceId => {
  const t = MESSAGES.en;
  const cooperativeSession = {
    ...session,
    id: `observed-${sourceId}`,
    title: `Observed ${sourceId}`,
    model: sourceId === 'antigravity' ? 'gemini-4-argon-medium' : 'gemini-2.5-pro',
    observation: { ...session.observation!, sourceId },
  } as SessionSummary;
  const cooperativeState = { ...state, sessions: [cooperativeSession] } as unknown as HostState;
  const host = {
    createSession: vi.fn(), sendPrompt: vi.fn(),
    modelChoices: vi.fn(),
    promptQueueStatus: vi.fn(), changePromptQueue: vi.fn(),
    observedControlStatus: vi.fn(), dispatchObservedControl: vi.fn(),
  } as unknown as AgentHostApi;
  const common = { t, language: 'en' as const, agents: host, state: cooperativeState, ...callbacks };
  const views = [
    createElement(ObserverPage, { ...common, onContinued: vi.fn() }),
    createElement(CharacterConversation, { ...common, session: cooperativeSession, agent: {
      id: `${cooperativeSession.id}:primary`, sessionId: cooperativeSession.id, agentId: 'primary', displayName: 'Observed agent',
      control: 'observed', status: 'observing', running: false,
    } as OfficeAgent }),
    createElement(ChatPage, { ...common, selection: { workspaceId: 'workspace', sessionId: cooperativeSession.id }, onSelect: vi.fn(), onReviewSkills: vi.fn() }),
  ];
  for (const view of views) {
    const markup = renderToStaticMarkup(view);
    const visible = markup.replace(/<details\b[\s\S]*?<\/details>/g, '');
    expect(visible).toContain('composer observed-codex-prompt');
    expect(visible).toContain(t.observedControl.placeholder);
    expect(visible).toContain('composer-attach');
    expect(visible).toContain('composer-model');
    expect(visible).toContain('composer-effort');
    expect(visible).toContain('type="file"');
    expect(visible.match(/<textarea\b/g)).toHaveLength(1);
  }
});
