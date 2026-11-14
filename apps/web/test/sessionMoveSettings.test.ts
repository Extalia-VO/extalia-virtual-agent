import type { AgentHostApi, HostState, SessionMovePreview, SessionSummary } from '@extalia/platform';
import type { Workspace } from '@extalia/core';
import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionMoveDialog } from '../src/chat/SessionMoveDialog';
import { Select } from '../src/ui/Select';
import { MESSAGES } from '../src/i18n';

const hooks = vi.hoisted(() => ({ index: 0, state: [] as unknown[], effects: new Map<number, { deps: unknown[]; cleanup?: () => void }>(), memo: new Map<number, { deps: unknown[]; value: unknown }>() }));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.state)) hooks.state[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.state[index], (next: unknown) => { hooks.state[index] = typeof next === 'function' ? next(hooks.state[index]) : next; }];
  },
  useRef: (initial: unknown) => { const index = hooks.index++; return hooks.state[index] ??= { current: initial }; },
  useId: () => 'session-settings',
  useMemo: (compute: () => unknown, deps: unknown[]) => {
    const index = hooks.index++, prior = hooks.memo.get(index);
    if (!prior || deps.length !== prior.deps.length || deps.some((value, i) => !Object.is(value, prior.deps[i]))) hooks.memo.set(index, { deps, value: compute() });
    return hooks.memo.get(index)!.value;
  },
  useLayoutEffect: (run: () => (() => void) | void, deps: unknown[]) => {
    const index = hooks.index++, previous = hooks.effects.get(index);
    if (previous?.deps.length === deps.length && previous.deps.every((value, i) => Object.is(value, deps[i]))) return;
    previous?.cleanup?.(); hooks.effects.set(index, { deps, cleanup: run() || undefined });
  },

  useEffect: (run: () => (() => void) | void, deps: unknown[]) => {
    const index = hooks.index++, previous = hooks.effects.get(index);
    if (previous?.deps.length === deps.length && previous.deps.every((value, i) => Object.is(value, deps[i]))) return;
    previous?.cleanup?.(); hooks.effects.set(index, { deps, cleanup: run() || undefined });
  },
}));
const elements = (node: ReactNode): ReactElement<Record<string, unknown>>[] => Array.isArray(node) ? node.flatMap(elements) : isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children as ReactNode)] : [];
const words = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(words).join('') : isValidElement<{ children?: ReactNode }>(node) ? words(node.props.children) : '';
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const at = '2026-11-13T00:00:00Z';
const workspace = (id: string): Workspace => ({ id, profileId: 'profile', name: id, projectLocation: `/projects/${id}`, additionalProjectLocations: [`/projects/${id}/extra`], createdAt: at, updatedAt: at });
const session: SessionSummary = { id: 'session-a', workspaceId: 'workspace-a', connectionId: 'connection', control: 'managed', title: 'Example task', running: false, createdAt: at, lastActiveAt: at };
const state = { sessions: [session] } as HostState;
const preview: SessionMovePreview = {
  sessionId: session.id, reviewId: 'exact-review', expiresAt: '2026-11-13T00:10:00Z', transfersHistory: true, permissionMode: 'workspace',
  source: { id: 'workspace-a', name: 'A', folders: ['/projects/workspace-a'], crossWorkspaceAccess: 'isolated', permissions: { fileWrite: 'ask', commands: 'ask' } },
  destination: { id: 'workspace-b', name: 'B', folders: ['/projects/workspace-b'], crossWorkspaceAccess: 'read-only', permissions: { fileWrite: 'ask', commands: 'ask' } },
  accessibleFolders: [{ workspaceId: 'workspace-b', path: '/projects/workspace-b', access: 'read-write' }],
};
function harness(language: 'en' | 'id' = 'en') {
  const host = { setSessionProjectRoot: vi.fn(async () => state), previewSessionMove: vi.fn(async () => preview), moveSession: vi.fn(async () => state) };
  const props = { t: MESSAGES[language], agents: host as unknown as AgentHostApi, session, workspaces: [workspace('workspace-a'), workspace('workspace-b')], onClose: vi.fn(), onMoved: vi.fn() };
  const render = () => { hooks.index = 0; return elements(SessionMoveDialog(props)); };
  const button = (label: string) => render().find(node => node.type === 'button' && words(node.props.children as ReactNode) === label)!;
  const select = (label: string) => render().find(node => node.type === Select && node.props.label === label)!;
  const click = async (label: string) => { (button(label).props.onClick as () => void)(); await settle(); };
  return { host, props, render, button, select, click };
}
beforeEach(() => { for (const effect of hooks.effects.values()) effect.cleanup?.(); hooks.index = 0; hooks.state = []; hooks.effects.clear(); hooks.memo.clear(); });

