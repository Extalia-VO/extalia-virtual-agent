import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { AgentHostApi, HostState } from '@extalia/platform';
import { describe, expect, it, vi } from 'vitest';
import { ChatPage } from '../src/chat/ChatPage';
import { Composer } from '../src/chat/Composer';
import { MESSAGES } from '../src/i18n';

vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()],
  useMemo: (compute: () => unknown) => compute(),
  useRef: (initial: unknown) => ({ current: initial }),
  useId: () => 'chat-learning', useEffect: () => undefined,
}));
vi.mock('../src/chat/useSessionEvents', () => ({ useSessionEvents: () => ({ events: [], loading: false, error: undefined }) }));
vi.mock('../src/chat/chatTeam', () => ({ useChatTeam: () => ({ supported: false, isUpdating: () => false }) }));

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const stamp = '2026-01-01T00:00:00.000Z';
const state: HostState = {
  setupComplete: true, profile: { id: 'profile', name: 'Example' }, connections: [],
  workspaces: [{ id: 'w_example', profileId: 'profile', name: 'Example project', projectLocation: '/example/project', createdAt: stamp, updatedAt: stamp }],
  sessions: [], library: [], dataDirectory: '/example/extalia', storage: { dataDirectory: '/example/extalia', secretStore: 'memory' }, host: { kind: 'bridge', version: 'test' },
};
const props = () => ({ t: MESSAGES.en, language: 'en', agents: {} as AgentHostApi, state,
  onState: vi.fn(), selection: { workspaceId: 'w_example', sessionId: null }, onSelect: vi.fn(), onOpenSettings: vi.fn(), onReviewSkills: vi.fn(), onLearningTarget: vi.fn() });

describe('Chat learning notification placement', () => {
  it('registers one normal-flow slot directly above the composer even before a model connection is configured', () => {
    const value = props(), tree = ChatPage(value);
    const all = elements(tree), slots = all.filter(node => node.props.className === 'chat-learning-slot');
    expect(slots).toHaveLength(1);
    const footer = all.find(node => node.props.className === 'chat-footer')!;
    const children = elements(footer);
    expect(children.indexOf(slots[0]!)).toBeGreaterThan(0);
    expect(children.indexOf(slots[0]!)).toBeLessThan(children.findIndex(node => node.type === Composer));
    const ref = slots[0]!.props.ref as (target: HTMLDivElement | null) => void;
    const target = { id: 'chat-slot' } as HTMLDivElement;
    ref(target); ref(null);
    expect(value.onLearningTarget.mock.calls).toEqual([[target], [null]]);
    expect(slots[0]!.props.style).toBeUndefined();
  });
  it('keeps a registered normal-flow target on the no-project setup view rather than requiring floating fallback', () => {
    const value = { ...props(), state: { ...state, workspaces: [] } };
    const tree = ChatPage(value), slots = elements(tree).filter(node => node.props.className === 'chat-learning-slot');
    expect(slots).toHaveLength(1);
    expect(slots[0]!.props.ref).toBe(value.onLearningTarget);
    expect(elements(tree).some(node => node.type === Composer)).toBe(false);
  });
});
