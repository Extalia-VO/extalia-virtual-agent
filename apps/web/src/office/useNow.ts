import { useEffect, useState } from 'react';

/** Wall-clock milliseconds that refresh every `intervalMs` while `enabled`, so time-based presence rules (liveness) re-evaluate. */
export function useNow(enabled: boolean, intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const first = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [enabled, intervalMs]);
  return now;
}

/** Keeps the previous value while a recomputed one is structurally identical, so clock ticks do not re-render consumers. */
export function useStableValue<T>(value: T): T {
  const [stable, setStable] = useState(value);
  const same = stable === value || JSON.stringify(stable) === JSON.stringify(value);
  if (!same) setStable(value);
  return same ? stable : value;
}
