import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { AgentHostApi, DirectorySelection, FileSystemCapability } from '@extalia/platform';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryPickerButton } from '../src/setup/DirectoryPickerButton';
import { DirectoryBrowser } from '../src/setup/DirectoryBrowser';
import { MESSAGES } from '../src/i18n';

// Run the component's actual event handlers and committed hook phases without
// opening a native dialog, browser filesystem handle or user profile.
const hooks = vi.hoisted(() => ({ index: 0, state: [] as unknown[], memo: new Map<number, { deps: readonly unknown[]; value: unknown }>(),
  effects: new Map<number, { deps: readonly unknown[]; cleanup?: () => void }>(), layoutQueue: [] as (() => void)[], effectQueue: [] as (() => void)[] }));
vi.mock('react', async original => {
  const changed = (before: readonly unknown[], after: readonly unknown[]) => before.length !== after.length || after.some((value, index) => !Object.is(value, before[index]));
  const effect = (queue: (() => void)[], run: () => void | (() => void), deps: readonly unknown[]) => {
    const id = hooks.index++, prior = hooks.effects.get(id);
    if (!prior || changed(prior.deps, deps)) {
      const entry = { deps: [...deps], cleanup: prior?.cleanup };
      hooks.effects.set(id, entry);
      queue.push(() => { entry.cleanup?.(); const cleanup = run(); entry.cleanup = typeof cleanup === 'function' ? cleanup : undefined; });
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
      if (!prior || changed(prior.deps, deps)) hooks.memo.set(id, { deps: [...deps], value: compute() });
      return hooks.memo.get(id)!.value;
    },
    useEffect: (run: () => void | (() => void), deps: readonly unknown[]) => effect(hooks.effectQueue, run, deps),
    useLayoutEffect: (run: () => void | (() => void), deps: readonly unknown[]) => effect(hooks.layoutQueue, run, deps),
  };
});
const elements = (node: ReactNode): ReactElement<Record<string, unknown>>[] => Array.isArray(node) ? node.flatMap(elements)
  : isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('')
  : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function harness() {
  const picker: FileSystemCapability = { selectDirectory: vi.fn(async () => ({ name: 'Chosen folder', path: '/projects/chosen' })) };
  const agents = { browseDirectories: vi.fn() } as unknown as AgentHostApi;
  const props: Parameters<typeof DirectoryPickerButton>[0] = { t: MESSAGES.en, agents, picker, initialPath: '/projects/current',
    purpose: 'project', title: 'Choose the project folder', label: 'Choose folder', scopeKey: 'workspace-one', onSelected: vi.fn() };
  const render = () => {
    hooks.index = 0; const tree = DirectoryPickerButton(props);
    for (const run of hooks.layoutQueue.splice(0)) run();
    for (const run of hooks.effectQueue.splice(0)) run();
    return tree;
  };
  const button = () => elements(render()).find(node => node.type === 'button')!;
  const click = () => { (button().props.onClick as () => void)(); };
  const browser = () => elements(render()).find(node => node.type === DirectoryBrowser);
  const unmount = () => { for (const entry of hooks.effects.values()) entry.cleanup?.(); };
  return { props, render, button, click, browser, picker, unmount };
}
beforeEach(() => { hooks.index = 0; hooks.state = []; hooks.memo.clear(); hooks.effects.clear(); hooks.layoutQueue = []; hooks.effectQueue = []; });

