import type * as React from 'react';
import type { HostState, Platform } from '@extalia/platform';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { SettingsPage, SkillsMovedPointer } from '../src/pages/SettingsPage';
import { AutoWatchLocations, IgnoredFolders } from '../src/pages/AutoWatchLocations';
import { ConnectAgentAppsCard } from '../src/pages/ConnectAgentAppsCard';
import { ConnectionsSection } from '../src/pages/settings/ConnectionsSection';
import { WorkspacesSection } from '../src/pages/settings/WorkspacesSection';
import { KnowledgeVaultSection } from '../src/pages/settings/KnowledgeVaultSection';
import { availableSettingsSections, nextSettingsSection, SETTINGS_SECTIONS } from '../src/pages/settings/settingsSections';
import { DEFAULT_PREFERENCES } from '../src/preferences';

type HookStore = { state: unknown[]; effects: Map<number, { dependencies?: unknown[]; cleanup?: () => void }> };
const hooks = vi.hoisted(() => ({ index: 0, store: null as HookStore | null, pending: [] as (() => void)[] }));
vi.mock('react', async original => ({
  ...await original<typeof React>(),
  useId: () => { hooks.index++; return 'settings-test'; },
  useState: (initial: unknown) => {
    const store = hooks.store!;
    const index = hooks.index++;
    if (!(index in store.state)) store.state[index] = typeof initial === 'function' ? initial() : initial;
    return [store.state[index], (value: unknown) => { store.state[index] = typeof value === 'function' ? value(store.state[index]) : value; }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    return hooks.store!.state[index] ??= { current: initial };
  },
  useEffect: (effect: () => void | (() => void), dependencies?: unknown[]) => {
    const store = hooks.store!;
    const index = hooks.index++;
    const previous = store.effects.get(index);
    if (previous && dependencies && previous.dependencies?.length === dependencies.length && previous.dependencies.every((value, at) => Object.is(value, dependencies[at]))) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      const cleanup = effect();
      store.effects.set(index, { dependencies, cleanup: cleanup || undefined });
    });
  },
}));

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function find(tree: ReactNode, type: unknown) { return elements(tree).find(element => element.type === type); }
function tab(tree: ReactNode, section: string) { return elements(tree).find(element => element.props.role === 'tab' && element.props.id === `settings-test-${section}-tab`)!; }
function panel(tree: ReactNode, section: string) { return elements(tree).find(element => element.props.role === 'tabpanel' && element.props.id === `settings-test-${section}-panel`)!; }
function click(element: ReactElement<Record<string, unknown>>) { (element.props.onClick as () => void)(); }
function store(): HookStore { return { state: [], effects: new Map() }; }
function flush() { for (const effect of hooks.pending.splice(0)) effect(); }
function cleanup(current: HookStore) { for (const effect of current.effects.values()) effect.cleanup?.(); }
function render<P, R>(component: (props: P) => R, props: P, current: HookStore): R {
  hooks.store = current; hooks.index = 0;
  return component(props);
}
function mount(props: Parameters<typeof SettingsPage>[0]) {
  const outer = store();
  let inner = store();
  let key: string | null | undefined;
  const focus = new Map<string, ReturnType<typeof vi.fn>>();
  return {
    draw(patch: Partial<Parameters<typeof SettingsPage>[0]> = {}) {
      props = { ...props, ...patch };
      const wrapper = render(SettingsPage, props, outer);
      if (key !== wrapper.key) { cleanup(inner); inner = store(); key = wrapper.key; }
      const component = wrapper.type as (props: Parameters<typeof SettingsPage>[0]) => ReactNode;
      const tree = render(component, wrapper.props, inner);
      for (const element of elements(tree).filter(element => element.props.role === 'tab')) {
        const id = element.props.id as string;
        if (!focus.has(id)) focus.set(id, vi.fn());
        (element.props.ref as (element: unknown) => void)({ focus: focus.get(id) });
      }
      flush();
      return tree;
    },
    focus,
    close() { cleanup(inner); cleanup(outer); },
  };
}
async function fixture() {
  const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
  const hostState = await platform.capabilities.agents!.getState();
  return { t: MESSAGES.en, platform, hostState, preferences: DEFAULT_PREFERENCES, onChange: vi.fn(), onHostState: vi.fn(), updateStatus: null, onOpenSkills: vi.fn() };
}
beforeEach(() => { hooks.pending = []; });

