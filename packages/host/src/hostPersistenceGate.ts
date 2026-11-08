/** Local persistence admission only; this does not establish external process settlement. */
export class HostPersistenceClosedError extends Error {
  constructor() { super('The host is shutting down.'); this.name = 'HostPersistenceClosedError'; }
}

/**
 * Admission happens synchronously, before deferred queues or filesystem awaits.
 * An admitted closure owns exactly its returned local-operation promise. Nested
 * writes need their own admission; no ambient execution context grants authority.
 */
export class HostPersistenceGate {
  private sealed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly idleListeners = new Set<() => void>();

  get isSealed(): boolean { return this.sealed; }
  get isBusy(): boolean { return this.pending.size > 0; }

  onIdle(listener: () => void): () => void {
    this.idleListeners.add(listener);
    return () => { this.idleListeners.delete(listener); };
  }

  run<T>(write: () => Promise<T>): Promise<T> {
    if (this.sealed) return Promise.reject(new HostPersistenceClosedError());
    const pending = Promise.resolve().then(write);
    this.pending.add(pending);
    const settled = () => {
      this.pending.delete(pending);
      if (!this.pending.size) for (const listener of this.idleListeners) { try { listener(); } catch { /* observation never changes persistence ownership */ } }
    };
    void pending.then(settled, settled);
    return pending;
  }

  seal(): void { this.sealed = true; }

  /** Seal first; every admitted local write must settle before the profile lock is released. */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
