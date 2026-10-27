/** Day/night decision for the "Solar" app theme. */
import { deviceSolarLocation } from './deviceLocation';
import { solarPosition, SUNRISE_ELEVATION, type SolarLocation } from './solarMath';

export type { SolarLocation } from './solarMath';

/**
 * Whether the sun's upper limb is above the horizon (refraction included). The default
 * location comes from the device time zone (see `deviceLocation.ts`), the same point the
 * Office scene lights itself for, so the Solar theme and the scene agree on sunset.
 */
export function isDaytime(date = new Date(), location: SolarLocation = deviceSolarLocation(date.getTime())): boolean {
  return solarPosition(date.getTime(), location).elevation > SUNRISE_ELEVATION;
}
