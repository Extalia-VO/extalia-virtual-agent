import { isDaytime } from '../environment/solarTime';
import { loadPreferences, type ThemePreference } from '../preferences';

/** Cached resolved theme, read by `public/boot-appearance.js` before any module runs. */
export const RESOLVED_THEME_KEY = 'extalia.ui.resolved-theme';

export function resolveTheme(theme: ThemePreference, systemDark: boolean, daytime: () => boolean): 'dark' | 'light' {
  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  if (theme === 'solar') return daytime() ? 'light' : 'dark';
  return systemDark ? 'dark' : 'light';
}

/** Remember the resolved theme so the next launch paints its first frame in it. */
export function rememberResolvedTheme(theme: 'dark' | 'light'): void {
  try { localStorage.setItem(RESOLVED_THEME_KEY, theme); } catch { /* Storage blocked */ }
}

/**
 * Apply the stored theme, material and font to <html> synchronously, before React
 * renders anything, so neither the Splash nor the first app frame flashes the
 * default theme. The App's own effects then see the same values and do nothing.
 */
export function applyInitialAppearance(): void {
  const preferences = loadPreferences();
  const root = document.documentElement;
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = resolveTheme(preferences.theme, systemDark, () => isDaytime());
  root.dataset.theme = theme;
  root.dataset.material = preferences.material;
  root.dataset.font = preferences.font;
  root.lang = preferences.language;
  rememberResolvedTheme(theme);
}
