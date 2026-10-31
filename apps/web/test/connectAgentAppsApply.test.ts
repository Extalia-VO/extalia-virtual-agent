import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { agentAppPrerequisites, ConnectAgentAppsCard, lastConnectionEvent } from '../src/pages/ConnectAgentAppsCard';

// Exercise preview and approval handlers with in-memory hooks and a fake host.
const hooks = vi.hoisted(() => ({
  index: 0, state: [] as unknown[], mounted: true, lateWrites: 0,
  effects: new Map<number, { dependencies?: unknown[]; cleanup?: () => void }>(),
  pending: [] as (() => void)[],
}));
vi.mock('react', async original => ({
  ...await original<typeof React>(),
  useEffect: (effect: () => void | (() => void), dependencies?: unknown[]) => {
    const index = hooks.index++;
    const previous = hooks.effects.get(index);
    if (previous && dependencies && previous.dependencies?.every((value, at) => Object.is(value, dependencies[at]))) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      const cleanup = effect();
      hooks.effects.set(index, { dependencies, cleanup: cleanup || undefined });
    });
  },
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    return hooks.state[index] ??= { current: initial };
  },
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.state)) hooks.state[index] = initial;
    return [hooks.state[index], (value: unknown) => {
      if (!hooks.mounted) hooks.lateWrites++;
      hooks.state[index] = typeof value === 'function' ? value(hooks.state[index]) : value;
    }];
  },
}));

function commitEffects() { for (const effect of hooks.pending.splice(0)) effect(); }
function unmount() {
  for (const effect of hooks.effects.values()) effect.cleanup?.();
  hooks.effects.clear();
  hooks.mounted = false;
}
function mount(props: Parameters<typeof ConnectAgentAppsCard>[0]) {
  return () => {
    hooks.index = 0;
    const tree = ConnectAgentAppsCard(props);
    commitEffects();
    return tree;
  };
}

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
const button = (node: ReactNode, label: string) => elements(node).find(element => element.type === 'button' && text(element.props.children as ReactNode) === label);

