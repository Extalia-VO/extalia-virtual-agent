import { useEffect, useState } from 'react';

/** The current time, refreshed every `intervalMs`, so relative times and rolling windows stay true. */
export function useClock(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
