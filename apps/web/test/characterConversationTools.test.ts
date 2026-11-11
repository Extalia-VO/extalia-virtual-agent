import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { CharacterConversation } from '../src/office/CharacterConversation';
import { ObservedSessionTools } from '../src/observe/ObservedSessionControl';
import type { OfficeAgent } from '../src/office/presence';

// Run the conversation's handlers and layout effects without mounting its host-backed children.
const hooks = vi.hoisted(() => ({
  index: 0, wide: true, state: [] as unknown[],
  effects: new Map<number, { deps: unknown[]; cleanup?: (() => void) | undefined }>(),
  pending: [] as (() => void)[], frames: [] as FrameRequestCallback[],
}));
vi.mock('../src/chat/useSessionEvents', () => ({ useSessionEvents: () => ({ events: [], error: null, loading: false }) }));
// This handler-only harness has no mounted provider; use its normal absent-context state.
vi.mock('../src/observe/ObservedInputProvider', () => ({ useObservedInputs: () => null }));
vi.mock('react', async original => ({
  ...await original<typeof React>(),
  useState: (initial: unknown) => {
    const id = hooks.index++;
    if (!(id in hooks.state)) hooks.state[id] = initial;
    return [hooks.state[id], (next: unknown) => { hooks.state[id] = typeof next === 'function' ? next(hooks.state[id]) : next; }];
  },
  useRef: (initial: unknown) => { const id = hooks.index++; return hooks.state[id] ??= { current: initial }; },
  useMemo: (compute: () => unknown) => compute(),
  useEffect: () => undefined,
  useLayoutEffect: (run: () => (() => void) | void, deps: unknown[]) => {
    const id = hooks.index++, prior = hooks.effects.get(id);
    if (!prior || prior.deps.length !== deps.length || deps.some((value, index) => !Object.is(value, prior.deps[index]))) {
      hooks.pending.push(() => {
        prior?.cleanup?.();
        hooks.effects.set(id, { deps, cleanup: run() || undefined });
      });
    }
  },
  useSyncExternalStore: () => hooks.wide,
  useId: () => 'conversation-tools',
}));

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const click = (element: ReactElement<Record<string, unknown>>) => (element.props.onClick as () => void)();
const byClass = (tree: ReactNode, className: string) => elements(tree).find(element => String(element.props.className).split(' ').includes(className))!;
const setFocusRef = (element: ReactElement<Record<string, unknown>>, focus: () => void) => { (element.props.ref as { current: unknown }).current = { focus }; };

function harness() {
  const session = { id: 'example-session', workspaceId: 'workspace', control: 'observed', observation: { sourceId: 'codex' } } as SessionSummary;
  const report = vi.fn();
  const props: Parameters<typeof CharacterConversation>[0] = {
    t: MESSAGES.en, language: 'en', agents: {} as AgentHostApi,
    state: { workspaces: [] } as unknown as HostState,
    session, agent: { id: 'example-session:primary', agentId: 'primary', displayName: 'Example agent', status: 'observing', control: 'observed' } as OfficeAgent,
    onState: vi.fn(), onToolsStateChange: report,
  };
  const render = () => {
    hooks.index = 0;
    const tree = CharacterConversation(props);
    for (const run of hooks.pending.splice(0)) run();
    return tree;
  };
  const unmount = () => { for (const effect of hooks.effects.values()) effect.cleanup?.(); };
  return { props, report, render, unmount };
}

beforeEach(() => {
  hooks.index = 0; hooks.wide = true; hooks.state = []; hooks.effects.clear(); hooks.pending = []; hooks.frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => hooks.frames.push(callback));
});
afterEach(() => { vi.unstubAllGlobals(); });

