import type { HostState } from '@extalia/platform';

interface MonitorOptions {
  getState(): Promise<HostState>;
  onState(state: HostState): void;
  onError(error: unknown): void;
  pollMs?: number;
  timeoutMs?: number;
}

/** Keep connection status current even when no agent emits events. */
export function createHostStateMonitor({ getState, onState, onError, pollMs = 5_000, timeoutMs = 8_000 }: MonitorOptions) {
  let disposed = false;
  let sequence = 0;
  let pending: { id: number; timer: ReturnType<typeof setTimeout> } | undefined;

  const cancelPending = () => {
    clearTimeout(pending?.timer);
    pending = undefined;
  };

  const refresh = () => {
    // A stalled transport has one bounded request, rather than a growing queue.
    if (disposed || pending) return;
    const id = ++sequence;
    const timer = setTimeout(() => {
      if (disposed || pending?.id !== id) return;
      pending = undefined;
      onError(new Error('The agent host did not respond in time.'));
    }, timeoutMs);
    pending = { id, timer };
    Promise.resolve().then(getState).then(
      next => {
        if (disposed || pending?.id !== id) return;
        cancelPending();
        onState(next);
      },
      error => {
        if (disposed || pending?.id !== id) return;
        cancelPending();
        onError(error);
      },
    );
  };

  const interval = setInterval(refresh, pollMs);
  refresh();
  return {
    refresh,
    apply(next: HostState) {
      if (disposed) return;
      cancelPending();
      onState(next);
    },
    dispose() {
      disposed = true;
      clearInterval(interval);
      cancelPending();
    },
  };
}
