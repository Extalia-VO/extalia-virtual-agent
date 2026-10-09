import type { AgentHostApi, RuntimeInfo } from '@extalia/platform';
import { useEffect, useState } from 'react';

/** Managed runtimes the host can drive; empty until known, or when an older host cannot tell. */
export function useRuntimes(agents: AgentHostApi): RuntimeInfo[] {
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  useEffect(() => {
    let live = true;
    agents.runtimes().then(list => { if (live) setRuntimes(list); }, () => { /* Extalia Native only */ });
    return () => { live = false; };
  }, [agents]);
  return runtimes;
}

/** Hermes Agent when it is installed. */
export const availableHermes = (runtimes: readonly RuntimeInfo[]) => runtimes.find(item => item.id === 'hermes' && item.available);
