/** Internal turn-loop hook. Reservations cover preflight and acknowledgement waits as well as tool code. */
export interface LocalToolPipelines {
  assertOpen(): void;
  reserveToolPipeline(): { run<T>(implementation: () => Promise<T>): Promise<T> };
}

/**
 * Tracks actual implementation promises, never an abort race or Promise.all.
 * Sealing closes admission; it never pretends an outstanding operation settled.
 */
export class LocalOperationTracker implements LocalToolPipelines {
  private sealed = false;
  private started = false;
  private settled = false;
  private notified = false;
  private outstanding = 0;
  private providers = 0;
  private tools = 0;

  constructor(private readonly drained: (counts: { providerOperations: number; toolOperations: number }) => void) {}

  get pending(): number { return this.outstanding; }
  markStarted(): void { this.started = true; this.notify(); }
  markSettled(): void { this.settled = true; this.seal(); }
  seal(): void { this.sealed = true; this.notify(); }
  assertOpen(): void { if (this.sealed) throw new Error('Native local operation admission is closed.'); }

  async invoke<T>(kind: 'provider' | 'tool', implementation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (kind === 'provider') {
      if (this.providers >= 20) throw new Error('Native provider operation limit exceeded.');
      this.providers++;
    } else {
      if (this.tools >= 80) throw new Error('Native tool operation limit exceeded.');
      this.tools++;
    }
    // Register before invoking user code, including implementations that throw synchronously.
    this.outstanding++;
    try { return await implementation(); }
    finally { this.release(); }
  }

  reserveToolPipeline(): ReturnType<LocalToolPipelines['reserveToolPipeline']> {
    this.assertOpen();
    this.outstanding++;
    return { run: async implementation => {
      try {
        this.assertOpen();
        return await implementation();
      } catch (error) {
        // A failed branch can reject the aggregate while siblings still wait in preflight.
        this.seal();
        throw error;
      } finally { this.release(); }
    } };
  }

  private release(): void { this.outstanding--; this.notify(); }
  private notify(): void {
    if (this.notified || !this.started || !this.settled || !this.sealed || this.outstanding !== 0) return;
    this.notified = true;
    this.drained({ providerOperations: this.providers, toolOperations: this.tools });
  }
}
