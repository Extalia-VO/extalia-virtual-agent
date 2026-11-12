import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { Workspace } from '@extalia/core';
import type { AgentHostApi, HostState, SessionMovePreview, SessionSummary } from '@extalia/platform';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionMoveDialog } from '../src/chat/SessionMoveDialog';
import { MESSAGES } from '../src/i18n';

// Exercise the component's real async handlers and committed layout phase using
// isolated in-memory hooks. No DOM, host profile or provider is touched.
const hooks = vi.hoisted(() => ({ index: 0, state: [] as unknown[], deps: new Map<number, readonly unknown[]>(), memo: new Map<number, { deps: readonly unknown[]; value: unknown }>(), layout: [] as (() => void)[], effects: [] as (() => void)[] }));
vi.mock('react', async original => {
  const effect = (queue: (() => void)[], run: () => void, deps: readonly unknown[]) => {
    const id = hooks.index++, previous = hooks.deps.get(id);
    if (!previous || deps.length !== previous.length || deps.some((value, i) => !Object.is(value, previous[i]))) {
      hooks.deps.set(id, deps); queue.push(run);
    }
  };
  return { ...await original<typeof React>(),
    useState: (initial: unknown) => {
      const id = hooks.index++;
      if (!(id in hooks.state)) hooks.state[id] = typeof initial === 'function' ? initial() : initial;
      return [hooks.state[id], (value: unknown) => { hooks.state[id] = typeof value === 'function' ? value(hooks.state[id]) : value; }];
    },
    useRef: (initial: unknown) => { const id = hooks.index++; return hooks.state[id] ??= { current: initial }; },
    useMemo: (compute: () => unknown, deps: readonly unknown[]) => {
      const id = hooks.index++, prior = hooks.memo.get(id);
      if (!prior || deps.length !== prior.deps.length || deps.some((value, i) => !Object.is(value, prior.deps[i]))) hooks.memo.set(id, { deps, value: compute() });
      return hooks.memo.get(id)!.value;
    },
    useId: () => 'review-dialog',
    useEffect: (run: () => void, deps: readonly unknown[]) => effect(hooks.effects, run, deps),
    useLayoutEffect: (run: () => void, deps: readonly unknown[]) => effect(hooks.layout, run, deps),
  };
});
const elements = (node: ReactNode): ReactElement<Record<string, unknown>>[] => Array.isArray(node) ? node.flatMap(elements)
  : isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
const stamp = '2026-11-12T00:00:00.000Z';
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function harness() {
  const workspace: Workspace = { id: 'workspace-example', name: 'Example', profileId: 'default', projectLocation: '/projects/first', providerProfileId: 'connection-example', createdAt: stamp, updatedAt: stamp };
  const session: SessionSummary = { id: 'session-example', workspaceId: workspace.id, connectionId: 'connection-example', title: 'Example', control: 'managed', running: false, createdAt: stamp, lastActiveAt: stamp, workspaceReviewRequired: true };
  const view: SessionMovePreview['source'] = { id: workspace.id, name: workspace.name, folders: [workspace.projectLocation!], crossWorkspaceAccess: 'read-only', permissions: { fileWrite: 'ask', commands: 'ask' } };
  const preview: SessionMovePreview = { sessionId: session.id, reviewId: 'review-example', expiresAt: '2030-01-01T00:00:00.000Z', source: view, destination: view,
    accessibleFolders: [{ workspaceId: workspace.id, path: workspace.projectLocation!, access: 'read-write' }], transfersHistory: true, permissionMode: 'workspace' };
  const agents = { previewSessionMove: vi.fn(async () => preview), moveSession: vi.fn() } as unknown as AgentHostApi;
  const props: Parameters<typeof SessionMoveDialog>[0] = { t: MESSAGES.en, agents, session, workspaces: [workspace], currentWorkspaceOnly: true, onClose: vi.fn(), onMoved: vi.fn() };
  const render = () => {
    hooks.index = 0; const tree = SessionMoveDialog(props);
    for (const run of hooks.layout.splice(0)) run();
    for (const run of hooks.effects.splice(0)) run();
    return tree;
  };
  const button = (label: string) => elements(render()).find(node => node.type === 'button' && text(node.props.children as ReactNode) === label)!;
  const click = (label: string) => { const element = button(label); (element.props.onClick as () => void)(); };
  const review = async () => {
    click(MESSAGES.en.chat.move.review);
    await vi.waitFor(() => expect(elements(render()).some(node => node.type === 'input' && node.props.type === 'checkbox')).toBe(true));
    const checkbox = elements(render()).find(node => node.type === 'input' && node.props.type === 'checkbox')!;
    (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } });
  };
  return { props, render, button, click, review };
}
beforeEach(() => { hooks.index = 0; hooks.state = []; hooks.deps.clear(); hooks.memo.clear(); hooks.layout = []; hooks.effects = []; });

