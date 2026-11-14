import { describe, expect, it } from 'vitest';
import {
  chatAvailable, LANDING_STORAGE_KEY, LEGACY_MODE_STORAGE_KEY, loadLandingMemory, navigationGroups, parseLandingMemory, resolveLandingPage, resolveLandingWorkspace, saveLandingMemory
} from '../src/appMode.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
}

describe('landing page resolution', () => {
  it('always lands in the 3D Office once an agent host exists, also right after setup', () => {
    expect(resolveLandingPage({ agents: true })).toBe('office');
  });

  it('keeps Get started where there is no agent host', () => {
    expect(resolveLandingPage({ agents: false })).toBe('start');
  });

  it('ignores a legacy remembered Chat mode', () => {
    const storage = memoryStorage({ [LEGACY_MODE_STORAGE_KEY]: '{"mode":"agent","workspaceId":"w1"}' });
    expect(loadLandingMemory(storage)).toEqual({ workspaceId: 'w1' });
    expect(resolveLandingPage({ agents: true })).toBe('office');
  });
});

describe('chat availability', () => {
  it('has no managed chat in Observe, even with mapped workspaces', () => {
    expect(chatAvailable({ agents: true, workflow: 'observe', hasWorkspaces: false })).toBe(false);
    expect(chatAvailable({ agents: true, workflow: 'observe', hasWorkspaces: true })).toBe(false);
    expect(chatAvailable({ agents: true, workflow: 'managed', hasWorkspaces: false })).toBe(true);
    expect(chatAvailable({ agents: false, workflow: 'managed', hasWorkspaces: true })).toBe(false);
  });
});

describe('navigation by purpose', () => {
  it('keeps primary managed work before collections, activity and system tools', () => {
    expect(navigationGroups({ agents: true, workflow: 'managed', canChat: true })).toEqual([
      { section: 'work', pages: ['office', 'chat', 'missions', 'observe', 'files', 'git'] },
      { section: 'library', pages: ['knowledge', 'skills'] },
      { section: 'activity', pages: ['history', 'import', 'logs'] },
      { section: 'app', pages: ['settings', 'diagnostics'] },
    ]);
  });

  it('keeps Observe focused regardless of mapped workspaces', () => {
    expect(navigationGroups({ agents: true, workflow: 'observe', canChat: true })[0]).toEqual({
      section: 'work', pages: ['office', 'observe'],
    });
    expect(navigationGroups({ agents: true, workflow: 'observe', canChat: false })[0]).toEqual({
      section: 'work', pages: ['office', 'observe'],
    });
    expect(navigationGroups({ agents: true, workflow: 'managed', canChat: false })[0]).toEqual({
      section: 'work', pages: ['office', 'chat', 'observe'],
    });
  });

  it('keeps only valid static-host pages without an empty library section', () => {
    expect(navigationGroups({ agents: false, workflow: 'managed', canChat: false })).toEqual([
      { section: 'work', pages: ['office', 'start'] },
      { section: 'activity', pages: ['logs'] },
      { section: 'app', pages: ['settings', 'diagnostics'] },
    ]);
  });

  it('never duplicates pages or emits empty groups across capability combinations', () => {
    for (const agents of [true, false]) for (const workflow of ['managed', 'observe'] as const) for (const canChat of [true, false]) {
      const groups = navigationGroups({ agents, workflow, canChat });
      const pages = groups.flatMap(group => group.pages);
      expect(groups.every(group => group.pages.length > 0)).toBe(true);
      expect(new Set(pages).size).toBe(pages.length);
      expect(pages).toContain(resolveLandingPage({ agents }));
      if (agents) {
        for (const id of ['knowledge', 'skills', 'chat']) expect(pages.includes(id as typeof pages[number])).toBe(workflow === 'managed');
        expect(pages).not.toContain('start');
      } else expect(pages.sort()).toEqual(['diagnostics', 'logs', 'office', 'settings', 'start']);
      for (const page of ['missions', 'files', 'git'] as const) expect(pages.includes(page)).toBe(agents && workflow === 'managed' && canChat);
    }
  });
});

describe('landing workspace', () => {
  const workspaces = [{ id: 'a' }, { id: 'b' }];
  it('uses the remembered workspace only while it exists', () => {
    expect(resolveLandingWorkspace(workspaces, 'b')).toBe('b');
    expect(resolveLandingWorkspace(workspaces, 'gone')).toBeUndefined();
    expect(resolveLandingWorkspace(workspaces, undefined)).toBeUndefined();
    expect(resolveLandingWorkspace([], 'a')).toBeUndefined();
  });
});

describe('landing memory', () => {
  it('tolerates missing or damaged data', () => {
    expect(parseLandingMemory(null)).toEqual({});
    expect(parseLandingMemory('not json')).toEqual({});
    expect(parseLandingMemory('42')).toEqual({});
    expect(parseLandingMemory('{"mode":"office","workspaceId":7}')).toEqual({});
    expect(parseLandingMemory('{"mode":"office","workspaceId":"w1"}')).toEqual({ workspaceId: 'w1' });
  });

  it('migrates the legacy mode record once, keeping the workspace and other preferences', () => {
    const storage = memoryStorage({ [LEGACY_MODE_STORAGE_KEY]: '{"mode":"office","workspaceId":"w1"}', 'extalia.ui.v1': '{"state":{"theme":"dark"}}' });
    expect(loadLandingMemory(storage)).toEqual({ workspaceId: 'w1' });
    expect(storage.data.has(LEGACY_MODE_STORAGE_KEY)).toBe(false);
    expect(JSON.parse(storage.data.get(LANDING_STORAGE_KEY)!)).toEqual({ workspaceId: 'w1' });
    expect(storage.data.get('extalia.ui.v1')).toBe('{"state":{"theme":"dark"}}');
    // The current record wins over a legacy record written by an older build later.
    storage.data.set(LEGACY_MODE_STORAGE_KEY, '{"mode":"agent","workspaceId":"old"}');
    expect(loadLandingMemory(storage)).toEqual({ workspaceId: 'w1' });
  });

  it('round-trips and survives a throwing storage', () => {
    const storage = memoryStorage();
    expect(loadLandingMemory(storage)).toEqual({});
    saveLandingMemory({ workspaceId: 'w2' }, storage);
    expect(loadLandingMemory(storage)).toEqual({ workspaceId: 'w2' });

    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(loadLandingMemory(blocked)).toEqual({});
    expect(() => saveLandingMemory({ workspaceId: 'w' }, blocked)).not.toThrow();
  });
});