describe('Native session settings moves', () => {
  it.each(['en', 'id'] as const)('applies only a registered folder within the current workspace (%s)', async language => {
    const h = harness(language), t = MESSAGES[language];
    expect(h.select(t.chat.sessionSettings.folder).props.options).toEqual([
      { value: '/projects/workspace-a', label: '/projects/workspace-a', icon: 'folder' },
      { value: '/projects/workspace-a/extra', label: '/projects/workspace-a/extra', icon: 'folder' },
    ]);
    (h.select(t.chat.sessionSettings.folder).props.onChange as (path: string) => void)('/projects/workspace-a/extra');
    await h.click(t.chat.sessionSettings.folderApply);
    expect(h.host.setSessionProjectRoot).toHaveBeenCalledExactlyOnceWith(session.id, { workspaceId: 'workspace-a', projectLocation: '/projects/workspace-a/extra' });
    expect(h.host.previewSessionMove).not.toHaveBeenCalled(); expect(h.host.moveSession).not.toHaveBeenCalled();
    expect(h.props.onMoved).toHaveBeenCalledWith(state, 'workspace-a');
  });

  it('requires the exact host preview and explicit consent for cross-workspace transfer', async () => {
    const h = harness(), t = MESSAGES.en;
    await h.click(t.chat.sessionSettings.workspace);
    (h.select(t.chat.move.destination).props.onChange as (id: string) => void)('workspace-b');
    await h.click(t.chat.move.review);
    expect(h.host.previewSessionMove).toHaveBeenCalledExactlyOnceWith(session.id, 'workspace-b');
    expect(h.button(t.chat.move.apply).props.disabled).toBe(true);
    await h.click(t.chat.move.apply);
    expect(h.host.moveSession).not.toHaveBeenCalled();
    const check = h.render().find(node => node.type === 'input' && node.props.type === 'checkbox')!;
    (check.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    await h.click(t.chat.move.apply);
    expect(h.host.moveSession).toHaveBeenCalledExactlyOnceWith(session.id, { workspaceId: 'workspace-b', reviewId: 'exact-review' });
    expect(h.host.setSessionProjectRoot).not.toHaveBeenCalled();
  });

  it('clears a destination review and consent after selecting another destination', async () => {
    const h = harness(), t = MESSAGES.en;
    await h.click(t.chat.sessionSettings.workspace); await h.click(t.chat.move.review);
    (h.select(t.chat.move.destination).props.onChange as (id: string) => void)('workspace-b');
    expect(h.render().some(node => node.type === 'input' && node.props.type === 'checkbox')).toBe(false);
    expect(h.host.moveSession).not.toHaveBeenCalled();
  });

  it('locks immediate duplicate folder operations and discards completion after unmount', async () => {
    const h = harness(), t = MESSAGES.en, pending = deferred<HostState>();
    h.host.setSessionProjectRoot.mockReturnValueOnce(pending.promise);
    (h.select(t.chat.sessionSettings.folder).props.onChange as (path: string) => void)('/projects/workspace-a/extra');
    const apply = h.button(t.chat.sessionSettings.folderApply).props.onClick as () => void;
    apply(); apply();
    expect(h.host.setSessionProjectRoot).toHaveBeenCalledOnce();
    expect(h.button(t.chat.move.applying).props.disabled).toBe(true);
    for (const effect of hooks.effects.values()) effect.cleanup?.();
    pending.resolve(state); await settle();
    expect(h.props.onMoved).not.toHaveBeenCalled();
  });

  it('discards a folder-change callback after committed workspace context changes', async () => {
    const h = harness(), t = MESSAGES.en, pending = deferred<HostState>();
    h.host.setSessionProjectRoot.mockReturnValueOnce(pending.promise);
    (h.select(t.chat.sessionSettings.folder).props.onChange as (path: string) => void)('/projects/workspace-a/extra');
    const apply = h.button(t.chat.sessionSettings.folderApply).props.onClick as () => void;
    apply();
    h.props.workspaces = [{ ...workspace('workspace-a'), projectLocation: '/projects/replaced' }, workspace('workspace-b')]; h.render();
    pending.resolve(state); await settle();
    expect(h.props.onMoved).not.toHaveBeenCalled();
    expect(h.button(t.chat.sessionSettings.folderApply).props.disabled).toBe(false);
  });

  it('retains the modal and reports failed folder changes without a cross-workspace fallback', async () => {
    const h = harness(), t = MESSAGES.en;
    h.host.setSessionProjectRoot.mockRejectedValueOnce(new Error('The session has pending prompts.'));
    (h.select(t.chat.sessionSettings.folder).props.onChange as (path: string) => void)('/projects/workspace-a/extra');
    await h.click(t.chat.sessionSettings.folderApply);
    expect(h.render().some(node => node.props.role === 'alert' && words(node.props.children as ReactNode).includes('pending prompts'))).toBe(true);
    expect(h.props.onMoved).not.toHaveBeenCalled(); expect(h.props.onClose).not.toHaveBeenCalled();
    expect(h.host.moveSession).not.toHaveBeenCalled();
  });

  it('blocks running sessions and unknown folder values even when invoked without the disabled button', async () => {
    const h = harness(), t = MESSAGES.en;
    (h.select(t.chat.sessionSettings.folder).props.onChange as (path: string) => void)('/unregistered');
    await h.click(t.chat.sessionSettings.folderApply);
    expect(h.host.setSessionProjectRoot).not.toHaveBeenCalled();
    h.props.session = { ...session, running: true };
    (h.select(t.chat.sessionSettings.folder).props.onChange as (path: string) => void)('/projects/workspace-a/extra');
    await h.click(t.chat.sessionSettings.folderApply);
    expect(h.host.setSessionProjectRoot).not.toHaveBeenCalled();
    await h.click(t.chat.sessionSettings.workspace); await h.click(t.chat.move.review);
    expect(h.host.previewSessionMove).not.toHaveBeenCalled();
  });
});
