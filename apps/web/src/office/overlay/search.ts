import type { StatusTone } from './status';

/** Case- and accent-insensitive text for matching. */
export function normalizeSearch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export interface AgentSearchItem {
  id: string;
  name: string;
  tone: StatusTone;
  /** Localized status text, e.g. "Working…". */
  status: string;
  project?: string | undefined;
  /** Localized current activity, e.g. "Editing". */
  activity?: string | undefined;
  /** What the character reports it is doing (summary or target). */
  detail?: string | undefined;
}
export interface RoomSearchItem {
  id: string;
  label: string;
  /** Shown beside the name, e.g. "Floor 2". */
  meta: string;
  /** Other names to match: the registry label, the room id, floor words. */
  aliases: readonly string[];
}
export interface ActivitySearchItem {
  id: string;
  characterId: string;
  name: string;
  kind: string;
  text: string;
}

export type SearchHit =
  | { kind: 'agent'; id: string; item: AgentSearchItem; score: number }
  | { kind: 'room'; id: string; item: RoomSearchItem; score: number }
  | { kind: 'activity'; id: string; item: ActivitySearchItem; score: number };

export interface SearchLimits { agents: number; rooms: number; activity: number }
export const DEFAULT_SEARCH_LIMITS: SearchLimits = { agents: 6, rooms: 5, activity: 4 };

/**
 * How well `query` matches a primary name and other text. Every word of the
 * query must appear in the text; a match at the start of the name ranks best.
 * Zero means no match.
 */
export function matchScore(query: string, name: string, extra: readonly string[] = []): number {
  const words = normalizeSearch(query).split(' ').filter(Boolean);
  if (!words.length) return 0;
  const primary = normalizeSearch(name);
  const haystack = [primary, ...extra.map(normalizeSearch)].join(' ');
  if (!words.every(word => haystack.includes(word))) return 0;
  const phrase = words.join(' ');
  if (primary === phrase) return 100;
  if (primary.startsWith(phrase)) return 80;
  if (words.every(word => primary.split(/[\s\-_./:·,()]+/).some(part => part.startsWith(word)))) return 60;
  if (primary.includes(phrase)) return 50;
  return words.every(word => primary.includes(word)) ? 40 : 20;
}

/**
 * Agents, rooms and recent activity matching `query`, grouped in that order
 * and best match first within each group. An empty query matches nothing.
 */
export function searchOffice(
  query: string,
  source: { agents: readonly AgentSearchItem[]; rooms: readonly RoomSearchItem[]; activity: readonly ActivitySearchItem[] },
  limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
): SearchHit[] {
  if (!normalizeSearch(query)) return [];
  const best = <T extends SearchHit>(hits: T[], limit: number) => hits.filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score).slice(0, limit);
  const agents = best(source.agents.map(item => ({
    kind: 'agent' as const, id: item.id, item,
    score: matchScore(query, item.name, [item.status, item.project ?? '', item.activity ?? '', item.detail ?? '']),
  })), limits.agents);
  const rooms = best(source.rooms.map(item => ({
    kind: 'room' as const, id: item.id, item, score: matchScore(query, item.label, item.aliases),
  })), limits.rooms);
  // Recent activity ranks by recency (the caller passes newest first), not by text.
  const activity = source.activity.map(item => ({
    kind: 'activity' as const, id: item.id, item, score: matchScore(query, item.text, [item.name, item.kind]),
  })).filter(hit => hit.score > 0).slice(0, limits.activity);
  return [...agents, ...rooms, ...activity];
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** `/` jumps to the search box unless the user is typing, holds a modifier or a dialog is open. */
export function isSearchShortcut(event: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; target: unknown }, modalOpen: boolean): boolean {
  if (event.key !== '/' || event.altKey || event.ctrlKey || event.metaKey || modalOpen) return false;
  const target = event.target as { tagName?: string; isContentEditable?: boolean } | null;
  return !(target && (target.isContentEditable || (target.tagName !== undefined && TYPING_TAGS.has(target.tagName))));
}

/** The result after `current` when moving by `step` (wraps around); 0 when there are no results. */
export function moveActive(current: number, step: 1 | -1, count: number): number {
  if (count <= 0) return 0;
  return (Math.min(current, count - 1) + step + count) % count;
}
