import { createContext, useContext, useMemo, type ReactNode } from 'react';

const defaults = { reducedMotion: false, state: { factors: { exteriorLightFactor: 0, interiorLightFactor: 0.3, daylightFactor: 1, nightFactor: 0, twilightFactor: 0 }, position: { sunDirection: [0.4, 0.8, -0.3] as [number, number, number], elevation: 45 } } };
const Environment = createContext(defaults);
/** Renderer lighting follows the shared app theme; no location or external requests. */
export function SceneEnvironment({ dark, reducedMotion, children }: { dark: boolean; reducedMotion: boolean; children: ReactNode }) {
  const value = useMemo(() => ({ reducedMotion, state: { factors: { exteriorLightFactor: dark ? 1 : 0, interiorLightFactor: dark ? 1 : 0.3, daylightFactor: dark ? 0 : 1, nightFactor: dark ? 1 : 0, twilightFactor: 0 }, position: { sunDirection: [0.4, 0.8, -0.3] as [number, number, number], elevation: dark ? -15 : 45 } } }), [dark, reducedMotion]);
  return <Environment.Provider value={value}>{children}</Environment.Provider>;
}
export const useSolarEnvironment = () => useContext(Environment);
