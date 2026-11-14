import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { AgentHostApi, HostState, LibrarySessionSummary } from '@extalia/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { HistoryPage } from '../src/library/HistoryPage';
import { WorkspacesSection } from '../src/pages/settings/WorkspacesSection';
import { SessionBrowser } from '../src/sessions/SessionBrowser';
import { WorkspaceForm } from '../src/setup/WorkspaceForm';
import { emptyWorkspaceDraft } from '../src/setup/validation';
import { DeleteConfirmation } from '../src/ui/DeleteConfirmation';

type Store = { index: number; dirty: boolean; values: unknown[]; effects: Map<number, { deps: unknown[]; cleanup?: () => void }>; pending: (() => void)[] };
const hooks = vi.hoisted(() => ({ current: undefined as Store | undefined }));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useId: () => 'removal-test', useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
  useState: (initial: unknown) => {
    const store = hooks.current!, id = store.index++;
    if (!(id in store.values)) store.values[id] = typeof initial === 'function' ? initial() : initial;
    return [store.values[id], (next: unknown) => {
      const value = typeof next === 'function' ? next(store.values[id]) : next;
      if (!Object.is(value, store.values[id])) { store.values[id] = value; store.dirty = true; }
    }];
  },
  useRef: (initial: unknown) => { const store = hooks.current!, id = store.index++; return store.values[id] ??= { current: initial }; },
  ...Object.fromEntries(['useEffect', 'useLayoutEffect'].map(name => [name, (run: () => void | (() => void), deps: unknown[]) => {
    const store = hooks.current!, id = store.index++, prior = store.effects.get(id);
    if (prior?.deps.length === deps.length && prior.deps.every((value, i) => Object.is(value, deps[i]))) return;
    const next = { deps, cleanup: undefined as (() => void) | undefined };
    store.effects.set(id, next); store.pending.push(() => { prior?.cleanup?.(); next.cleanup = run() || undefined; });
  }])),
}));
const stores: Store[] = [];
const store = (): Store => { const value = { index: 0, dirty: false, values: [], effects: new Map(), pending: [] }; stores.push(value); return value; };
afterEach(() => { for (const value of stores.splice(0)) for (const effect of value.effects.values()) effect.cleanup?.(); });
function run<T>(value: Store, render: () => T): T {
  let output: T;
  do { hooks.current = value; value.index = 0; value.dirty = false; output = render(); for (const effect of value.pending.splice(0)) effect(); } while (value.dirty);
  return output;
}
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const invoke = (element: ReactElement<Record<string, unknown>>, name = 'onClick') => (element.props[name] as () => void)();
const modal = (tree: ReactNode) => elements(tree).find(element => element.type === DeleteConfirmation);
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const t = MESSAGES.en;
const workspace = { id: 'workspace-one', name: 'Project Alpha', projectLocation: '/projects/alpha', mode: 'observe', createdAt: 'now', updatedAt: 'now' };
const state = { profile: { id: 'profile-one' }, workflow: 'observe', workspaces: [workspace], connections: [], sessions: [], library: [] } as unknown as HostState;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}

describe('project and folder removal confirmations', () => {
  it('cancels project removal, locks duplicate confirmation and retries errors in the modal', async () => {
    const request = deferred<HostState>(), deleteWorkspace = vi.fn().mockImplementationOnce(() => request.promise).mockResolvedValue(state);
    const agents = { runtimes: async () => [], deleteWorkspace } as unknown as AgentHostApi;
    const onState = vi.fn(), outer = store(), inner = store();
    const render = () => { const child = run(outer, () => WorkspacesSection({ t, agents, state, onState })); return run(inner, () => (child.type as (props: typeof child.props) => ReactNode)(child.props)); };
    const open = () => invoke(elements(render()).find(element => element.props['aria-label'] === `${t.common.delete}: ${workspace.name}`)!);
    open(); expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(modal(render())?.props.target).toBe(workspace.name);
    invoke(modal(render())!, 'onCancel'); expect(modal(render())).toBeUndefined(); expect(deleteWorkspace).not.toHaveBeenCalled();
    open(); const asking = modal(render())!; invoke(asking, 'onConfirm'); invoke(asking, 'onConfirm');
    expect(deleteWorkspace).toHaveBeenCalledExactlyOnceWith(workspace.id); expect(modal(render())?.props.busy).toBe(true);
    request.reject(new Error('Project is unavailable')); await settle();
    expect(modal(render())?.props.error).toBe('Project is unavailable'); expect(modal(render())?.props.busy).toBe(false);
    invoke(modal(render())!, 'onConfirm'); await settle(); expect(deleteWorkspace).toHaveBeenCalledTimes(2); expect(onState).toHaveBeenCalledOnce(); expect(modal(render())).toBeUndefined();
  });

  function folderHarness() {
    const value = store(), onChange = vi.fn(), agents = {} as AgentHostApi;
    const props: Parameters<typeof WorkspaceForm>[0] = { t, agents, onChange, draft: { ...emptyWorkspaceDraft(), id: workspace.id, name: workspace.name, folderInput: '/projects/alpha', folder: { path: '/projects/alpha', name: 'alpha' }, additionalProjectLocations: ['/projects/extra', '/projects/keep'] } };
    const render = () => run(value, () => WorkspaceForm(props));
    const open = () => invoke(elements(render()).find(element => element.props['aria-label'] === t.workspace.additionalFolders.remove('/projects/extra'))!);
    return { props, render, open, onChange };
  }
  it('changes only the confirmed additional folder in the latest draft and cancels without mutation', () => {
    const h = folderHarness(); h.open(); expect(h.onChange).not.toHaveBeenCalled();
    invoke(modal(h.render())!, 'onCancel'); expect(h.onChange).not.toHaveBeenCalled();
    h.open(); h.props.draft = { ...h.props.draft, name: 'New project name', additionalProjectLocations: [...h.props.draft.additionalProjectLocations, '/projects/new'] };
    const asking = modal(h.render())!; invoke(asking, 'onConfirm'); invoke(asking, 'onConfirm');
    expect(h.onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'New project name', folder: h.props.draft.folder, additionalProjectLocations: ['/projects/keep', '/projects/new'] }));
  });
  it.each(['project', 'root', 'runtime', 'agents'] as const)('rejects a stale folder confirmation after the %s changes', reason => {
    const h = folderHarness(); h.open(); const asking = modal(h.render())!;
    if (reason === 'project') h.props.draft = { ...h.props.draft, id: 'workspace-two' };
    if (reason === 'root') h.props.draft = { ...h.props.draft, folderInput: '/projects/other', folder: { path: '/projects/other', name: 'other' } };
    if (reason === 'runtime') h.props.draft = { ...h.props.draft, runtimeId: 'hermes' };
    if (reason === 'agents') h.props.agents = {} as AgentHostApi;
    expect(modal(h.render())).toBeUndefined(); invoke(asking, 'onConfirm'); expect(h.onChange).not.toHaveBeenCalled();
  });
});

