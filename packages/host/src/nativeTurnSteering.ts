import type { ModelMessage } from '@extalia/runtime';

/** One Native invocation's text inbox. It never mutates an in-flight model request. */
export class NativeTurnSteering {
  private history: ModelMessage[];
  private pending: string[] = [];
  private writes: Promise<void> = Promise.resolve();
  private open = true;
  private failure?: unknown;

  constructor(history: readonly ModelMessage[], private readonly accept: (history: ModelMessage[], text: string) => Promise<void>) {
    this.history = this.stored(history);
  }
  private stored(history: readonly ModelMessage[]) {
    return history.map(message => message.role === 'user' ? { role: 'user' as const, text: message.text } : message);
  }
  get available(): boolean { return this.open; }
  async close(): Promise<void> {
    this.open = false;
    await this.writes;
  }

  send(text: string): Promise<'sent'> {
    if (!this.open) return Promise.reject(new Error('The Native invocation is no longer accepting steering.'));
    // Reserve synchronously. A completion boundary must observe even an admission awaiting disk.
    this.pending.push(text);
    const admitted = this.pending.length;
    const write = this.writes.then(async () => {
      if (this.failure) throw this.failure;
      try {
        await this.accept([...this.history, ...this.pending.slice(0, admitted).map(text => ({ role: 'user' as const, text }))], text);
      } catch (error) { this.open = false; this.failure = error; throw error; }
    });
    this.writes = write.then(() => undefined, () => undefined);
    return write.then(() => 'sent');
  }

  async take(history: readonly ModelMessage[], boundary: 'step' | 'complete' | 'stop'): Promise<readonly string[]> {
    if (boundary === 'stop') this.open = false;
    this.history = this.stored(history);
    // Admissions can arrive while a prior disk write is draining.
    for (;;) { const writes = this.writes; await writes; if (writes === this.writes) break; }
    if (this.failure) throw this.failure;
    const pending = this.pending.splice(0);
    this.history.push(...pending.map(text => ({ role: 'user' as const, text })));
    if (boundary === 'complete' && !pending.length) this.open = false;
    return pending;
  }
}
