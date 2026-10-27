import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Language } from './i18n';

export const THEMES = ['system', 'solar', 'light', 'dark'] as const;
/** Surface styles; the value is applied verbatim as `<html data-material>`. */
export const MATERIALS = ['standard', 'liquid-glass', 'liquid-glass-pro'] as const;
export const SIDEBARS = ['expanded', 'compact'] as const;
export const FONTS = ['sf-pro', 'quicksand', 'geist', 'jakarta', 'inter'] as const;
const LANGUAGE_IDS = ['en', 'id'] as const satisfies readonly Language[];

export type ThemePreference = typeof THEMES[number];
export type MaterialPreference = typeof MATERIALS[number];
export type SidebarPreference = typeof SIDEBARS[number];
export type FontPreference = typeof FONTS[number];

export interface Preferences {
  theme: ThemePreference;
  /** Surface style, independent of light/dark. */
  material: MaterialPreference;
  language: Language;
  sidebar: SidebarPreference;
  font: FontPreference;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'solar',
  material: 'liquid-glass',
  language: 'en',
  sidebar: 'expanded',
  font: 'quicksand'
};

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

/**
 * Decode stored preferences field by field. Unknown, missing or malformed
 * values (an older or newer build, a hand-edited store) fall back to the
 * defaults instead of reaching the DOM.
 */
export function decodePreferences(raw: unknown): Preferences {
  const value = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    theme: pick(THEMES, value.theme, DEFAULT_PREFERENCES.theme),
    material: pick(MATERIALS, value.material, DEFAULT_PREFERENCES.material),
    language: pick(LANGUAGE_IDS, value.language, DEFAULT_PREFERENCES.language),
    sidebar: pick(SIDEBARS, value.sidebar, DEFAULT_PREFERENCES.sidebar),
    font: pick(FONTS, value.font, DEFAULT_PREFERENCES.font)
  };
}

interface PreferencesState extends Preferences {
  setTheme: (theme: ThemePreference) => void;
  setMaterial: (material: MaterialPreference) => void;
  setLanguage: (language: Language) => void;
  setSidebar: (sidebar: SidebarPreference) => void;
  setFont: (font: FontPreference) => void;
  updatePreferences: (next: Partial<Preferences>) => void;
}

const safeStorage = {
  getItem: (key: string): string | null => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  },
  setItem: (key: string, value: string): void => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    } catch {
      /* Quota or private mode */
    }
  },
  removeItem: (key: string): void => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
    } catch {
      /* Ignore */
    }
  }
};

/**
 * Global Zustand Store for UI Preferences.
 * Automatically persists to localStorage across Web & Electron desktop sessions.
 */
export const usePreferencesStore = create<PreferencesState>()(
  persist(
    set => ({
      ...DEFAULT_PREFERENCES,
      setTheme: theme => set({ theme }),
      setMaterial: material => set({ material }),
      setLanguage: language => set({ language }),
      setSidebar: sidebar => set({ sidebar }),
      setFont: font => set({ font }),
      updatePreferences: next => set(state => ({ ...state, ...next }))
    }),
    {
      name: 'extalia.ui.v1',
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      partialize: state => decodePreferences(state),
      // Version 1 stores gained 'liquid-glass-pro'; decoding keeps old stores valid and rejects unknown values.
      migrate: persisted => decodePreferences(persisted),
      merge: (persisted, current) => ({ ...current, ...decodePreferences(persisted) })
    }
  )
);

/** Per-device interface preferences. Compatible with existing synchronous calls. */
export function loadPreferences(): Preferences {
  const state = usePreferencesStore.getState();
  return {
    theme: state.theme,
    material: state.material,
    language: state.language,
    sidebar: state.sidebar,
    font: state.font
  };
}

export function savePreferences(preferences: Preferences): void {
  usePreferencesStore.getState().updatePreferences(decodePreferences(preferences));
}
