import { QA_HOOKS } from './qaHooks';
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { deviceSolarLocation } from '../../environment/deviceLocation';
import type { LightOverride } from './environment/lightOverride';
import { computeSceneEnvironment, sceneEnvironmentKey, type SceneEnvironmentState, type SceneSky } from './environment/sceneEnvironment';

/**
 * Interior lights: `auto` follows the time of day (on after dusk), `on`/`off` are the user's override.
 * `lightsOn` is the resolved state every fixture, window and screen glow reads; `state.factors`
 * carries the matching levels (night Off is zero; daylight fill remains available).
 */
export type { LightOverride } from './environment/lightOverride';
export type { SceneFactors, SceneSky } from './environment/sceneEnvironment';

export interface SolarEnvironmentValue extends SceneEnvironmentState {
  reducedMotion: boolean;
}

const fallback: SolarEnvironmentValue = {
  reducedMotion: false,
  ...computeSceneEnvironment({ sky: 'day', epochMs: 0, location: { latitude: 0, longitude: 0 }, lightOverride: 'auto' }),
};
const Environment = createContext<SolarEnvironmentValue>(fallback);

/* Development-only time preview for visual QA (`__EXTALIA_SOLAR_PREVIEW__(minutes | null)`). */
let previewMinutes: number | null = null;
const previewListeners = new Set<() => void>();
const subscribePreview = (listener: () => void) => { previewListeners.add(listener); return () => { previewListeners.delete(listener); }; };
const getPreview = () => previewMinutes;
/** Local wall-clock minute the scene shows (the development time preview, else this device's clock). */
export function sceneLocalMinutes(now = new Date()): number { return previewMinutes ?? now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60; }
let latest: SolarEnvironmentValue = fallback;
type QaWindow = Window & { __EXTALIA_SOLAR_PREVIEW__?: (minutes: number | null) => void; __EXTALIA_ENV_STATE__?: () => unknown };
if (QA_HOOKS && typeof window !== 'undefined') {
  (window as QaWindow).__EXTALIA_SOLAR_PREVIEW__ = minutes => {
    previewMinutes = minutes === null || !Number.isFinite(minutes) ? null : ((minutes % 1440) + 1440) % 1440;
    previewListeners.forEach(listener => listener());
  };
  (window as QaWindow).__EXTALIA_ENV_STATE__ = () => ({ lightOverride: latest.lightOverride, lightsOn: latest.lightsOn, ...latest.state });
}
/** Today's local wall-clock minute on this device. */
function localEpoch(minutes: number): number {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime() + minutes * 60_000;
}

/**
 * Daylight and lights for the Office. With `followSun` (the "Solar" app theme) the scene
 * follows the real sun for this device's time zone (no location prompt, no network; see
 * `environment/deviceLocation.ts`); otherwise the forced light/dark theme shows day or night.
 */
export function SceneEnvironment({ dark, reducedMotion, lightOverride = 'auto', followSun = false, children }: {
  dark: boolean; reducedMotion: boolean; lightOverride?: LightOverride; followSun?: boolean; children: ReactNode;
}) {
  const preview = useSyncExternalStore(subscribePreview, getPreview, getPreview);
  const sky: SceneSky = preview !== null || followSun ? 'sun' : dark ? 'night' : 'day';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (sky !== 'sun' || preview !== null) return;
    const tick = () => setNow(Date.now());
    tick();
    const interval = window.setInterval(tick, 30_000);
    // A device waking from sleep jumps straight to the current light.
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', tick); };
  }, [sky, preview]);
  const location = useMemo(() => deviceSolarLocation(), []);
  const computed = computeSceneEnvironment({ sky, epochMs: preview !== null ? localEpoch(preview) : now, location, lightOverride });
  const key = sceneEnvironmentKey(computed);
  // The key captures every visible change, so a ticking clock re-renders consumers only when the light moves.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo<SolarEnvironmentValue>(() => ({ reducedMotion, ...computed }), [key, reducedMotion]);
  useEffect(() => { latest = value; }, [value]);
  return <Environment.Provider value={value}>{children}</Environment.Provider>;
}

export const useSolarEnvironment = () => useContext(Environment);
