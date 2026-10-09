/**
 * Solar cycle calculation for automatic day/night theme transitions.
 * Calculates sunrise and sunset times based on geographic coordinates or device time.
 */

export interface SolarLocation {
  readonly latitude: number;
  readonly longitude: number;
}

// Default reference: Banda Aceh, Indonesia (+7 WIB)
export const DEFAULT_SOLAR_LOCATION: SolarLocation = {
  latitude: 5.5483,
  longitude: 95.3238
};

/**
 * Calculates whether the sun is currently above the horizon (daytime).
 * Uses standard solar zenith angle formula with approximate equation of time.
 */
export function isDaytime(date = new Date(), location = DEFAULT_SOLAR_LOCATION): boolean {
  const startOfYear = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - startOfYear.getTime();
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));

  // Fractional year in radians
  const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + (date.getHours() - 12) / 24);

  // Equation of time in minutes
  const eqtime = 229.18 * (
    0.000075 +
    0.001868 * Math.cos(gamma) -
    0.032077 * Math.sin(gamma) -
    0.014615 * Math.cos(2 * gamma) -
    0.040849 * Math.sin(2 * gamma)
  );

  // Solar declination in radians
  const decl = 0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  // Local time in minutes from midnight
  const timeOffset = eqtime + 4 * location.longitude - 60 * (-date.getTimezoneOffset() / 60);
  const trueSolarTime = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60 + timeOffset;

  // Solar hour angle in degrees
  let hourAngle = trueSolarTime / 4 - 180;
  if (hourAngle < -180) hourAngle += 360;

  const latRad = location.latitude * (Math.PI / 180);
  const haRad = hourAngle * (Math.PI / 180);

  // Solar elevation angle in radians (sin(elevation))
  const sinElevation = Math.sin(latRad) * Math.sin(decl) + Math.cos(latRad) * Math.cos(decl) * Math.cos(haRad);

  // Sun elevation > -0.833° (civil dawn/dusk threshold) is considered daylight
  return sinElevation > -0.0145;
}
