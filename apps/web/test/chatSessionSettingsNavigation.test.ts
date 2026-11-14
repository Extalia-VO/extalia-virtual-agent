import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPage } from '../src/chat/ChatPage';
import { NativeSessionTree } from '../src/chat/NativeSessionTree';
import { SessionMoveDialog } from '../src/chat/SessionMoveDialog';
import { MESSAGES } from '../src/i18n';

const hooks = vi.hoisted(() => ({ index: 0, values: [] as unknown[] }));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next; }];
  },
  useRef: (initial: unknown) => { const index = hooks.index++; return hooks.values[index] ??= { current: initial }; },
  useMemo: (compute: () => unknown) => compute(), useId: () => 'chat-session-settings',
  useEffect: (run: () => unknown) => { run(); },
  useLayoutEffect: (run: () => unknown) => { run(); },
}));
vi.mock('../src/chat/useSessionEvents', () => ({ useSessionEvents: () => ({ events: [], loading: false, error: undefined }) }));
vi.mock('../src/chat/chatTeam', () => ({ useChatTeam: () => ({ supported: false, isUpdating: () => false }) }));

const at = '2026-11-13T00:00:00Z';
const row = (id: string): SessionSummary => ({ id, workspaceId: 'workspace-a', connectionId: 'connection', title: id, control: 'managed', running: false, createdAt: at, lastActiveAt: at });
const state: HostState = {
  setupComplete: true, profile: { id: 'profile', name: 'Example' }, connections: [],
  workspaces: ['workspace-a', 'workspace-b'].map(id => ({ id, profileId: 'profile', name: id, projectLocation: `/projects/${id}`, createdAt: at, updatedAt: at })),
  sessions: [row('first'), row('second')], library: [], dataDirectory: '/example/extalia', storage: { dataDirectory: '/example/extalia', secretStore: 'memory' }, host: { kind: 'bridge', version: 'test' },
};
const elements = (node: ReactNode): ReactElement<Record<string, unknown>>[] => Array.isArray(node) ? node.flatMap(elements) : isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children as ReactNode)] : [];
function harness() {
  const props: Parameters<typeof ChatPage>[0] = { t: MESSAGES.en, language: 'en', agents: {} as AgentHostApi, state,
    onState: vi.fn(), selection: { workspaceId: 'workspace-a', sessionId: 'first' }, onSelect: vi.fn(), onOpenSettings: vi.fn(), onReviewSkills: vi.fn() };
  const render = () => { hooks.index = 0; return elements(ChatPage(props)); };
  const settings = (id: string) => {
    const tree = render().find(node => node.type === NativeSessionTree)!;
    (tree.props.onSettings as (session: SessionSummary) => void)(state.sessions.find(session => session.id === id)!);
    return render().find(node => node.type === SessionMoveDialog)!;
  };
  return { props, render, settings };
}
beforeEach(() => {
  hooks.index = 0; hooks.values = [];
  vi.stubGlobal('window', { addEventListener: vi.fn(), scrollTo: vi.fn() });
  vi.stubGlobal('document', { documentElement: { scrollHeight: 0 } });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
});
afterEach(() => vi.unstubAllGlobals());

describe('session settings completion navigation', () => {
  it('does not replace the active conversation when configuring another row', () => {
    const h = harness(), dialog = h.settings('second');
    (dialog.props.onMoved as (next: HostState, workspaceId: string) => void)(state, 'workspace-b');
    expect(h.props.onState).toHaveBeenCalledWith(state);
    expect(h.props.onSelect).not.toHaveBeenCalled();
  });
  it('follows a cross-workspace move only while that session is still active', () => {
    const h = harness(), dialog = h.settings('first');
    (dialog.props.onMoved as (next: HostState, workspaceId: string) => void)(state, 'workspace-b');
    expect(h.props.onSelect).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-b', sessionId: 'first' });
  });
  it('follows the requested session when streamed host state arrives before the move acknowledgement', () => {
    const h = harness(), dialog = h.settings('first');
    const streamed = { ...state, sessions: state.sessions.map(session => session.id === 'first' ? { ...session, workspaceId: 'workspace-b' } : session) };
    h.props.state = streamed; h.render();
    (dialog.props.onMoved as (next: HostState, workspaceId: string) => void)(streamed, 'workspace-b');
    expect(h.props.onSelect).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-b', sessionId: 'first' });
  });
  it('does not restore an old session after the user switches to another session or a new draft', () => {
    const h = harness(), dialog = h.settings('first');
    h.props.selection = { workspaceId: 'workspace-a', sessionId: null }; h.render();
    (dialog.props.onMoved as (next: HostState, workspaceId: string) => void)(state, 'workspace-b');
    expect(h.props.onState).toHaveBeenCalledWith(state);
    expect(h.props.onSelect).not.toHaveBeenCalled();
  });
  it.each(['profile', 'api'] as const)('drops completion from the old %s scope', kind => {
    const h = harness(), dialog = h.settings('first');
    if (kind === 'api') h.props.agents = {} as AgentHostApi;
    else h.props.state = { ...state, dataDirectory: '/example/other', storage: { ...state.storage, dataDirectory: '/example/other' } };
    h.render();
    (dialog.props.onMoved as (next: HostState, workspaceId: string) => void)(state, 'workspace-b');
    expect(h.props.onState).not.toHaveBeenCalled(); expect(h.props.onSelect).not.toHaveBeenCalled();
  });
});
