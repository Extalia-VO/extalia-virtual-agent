import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { CharacterConversation } from '../src/office/CharacterConversation';
import type { OfficeAgent } from '../src/office/presence';

const session = {
  id: 'example-session', title: 'Example conversation', workspaceId: 'workspace', connectionId: 'connection', control: 'observed', running: false,
  createdAt: '2030-01-01T00:00:00Z', lastActiveAt: '2030-01-01T00:00:00Z',
  observation: { sourceId: 'codex', nativeSessionId: '11111111-1111-4111-8111-111111111111', watching: true, status: 'watching' },
} as SessionSummary;
const agent = { id: 'example-session:primary', sessionId: session.id, agentId: 'primary', displayName: 'Example agent', control: 'observed', status: 'observing', running: false } as OfficeAgent;
const state = { sessions: [session], connections: [], profile: { id: 'example' }, workspaces: [{ id: 'workspace', name: 'Example', runtimeId: 'extalia-native', projectLocation: '/projects/example' }] } as unknown as HostState;
const host = {
  createSession: vi.fn(), sendPrompt: vi.fn(), queueObservedCodexMessage: vi.fn(), setObservedCodexQueue: vi.fn(), promptQueueStatus: vi.fn(), changePromptQueue: vi.fn(),
  applyObservedCodexPermissionHook: vi.fn(), answerObservedCodexPermission: vi.fn(),
} as unknown as AgentHostApi;
const render = (patch: Partial<Parameters<typeof CharacterConversation>[0]> = {}) => renderToStaticMarkup(createElement(CharacterConversation, {
  t: MESSAGES.en, language: 'en', agents: host, state, session, agent, onState: vi.fn(), ...patch,
}));
const footer = (html: string) => html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)![1]!;
const aside = (html: string) => html.match(/<aside\b[^>]*>([\s\S]*?)<\/aside>/)![1]!;

it.each(['en', 'id'] as const)('keeps the normal observed composer in the footer and moves all auxiliary controls into the aside (%s)', language => {
  const t = MESSAGES[language], html = render({ t, language }), tools = aside(html), mainFooter = footer(html);
  expect(mainFooter).toContain('composer observed-codex-prompt');
  expect(mainFooter).not.toContain('<details'); expect(mainFooter).not.toContain('prompt-queue');
  expect(tools).toContain(t.observedCodexNativeQueue.title);
  expect(mainFooter).not.toContain('observed-codex-native-queue');
  for (const label of [t.observedCodexPrompt.settings, t.observedCodexPermission.title, t.observedCodex.title, t.observedReply.title]) expect(tools).toContain(label);
  expect(tools).not.toContain('prompt-queue'); expect(mainFooter.match(/<textarea/g)).toHaveLength(1);
  expect(tools).not.toContain('composer observed-codex-prompt');
  expect(html).toContain('aria-expanded="true"'); expect(html).toContain(t.characterConsole.tools);
  const target = html.match(/class="button small character-tools-toggle"[^>]*aria-controls="([^"]+)"/)![1]!;
  expect(html).toContain(`<aside id="${target}"`);
});

it('keeps the busy managed composer and pending queue together in the main footer', () => {
  const managed = { ...session, control: 'managed' as const, observation: undefined, running: true };
  const html = render({ session: managed, agent: { ...agent, control: 'managed', status: 'idle' } });
  expect(footer(html)).toContain('id="composer-input"'); expect(footer(html)).toContain('prompt-queue');
  expect(footer(html).match(/<textarea/g)).toHaveLength(1);
  expect(aside(html)).not.toContain('prompt-queue'); expect(aside(html)).not.toContain('observed-codex-office');
});

it.each(['managed', 'observed'] as const)('does not expose a queue, tools drawer or sender for workers and ended sessions (%s)', control => {
  const source = { ...session, control }, lead = { ...agent, control };
  for (const patch of [{ agent: { ...lead, agentId: 'worker', id: 'worker' } }, { agent: lead, readOnlyReason: 'Session ended' }]) {
    const html = render({ session: source, ...patch });
    expect(html).not.toContain('<aside'); expect(html).not.toContain('character-tools-toggle');
    expect(html).not.toContain('prompt-queue'); expect(html).not.toContain('<textarea');
    expect(html).toContain('role="tabpanel"');
  }
});

it('keeps all transcript tabs mounted and renders no mutating host calls', () => {
  for (const tab of ['messages', 'activity', 'files'] as const) {
    const html = render({ tab });
    expect(html.match(/role="tabpanel"/g)).toHaveLength(3);
    expect(html.match(/role="tabpanel"[^>]*hidden=""/g)).toHaveLength(2);
    expect(footer(html)).toContain('composer observed-codex-prompt'); expect(aside(html)).not.toContain('prompt-queue');
    expect(footer(html).match(/<textarea/g)).toHaveLength(1);
  }
  for (const operation of Object.values(host)) expect(operation).not.toHaveBeenCalled();
});
