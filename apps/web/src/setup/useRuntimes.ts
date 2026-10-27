import type { AgentHostApi, RuntimeInfo } from '@extalia/platform';
import { useCallback, useEffect, useState } from 'react';

export interface RuntimeStatus {
  runtimes: RuntimeInfo[];
  /** The host answered; until then (or on an older host) the list is empty. */
  ready: boolean;
  /** Look for the runtimes again, for example after the user installed Hermes Agent. */
  refresh: () => Promise<void>;
}

/** Managed runtimes the host can drive, with a way to detect them again. */
export function useRuntimeStatus(agents: AgentHostApi): RuntimeStatus {
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [ready, setReady] = useState(false);
  const refresh = useCallback(async () => {
    try { setRuntimes(await agents.runtimes()); } catch { /* Extalia Native only */ }
    setReady(true);
  }, [agents]);
  useEffect(() => {
    let live = true;
    agents.runtimes().then(list => { if (live) setRuntimes(list); }, () => { /* Extalia Native only */ }).finally(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, [agents]);
  return { runtimes, ready, refresh };
}

/** Managed runtimes the host can drive; empty until known, or when an older host cannot tell. */
export function useRuntimes(agents: AgentHostApi): RuntimeInfo[] {
  return useRuntimeStatus(agents).runtimes;
}

/** Hermes Agent when it is installed. */
export const availableHermes = (runtimes: readonly RuntimeInfo[]) => runtimes.find(item => item.id === 'hermes' && item.available);
