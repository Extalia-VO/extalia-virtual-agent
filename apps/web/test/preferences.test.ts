import { describe, expect, it } from 'vitest';
import { loadPreferences, savePreferences, decodePreferences, usePreferencesStore, DEFAULT_PREFERENCES, MATERIALS } from '../src/preferences.js';

describe('Preferences storage persistence', () => {
  it('loads valid defaults and allows updates', () => {
    const initial = loadPreferences();
    expect(initial.theme).toBeDefined();
    expect(initial.material).toBeDefined();

    savePreferences({
      theme: 'dark',
      material: 'liquid-glass',
      language: 'id',
      sidebar: 'compact',
      font: 'quicksand'
    });

    const current = loadPreferences();
    expect(current.theme).toBe('dark');
    expect(current.material).toBe('liquid-glass');
    expect(current.language).toBe('id');
    expect(current.sidebar).toBe('compact');
    expect(current.font).toBe('quicksand');
  });

  it('provides safe fallback defaults', () => {
    expect(DEFAULT_PREFERENCES.theme).toBe('solar');
    expect(DEFAULT_PREFERENCES.material).toBe('liquid-glass');
    expect(DEFAULT_PREFERENCES.language).toBe('en');
    expect(DEFAULT_PREFERENCES.sidebar).toBe('expanded');
    expect(DEFAULT_PREFERENCES.font).toBe('quicksand');
  });
});

describe('Preferences decoding and migration', () => {
  it('accepts every surface style, including Liquid Glass Pro', () => {
    for (const material of MATERIALS) expect(decodePreferences({ material }).material).toBe(material);
    expect(MATERIALS).toEqual(['standard', 'liquid-glass', 'liquid-glass-pro']);
  });

  it('falls back field by field for unknown or malformed values', () => {
    expect(decodePreferences({ theme: 'dark', material: 'plasma-webgl', language: 'fr', sidebar: 7, font: null })).toEqual({
      ...DEFAULT_PREFERENCES,
      theme: 'dark'
    });
    expect(decodePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(decodePreferences('liquid-glass-pro')).toEqual(DEFAULT_PREFERENCES);
  });

  it('keeps stores written before Liquid Glass Pro existed (no font field)', () => {
    expect(decodePreferences({ theme: 'light', material: 'standard', language: 'id', sidebar: 'compact' })).toEqual({
      theme: 'light', material: 'standard', language: 'id', sidebar: 'compact', font: DEFAULT_PREFERENCES.font
    });
  });

  it('rehydrates a persisted store and drops unknown values', async () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key) };
    const previous = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    try {
      data.set('extalia.ui.v1', JSON.stringify({ version: 1, state: { theme: 'dark', material: 'liquid-glass-pro', language: 'id', sidebar: 'expanded', font: 'geist' } }));
      await usePreferencesStore.persist.rehydrate();
      expect(loadPreferences()).toEqual({ theme: 'dark', material: 'liquid-glass-pro', language: 'id', sidebar: 'expanded', font: 'geist' });

      data.set('extalia.ui.v1', JSON.stringify({ version: 1, state: { theme: 'neon', material: 'glass-ultra', language: 'en', sidebar: 'compact', font: 'comic' } }));
      await usePreferencesStore.persist.rehydrate();
      expect(loadPreferences()).toEqual({ ...DEFAULT_PREFERENCES, sidebar: 'compact' });

      data.set('extalia.ui.v1', JSON.stringify({ version: 0, state: { material: 'liquid-glass', theme: 'system' } }));
      await usePreferencesStore.persist.rehydrate();
      expect(loadPreferences()).toMatchObject({ material: 'liquid-glass', theme: 'system' });

      savePreferences({ ...DEFAULT_PREFERENCES, material: 'liquid-glass-pro' });
      expect(JSON.parse(data.get('extalia.ui.v1') ?? '{}').state).toEqual({ ...DEFAULT_PREFERENCES, material: 'liquid-glass-pro' });
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = previous;
    }
  });
});
