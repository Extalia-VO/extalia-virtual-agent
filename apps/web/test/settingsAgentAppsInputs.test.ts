import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { AgentHostApi, HookIngestStatus, HookPrivacyOptions, HostState, ImportLocation } from '@extalia/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { AutoWatchLocations, IgnoredFolders } from '../src/pages/AutoWatchLocations';
import { ConnectAgentAppsCard } from '../src/pages/ConnectAgentAppsCard';
import { HostFolderPicker } from '../src/ui/HostFolderPicker';
import { CopyButton } from '../src/ui/CopyButton';

type Store = { index: number; dirty: boolean; values: unknown[]; effects: Map<number, { deps: unknown[]; cleanup?: (() => void) | undefined }>; pending: (() => void)[] };
const hooks = vi.hoisted(() => ({ current: undefined as Store | undefined }));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useState: (initial: unknown) => {
    const store = hooks.current!, id = store.index++;
    if (!(id in store.values)) store.values[id] = typeof initial === 'function' ? initial() : initial;
    return [store.values[id], (next: unknown) => {
      const value = typeof next === 'function' ? next(store.values[id]) : next;
      if (!Object.is(value, store.values[id])) { store.values[id] = value; store.dirty = true; }
    }];
  },
  useRef: (initial: unknown) => { const store = hooks.current!, id = store.index++; return store.values[id] ??= { current: initial }; },
  useId: () => `settings-input-${hooks.current!.index++}`,
  useEffect: (run: () => void | (() => void), deps: unknown[]) => {
    const store = hooks.current!, id = store.index++, prior = store.effects.get(id);
    if (prior?.deps.length === deps.length && prior.deps.every((value, i) => Object.is(value, deps[i]))) return;
    const next = { deps, cleanup: undefined as (() => void) | undefined };
    store.effects.set(id, next); store.pending.push(() => { prior?.cleanup?.(); next.cleanup = run() || undefined; });
  },
}));
const store = (): Store => ({ index: 0, dirty: false, values: [], effects: new Map(), pending: [] });
const dispose = (value: Store) => { for (const effect of value.effects.values()) effect.cleanup?.(); value.effects.clear(); };
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
const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function harness<P extends { agents: AgentHostApi }>(Component: (props: P) => ReactElement, props: P) {
  const outer = store(); let inner = store(), key: string | null | undefined;
  const render = () => {
    const child = run(outer, () => Component(props));
    if (child.key !== key) { dispose(inner); inner = store(); key = child.key; }
    return elements(run(inner, () => (child.type as (p: typeof child.props) => ReactNode)(child.props)));
  };
  const stop = () => { dispose(inner); dispose(outer); };
  cleanups.push(stop);
  const button = (label: string) => render().find(node => node.type === 'button' && text(node) === label)!;
  const click = (label: string) => (button(label).props.onClick as () => void)();
  return { props, render, stop, button, click };
}
function fakeHost(initial: Partial<HookIngestStatus> = {}) {
  let status = { tokenPath: '/data/hooks/token', lastEvents: {}, ignoreFolders: ['~/.claude-mem'], ...initial } as HookIngestStatus;
  const setHookPrivacy = vi.fn(async (input: HookPrivacyOptions) => {
    status = { ...status,
      ...(input.ignoreFolders !== undefined ? { ignoreFolders: input.ignoreFolders ?? ['~/.claude-mem'] } : {}),
      ...(input.hermesDashboardUrl !== undefined ? { hermesDashboardUrl: input.hermesDashboardUrl ?? undefined } : {}),
    } as HookIngestStatus;
    return status;
  });
  const getState = vi.fn(async () => ({}) as HostState);
  const location: ImportLocation = { id: 'codex', sourceId: 'codex', label: 'Codex', path: '/data/codex', format: 'jsonl', available: true, supported: true, autoWatch: false };
  const setAutoWatch = vi.fn(async (_id: string, enabled: boolean): Promise<ImportLocation[]> => [{ ...location, autoWatch: enabled }]);
  const agents = { hookIngest: vi.fn(async () => status), agentAppConnections: vi.fn(async () => []), setHookPrivacy, getState,
    importLocations: vi.fn(async () => [location]), setAutoWatch } as unknown as AgentHostApi;
  return { agents, setHookPrivacy, getState, setAutoWatch };
}
function ignored(initial?: Partial<HookIngestStatus>, language: 'en' | 'id' = 'en') {
  const host = fakeHost(initial), onState = vi.fn();
  const h = harness(IgnoredFolders, { agents: host.agents, t: MESSAGES[language], onState, picker: { selectDirectory: vi.fn(async () => null) } });
  const picker = () => h.render().find(node => node.type === HostFolderPicker)! as ReactElement<Parameters<typeof HostFolderPicker>[0]>;
  return { ...h, ...host, onState, picker };
}
function dashboard(initial?: Partial<HookIngestStatus>, language: 'en' | 'id' = 'en') {
  const host = fakeHost(initial);
  const h = harness(ConnectAgentAppsCard, { agents: host.agents, t: MESSAGES[language], initialConnections: [], initialIngest: { tokenPath: '/data/hooks/token', lastEvents: {}, ...initial } as HookIngestStatus });
  const input = () => h.render().find(node => node.type === 'input' && node.props.type === 'url')!;
  const edit = (value: string) => (input().props.onChange as (event: unknown) => void)({ target: { value } });
  const submit = () => (h.render().find(node => node.type === 'form')!.props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() });
  const save = () => h.render().find(node => node.type === 'button' && node.props.type === 'submit')!;
  return { ...h, ...host, input, edit, submit, save };
}

