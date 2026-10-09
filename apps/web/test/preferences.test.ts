import { describe, expect, it } from 'vitest';
import { loadPreferences, savePreferences, DEFAULT_PREFERENCES } from '../src/preferences.js';

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
