import { describe, expect, it } from 'vitest';
import { resolveTheme } from '../src/boot/appearance.js';
import { BOOT_CONFIG_VERSION, resolveBootState, SPLASH_MIN_MS, splashHoldMs } from '../src/boot/bootState.js';

const host = (setupComplete: boolean, sessions = 0) => ({ setupComplete, sessions: Array.from({ length: sessions }, (_, index) => index) });

describe('boot state', () => {
  it('is loading until the host answers, without claiming sessions', () => {
    const state = resolveBootState({ agents: true, host: null, error: null, timedOut: false });
    expect(state).toEqual({ phase: 'loading', configVersion: BOOT_CONFIG_VERSION, hostReady: false, setupComplete: false });
    expect(state.restoredSessionCount).toBeUndefined();
  });

  it('requires setup on a first run and is ready once setup is complete', () => {
    expect(resolveBootState({ agents: true, host: host(false), error: null, timedOut: false })).toMatchObject({ phase: 'setup-required', hostReady: true, setupComplete: false, restoredSessionCount: 0 });
    expect(resolveBootState({ agents: true, host: host(true, 3), error: null, timedOut: false })).toMatchObject({ phase: 'ready', hostReady: true, setupComplete: true, restoredSessionCount: 3 });
  });

  it('turns a host failure or a timeout into a recoverable error', () => {
    expect(resolveBootState({ agents: true, host: null, error: 'connection refused', timedOut: false })).toMatchObject({
      phase: 'recoverable-error', error: { category: 'host-unreachable', recoverable: true, message: 'connection refused' },
    });
    expect(resolveBootState({ agents: true, host: null, error: null, timedOut: true })).toMatchObject({ phase: 'recoverable-error', error: { category: 'timeout', recoverable: true } });
  });

  it('lets a late host answer win over an earlier timeout or error', () => {
    expect(resolveBootState({ agents: true, host: host(true), error: 'stale', timedOut: true }).phase).toBe('ready');
    expect(resolveBootState({ agents: true, host: host(false), error: null, timedOut: true }).phase).toBe('setup-required');
  });

  it('is ready at once without an agent host (Get started)', () => {
    expect(resolveBootState({ agents: false, host: null, error: null, timedOut: false })).toMatchObject({ phase: 'ready', hostReady: false });
  });
});

describe('splash timing', () => {
  it('tops a fast boot up to the minimum and never delays a slow one', () => {
    expect(splashHoldMs('ready', 200)).toBe(SPLASH_MIN_MS - 200);
    expect(splashHoldMs('setup-required', 0)).toBe(SPLASH_MIN_MS);
    expect(splashHoldMs('ready', SPLASH_MIN_MS)).toBe(0);
    expect(splashHoldMs('ready', 4000)).toBe(0);
    expect(splashHoldMs('ready', -5)).toBe(SPLASH_MIN_MS);
  });

  it('has nothing to hold while loading or on errors (the recovery panel shows at once)', () => {
    expect(splashHoldMs('loading', 100)).toBe(0);
    expect(splashHoldMs('recoverable-error', 100)).toBe(0);
  });
});

describe('first-paint theme', () => {
  it('resolves explicit, system and solar themes', () => {
    const never = () => { throw new Error('not consulted'); };
    expect(resolveTheme('dark', false, never)).toBe('dark');
    expect(resolveTheme('light', true, never)).toBe('light');
    expect(resolveTheme('system', true, never)).toBe('dark');
    expect(resolveTheme('system', false, never)).toBe('light');
    expect(resolveTheme('solar', true, () => true)).toBe('light');
    expect(resolveTheme('solar', false, () => false)).toBe('dark');
  });
});