describe('ignored-folder settings inputs', () => {
  it.each(['en', 'id'] as const)('chooses a host folder, shows copyable confirmed paths and preserves defaults (%s)', async language => {
    const h = ignored(undefined, language); h.render(); await settle();
    expect(h.render().some(node => node.type === 'input')).toBe(false);
    expect(h.picker().props).toMatchObject({ agents: h.agents, picker: h.props.picker, title: MESSAGES[language].observedOrigin.ignoredLabel });
    expect(h.render().find(node => node.type === CopyButton)?.props.text).toBe('~/.claude-mem');
    await h.picker().props.onSelect('/data/project/'); await settle();
    expect(h.setHookPrivacy).toHaveBeenCalledExactlyOnceWith({ ignoreFolders: ['~/.claude-mem', '/data/project'] });
    expect(h.render().filter(node => node.type === CopyButton).map(node => node.props.text)).toContain('/data/project');
    expect(h.onState).toHaveBeenCalledOnce();
  });

  it('rejects duplicate selections and restores missing defaults without choosing nonexistent folders', async () => {
    const h = ignored({ ignoreFolders: ['/data/project'], defaultIgnoreFolders: ['~/.claude-mem'] }); h.render(); await settle();
    await h.picker().props.onSelect('/data/project/');
    expect(text(h.render())).toContain(MESSAGES.en.observedOrigin.ignoredDuplicate); expect(h.setHookPrivacy).not.toHaveBeenCalled();
    h.click(MESSAGES.en.observedOrigin.ignoredRestore); await settle();
    expect(h.setHookPrivacy).toHaveBeenCalledExactlyOnceWith({ ignoreFolders: null });
    expect(h.render().find(node => node.type === CopyButton)?.props.text).toBe('~/.claude-mem');
  });

  it('locks list edits while choosing and blocks repeated saves before rerender', async () => {
    const h = ignored(); h.render(); await settle();
    h.picker().props.onBusyChange!(true);
    expect(h.render().find(node => node.type === 'button')?.props.disabled).toBe(true);
    h.picker().props.onBusyChange!(false);
    const pending = deferred<HookIngestStatus>(); h.setHookPrivacy.mockImplementation(() => pending.promise);
    const add = h.picker().props.onSelect; void add('/data/one'); void add('/data/two');
    expect(h.setHookPrivacy).toHaveBeenCalledOnce();
    pending.resolve({ ignoreFolders: ['~/.claude-mem', '/data/one'] } as HookIngestStatus); await settle();
    expect(h.picker().props.disabled).toBe(false);
  });

  it.each(['unmount', 'host'] as const)('ignores pending save results and stale choose callbacks after %s', async reason => {
    const h = ignored(); h.render(); await settle();
    const pending = deferred<HookIngestStatus>(); h.setHookPrivacy.mockImplementation(() => pending.promise);
    const add = h.picker().props.onSelect; void add('/data/old');
    if (reason === 'unmount') h.stop();
    else { h.props.agents = fakeHost({ ignoreFolders: ['/data/new-host'] }).agents; h.render(); await settle(); }
    pending.resolve({ ignoreFolders: ['/data/old'] } as HookIngestStatus); await settle();
    await add('/data/stale');
    expect(h.setHookPrivacy).toHaveBeenCalledOnce(); expect(h.getState).not.toHaveBeenCalled(); expect(h.onState).not.toHaveBeenCalled();
    if (reason === 'host') expect(h.render().find(node => node.type === CopyButton)?.props.text).toBe('/data/new-host');
  });

  it('keeps confirmed exclusions and allows retry after a failed save', async () => {
    const h = ignored(); h.render(); await settle();
    h.setHookPrivacy.mockRejectedValueOnce(new Error('Save refused'));
    await h.picker().props.onSelect('/data/project');
    expect(text(h.render())).toContain('Save refused');
    expect(h.render().filter(node => node.type === CopyButton)).toHaveLength(1);
    await h.picker().props.onSelect('/data/project'); await settle();
    expect(h.setHookPrivacy).toHaveBeenCalledTimes(2);
    expect(h.render().filter(node => node.type === CopyButton)).toHaveLength(2);
  });
});