describe('session workspace review callback ownership', () => {
  it('applies an exact still-current review through the original callback', async () => {
    const h = harness();
    const result = { sessions: [] } as unknown as HostState;
    vi.mocked(h.props.agents.moveSession!).mockResolvedValue(result);
    await h.review(); h.click(MESSAGES.en.chat.move.apply);
    await vi.waitFor(() => expect(h.props.onMoved).toHaveBeenCalledExactlyOnceWith(result, h.props.session.workspaceId));
  });

  it.each([false, true])('drops a delayed apply after committed context changes, including ABA=%s, and releases busy', async revert => {
    const h = harness(), pending = deferred<HostState>();
    vi.mocked(h.props.agents.moveSession!).mockReturnValue(pending.promise);
    await h.review(); h.click(MESSAGES.en.chat.move.apply);
    expect(h.props.agents.moveSession).toHaveBeenCalledOnce();
    const previous = h.props.workspaces;
    h.props.workspaces = [{ ...previous[0]!, projectLocation: '/projects/second' }]; h.render();
    if (revert) { h.props.workspaces = previous; h.render(); }
    pending.resolve({ sessions: [] } as unknown as HostState);
    await vi.waitFor(() => expect(h.button(MESSAGES.en.chat.move.review)?.props.disabled).toBe(false));
    expect(h.props.onMoved).not.toHaveBeenCalled();
    expect(elements(h.render()).some(node => node.type === 'input' && node.props.type === 'checkbox')).toBe(false);
  });

  it('discards a delayed preview for an earlier context and allows a fresh review', async () => {
    const h = harness(), pending = deferred<SessionMovePreview>();
    vi.mocked(h.props.agents.previewSessionMove!).mockReturnValue(pending.promise);
    h.click(MESSAGES.en.chat.move.review);
    h.props.session = { ...h.props.session, title: 'Updated conversation' }; h.render();
    pending.resolve({ reviewId: 'old-review' } as SessionMovePreview);
    await vi.waitFor(() => expect(h.button(MESSAGES.en.chat.move.review)?.props.disabled).toBe(false));
    expect(elements(h.render()).some(node => node.type === 'input' && node.props.type === 'checkbox')).toBe(false);
    expect(h.props.onMoved).not.toHaveBeenCalled();
  });

  it('follows a changed current workspace rather than retaining an earlier destination in current-only recovery', async () => {
    const h = harness(); h.render();
    h.props.session = { ...h.props.session, workspaceId: 'changed-workspace' };
    h.props.workspaces = [{ ...h.props.workspaces[0]!, id: 'changed-workspace' }];
    const select = elements(h.render()).find(node => Array.isArray(node.props.options))!;
    expect(select.props.value).toBe('changed-workspace');
    h.click(MESSAGES.en.chat.move.review);
    expect(h.props.agents.previewSessionMove).toHaveBeenCalledExactlyOnceWith(h.props.session.id, 'changed-workspace');
    await Promise.resolve();
  });

  it('keeps the Native session’s current workspace selectable after its default becomes Hermes', () => {
    const h = harness();
    h.props.workspaces = [{ ...h.props.workspaces[0]!, runtimeId: 'hermes', runtimeProfileId: 'default' },
      { ...h.props.workspaces[0]!, id: 'other-hermes', runtimeId: 'hermes' }];
    const select = elements(h.render()).find(node => Array.isArray(node.props.options))!;
    expect(select.props.options).toEqual([expect.objectContaining({ value: h.props.session.workspaceId })]);
  });
});
