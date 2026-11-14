import type { SessionBrowserQuery } from '@extalia/platform';

/** Explicit user filters reset the data page; changing live attention does not. */
export const sessionBrowserFilterKey = (filters: SessionBrowserQuery): string =>
  JSON.stringify([filters.collection, filters.query ?? '', filters.status, filters.state]);

/** In-memory presentation state only; owned by one host/profile/collection view. */
export class SessionBrowserExpansion {
  private readonly values = new Map<string, boolean>();
  constructor(private readonly capacity = 1024) {}

  private put(key: string, value: boolean): boolean {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.capacity) this.values.delete(this.values.keys().next().value!);
    return value;
  }

  read(key: string, fallback: boolean, defaultSlot?: string): boolean {
    const saved = this.values.get(key);
    if (saved !== undefined) return this.put(key, saved);
    // A newly promoted first sibling must not take over the first-open default
    // after the user has already browsed this parent.
    const available = !defaultSlot || !this.values.has(defaultSlot);
    if (fallback && defaultSlot) this.put(defaultSlot, true);
    return this.put(key, fallback && available);
  }

  set(key: string, open: boolean): void { this.put(key, open); }
}

export const sessionBrowserNodeKey = (...parts: string[]): string => JSON.stringify(parts);

/** Refresh the user-loaded window atomically; each request stays host-page bounded. */
export async function readSessionBrowserWindow<T>({ cursor, count, pageSize, current, fetchPage }: {
  cursor?: string; count: number; pageSize: number; current: () => boolean;
  fetchPage: (limit: number, cursor?: string) => Promise<{ items: T[]; nextCursor?: string; total?: number }>;
}): Promise<{ items: T[]; cursor?: string; total?: number } | undefined> {
  const items: T[] = [];
  let next = cursor, total: number | undefined;
  const target = cursor ? pageSize : Math.max(pageSize, count);
  do {
    if (!current()) return undefined;
    const page = await fetchPage(Math.min(100, target - items.length), next);
    if (!current()) return undefined;
    total ??= page.total;
    items.push(...page.items);
    next = page.nextCursor;
    if (!page.items.length) break;
  } while (items.length < target && next);
  return { items, cursor: next, total };
}
