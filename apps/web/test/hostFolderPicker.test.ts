import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { AgentHostApi, DirectorySelection, FileSystemCapability, VaultProfilesCatalog } from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostFolderPicker } from '../src/ui/HostFolderPicker';
import { DirectoryBrowser } from '../src/setup/DirectoryBrowser';
import { MESSAGES } from '../src/i18n';
import { VaultProfilesSection, type VaultProfilesView } from '../src/pages/settings/VaultProfilesSection';
import { KnowledgeVaultSection, KnowledgeVaultView } from '../src/pages/settings/KnowledgeVaultSection';

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
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
const cleanups: (() => void)[] = [];
function harness(picker?: FileSystemCapability) {
  const outer = store(); let inner = store(), key: string | null | undefined, tree: ReactNode;
  const props: Parameters<typeof HostFolderPicker>[0] = { t: MESSAGES.en, agents: {} as AgentHostApi, picker, startPath: '/data/notes', onSelect: vi.fn(), onBusyChange: vi.fn() };
  const render = () => {
    const child = run(outer, () => HostFolderPicker(props));
    if (child.key !== key) { dispose(inner); inner = store(); key = child.key; }
    tree = run(inner, () => (child.type as (p: typeof child.props) => ReactNode)(child.props));
    return elements(tree);
  };
  const button = () => render().find(element => element.type === 'button')!;
  const browse = () => render().find(element => element.type === DirectoryBrowser);
  const click = () => { (button().props.onClick as () => void)(); };
  const stop = () => { dispose(inner); dispose(outer); };
  cleanups.push(stop); return { props, render, button, browse, click, stop };
}
beforeEach(() => { hooks.current = undefined; });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

