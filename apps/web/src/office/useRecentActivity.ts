import type { ExtaliaEvent } from '@extalia/protocol';
import { useEffect, useRef, useState } from 'react';
import { newActivities, type OfficeActivity } from './activityFeed';

/**
 * The latest live activities (at most 50) for character bubbles, screens and the lead bar.
 * Events already present when the Office opens are history and are left out.
 */
export function useRecentActivity(events: readonly ExtaliaEvent[]): readonly OfficeActivity[] {
  const seen = useRef(new Set<string>());
  // History arrives after mount, so "new" means newer than the Office (with slack for clock rounding).
  const [openedAt] = useState(() => Date.now() - 2_000);
  const [recent, setRecent] = useState<OfficeActivity[]>([]);
  useEffect(() => {
    const fresh = newActivities(events, seen.current).filter(activity => Date.parse(activity.at) >= openedAt);
    for (const event of events) seen.current.add(event.id);
    if (fresh.length) setRecent(current => [...current, ...fresh].slice(-50));
  }, [events, openedAt]);
  return recent;
}