describe('history removal confirmations', () => {
  function harness(sessionState: 'active' | 'trashed') {
    const request = deferred<HostState>(), organizeLibrarySession = vi.fn().mockImplementationOnce(() => request.promise).mockResolvedValue(state);
    const agents = { librarySession: async () => undefined, organizeLibrarySession } as unknown as AgentHostApi;
    const summary = { id: 'history-one', title: 'Imported conversation', state: sessionState, sourceId: 'codex', importMode: 'linked', messageCount: 2, startedAt: '2026-11-01T00:00:00Z', lastMessageAt: '2026-11-01T00:00:00Z' } as LibrarySessionSummary;
    const outer = store(), inner = store(), props = { t, language: 'en', agents, state: { ...state, library: [summary] }, onState: vi.fn(), onOpenImport: vi.fn(), onContinued: vi.fn(), onOpenSettings: vi.fn() };
    // Select through the real browser row callback; the viewer remains private.
    if (sessionState === 'trashed') outer.values[0] = 'trashed';
    const page = () => run(outer, () => HistoryPage(props));
    const browser = elements(page()).find(element => element.type === SessionBrowser)!;
    const rows = (browser.props.renderRows as (rows: LibrarySessionSummary[]) => ReactNode)([summary]);
    invoke(elements(rows).find(element => element.type === 'button')!);
    const render = () => { const viewer = elements(page()).find(element => typeof element.type === 'function' && element.props.summary === summary)!; return run(inner, () => (viewer.type as (props: Record<string, unknown>) => ReactNode)(viewer.props)); };
    const open = () => invoke(elements(render()).find(element => element.type === 'button' && (element.props.children as ReactNode[])?.includes(sessionState === 'trashed' ? t.history.delete : t.history.trash))!);
    return { render, open, request, organizeLibrarySession, props, summary };
  }
  it.each(['active', 'trashed'] as const)('confirms %s history removal and keeps failures retryable', async sessionState => {
    const h = harness(sessionState); h.open(); expect(h.organizeLibrarySession).not.toHaveBeenCalled();
    let asking = modal(h.render())!; expect(asking.props.target).toBe(h.summary.title);
    if (sessionState === 'trashed') expect(asking.props.description).toContain(t.history.deleteLinked);
    invoke(asking, 'onCancel'); expect(modal(h.render())).toBeUndefined(); expect(h.organizeLibrarySession).not.toHaveBeenCalled();
    h.open(); asking = modal(h.render())!; invoke(asking, 'onConfirm'); invoke(asking, 'onConfirm');
    expect(h.organizeLibrarySession).toHaveBeenCalledExactlyOnceWith(h.summary.id, sessionState === 'trashed' ? 'delete' : 'trash', undefined);
    expect(modal(h.render())?.props.busy).toBe(true);
    invoke(asking, 'onCancel'); expect(modal(h.render())).toBeDefined();
    h.request.reject(new Error('History unavailable')); await settle();
    expect(modal(h.render())?.props.error).toBe('History unavailable'); expect(modal(h.render())?.props.busy).toBe(false);
    invoke(modal(h.render())!, 'onConfirm'); await settle(); expect(h.organizeLibrarySession).toHaveBeenCalledTimes(2); expect(h.props.onState).toHaveBeenCalledOnce();
  });
});
