import { afterEach, describe, expect, it } from 'vitest';
import type { PageId } from '../src/i18n.js';
import { groupFocusTarget, OFFICE_VIEWS, showsOfficeControls, useOfficeControls } from '../src/office/officeControls.js';
import { LIGHT_OVERRIDE_STORAGE_KEY } from '../src/office/scene/environment/lightOverride.js';

const PAGES: PageId[] = ['office', 'chat', 'observe', 'files', 'git', 'history', 'import', 'logs', 'start', 'diagnostics', 'settings'];

describe('top bar office controls', () => {
  it('appear on the 3D Office only', () => {
    expect(PAGES.filter(showsOfficeControls)).toEqual(['office']);
  });

  it('offer Campus, the three floors and All floors in order', () => {
    expect(OFFICE_VIEWS).toEqual(['campus', 1, 2, 3, 'stack']);
  });

  it('move focus with arrows, Home and End, wrapping at the ends', () => {
    expect(groupFocusTarget('ArrowRight', 0, 5)).toBe(1);
    expect(groupFocusTarget('ArrowRight', 4, 5)).toBe(0);
    expect(groupFocusTarget('ArrowLeft', 0, 5)).toBe(4);
    expect(groupFocusTarget('ArrowDown', 1, 3)).toBe(2);
    expect(groupFocusTarget('ArrowUp', 1, 3)).toBe(0);
    expect(groupFocusTarget('Home', 3, 5)).toBe(0);
    expect(groupFocusTarget('End', 0, 5)).toBe(4);
    expect(groupFocusTarget('Enter', 0, 5)).toBeUndefined();
    expect(groupFocusTarget('ArrowRight', 0, 0)).toBeUndefined();
  });
});

describe('office controls store', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage');
    useOfficeControls.setState({ view: 'campus', viewRequest: 0, lightOverride: 'auto' });
  });

  it('is the single source for the floor view', () => {
    useOfficeControls.getState().setView(2);
    expect(useOfficeControls.getState().view).toBe(2);
    useOfficeControls.getState().setView('stack');
    expect(useOfficeControls.getState().view).toBe('stack');
  });

  it('distinguishes automatic followed floors from explicit requests, including the same floor', () => {
    const controls = useOfficeControls.getState();
    const initial = controls.viewRequest;
    controls.followFloor(2);
    expect(useOfficeControls.getState().view).toBe(2);
    expect(useOfficeControls.getState().viewRequest).toBe(initial);
    controls.followFloor(3);
    expect(useOfficeControls.getState().view).toBe(3);
    expect(useOfficeControls.getState().viewRequest).toBe(initial);
    controls.setView(3);
    expect(useOfficeControls.getState().viewRequest).toBe(initial + 1);
    controls.setView('campus');
    expect(useOfficeControls.getState().viewRequest).toBe(initial + 2);
  });

  it('remembers the light choice through the existing light storage', () => {
    const data = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } } });
    useOfficeControls.getState().setLightOverride('off');
    expect(useOfficeControls.getState().lightOverride).toBe('off');
    expect(data.get(LIGHT_OVERRIDE_STORAGE_KEY)).toBe('off');
    useOfficeControls.getState().setLightOverride('auto');
    expect(data.has(LIGHT_OVERRIDE_STORAGE_KEY)).toBe(false);
  });
});