beforeEach(() => {
  hooks.index = 0; hooks.state = []; hooks.effects.clear(); hooks.pending = []; hooks.mounted = true; hooks.lateWrites = 0;
});
afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('agent app preview approval', () => {
  it('does not use old live-ingest history as proof that a new configuration loaded', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const connection = { ...(await agents.agentAppConnections())[0]!, configuredAt: '2026-10-29T12:00:00Z', lastEventAt: '2026-10-29T11:59:59Z' };
    const initialIngest = await agents.hookIngest();
    const ingest = { ...initialIngest, lastEvents: { ...initialIngest.lastEvents, [connection.app]: '2026-10-29T11:58:00Z' } };
    expect(lastConnectionEvent(connection, ingest)).toBeUndefined();
    expect(agentAppPrerequisites(connection, connection.lastEventAt).eventsReceived).toBe(false);
    const current = '2026-10-29T12:01:00Z';
    expect(lastConnectionEvent(connection, { ...ingest, lastEvents: { ...ingest.lastEvents, [connection.app]: current } })).toBe(current);
    expect(agentAppPrerequisites(connection, current).eventsReceived).toBe(true);
  });
  it.each([
    { app: 'codex' as const, previewDigest: 'approved-preview', trust: true },
    { app: 'codex' as const, previewDigest: undefined, trust: false },
    { app: 'claude' as const, previewDigest: 'approved-preview', trust: false },
    { app: 'claude' as const, previewDigest: undefined, trust: false },
  ])('passes the shown $app preview digest and separate trust consent ($previewDigest)', async ({ app, previewDigest, trust }) => {
    const base = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const initialConnections = (await base.agentAppConnections()).filter(connection => connection.app === app);
    const initialIngest = await base.hookIngest();
    const preview = { ...await base.planAgentAppConnect(app), previewDigest };
    const plan = vi.fn(async () => preview);
    const apply = vi.fn(base.applyAgentAppConnect);
    const agents = { ...base, planAgentAppConnect: plan, applyAgentAppConnect: apply };
    const render = mount({ t: MESSAGES.en, agents, initialConnections, initialIngest });

    (button(render(), MESSAGES.en.agentApps.connect)!.props.onClick as () => void)();
    await vi.waitFor(() => expect(button(render(), MESSAGES.en.agentApps.apply)).toBeDefined());
    expect(plan).toHaveBeenCalledWith(app);
    if (trust) {
      const label = elements(render()).find(element => element.type === 'label' && text(element.props.children as ReactNode).includes(MESSAGES.en.agentApps.trustConsent))!;
      const checkbox = elements(label).find(element => element.type === 'input')!;
      (checkbox.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    }
    (button(render(), MESSAGES.en.agentApps.apply)!.props.onClick as () => void)();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(app, app === 'codex' || previewDigest !== undefined ? {
      ...(app === 'codex' ? { trust } : {}),
      ...(previewDigest !== undefined ? { expectedPreviewDigest: previewDigest } : {}),
    } : undefined));
    await vi.waitFor(() => expect(button(render(), MESSAGES.en.agentApps.connect)?.props.disabled).toBe(false));
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function browserEvents() {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  return { window, document };
}
const dashboard = (tree: ReactNode) => elements(tree).find(element => element.type === 'input' && element.props.type === 'url')!;
const labels = (tree: ReactNode) => elements(tree).find(element => element.type === 'label' && text(element.props.children as ReactNode).includes(MESSAGES.en.agentApps.labelsOnlyLabel))!;
const input = (tree: ReactNode) => elements(tree).find(element => element.type === 'input')!;

describe('agent app automatic status refresh', () => {
  it('releases a finished old action when the host capability changes without applying its stale reply', async () => {
    browserEvents();
    const base = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const initialConnections = (await base.agentAppConnections()).filter(connection => connection.app === 'codex');
    const preview = await base.planAgentAppConnect('codex');
    const old = deferred<typeof preview>();
    const props: Parameters<typeof ConnectAgentAppsCard>[0] = {
      t: MESSAGES.en, agents: { ...base, planAgentAppConnect: () => old.promise }, initialConnections,
    };
    const render = mount(props);
    (button(render(), MESSAGES.en.agentApps.connect)!.props.onClick as () => void)();
    const nextPlan = vi.fn(async () => ({ ...preview, diff: 'new host preview' }));
    props.agents = { ...base, planAgentAppConnect: nextPlan };
    render();
    old.resolve({ ...preview, diff: 'stale host preview' });
    await settle();
    expect(button(render(), MESSAGES.en.agentApps.connect)!.props.disabled).toBe(false);
    expect(text(render())).not.toContain('stale host preview');
    (button(render(), MESSAGES.en.agentApps.connect)!.props.onClick as () => void)();
    await settle();
    expect(nextPlan).toHaveBeenCalledTimes(1);
    expect(text(render())).toContain('new host preview');
  });
  it('polls only cheap live ingest for all five apps, preserves the shown preview, trust choice and dashboard draft', async () => {
    browserEvents();
    const base = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const initialConnections = (await base.agentAppConnections()).map(connection => ({ ...connection, connected: true, state: 'connected' as const, lastEventAt: undefined }));
    const initialIngest = await base.hookIngest();
    const initialPlan = { ...await base.planAgentAppConnect('codex'), diff: 'the exact approved preview', previewDigest: 'shown-digest' };
    const now = new Date().toISOString();
    const nextIngest = { ...initialIngest, labelsOnly: true, hermesDashboardUrl: 'http://127.0.0.1:9222', lastEvents: Object.fromEntries(initialConnections.map(connection => [connection.app, now])) as typeof initialIngest.lastEvents };
    const full = vi.fn(base.agentAppConnections);
    const light = vi.fn(async () => nextIngest);
    const agents = { ...base, agentAppConnections: full, hookIngest: light };
    vi.useFakeTimers();
    const render = mount({ t: MESSAGES.en, agents, initialConnections, initialIngest, initialPlan });
    let tree = render();
    (dashboard(tree).props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'http://127.0.0.1:9333' } });
    const trust = elements(tree).find(element => element.type === 'label' && text(element.props.children as ReactNode).includes(MESSAGES.en.agentApps.trustConsent))!;
    (input(trust).props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    await vi.advanceTimersByTimeAsync(6000);
    tree = render();
    expect(full).not.toHaveBeenCalled();
    expect(light).toHaveBeenCalledTimes(3);
    expect(text(tree).match(/Last event /g)).toHaveLength(5);
    expect(text(tree)).toContain('the exact approved preview');
    expect(dashboard(tree).props.value).toBe('http://127.0.0.1:9333');
    expect(input(labels(tree)).props.checked).toBe(true);
    expect(input(elements(tree).find(element => element.type === 'label' && text(element.props.children as ReactNode).includes(MESSAGES.en.agentApps.trustConsent))!).props.checked).toBe(true);
  });

  it('loads initially and debounces focus/visibility into a full refresh after external terminal changes', async () => {
    const { window, document } = browserEvents();
    const base = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    let nextConnections = await base.agentAppConnections();
    const initialIngest = await base.hookIngest();
    const full = vi.fn(async () => nextConnections);
    const light = vi.fn(async () => initialIngest);
    const agents = { ...base, agentAppConnections: full, hookIngest: light };
    vi.useFakeTimers();
    const render = mount({ t: MESSAGES.en, agents });
    render();
    await settle();
    expect(full).toHaveBeenCalledTimes(1);
    nextConnections = nextConnections.map(connection => ({ ...connection, connected: true, state: 'connected' }));
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(4000);
    expect(light).toHaveBeenCalledTimes(1);
    document.visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(200);
    expect(full).toHaveBeenCalledTimes(2);
    const rows = elements(render()).filter(element => element.type === 'li' && String(element.props.className).includes('connect-app-row'));
    expect(rows).toHaveLength(5);
    expect(rows.every(row => text(row).includes(MESSAGES.en.agentApps.disconnect))).toBe(true);
    unmount();
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(full).toHaveBeenCalledTimes(2);
    expect(hooks.lateWrites).toBe(0);
  });

  it('does one trailing full read when focus returns during an older full scan', async () => {
    const { window } = browserEvents();
    const base = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const initial = await base.agentAppConnections();
    const old = deferred<typeof initial>();
    const latest: typeof initial = initial.map(connection => ({ ...connection, nodeStatus: 'ready', connected: true, state: 'connected' }));
    const full = vi.fn(async () => latest).mockImplementationOnce(() => old.promise);
    vi.useFakeTimers();
    const render = mount({ t: MESSAGES.en, agents: { ...base, agentAppConnections: full } });
    render();
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(200);
    old.resolve(initial);
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(full).toHaveBeenCalledTimes(2);
    const rows = elements(render()).filter(element => element.type === 'li' && String(element.props.className).includes('connect-app-row'));
    expect(rows).toHaveLength(5);
    expect(rows.every(row => text(row).includes(MESSAGES.en.agentApps.disconnect))).toBe(true);
  });

  it('serializes slow reads, rejects a pre-write reply and keeps saved privacy plus an unsaved dashboard draft', async () => {
    const { window } = browserEvents();
    const base = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const initialConnections = await base.agentAppConnections();
    const initialIngest = await base.hookIngest();
    const old = deferred<typeof initialIngest>();
    let nextIngest = initialIngest;
    const light = vi.fn(async () => nextIngest).mockImplementationOnce(() => old.promise);
    const full = vi.fn(async () => initialConnections);
    const agents = { ...base, hookIngest: light, agentAppConnections: full, setHookPrivacy: vi.fn(async ({ labelsOnly }: { labelsOnly?: boolean }) => nextIngest = { ...nextIngest, labelsOnly }) };
    vi.useFakeTimers();
    const render = mount({ t: MESSAGES.en, agents, initialConnections, initialIngest });
    let tree = render();
    (dashboard(tree).props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'http://127.0.0.1:9444' } });
    await vi.advanceTimersByTimeAsync(6000);
    expect(light).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(200);
    expect(full).not.toHaveBeenCalled();
    (input(labels(tree)).props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    await settle();
    expect(input(labels(render())).props.checked).toBe(true);
    old.resolve(initialIngest);
    await settle();
    tree = render();
    expect(input(labels(tree)).props.checked).toBe(true);
    expect(dashboard(tree).props.value).toBe('http://127.0.0.1:9444');
    expect(full).toHaveBeenCalledTimes(1);
    expect(light).toHaveBeenCalledTimes(2);
  });

  it('keeps the last status when a background read fails, and surfaces an explicit refresh failure', async () => {
    browserEvents();
    const base = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const initialConnections = await base.agentAppConnections();
    const initialIngest = await base.hookIngest();
    const agents = { ...base, agentAppConnections: vi.fn(async () => initialConnections), hookIngest: vi.fn(async () => { throw new Error('Read unavailable'); }) };
    vi.useFakeTimers();
    const render = mount({ t: MESSAGES.en, agents, initialConnections, initialIngest });
    render();
    await vi.advanceTimersByTimeAsync(2000);
    expect(text(render())).not.toContain('Read unavailable');
    (button(render(), MESSAGES.en.agentApps.refresh)!.props.onClick as () => void)();
    await settle();
    expect(text(render())).toContain('Read unavailable');
    expect(text(render())).toContain('Codex');
  });

  it.each(['read', 'preview', 'privacy', 'apply', 'test', 'disconnect'] as const)('ignores %s replies after unmount', async kind => {
    browserEvents();
    const base = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    await base.applyAgentAppConnect('codex');
    const initialConnections = (await base.agentAppConnections()).filter(connection => connection.app === 'codex');
    const initialIngest = await base.hookIngest();
    const initialPlan = await base.planAgentAppConnect('codex');
    const done = deferred<void>();
    const agents = {
      ...base,
      hookIngest: vi.fn(async () => { if (kind === 'read') await done.promise; return initialIngest; }),
      planAgentAppConnect: vi.fn(async () => { await done.promise; return initialPlan; }),
      setHookPrivacy: vi.fn(async () => { await done.promise; return initialIngest; }),
      applyAgentAppConnect: vi.fn(async () => { await done.promise; return base.applyAgentAppConnect('codex'); }),
      testAgentAppConnection: vi.fn(async () => { await done.promise; return base.testAgentAppConnection('codex'); }),
      disconnectAgentApp: vi.fn(async () => { await done.promise; return base.disconnectAgentApp('codex'); }),
    };
    vi.useFakeTimers();
    const render = mount({ t: MESSAGES.en, agents, initialConnections, initialIngest, initialPlan });
    const tree = render();
    if (kind === 'read') await vi.advanceTimersByTimeAsync(2000);
    else if (kind === 'privacy') (input(labels(tree)).props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    else (button(tree, MESSAGES.en.agentApps[kind === 'preview' ? 'connect' : kind])!.props.onClick as () => void)();
    unmount();
    done.resolve();
    await settle();
    await vi.advanceTimersByTimeAsync(6000);
    expect(hooks.lateWrites).toBe(0);
  });

  it('explains hook-only disconnect in both languages without changing observer settings', async () => {
    const base = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    await base.applyAgentAppConnect('claude');
    const initialConnections = (await base.agentAppConnections()).filter(connection => connection.app === 'claude');
    const render = mount({ t: MESSAGES.en, agents: base, initialConnections });
    expect(text(render())).toContain(MESSAGES.en.agentApps.disconnectHint);
    (button(render(), MESSAGES.en.agentApps.disconnect)!.props.onClick as () => void)();
    await vi.waitFor(() => expect(text(render())).toContain('Transcript watching may continue if separately enabled.'));
    expect(MESSAGES.id.agentApps.disconnectHint).toContain('tetap aktif');
    expect(MESSAGES.id.agentApps.disconnectedNote(1)).toContain('diaktifkan secara terpisah');
  });

  it.each(['en', 'id'] as const)('disables missing-Node hooks with localized %s copy while webhook-only Hermes stays available', async language => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const initialConnections = (await agents.agentAppConnections()).filter(connection => connection.app === 'codex' || connection.app === 'hermes').map(connection => ({ ...connection, nodeStatus: connection.app === 'codex' ? 'missing' as const : 'not-required' as const }));
    const initialPlan = { ...await agents.planAgentAppConnect('codex'), nodeStatus: 'missing' as const };
    const render = mount({ t: MESSAGES[language], agents, initialConnections, initialPlan });
    const tree = render();
    const rows = elements(tree).filter(element => element.type === 'li' && String(element.props.className).includes('connect-app-row'));
    expect(button(rows[0], MESSAGES[language].agentApps.connect)?.props.disabled).toBe(true);
    expect(button(rows[0], MESSAGES[language].agentApps.apply)?.props.disabled).toBe(true);
    expect(text(rows[0])).toContain(MESSAGES[language].agentApps.nodeMissing);
    expect(button(rows[1], MESSAGES[language].agentApps.connect)?.props.disabled).toBe(false);
  });
});