describe('shared folder picker button', () => {
  it('forwards the native title, initial path and purpose and applies only the returned host path', async () => {
    const h = harness(); h.click();
    expect(h.picker.selectDirectory).toHaveBeenCalledExactlyOnceWith({ title: h.props.title, initialPath: '/projects/current', purpose: 'project' });
    await vi.waitFor(() => expect(h.props.onSelected).toHaveBeenCalledExactlyOnceWith('/projects/chosen'));
    expect(h.browser()).toBeUndefined();
    expect(h.button().props.disabled).toBe(false);
  });

  it('treats native cancellation as no change and keeps the current draft', async () => {
    const h = harness(); let draft = '/projects/current';
    h.props.onSelected = vi.fn(path => { draft = path; });
    vi.mocked(h.picker.selectDirectory).mockResolvedValue(null);
    h.click(); await vi.waitFor(() => expect(h.button().props.disabled).toBe(false));
    expect(draft).toBe('/projects/current'); expect(h.props.onSelected).not.toHaveBeenCalled();
    expect(h.browser()).toBeUndefined();
  });

  it('uses host browsing for a pathless browser selection without guessing its folder name', async () => {
    const h = harness();
    vi.mocked(h.picker.selectDirectory).mockResolvedValue({ name: 'A display name is not a host path' });
    h.click(); await vi.waitFor(() => expect(h.browser()).toBeDefined());
    expect(h.props.onSelected).not.toHaveBeenCalled();
    const browser = h.browser()!;
    expect(browser.props.agents).toBe(h.props.agents); expect(browser.props.startPath).toBe('/projects/current');
    (browser.props.onSelect as (path: string) => void)('/projects/actual-host-folder');
    await vi.waitFor(() => expect(h.props.onSelected).toHaveBeenCalledExactlyOnceWith('/projects/actual-host-folder'));
    expect(h.browser()).toBeUndefined();
  });

  it('opens the real host-browser component directly when native picking is unavailable', () => {
    const h = harness(); h.props.picker = undefined; h.click();
    const browser = h.browser()!;
    expect(browser).toBeDefined(); expect(browser.props.agents).toBe(h.props.agents);
    expect(browser.props.title).toBe(h.props.title); expect(browser.props.startPath).toBe('/projects/current');
    expect(h.picker.selectDirectory).not.toHaveBeenCalled();
    (browser.props.onClose as () => void)();
    expect(h.browser()).toBeUndefined(); expect(h.props.onSelected).not.toHaveBeenCalled();
  });

  it.each(['scope-aba', 'disabled', 'agents', 'picker', 'initial-path', 'purpose'] as const)('ignores a delayed native result after a committed %s change', async change => {
    const h = harness(), pending = deferred<DirectorySelection | null>();
    vi.mocked(h.picker.selectDirectory).mockReturnValue(pending.promise); h.click();
    if (change === 'scope-aba') { h.props.scopeKey = 'workspace-two'; h.render(); h.props.scopeKey = 'workspace-one'; }
    if (change === 'disabled') h.props.disabled = true;
    if (change === 'agents') h.props.agents = { browseDirectories: vi.fn() } as unknown as AgentHostApi;
    if (change === 'picker') h.props.picker = { selectDirectory: vi.fn(async () => null) };
    if (change === 'initial-path') h.props.initialPath = '/projects/updated';
    if (change === 'purpose') h.props.purpose = 'knowledge-vault';
    h.render(); pending.resolve({ name: 'Stale', path: '/projects/stale' });
    await Promise.resolve(); await Promise.resolve();
    if (change === 'disabled') { h.props.disabled = false; h.render(); }
    await vi.waitFor(() => expect(h.button().props.disabled).toBe(false));
    expect(h.props.onSelected).not.toHaveBeenCalled(); expect(h.browser()).toBeUndefined();
  });

  it('ignores a native result after unmount and fences stale picker failures', async () => {
    const h = harness(), pending = deferred<DirectorySelection | null>();
    vi.mocked(h.picker.selectDirectory).mockReturnValue(pending.promise); h.click(); h.unmount();
    pending.resolve({ name: 'Unmounted', path: '/projects/unmounted' });
    await Promise.resolve(); await Promise.resolve(); expect(h.props.onSelected).not.toHaveBeenCalled();
  });

  it('blocks duplicate native clicks while picking and while the selected-folder callback is still pending', async () => {
    const h = harness(), picking = deferred<DirectorySelection | null>(), saving = deferred<void>();
    vi.mocked(h.picker.selectDirectory).mockReturnValue(picking.promise);
    h.props.onSelected = vi.fn(() => saving.promise);
    const click = h.button().props.onClick as () => void;
    click(); click(); expect(h.picker.selectDirectory).toHaveBeenCalledOnce();
    picking.resolve({ name: 'Chosen', path: '/projects/chosen' });
    await vi.waitFor(() => expect(h.props.onSelected).toHaveBeenCalledOnce());
    click(); expect(h.picker.selectDirectory).toHaveBeenCalledOnce();
    expect(h.button().props.disabled).toBe(true);
    saving.resolve(); await vi.waitFor(() => expect(h.button().props.disabled).toBe(false));
  });

  it('shows a current picker or callback error locally and clears it for the next choice', async () => {
    const h = harness(); vi.mocked(h.picker.selectDirectory).mockRejectedValueOnce(new Error('Folder chooser unavailable'));
    h.click(); await vi.waitFor(() => expect(elements(h.render()).some(node => node.props.role === 'alert' && text(node.props.children as ReactNode).includes('Folder chooser unavailable'))).toBe(true));
    h.props.onSelected = vi.fn(async () => { throw new Error('Selected folder could not be saved'); });
    h.render(); h.click();
    await vi.waitFor(() => expect(elements(h.render()).some(node => node.props.role === 'alert' && text(node.props.children as ReactNode).includes('Selected folder could not be saved'))).toBe(true));
    h.props.onSelected = vi.fn(); h.render(); h.click();
    await vi.waitFor(() => expect(h.button().props.disabled).toBe(false));
    expect(elements(h.render()).some(node => node.props.role === 'alert')).toBe(false);
  });

  it('hides an already displayed error when the workspace context changes', async () => {
    const h = harness();
    vi.mocked(h.picker.selectDirectory).mockRejectedValue(new Error('Earlier folder error'));
    h.click();
    await vi.waitFor(() => expect(elements(h.render()).some(node => node.props.role === 'alert')).toBe(true));
    h.props.scopeKey = 'workspace-two';
    expect(elements(h.render()).some(node => node.props.role === 'alert')).toBe(false);
  });

  it('does not show errors from an earlier context or apply a stale host-browser selection', async () => {
    const h = harness(), pending = deferred<DirectorySelection | null>();
    vi.mocked(h.picker.selectDirectory).mockReturnValue(pending.promise); h.click();
    h.props.scopeKey = 'workspace-two'; h.render(); pending.reject(new Error('Stale failure'));
    await vi.waitFor(() => expect(h.button().props.disabled).toBe(false));
    expect(elements(h.render()).some(node => node.props.role === 'alert')).toBe(false);
    h.props.picker = undefined; h.render(); h.click();
    const stale = h.browser()!;
    h.props.scopeKey = 'workspace-three'; h.render();
    expect(h.browser()).toBeUndefined();
    (stale.props.onSelect as (path: string) => void)('/projects/stale-browser');
    await Promise.resolve(); expect(h.props.onSelected).not.toHaveBeenCalled();
  });

  it('hides an already-visible current error after the selected scope changes', async () => {
    const h = harness(); vi.mocked(h.picker.selectDirectory).mockRejectedValueOnce(new Error('Current scope picker failure'));
    h.click();
    await vi.waitFor(() => expect(elements(h.render()).some(node => node.props.role === 'alert' && text(node.props.children as ReactNode).includes('Current scope picker failure'))).toBe(true));
    h.props.scopeKey = 'workspace-two'; h.render();
    expect(elements(h.render()).some(node => node.props.role === 'alert')).toBe(false);
    h.props.onSelected = vi.fn(); h.render(); h.click();
    await vi.waitFor(() => expect(h.props.onSelected).toHaveBeenCalledExactlyOnceWith('/projects/chosen'));
    expect(elements(h.render()).some(node => node.props.role === 'alert')).toBe(false);
  });

  it('rechecks the browser context when a queued selection callback reaches its microtask', async () => {
    const h = harness(); h.props.picker = undefined; h.click();
    (h.browser()!.props.onSelect as (path: string) => void)('/projects/late-browser');
    h.props.scopeKey = 'workspace-two'; h.render();
    await Promise.resolve(); expect(h.props.onSelected).not.toHaveBeenCalled();
  });
});
