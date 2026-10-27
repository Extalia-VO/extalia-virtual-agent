import type { SolarLocation } from './solarMath';

/**
 * Where the sun is computed for, without asking for location or calling a service.
 *
 * The device's IANA time zone picks a representative point: the zone's namesake city
 * from the table below (Asia/Jakarta keeps the project's existing WIB reference point).
 * Any other zone uses longitude = 15° × its standard UTC offset (so solar noon falls near
 * 12:00 standard time) and a typical latitude for its region. Without a zone: 0°, 0°.
 */
export interface DeviceSolarLocation extends SolarLocation {
  readonly timeZone: string;
  readonly source: 'zone' | 'estimate';
}

const ZONES: Readonly<Record<string, readonly [number, number]>> = {
  'Asia/Jakarta': [5.5483, 95.3238], 'Asia/Pontianak': [-0.03, 109.34], 'Asia/Makassar': [-5.14, 119.42],
  'Asia/Jayapura': [-2.53, 140.72], 'Asia/Singapore': [1.35, 103.82], 'Asia/Kuala_Lumpur': [3.14, 101.69],
  'Asia/Bangkok': [13.75, 100.5], 'Asia/Ho_Chi_Minh': [10.82, 106.63], 'Asia/Saigon': [10.82, 106.63],
  'Asia/Manila': [14.6, 120.98], 'Asia/Shanghai': [31.23, 121.47], 'Asia/Hong_Kong': [22.32, 114.17],
  'Asia/Taipei': [25.03, 121.57], 'Asia/Tokyo': [35.68, 139.69], 'Asia/Seoul': [37.57, 126.98],
  'Asia/Kolkata': [28.61, 77.21], 'Asia/Calcutta': [28.61, 77.21], 'Asia/Dhaka': [23.81, 90.41],
  'Asia/Karachi': [24.86, 67.0], 'Asia/Dubai': [25.2, 55.27], 'Asia/Riyadh': [24.71, 46.68],
  'Europe/London': [51.51, -0.13], 'Europe/Dublin': [53.35, -6.26], 'Europe/Lisbon': [38.72, -9.14],
  'Europe/Madrid': [40.42, -3.7], 'Europe/Paris': [48.86, 2.35], 'Europe/Amsterdam': [52.37, 4.9],
  'Europe/Brussels': [50.85, 4.35], 'Europe/Berlin': [52.52, 13.4], 'Europe/Rome': [41.9, 12.5],
  'Europe/Stockholm': [59.33, 18.07], 'Europe/Warsaw': [52.23, 21.01], 'Europe/Istanbul': [41.01, 28.98],
  'Europe/Moscow': [55.76, 37.62], 'Africa/Cairo': [30.04, 31.24], 'Africa/Lagos': [6.52, 3.38],
  'Africa/Nairobi': [-1.29, 36.82], 'Africa/Johannesburg': [-26.2, 28.05],
  'America/New_York': [40.71, -74.01], 'America/Toronto': [43.65, -79.38], 'America/Chicago': [41.88, -87.63],
  'America/Denver': [39.74, -104.99], 'America/Phoenix': [33.45, -112.07], 'America/Los_Angeles': [34.05, -118.24],
  'America/Vancouver': [49.28, -123.12], 'America/Mexico_City': [19.43, -99.13], 'America/Bogota': [4.71, -74.07],
  'America/Lima': [-12.05, -77.04], 'America/Santiago': [-33.45, -70.67], 'America/Sao_Paulo': [-23.55, -46.63],
  'America/Argentina/Buenos_Aires': [-34.6, -58.38], 'America/Buenos_Aires': [-34.6, -58.38],
  'Australia/Perth': [-31.95, 115.86], 'Australia/Adelaide': [-34.93, 138.6], 'Australia/Brisbane': [-27.47, 153.03],
  'Australia/Sydney': [-33.87, 151.21], 'Australia/Melbourne': [-37.81, 144.96], 'Pacific/Auckland': [-36.85, 174.76],
  'Pacific/Honolulu': [21.31, -157.86],
};

const REGION_LATITUDE: Readonly<Record<string, number>> = {
  Europe: 50, America: 35, Asia: 25, Africa: 5, Australia: -30, Pacific: -15, Atlantic: 35, Indian: -10,
  Antarctica: -70, Arctic: 75,
};

/** UTC offset in minutes at an instant, read through Intl; undefined for an unknown zone. */
export function zoneOffsetMinutes(timeZone: string, epochMs: number): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(epochMs);
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === type)?.value);
    const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
    return Math.round((wall - Math.floor(epochMs / 60_000) * 60_000) / 60_000);
  } catch {
    return undefined;
  }
}

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Representative solar location for a time zone (see the module comment). */
export function solarLocationForZone(timeZone: string, epochMs = Date.now()): DeviceSolarLocation {
  const known = ZONES[timeZone];
  if (known) return { latitude: known[0], longitude: known[1], timeZone, source: 'zone' };
  const year = new Date(epochMs).getUTCFullYear();
  // Standard time is the smaller of the January and July offsets (daylight saving adds to it).
  const offsets = [Date.UTC(year, 0, 15), Date.UTC(year, 6, 15)].map(at => zoneOffsetMinutes(timeZone, at));
  const standard = offsets.every(value => value !== undefined) ? Math.min(...(offsets as number[])) : 0;
  const longitude = Math.max(-180, Math.min(180, standard / 4));
  const latitude = REGION_LATITUDE[timeZone.split('/')[0] ?? ''] ?? 0;
  return { latitude, longitude, timeZone, source: 'estimate' };
}

/** The solar location for this device's time zone. */
export function deviceSolarLocation(epochMs = Date.now()): DeviceSolarLocation {
  return solarLocationForZone(deviceTimeZone(), epochMs);
}
