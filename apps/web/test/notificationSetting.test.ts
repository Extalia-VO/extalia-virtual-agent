import type * as React from 'react';
import type { NotificationCapability } from '@extalia/platform';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalNotificationSetting } from '../src/approvals/NotificationSetting';
import { MESSAGES } from '../src/i18n';

type Store = { index: number; state: unknown[]; effects: Map<number, { deps: unknown[]; cleanup?: (() => void) | undefined }>; pending: (() => void)[] };
const mock = vi.hoisted(() => ({ store: undefined as Store | undefined, stored: undefined as boolean | undefined,
  permission: 'default' as NotificationPermission | 'unsupported', writes: vi.fn(), request: vi.fn() }));
vi.mock('../src/approvals/notify', () => ({
  approvalNotificationsEnabled: (hostKind: string) => mock.stored ?? hostKind === 'desktop',
  saveApprovalNotifications: (enabled: boolean) => { mock.stored = enabled; mock.writes(enabled); },
}));
vi.mock('../src/approvals/browserNotifications', () => ({ browserNotificationPermission: () => mock.permission }));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useState: (initial: unknown) => {
    const store = mock.store!, index = store.index++;
    if (!(index in store.state)) store.state[index] = typeof initial === 'function' ? initial() : initial;
    return [store.state[index], (next: unknown) => { store.state[index] = typeof next === 'function' ? next(store.state[index]) : next; }];
  },
  useRef: (initial: unknown) => { const store = mock.store!, index = store.index++; return store.state[index] ??= { current: initial }; },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const store = mock.store!, index = store.index++, prior = store.effects.get(index);
    if (prior?.deps.length === deps.length && prior.deps.every((value, at) => Object.is(value, deps[at]))) return;
    const next = { deps, cleanup: undefined as (() => void) | undefined };
    store.effects.set(index, next); store.pending.push(() => { prior?.cleanup?.(); next.cleanup = effect() || undefined; });
  },
}));
const store = (): Store => ({ index: 0, state: [], effects: new Map(), pending: [] });
const dispose = (value: Store) => { for (const effect of value.effects.values()) effect.cleanup?.(); value.effects.clear(); };
function render<T>(value: Store, component: () => T): T {
  mock.store = value; value.index = 0; const output = component();
  for (const effect of value.pending.splice(0)) effect(); return output;
}
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function deferred() {
  let resolve!: (value: NotificationPermission) => void;
  const promise = new Promise<NotificationPermission>(complete => { resolve = complete; }); return { promise, resolve };
}
const settle = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
const cleanups: (() => void)[] = [];
const notifier = (): NotificationCapability => ({ notify: async () => undefined, onActivate: () => () => undefined });
function harness(hostKind: 'desktop' | 'web' = 'web', notifications: NotificationCapability | undefined = notifier()) {
  const props: Parameters<typeof ApprovalNotificationSetting>[0] = { t: MESSAGES.en, hostKind, notifier: notifications };
  const outer = store(); let inner = store(), key: string | null | undefined;
  const draw = () => {
    const child = render(outer, () => ApprovalNotificationSetting(props));
    if (child.key !== key) { dispose(inner); inner = store(); key = child.key; }
    return elements(render(inner, () => (child.type as (value: typeof child.props) => ReactNode)(child.props)));
  };
  const button = () => draw().find(node => node.type === 'button')!;
  const click = () => (button().props.onClick as () => void)();
  const stop = () => { dispose(inner); dispose(outer); }; cleanups.push(stop);
  return { props, draw, button, click, stop };
}
beforeEach(() => {
  mock.stored = undefined; mock.permission = 'default'; mock.writes.mockReset(); mock.request.mockReset();
  vi.stubGlobal('Notification', { requestPermission: mock.request });
});
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });

describe('approval notification preference', () => {
  it('serializes browser consent, shows its pending state and saves only a grant', async () => {
    const request = deferred(); mock.request.mockReturnValue(request.promise);
    const h = harness(); h.click(); h.click();
    expect(mock.request).toHaveBeenCalledOnce(); expect(mock.writes).not.toHaveBeenCalled();
    expect(h.button().props).toMatchObject({ disabled: true, 'aria-busy': true, children: MESSAGES.en.common.loading });
    request.resolve('granted'); await settle();
    expect(mock.writes).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.button().props).toMatchObject({ disabled: false, 'aria-pressed': true, 'aria-busy': undefined });
  });

  it.each(['denied', 'default', 'rejected'] as const)('keeps the preference off after %s consent', async answer => {
    mock.request.mockImplementation(() => answer === 'rejected' ? Promise.reject(new Error('Dismissed')) : Promise.resolve(answer));
    const h = harness(); h.click(); await settle();
    expect(mock.writes).not.toHaveBeenCalled();
    expect(h.button().props).toMatchObject({ disabled: false, 'aria-pressed': false });
    expect(h.draw().find(node => node.props.role === 'alert')?.props.children).toBe(MESSAGES.en.approvalInbox.settings.blocked);
  });

  it('does not repeat a refused permission request and honors an existing grant', async () => {
    mock.permission = 'denied'; const h = harness(); h.click(); await settle();
    expect(mock.request).not.toHaveBeenCalled(); expect(mock.writes).not.toHaveBeenCalled();
    mock.permission = 'granted'; h.click(); await settle();
    expect(mock.request).not.toHaveBeenCalled(); expect(mock.writes).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(['unmount', 'notifier', 'host', 'source-ABA'] as const)('ignores a late grant after %s retires the permission owner', async change => {
    const request = deferred(); mock.request.mockReturnValue(request.promise);
    const h = harness(), originalNotifier = h.props.notifier; h.click(); h.draw();
    if (change === 'unmount') h.stop();
    else if (change === 'host') { h.props.hostKind = 'desktop'; h.draw(); }
    else {
      h.props.notifier = notifier(); h.draw();
      if (change === 'source-ABA') { h.props.notifier = originalNotifier; h.draw(); }
    }
    request.resolve('granted'); await settle(); expect(mock.writes).not.toHaveBeenCalled();
  });

  it('preserves Desktop default-on and never asks for browser consent when toggling native preferences', async () => {
    const h = harness('desktop'); expect(h.button().props['aria-pressed']).toBe(true);
    h.click(); await settle(); expect(h.button().props['aria-pressed']).toBe(false);
    h.click(); await settle(); expect(h.button().props['aria-pressed']).toBe(true);
    expect(mock.writes.mock.calls).toEqual([[false], [true]]); expect(mock.request).not.toHaveBeenCalled();
  });

  it('keeps missing capabilities disabled and explains unavailable browser permission support', async () => {
    const h = harness(); h.props.notifier = undefined;
    expect(h.button().props.disabled).toBe(true); h.click(); await settle(); expect(mock.writes).not.toHaveBeenCalled();
    const supported = harness(); mock.permission = 'unsupported'; supported.click(); await settle();
    expect(supported.draw().find(node => node.props.role === 'alert')?.props.children).toBe(MESSAGES.en.approvalInbox.settings.unsupported);
    expect(mock.request).not.toHaveBeenCalled(); expect(mock.writes).not.toHaveBeenCalled();
  });
});
