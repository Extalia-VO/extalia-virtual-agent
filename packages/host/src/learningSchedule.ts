import { randomUUID } from 'node:crypto';
import type { LearningScheduleAction, LearningScheduleJob, LearningScheduleSnapshot } from '@extalia/platform';

export interface ScheduledLearningInput {
  /** Immutable source invocation identity, also used to prevent repeated admission. */
  id: string;
  workspaceId: string;
  profileId: string;
  profileName: string;
  sessionId: string;
  /** Callers retain bounded evidence only; no source run or conversation-history closure. */
  execute(signal: AbortSignal): Promise<void>;
  validate(): Promise<boolean>;
  ready(): boolean;
}

interface Entry { view: LearningScheduleJob; input?: ScheduledLearningInput }
export interface LearningScheduleOptions {
  now?(): number;
  setTimer?(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimer?(timer: ReturnType<typeof setTimeout>): void;
  onChange?(snapshot: LearningScheduleSnapshot): void;
}

/** Connection-scoped admission queue. Nothing starts a Rust job or acquires a vault pin while waiting. */
export class LearningSchedule {
  private readonly entries = new Map<string, Entry>();
  /** Recent IDs only; durable publication receipts remain owned by Rust. */
  private readonly admitted = new Set<string>();
  private readonly epoch = randomUUID();
  private serial = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: { controller: AbortController; done: Promise<void> };
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<LearningScheduleOptions['setTimer']>;
  private readonly clearTimer: NonNullable<LearningScheduleOptions['clearTimer']>;

  constructor(private readonly options: LearningScheduleOptions = {}) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  /** Includes asynchronous authorization and entered effects, until physical settlement. */
  get isBusy(): boolean { return this.active !== undefined; }

  snapshot(): LearningScheduleSnapshot {
    return { revision: `${this.epoch}:${this.serial}`, jobs: [...this.entries.values()].map(({ view }) => ({ ...view })), delaySeconds: 60, snoozeSeconds: 600 };
  }

  schedule(input: ScheduledLearningInput): boolean {
    if (this.closed || this.admitted.has(input.id) || [...this.entries.values()].filter(entry => entry.view.state === 'scheduled').length >= 16) return false;
    const createdAt = new Date(this.now()).toISOString();
    const { id, workspaceId, profileId, profileName, sessionId } = input;
    this.admitted.add(id);
    this.entries.set(id, { input, view: { id, workspaceId, profileId, profileName, sessionId, state: 'scheduled', createdAt, dueAt: new Date(this.now() + 60_000).toISOString() } });
    for (const previous of this.admitted) {
      if (this.admitted.size <= 256) break;
      if (!this.entries.has(previous)) this.admitted.delete(previous);
    }
    this.changed();
    this.arm();
    return true;
  }

  /** Admission is synchronous and never waits for a model or storage effect. */
  act(input: LearningScheduleAction): LearningScheduleSnapshot {
    if (this.closed || input.revision !== this.snapshot().revision) throw new Error('Learning schedules changed. Refresh before trying again.');
    const entry = this.entries.get(input.id);
    if (!entry || entry.view.state !== 'scheduled') throw new Error('That learning job is no longer waiting.');
    if (input.action !== 'snooze' && input.action !== 'run-now') throw new Error('Choose a supported learning action.');
    entry.view.dueAt = new Date(this.now() + (input.action === 'snooze' ? 600_000 : 0)).toISOString();
    delete entry.view.reason;
    this.changed();
    this.arm();
    return this.snapshot();
  }

  /** Configuration mutations invalidate old destinations rather than redirecting source evidence. */
  invalidatePending(): void {
    for (const entry of this.entries.values()) if (entry.view.state === 'scheduled') this.terminal(entry, 'cancelled', 'changed');
    this.arm();
  }

  /** A fresh foreground prompt restarts the workspace's quiet period without changing provenance. */
  deferWorkspace(workspaceId: string): void {
    for (const entry of this.entries.values()) if (entry.view.state === 'scheduled' && entry.view.workspaceId === workspaceId) {
      entry.view.dueAt = new Date(Math.max(Date.parse(entry.view.dueAt), this.now() + 60_000)).toISOString();
      entry.view.reason = 'busy';
      this.changed();
    }
    this.arm();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.timer !== undefined) { this.clearTimer(this.timer); this.timer = undefined; }
    for (const entry of this.entries.values()) if (entry.view.state === 'scheduled') this.terminal(entry, 'cancelled', 'shutdown');
    this.active?.controller.abort();
    return this.closePromise = this.active?.done ?? Promise.resolve();
  }

  private changed(): void {
    this.serial++;
    try { this.options.onChange?.(this.snapshot()); } catch { /* Presentation cannot release job ownership. */ }
  }

  private terminal(entry: Entry, state: 'completed' | 'failed' | 'cancelled', reason?: LearningScheduleJob['reason']): void {
    entry.view.state = state;
    if (reason) entry.view.reason = reason; else delete entry.view.reason;
    delete entry.input;
    const terminal = [...this.entries.values()].filter(item => !['scheduled', 'running'].includes(item.view.state));
    for (const old of terminal.slice(0, Math.max(0, terminal.length - 8))) this.entries.delete(old.view.id);
    this.changed();
  }

  private arm(): void {
    if (this.timer !== undefined) { this.clearTimer(this.timer); this.timer = undefined; }
    if (this.closed || this.active) return;
    const waiting = [...this.entries.values()].filter(entry => entry.view.state === 'scheduled');
    if (!waiting.length) return;
    const next = Math.min(...waiting.map(entry => Date.parse(entry.view.dueAt)));
    this.timer = this.setTimer(() => { this.timer = undefined; this.dispatch(); }, Math.max(0, next - this.now()));
    this.timer.unref?.();
  }

  private defer(entry: Entry): void {
    entry.view.state = 'scheduled';
    entry.view.reason = 'busy';
    entry.view.dueAt = new Date(this.now() + 1_000).toISOString();
    this.changed();
  }

  private dispatch(): void {
    if (this.closed || this.active) return;
    const due = [...this.entries.values()].filter(entry => entry.view.state === 'scheduled' && Date.parse(entry.view.dueAt) <= this.now());
    for (const entry of due) {
      const input = entry.input!;
      let ready: boolean;
      try { ready = input.ready(); } catch { this.terminal(entry, 'failed', 'failed'); continue; }
      if (!ready) { this.defer(entry); continue; }
      const controller = new AbortController();
      // Defer the callback to install ownership before authorization starts or subscribers react.
      const done = Promise.resolve().then(async () => {
        try {
          if (controller.signal.aborted) { this.terminal(entry, 'cancelled', 'shutdown'); return; }
          if (!await input.validate()) { this.terminal(entry, 'cancelled', 'changed'); return; }
          if (controller.signal.aborted) { this.terminal(entry, 'cancelled', 'shutdown'); return; }
          if (!input.ready()) { this.defer(entry); return; }
          await input.execute(controller.signal);
          this.terminal(entry, controller.signal.aborted ? 'cancelled' : 'completed', controller.signal.aborted ? 'shutdown' : undefined);
        } catch {
          this.terminal(entry, controller.signal.aborted ? 'cancelled' : 'failed', controller.signal.aborted ? 'shutdown' : 'failed');
        } finally {
          this.active = undefined;
          this.changed();
          this.arm();
        }
      });
      this.active = { controller, done };
      entry.view.state = 'running';
      delete entry.view.reason;
      this.changed();
      return;
    }
    this.arm();
  }
}
