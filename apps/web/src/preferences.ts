import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Language } from './i18n';

export type ThemePreference = 'system' | 'solar' | 'light' | 'dark';
export type MaterialPreference = 'standard' | 'liquid-glass';
export type SidebarPreference = 'expanded' | 'compact';

export interface Preferences {
  theme: ThemePreference;
  /** Surface style, independent of light/dark. */
  material: MaterialPreference;
  language: Language;
  sidebar: SidebarPreference;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'solar',
  material: 'standard',
  language: 'en',
  sidebar: 'expanded'
};

interface PreferencesState extends Preferences {
  setTheme: (theme: ThemePreference) => void;
  setMaterial: (material: MaterialPreference) => void;
  setLanguage: (language: Language) => void;
  setSidebar: (sidebar: SidebarPreference) => void;
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
      updatePreferences: next => set(state => ({ ...state, ...next }))
    }),
    {
      name: 'extalia.ui.v1',
      version: 1,
      storage: createJSONStorage(() => safeStorage)
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
    sidebar: state.sidebar
  };
}

export function savePreferences(preferences: Preferences): void {
  usePreferencesStore.getState().updatePreferences(preferences);
}