it('keeps a collapsed wide rail mounted and inaccessible, and restores focus to its toggle', () => {
  const h = harness(), open = h.render(), toggleFocus = vi.fn();
  const initialTools = byClass(open, 'character-conversation-tools');
  setFocusRef(byClass(open, 'character-tools-toggle'), toggleFocus);
  click(byClass(open, 'character-tools-toggle'));
  const closed = h.render(), closedTools = byClass(closed, 'character-conversation-tools');
  expect(closedTools.type).toBe(initialTools.type);
  expect(closedTools.props.id).toBe(initialTools.props.id);
  expect(closedTools.props.children).toHaveLength(2);
  expect(closedTools.props.hidden).toBeUndefined();
  expect(closedTools.props.inert).toBe(true);
  expect(closedTools.props['aria-hidden']).toBe(true);
  expect(byClass(closed, 'character-tools-toggle').props['aria-expanded']).toBe(false);
  expect(byClass(closed, 'character-conversation-main').props.inert).toBeUndefined();
  expect(h.report.mock.calls.map(call => call[0])).toEqual([
    { available: true, open: true, wide: true }, { available: true, open: false, wide: true },
  ]);
  for (const frame of hooks.frames.splice(0)) frame(0);
  expect(toggleFocus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  click(byClass(closed, 'character-tools-toggle'));
  const reopened = byClass(h.render(), 'character-conversation-tools');
  expect(reopened.props.inert).toBeUndefined();
  expect(reopened.props['aria-hidden']).toBeUndefined();
  expect(reopened.props.id).toBe(initialTools.props.id);
});

it('opens narrow tools as a focused drawer and removes its Escape target immediately on close', () => {
  hooks.wide = false;
  const h = harness(), closed = h.render(), closeFocus = vi.fn();
  const tools = byClass(closed, 'character-conversation-tools');
  expect(tools.props.inert).toBe(true);
  setFocusRef(elements(tools).find(element => element.props['data-conversation-tools-close'] === true)!, closeFocus);
  click(byClass(closed, 'character-tools-toggle'));
  const opened = h.render();
  expect(byClass(opened, 'character-conversation-main').props.inert).toBe(true);
  expect(byClass(opened, 'character-conversation-tools').props['data-conversation-drawer']).toBe('true');
  expect(closeFocus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  click(elements(opened).find(element => element.props['data-conversation-tools-close'] === true)!);
  const closing = h.render();
  expect(byClass(closing, 'character-conversation-tools').props['data-conversation-drawer']).toBeUndefined();
  expect(byClass(closing, 'character-conversation-tools').props.inert).toBe(true);
  expect(byClass(closing, 'character-conversation-main').props.inert).toBeUndefined();
});

it('reports breakpoint, ended-session and unmount changes without resetting on ordinary rerenders', () => {
  const h = harness(); h.render(); h.render();
  expect(h.report).toHaveBeenCalledTimes(1);
  hooks.wide = false; h.render();
  expect(h.report).toHaveBeenLastCalledWith({ available: true, open: false, wide: false });
  h.props.readOnlyReason = 'Session ended';
  expect(elements(h.render()).some(element => element.type === 'aside')).toBe(false);
  expect(h.report).toHaveBeenLastCalledWith({ available: false, open: false, wide: false });
  h.unmount();
  expect(h.report).toHaveBeenLastCalledWith({ available: false, open: false, wide: false });
});

it('publishes unmount cleanup to the latest callback', () => {
  const h = harness(); h.render();
  const latest = vi.fn(); h.props.onToolsStateChange = latest; h.render();
  h.unmount();
  expect(latest).toHaveBeenCalledExactlyOnceWith({ available: false, open: false, wide: true });
  expect(h.report).toHaveBeenCalledTimes(1);
});

it('keeps cooperative observed settings collapsed until the user opens the tools', () => {
  const h = harness();
  h.props.session = { ...h.props.session, observation: { ...h.props.session.observation!, sourceId: 'hermes' } };
  h.props.agents = { observedControlStatus: vi.fn(), dispatchObservedControl: vi.fn() } as unknown as AgentHostApi;
  const tree = h.render();
  expect(byClass(tree, 'character-conversation-tools').props.inert).toBe(true);
  expect(byClass(tree, 'character-tools-toggle').props['aria-expanded']).toBe(false);
  expect(h.report).toHaveBeenLastCalledWith({ available: true, open: false, wide: true });
  click(byClass(tree, 'character-tools-toggle'));
  const opened = h.render();
  expect(byClass(opened, 'character-conversation-tools').props.inert).toBeUndefined();
  expect(elements(opened).some(element => element.type === ObservedSessionTools)).toBe(true);
});
