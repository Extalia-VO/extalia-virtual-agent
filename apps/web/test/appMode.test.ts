import { describe, expect, it } from 'vitest';
import {
  chatAvailable, LANDING_STORAGE_KEY, LEGACY_MODE_STORAGE_KEY, loadLandingMemory, parseLandingMemory, resolveLandingPage, resolveLandingWorkspace, saveLandingMemory
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
  it('has no chat in the observe workflow without workspaces, or without an agent host', () => {
    expect(chatAvailable({ agents: true, workflow: 'observe', hasWorkspaces: false })).toBe(false);
    expect(chatAvailable({ agents: true, workflow: 'observe', hasWorkspaces: true })).toBe(true);
    expect(chatAvailable({ agents: true, workflow: 'managed', hasWorkspaces: false })).toBe(true);
    expect(chatAvailable({ agents: false, workflow: 'managed', hasWorkspaces: true })).toBe(false);
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
