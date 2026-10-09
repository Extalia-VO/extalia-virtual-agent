import type { Language } from './i18n';

export type ThemePreference = 'system' | 'light' | 'dark';
export type MaterialPreference = 'standard' | 'liquid-glass';
export type SidebarPreference = 'expanded' | 'compact';

export interface Preferences {
  theme: ThemePreference;
  /** Surface style, independent of light/dark. */
  material: MaterialPreference;
  language: Language;
  sidebar: SidebarPreference;
}

const KEY = 'extalia.ui.v1';
export const DEFAULT_PREFERENCES: Preferences = { theme: 'system', material: 'standard', language: 'en', sidebar: 'expanded' };

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;

/** Per-device interface preferences. Storage may be unavailable; defaults always work. */
export function loadPreferences(): Preferences {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return DEFAULT_PREFERENCES;
    const value = raw as Record<string, unknown>;
    return {
      theme: pick(value.theme, ['system', 'light', 'dark'], DEFAULT_PREFERENCES.theme),
      material: pick(value.material, ['standard', 'liquid-glass'], DEFAULT_PREFERENCES.material),
      language: pick(value.language, ['en', 'id'], DEFAULT_PREFERENCES.language),
      sidebar: pick(value.sidebar, ['expanded', 'compact'], DEFAULT_PREFERENCES.sidebar),
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(preferences: Preferences): void {
  try { localStorage.setItem(KEY, JSON.stringify(preferences)); }
  catch { /* Private browsing or blocked storage: keep the in-memory choice. */ }
}
