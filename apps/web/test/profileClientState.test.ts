import type { AgentHostApi, ProfileClientState, UserProfilePatch } from '@extalia/platform';
import { describe, expect, it, vi } from 'vitest';
import { CLIENT_STATE_KEYS, createProfileClientStateStore } from '../src/profileClientState';
import { loadLandingMemory } from '../src/appMode';
import { loadLightOverride, saveLightOverride } from '../src/office/scene/environment/lightOverride';

const tick = () => Promise.resolve();
function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
function server() {
  const patches: UserProfilePatch[] = [];
  const save: AgentHostApi['saveProfile'] = vi.fn(async patch => {
    patches.push(structuredClone(patch));
    return { schema: 'extalia.profile.v1' as const, preferences: {}, updatedAt: '2026-11-12T00:00:00.000Z' };
  });
  return { patches, save };
}

describe('host-backed client interface state', () => {
  it('retains explicit injected/device storage without an agent host', () => {
    const cache = memory({ [CLIENT_STATE_KEYS.lastWorkspaceId]: '{"workspaceId":"old"}' });
    const store = createProfileClientStateStore(() => cache);
    expect(loadLandingMemory(store.storage)).toEqual({ workspaceId: 'old' });
    saveLightOverride('off', store.storage);
    expect(loadLightOverride(store.storage)).toBe('off');
    saveLightOverride('auto', store.storage);
    expect(cache.getItem(CLIENT_STATE_KEYS.officeLights)).toBeNull();
  });

  it('never reads or saves a stale cache while host hydration is pending', async () => {
    const cache = memory({ [CLIENT_STATE_KEYS.lastWorkspaceId]: '{"workspaceId":"old"}', [CLIENT_STATE_KEYS.officeLights]: 'off' });
    const store = createProfileClientStateStore(() => cache), host = server();
    const binding = store.attach(host.save);
    expect(loadLandingMemory(store.storage)).toEqual({});
    expect(loadLightOverride(store.storage)).toBe('auto');
    store.storage.setItem(CLIENT_STATE_KEYS.officeLights, 'on');
    await binding.flush();
    expect(host.patches).toEqual([]);
    binding.hydrate(undefined);
    expect(cache.getItem(CLIENT_STATE_KEYS.officeLights)).toBeNull();
  });

  it('restarts from canonical profile values and mirrors them without saving them back', async () => {
    const cache = memory({ [CLIENT_STATE_KEYS.lastWorkspaceId]: '{"workspaceId":"wrong"}', 'extalia.mode.v1': '{"workspaceId":"legacy"}' });
    const store = createProfileClientStateStore(() => cache), host = server();
    const binding = store.attach(host.save);
    const canonical: ProfileClientState = { lastWorkspaceId: 'workspace-2', officeLights: 'off', approvalNotifications: 'on', earlierOpen: '1' };
    binding.hydrate(canonical);
    expect(loadLandingMemory(store.storage)).toEqual({ workspaceId: 'workspace-2' });
    expect(loadLightOverride(store.storage)).toBe('off');
    expect(store.storage.getItem(CLIENT_STATE_KEYS.approvalNotifications)).toBe('on');
    expect(store.storage.getItem(CLIENT_STATE_KEYS.earlierOpen)).toBe('1');
    expect(cache.getItem('extalia.mode.v1')).toBeNull();
    await binding.flush();
    expect(host.patches).toEqual([]);
    binding.dispose();
    const next = store.attach(host.save); next.hydrate(canonical);
    expect(loadLandingMemory(store.storage)).toEqual({ workspaceId: 'workspace-2' });
  });

  it('forgets every cached choice when a removed profile is replaced with an empty host', () => {
    const cache = memory(), store = createProfileClientStateStore(() => cache), host = server();
    const previous = store.attach(host.save);
    previous.hydrate({ lastWorkspaceId: 'old', officeLights: 'off', approvalNotifications: 'on', earlierOpen: '1' });
    const current = store.attach(host.save); current.hydrate(undefined);
    expect(loadLandingMemory(store.storage)).toEqual({});
    expect(loadLightOverride(store.storage)).toBe('auto');
    for (const key of Object.values(CLIENT_STATE_KEYS)) expect(cache.getItem(key)).toBeNull();
    // A late response or cleanup from the old host cannot restore the previous settings.
    previous.hydrate({ lastWorkspaceId: 'old', officeLights: 'off' }); previous.dispose();
    expect(loadLightOverride(store.storage)).toBe('auto');
    expect(loadLandingMemory(store.storage)).toEqual({});
  });

  it('saves only changed keys, coalesces quick changes and persists removals as null', async () => {
    const cache = memory(), store = createProfileClientStateStore(() => cache), host = server();
    const binding = store.attach(host.save); binding.hydrate({ officeLights: 'off', lastWorkspaceId: 'old' });
    store.storage.setItem(CLIENT_STATE_KEYS.officeLights, 'on');
    store.storage.setItem(CLIENT_STATE_KEYS.officeLights, 'off');
    store.storage.setItem(CLIENT_STATE_KEYS.approvalNotifications, 'on');
    await binding.flush();
    expect(host.patches).toEqual([{ clientState: { officeLights: 'off', approvalNotifications: 'on' } }]);
    store.storage.removeItem(CLIENT_STATE_KEYS.officeLights);
    store.storage.setItem(CLIENT_STATE_KEYS.lastWorkspaceId, '{}');
    await binding.flush();
    expect(host.patches[1]).toEqual({ clientState: { officeLights: null, lastWorkspaceId: null } });
    expect(loadLightOverride(store.storage)).toBe('auto');
    expect(loadLandingMemory(store.storage)).toEqual({});
  });

  it('serializes delayed saves and drops queued writes when that host detaches', async () => {
    const store = createProfileClientStateStore(() => memory());
    let finish!: () => void;
    const entered: UserProfilePatch[] = [];
    const save: AgentHostApi['saveProfile'] = vi.fn(async patch => {
      entered.push(patch);
      await new Promise<void>(resolve => { finish = resolve; });
      return { schema: 'extalia.profile.v1' as const, preferences: {}, updatedAt: '2026-11-12T00:00:00.000Z' };
    });
    const old = store.attach(save); old.hydrate({});
    store.storage.setItem(CLIENT_STATE_KEYS.officeLights, 'on');
    await tick();
    store.storage.setItem(CLIENT_STATE_KEYS.earlierOpen, '1');
    expect(entered).toHaveLength(1);
    old.dispose();
    const freshHost = server(), fresh = store.attach(freshHost.save); fresh.hydrate(undefined);
    finish(); await old.flush(); await fresh.flush();
    expect(entered).toEqual([{ clientState: { officeLights: 'on' } }]);
    expect(freshHost.patches).toEqual([]);
    expect(store.storage.getItem(CLIENT_STATE_KEYS.earlierOpen)).toBeNull();
  });

  it('bounds failed-save warnings and never implicitly retries into a new host', async () => {
    const cache = memory(), store = createProfileClientStateStore(() => cache);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = vi.fn(async () => { throw new Error('offline'); });
    try {
      const binding = store.attach(bad); binding.hydrate(undefined);
      store.storage.setItem(CLIENT_STATE_KEYS.officeLights, 'on'); await binding.flush();
      store.storage.setItem(CLIENT_STATE_KEYS.officeLights, 'off'); await binding.flush();
      expect(bad).toHaveBeenCalledTimes(2); expect(warn).toHaveBeenCalledTimes(1);
      binding.dispose();
      const host = server(), fresh = store.attach(host.save); fresh.hydrate(undefined); await fresh.flush();
      expect(host.patches).toEqual([]);
    } finally { warn.mockRestore(); }
  });

  it('notifies current consumers when host hydration resets lights, workspace and toggles', () => {
    const store = createProfileClientStateStore(() => memory()), host = server();
    const snapshots: string[] = [];
    const unsubscribe = store.subscribe(() => snapshots.push(JSON.stringify(Object.fromEntries(Object.values(CLIENT_STATE_KEYS).map(key => [key, store.storage.getItem(key)])))));
    const binding = store.attach(host.save);
    binding.hydrate({ officeLights: 'off', earlierOpen: '1' });
    binding.hydrate(undefined);
    expect(snapshots).toHaveLength(3);
    expect(store.storage.getItem(CLIENT_STATE_KEYS.earlierOpen)).toBeNull();
    expect(loadLightOverride(store.storage)).toBe('auto');
    unsubscribe();
  });
});