describe('host folder selection', () => {
  it('can retry an unavailable vault setting without applying a folder change', async () => {
    const knowledgeSettings = vi.fn().mockRejectedValueOnce(new Error('Connection unavailable')).mockResolvedValue({ kind: 'default', path: '/data/notes', label: 'notes', available: true, obsidian: false, watch: 'off' });
    const setKnowledgeVaultRoot = vi.fn();
    const props = { t: MESSAGES.en, agents: { knowledgeSettings, setKnowledgeVaultRoot } as unknown as AgentHostApi, showProfiles: false };
    const outer = store(), inner = store(); cleanups.push(() => { dispose(inner); dispose(outer); });
    const draw = () => {
      const wrapper = run(outer, () => KnowledgeVaultSection(props));
      return run(inner, () => (wrapper.type as (value: typeof wrapper.props) => ReactNode)(wrapper.props));
    };
    draw(); await settle();
    const failed = elements(draw());
    expect(failed.find(node => node.props.role === 'alert')?.props.children).toContain('Connection unavailable');
    const retry = failed.find(node => node.type === 'button' && node.props.children === MESSAGES.en.common.retry)!;
    (retry.props.onClick as () => void)(); draw(); await settle();
    const ready = elements(draw()).find(node => node.type === KnowledgeVaultView)!;
    expect(ready.props.settings).toMatchObject({ path: '/data/notes' });
    expect(knowledgeSettings).toHaveBeenCalledTimes(2); expect(setKnowledgeVaultRoot).not.toHaveBeenCalled();
  });

  it('can retry a failed shared-vault catalog without dropping the settings destination', async () => {
    const catalog: VaultProfilesCatalog = { revision: 'current', defaultProfileId: 'default', workspaces: [], profiles: [{ id: 'default', name: 'Default', kind: 'indexed', root: '/data/notes', workspaceIds: [], minutesEnabled: false, automaticLearning: { enabled: false, skills: false, notes: false } }] };
    const listVaultProfiles = vi.fn().mockRejectedValueOnce(new Error('Connection unavailable')).mockResolvedValue(catalog);
    const saveVaultProfile = vi.fn(), outer = store(), inner = store();
    const props = { t: MESSAGES.en, agents: { listVaultProfiles, saveVaultProfile } as unknown as AgentHostApi };
    cleanups.push(() => { dispose(inner); dispose(outer); });
    const draw = () => {
      const wrapper = run(outer, () => VaultProfilesSection(props));
      return run(inner, () => (wrapper.type as (value: typeof wrapper.props) => ReactNode)(wrapper.props));
    };
    draw(); await settle(); const failed = elements(draw());
    expect(failed.find(node => node.type === 'h2')?.props.children).toBe(MESSAGES.en.vaultProfiles.title);
    const retry = failed.find(node => node.type === 'button' && node.props.children === MESSAGES.en.common.retry)!;
    (retry.props.onClick as () => void)(); draw(); await settle();
    expect((draw() as ReactElement<Parameters<typeof VaultProfilesView>[0]>).props.draft.name).toBe('Default');
    expect(listVaultProfiles).toHaveBeenCalledTimes(2); expect(saveVaultProfile).not.toHaveBeenCalled();
  });

  it('opens the Web host browser and cancels without changing the vault', () => {
    const h = harness(); h.click();
    const browser = h.browse()!;
    expect(browser.props.agents).toBe(h.props.agents);
    expect(browser.props.startPath).toBe('/data/notes');
    expect(browser.props.title).toBe(MESSAGES.en.knowledgeVault.folderOptions);
    expect(h.props.onBusyChange).toHaveBeenLastCalledWith(true);
    (browser.props.onClose as () => void)();
    expect(h.browse()).toBeUndefined(); expect(h.props.onSelect).not.toHaveBeenCalled();
    expect(h.props.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('keeps a native cancellation read-only and releases its busy state', async () => {
    const selectDirectory = vi.fn(async () => null), h = harness({ selectDirectory });
    h.click(); h.render(); await settle();
    expect(h.button().props.disabled).toBeFalsy(); expect(h.browse()).toBeUndefined();
    expect(h.props.onSelect).not.toHaveBeenCalled(); expect(h.props.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('selects the native host path once and blocks duplicate pending requests', async () => {
    const request = deferred<DirectorySelection | null>(), selectDirectory = vi.fn(() => request.promise), h = harness({ selectDirectory });
    h.click(); h.click(); expect(selectDirectory).toHaveBeenCalledOnce();
    expect(h.button().props.disabled).toBe(true);
    request.resolve({ name: 'Vault', path: '/data/custom-vault' }); await settle(); h.render();
    expect(h.props.onSelect).toHaveBeenCalledExactlyOnceWith('/data/custom-vault');
    expect(h.props.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('falls back from a pathless browser handle to host browsing before changing any folder', async () => {
    const h = harness({ selectDirectory: vi.fn(async () => ({ name: 'Local folder' })) });
    h.click(); h.render(); await settle();
    const browser = h.browse()!;
    expect(browser).toBeDefined(); expect(h.props.onSelect).not.toHaveBeenCalled();
    expect(h.props.onBusyChange).toHaveBeenLastCalledWith(true);
    (browser.props.onSelect as (path: string) => void)('/data/selected'); await settle();
    expect(h.browse()).toBeUndefined(); expect(h.props.onSelect).toHaveBeenCalledExactlyOnceWith('/data/selected');
    expect(h.props.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('shows picker and selection errors and leaves the draft available for another attempt', async () => {
    const selectDirectory = vi.fn().mockRejectedValueOnce(new Error('Picker unavailable')).mockResolvedValue({ name: 'Vault', path: '/data/vault' });
    const h = harness({ selectDirectory }); h.click(); await settle();
    expect(h.render().find(element => element.props.role === 'alert')?.props.children).toBe('Picker unavailable');
    expect(h.props.onSelect).not.toHaveBeenCalled();
    h.props.onSelect = vi.fn(async () => { throw new Error('Folder is unavailable'); });
    h.click(); await settle();
    expect(h.render().find(element => element.props.role === 'alert')?.props.children).toBe('Folder is unavailable');
    expect(h.button().props.disabled).toBeFalsy(); expect(h.props.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it.each(['unmount', 'agents', 'locked', 'path', 'picker'] as const)('ignores a late native reply after %s changes the owner', async reason => {
    const request = deferred<DirectorySelection | null>(), h = harness({ selectDirectory: () => request.promise });
    h.click(); h.render();
    if (reason === 'unmount') h.stop();
    else {
      if (reason === 'agents') h.props.agents = {} as AgentHostApi;
      if (reason === 'locked') h.props.disabled = true;
      if (reason === 'path') h.props.startPath = '/data/other';
      if (reason === 'picker') h.props.picker = { selectDirectory: async () => null };
      h.render();
    }
    request.resolve({ name: 'Old vault', path: '/data/stale' }); await settle();
    expect(h.props.onSelect).not.toHaveBeenCalled(); expect(h.props.onBusyChange).toHaveBeenLastCalledWith(false);
  });
});

describe('advanced vault folder drafts', () => {
  it('keeps the selected host location in the draft until Save and retains it after a failed save', async () => {
    const catalog: VaultProfilesCatalog = { revision: 'revision-one', defaultProfileId: 'default', workspaces: [], profiles: [
      { id: 'custom', name: 'Team notes', root: '/data/old-vault', kind: 'custom', workspaceIds: [], minutesEnabled: true,
        automaticLearning: { enabled: false, skills: false, notes: false } },
    ] };
    const saveVaultProfile = vi.fn().mockRejectedValueOnce(new Error('Revision changed. Refresh before saving.'));
    const agents = { listVaultProfiles: vi.fn(async () => catalog), saveVaultProfile } as unknown as AgentHostApi;
    const outer = store(), inner = store(); cleanups.push(() => { dispose(inner); dispose(outer); });
    const render = () => {
      const child = run(outer, () => VaultProfilesSection({ t: MESSAGES.en, agents }));
      const view = run(inner, () => (child.type as (props: typeof child.props) => ReactNode)(child.props));
      return isValidElement<Parameters<typeof VaultProfilesView>[0]>(view) ? view.props : undefined;
    };
    render(); await settle();
    const original = render()!, picker = original.folderControl as ReactElement<Parameters<typeof HostFolderPicker>[0]>;
    expect(picker.props.startPath).toBe('/data/old-vault');
    await picker.props.onSelect('/data/new-vault');
    let updated = render()!;
    expect(updated.draft.vaultRoot).toBe('/data/new-vault');
    expect(saveVaultProfile).not.toHaveBeenCalled();
    expect(catalog.profiles[0]!.root).toBe('/data/old-vault');
    updated.onSave(); await settle(); updated = render()!;
    expect(saveVaultProfile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'custom', vaultRoot: '/data/new-vault', expectedRevision: 'revision-one' }));
    expect(updated.draft.vaultRoot).toBe('/data/new-vault');
    expect(updated.error).toContain('Revision changed');
  });
});
