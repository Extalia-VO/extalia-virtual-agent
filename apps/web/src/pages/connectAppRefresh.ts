import type { AgentAppConnection, AgentHostApi, HookIngestStatus } from '@extalia/platform';

/** Status reads are serialized; writes revoke older replies before they can reach the UI. */
export function createConnectAppRefresh({ agents, connections, ingest, error }: {
  agents: Pick<AgentHostApi, 'agentAppConnections' | 'hookIngest'>;
  connections: (value: AgentAppConnection[]) => void;
  ingest: (value: HookIngestStatus) => void;
  error: (failure: unknown) => void;
}) {
  let disposed = false;
  let paused = false;
  let revision = 0;
  let running: Promise<void> | undefined;
  let pendingFull = false;

  const refresh = (full = true): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (paused) {
      pendingFull ||= full;
      return Promise.resolve();
    }
    if (running) {
      // Returning from an outside app must observe changes made after an older
      // scan began. Coalesce repeated full requests into one trailing scan.
      pendingFull ||= full;
      return running;
    }
    const requestedRevision = revision;
    const current = () => !disposed && !paused && requestedRevision === revision;
    running = (async () => {
      try {
        if (full) {
          const [nextConnections, nextIngest] = await Promise.all([agents.agentAppConnections(), agents.hookIngest()]);
          if (current()) { connections(nextConnections); ingest(nextIngest); }
        } else {
          const nextIngest = await agents.hookIngest();
          if (current()) ingest(nextIngest);
        }
      } catch (failure) {
        // Background liveness failures do not replace the last successful status with an error.
        if (full && current()) error(failure);
      }
    })().finally(async () => {
      running = undefined;
      if (!disposed && !paused && pendingFull) {
        pendingFull = false;
        await refresh();
      }
    });
    return running;
  };

  return {
    refresh,
    pause() { paused = true; revision++; },
    resume() { paused = false; pendingFull = false; return refresh(); },
    dispose() { disposed = true; revision++; pendingFull = false; },
  };
}