describe('Settings section ownership and navigation', () => {
  it('hides sections without their capabilities and falls back from an unavailable deep link', async () => {
    expect(availableSettingsSections({ agents: true, system: true })).toEqual(SETTINGS_SECTIONS);
    expect(availableSettingsSections({ agents: false, system: false })).toEqual(['general']);
    expect(availableSettingsSections({ agents: false, system: true })).toEqual(['general', 'system']);
    const props = await fixture();
    const page = mount({ ...props, platform: { ...props.platform, capabilities: {} }, hostState: null, section: 'agent-apps' });
    const tree = page.draw();
    expect(elements(tree).filter(element => element.props.role === 'tab')).toHaveLength(1);
    expect(tab(tree, 'general').props['aria-selected']).toBe(true);
    page.close();
  });

  it('mounts no integration or source panels when opening General', async () => {
    const props = await fixture();
    const connector = vi.spyOn(props.platform.capabilities.agents!, 'agentAppConnections');
    const sources = vi.spyOn(props.platform.capabilities.agents!, 'importLocations');
    const ingest = vi.spyOn(props.platform.capabilities.agents!, 'hookIngest');
    const page = mount(props);
    const tree = page.draw();
    for (const type of [ConnectAgentAppsCard, AutoWatchLocations, IgnoredFolders, ConnectionsSection, WorkspacesSection, KnowledgeVaultSection, SkillsMovedPointer]) expect(find(tree, type)).toBeUndefined();
    expect(connector).not.toHaveBeenCalled();
    expect(sources).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    page.close();
  });

  it('keeps visited connection editors mounted with stable panel keys across external deep links', async () => {
    const props = await fixture();
    const page = mount({ ...props, section: 'connections' });
    const initial = page.draw();
    expect(find(initial, ConnectionsSection)).toBeDefined();
    const connectionsKey = panel(initial, 'connections').key;
    const apps = page.draw({ section: 'agent-apps' });
    expect(panel(apps, 'connections').props.hidden).toBe(true);
    expect(panel(apps, 'connections').key).toBe(connectionsKey);
    expect(find(apps, ConnectionsSection)?.type).toBe(find(initial, ConnectionsSection)?.type);
    for (const type of [ConnectAgentAppsCard, AutoWatchLocations, IgnoredFolders]) expect(find(panel(apps, 'agent-apps'), type)).toBeDefined();
    expect(page.focus.get('settings-test-agent-apps-tab')).toHaveBeenCalled();
    const general = page.draw({ section: 'general' });
    expect(find(panel(general, 'connections'), ConnectionsSection)).toBeDefined();
    expect(find(panel(general, 'agent-apps'), ConnectAgentAppsCard)).toBeDefined();
    expect(panel(general, 'general').props.hidden).toBe(false);
    page.close();
  });

  it('activates Workspaces for a gate request and keeps the Grimoire pointer there', async () => {
    const props = await fixture();
    const page = mount({ ...props, section: 'general', editGateFor: props.hostState.workspaces[0]!.id });
    const tree = page.draw();
    expect(tab(tree, 'workspaces').props['aria-selected']).toBe(true);
    expect(find(panel(tree, 'workspaces'), WorkspacesSection)?.props.editGateFor).toBe(props.hostState.workspaces[0]!.id);
    expect(find(panel(tree, 'workspaces'), SkillsMovedPointer)).toBeDefined();
    expect(page.focus.get('settings-test-workspaces-tab')).toHaveBeenCalled();
    page.close();
  });

  it('uses roving tab stops, arrow wraparound and Home/End without host writes', async () => {
    const props = await fixture();
    const onSectionChange = vi.fn();
    const workflow = vi.spyOn(props.platform.capabilities.agents!, 'setWorkflow');
    const page = mount({ ...props, onSectionChange });
    let tree = page.draw();
    const preventDefault = vi.fn();
    (tab(tree, 'general').props.onKeyDown as (event: unknown) => void)({ key: 'ArrowRight', preventDefault });
    tree = page.draw();
    expect(tab(tree, 'connections').props.tabIndex).toBe(0);
    expect(tab(tree, 'general').props.tabIndex).toBe(-1);
    expect(onSectionChange).toHaveBeenCalledWith('connections');
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(page.focus.get('settings-test-connections-tab')).toHaveBeenCalled();
    expect(nextSettingsSection('general', 'ArrowLeft', SETTINGS_SECTIONS)).toBe('system');
    expect(nextSettingsSection('storage', 'Home', SETTINGS_SECTIONS)).toBe('general');
    expect(nextSettingsSection('general', 'End', SETTINGS_SECTIONS)).toBe('system');
    expect(nextSettingsSection('general', 'Tab', SETTINGS_SECTIONS)).toBeUndefined();
    expect(workflow).not.toHaveBeenCalled();
    page.close();
  });

  it.each(['agents', 'profile', 'directory'] as const)('discards visited private panels when the %s context changes', async identity => {
    const props = await fixture();
    const page = mount(props);
    click(tab(page.draw(), 'connections'));
    expect(find(page.draw(), ConnectionsSection)).toBeDefined();
    const hostState: HostState = identity === 'profile' ? { ...props.hostState, profile: { ...props.hostState.profile, id: 'another-profile' } }
      : identity === 'directory' ? { ...props.hostState, dataDirectory: '/profiles/another' } : props.hostState;
    const platform: Platform = identity === 'agents' ? { ...props.platform, capabilities: { ...props.platform.capabilities, agents: { ...props.platform.capabilities.agents! } } } : props.platform;
    const changed = page.draw({ hostState, platform });
    expect(tab(changed, 'general').props['aria-selected']).toBe(true);
    expect(find(changed, ConnectionsSection)).toBeUndefined();
    page.close();
  });

  it('blocks duplicate workflow clicks and drops completion from a retired host', async () => {
    const props = await fixture();
    let complete!: (state: HostState) => void;
    const workflow = vi.spyOn(props.platform.capabilities.agents!, 'setWorkflow').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const page = mount(props);
    const tree = page.draw();
    const mode = elements(tree).find(element => element.type === 'button' && element.props.children === MESSAGES.en.observer.observe)!;
    click(mode); click(mode);
    expect(workflow).toHaveBeenCalledOnce();
    page.draw({ hostState: { ...props.hostState, profile: { ...props.hostState.profile, id: 'another-profile' } } });
    complete(props.hostState);
    await Promise.resolve(); await Promise.resolve();
    expect(props.onHostState).not.toHaveBeenCalled();
    page.close();
  });
});
