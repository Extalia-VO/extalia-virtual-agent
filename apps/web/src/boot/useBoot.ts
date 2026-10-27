import { useCallback, useEffect, useState } from 'react';
import type { HostController } from '../host/useHostState';
import { BOOT_TIMEOUT_MS, resolveBootState, splashHoldMs, type BootState } from './bootState';

/** Time since the page started loading, so the Splash minimum counts from launch, not from React. */
const sinceLaunch = () => (typeof performance !== 'undefined' ? performance.now() : 0);

/**
 * Boot coordinator: derives the boot phase from the host controller, arms the
 * timeout while loading and keeps the Splash up only until a fast boot reaches
 * `SPLASH_MIN_MS`. After the first settle the Splash never returns.
 */
export function useBoot(agents: boolean, host: HostController): { boot: BootState; splash: boolean; retry(): void } {
  const [timedOut, setTimedOut] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState(false);
  const boot = resolveBootState({ agents, host: host.state, error: host.error, timedOut });

  useEffect(() => {
    if (boot.phase !== 'loading') return;
    const timer = setTimeout(() => setTimedOut(true), BOOT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [boot.phase, attempt]);

  useEffect(() => {
    if (settled || boot.phase === 'loading') return;
    const hold = splashHoldMs(boot.phase, sinceLaunch());
    const timer = setTimeout(() => setSettled(true), hold);
    return () => clearTimeout(timer);
  }, [settled, boot.phase]);

  const { retry: retryHost } = host;
  const retry = useCallback(() => { setTimedOut(false); setAttempt(value => value + 1); retryHost(); }, [retryHost]);
  // Errors replace the Splash at once (the recovery panel is drawn by the Splash itself).
  return { boot, splash: boot.phase === 'loading' || boot.phase === 'recoverable-error' || !settled, retry };
}