describe('automatic observation settings', () => {
  it('blocks duplicate toggles and ignores results after changing hosts', async () => {
    const host = fakeHost(), onState = vi.fn(), h = harness(AutoWatchLocations, { agents: host.agents, t: MESSAGES.en, onState });
    h.render(); await settle();
    const pending = deferred<ImportLocation[]>(); host.setAutoWatch.mockImplementation(() => pending.promise);
    const toggle = h.render().find(node => node.type === 'input')!.props.onChange as (event: unknown) => void;
    toggle({ target: { checked: true } }); toggle({ target: { checked: true } });
    expect(host.setAutoWatch).toHaveBeenCalledExactlyOnceWith('codex', true);
    h.props.agents = fakeHost().agents; h.render(); await settle(); pending.resolve([]); await settle();
    expect(onState).not.toHaveBeenCalled(); expect(host.getState).not.toHaveBeenCalled();
    expect(h.render().find(node => node.type === 'input')!.props.disabled).toBe(false);
  });

  it('ignores a state refresh that finishes after unmount', async () => {
    const host = fakeHost(), onState = vi.fn(), h = harness(AutoWatchLocations, { agents: host.agents, t: MESSAGES.en, onState });
    h.render(); await settle();
    const pending = deferred<HostState>(); host.getState.mockImplementation(() => pending.promise);
    (h.render().find(node => node.type === 'input')!.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    await settle(); h.stop(); pending.resolve({} as HostState); await settle(); expect(onState).not.toHaveBeenCalled();
  });
});

describe('dashboard URL settings form', () => {
  it.each(['en', 'id'] as const)('labels the optional URL and links invalid input to localized errors (%s)', language => {
    const h = dashboard(undefined, language); h.render();
    expect(h.save().props.disabled).toBe(true);
    expect(h.render().find(node => node.type === 'label' && node.props.htmlFor === h.input().props.id)).toBeDefined();
    h.edit('not a url'); h.submit();
    expect(h.setHookPrivacy).not.toHaveBeenCalled();
    expect(h.input().props['aria-invalid']).toBe(true);
    const alert = h.render().find(node => node.props.role === 'alert')!;
    expect(text(alert)).toBe(MESSAGES[language].agentApps.dashboardUrlInvalid);
    expect(h.input().props['aria-describedby']).toContain(alert.props.id);
    h.edit('http://localhost:9119'); expect(h.input().props['aria-invalid']).toBeUndefined();
    expect(h.input().props).toMatchObject({ autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false });
  });

  it('resets a saved URL with null, blocks repeated submissions and disables unchanged saves', async () => {
    const h = dashboard({ hermesDashboardUrl: 'http://localhost:9119' }); h.render(); h.submit();
    expect(h.setHookPrivacy).not.toHaveBeenCalled();
    h.edit('  '); h.submit(); h.submit(); await settle();
    expect(h.setHookPrivacy).toHaveBeenCalledExactlyOnceWith({ hermesDashboardUrl: null });
    expect(h.input().props.value).toBe(''); expect(h.save().props.disabled).toBe(true);
    expect(text(h.render())).toContain(MESSAGES.en.agentApps.dashboardUrlSaved);
  });

  it('leaves URL policy to the host and retains its error and draft for retry', async () => {
    const h = dashboard(); h.render();
    h.setHookPrivacy.mockRejectedValueOnce(new Error('Dashboard must be local.'));
    h.edit('https://example.com/dashboard'); h.submit(); await settle();
    expect(h.setHookPrivacy).toHaveBeenCalledExactlyOnceWith({ hermesDashboardUrl: 'https://example.com/dashboard' });
    expect(h.input().props.value).toBe('https://example.com/dashboard'); expect(h.input().props['aria-invalid']).toBe(true);
    expect(text(h.render().find(node => node.props.role === 'alert'))).toContain('Dashboard must be local.');
    h.edit('http://localhost:9119'); h.submit(); await settle(); expect(h.setHookPrivacy).toHaveBeenCalledTimes(2);
  });

  it.each(['unmount', 'host'] as const)('drops a pending dashboard save after %s without unlocking a new operation', async reason => {
    const h = dashboard(); h.render();
    const pending = deferred<HookIngestStatus>(); h.setHookPrivacy.mockImplementation(() => pending.promise);
    h.edit('http://localhost:9119'); h.submit();
    if (reason === 'unmount') h.stop();
    else {
      const next = fakeHost(), nextPending = deferred<HookIngestStatus>(); next.setHookPrivacy.mockImplementation(() => nextPending.promise);
      h.props.agents = next.agents; h.render(); h.edit('http://localhost:9222'); h.submit();
      pending.resolve({ hermesDashboardUrl: 'http://localhost:9119' } as HookIngestStatus); await settle();
      expect(h.input().props.value).toBe('http://localhost:9222'); expect(h.save().props.disabled).toBe(true);
      h.submit(); expect(next.setHookPrivacy).toHaveBeenCalledOnce();
      nextPending.resolve({ hermesDashboardUrl: 'http://localhost:9222' } as HookIngestStatus); await settle(); return;
    }
    pending.resolve({ hermesDashboardUrl: 'http://localhost:9119' } as HookIngestStatus); await settle();
    expect(h.agents.agentAppConnections).not.toHaveBeenCalled();
  });
});
