import type { OfficeActivity } from '../activityFeed';

/** The board shows this many of the latest activities. */
export const BOARD_LIMIT = 50;

/**
 * The latest activities across `sources` (history from loaded events, live
 * items), newest first, one entry per event id, for characters in `known` only.
 */
export function boardActivities(sources: readonly (readonly OfficeActivity[])[], known: ReadonlySet<string>, limit = BOARD_LIMIT): OfficeActivity[] {
  const byId = new Map<string, OfficeActivity>();
  for (const source of sources) for (const activity of source) if (known.has(activity.characterId)) byId.set(activity.id, activity);
  return [...byId.values()]
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

export type AgoUnit = 'now' | 'seconds' | 'minutes' | 'hours' | 'days';
export interface Ago { unit: AgoUnit; value: number }

/** How long before `now` an activity happened, in the largest whole unit. */
export function timeAgo(at: string, now: number): Ago {
  const seconds = Math.floor((now - Date.parse(at)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 5) return { unit: 'now', value: 0 };
  if (seconds < 60) return { unit: 'seconds', value: seconds };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { unit: 'minutes', value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: 'hours', value: hours };
  return { unit: 'days', value: Math.floor(hours / 24) };
}

export interface AgoText {
  now: string;
  seconds(value: number): string;
  minutes(value: number): string;
  hours(value: number): string;
  days(value: number): string;
}

export function formatAgo(text: AgoText, ago: Ago): string {
  return ago.unit === 'now' ? text.now : text[ago.unit](ago.value);
}
