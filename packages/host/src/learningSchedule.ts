import { randomUUID } from 'node:crypto';
import type { LearningMeetingResult, LearningScheduleAction, LearningScheduleJob, LearningScheduleResult, LearningScheduleSnapshot, LearningSkillNotice } from '@extalia/platform';

export interface ScheduledLearningInput {
  /** Immutable source invocation identity, also used to prevent repeated admission. */
  id: string;
  workspaceId: string;
  profileId: string;
  profileName: string;
  sessionId: string;
  /** The host proved this non-default profile belongs only to its isolated workspace. */
  independent?: boolean;
  kind?: 'learning' | 'knowledge-meeting';
  workspaceName?: string;
  sessionName?: string;
  /** Callers retain bounded evidence only; no source run or conversation-history closure. */
  execute(signal: AbortSignal): Promise<void>;
  validate(): Promise<boolean>;
  ready(): boolean;
}

interface Entry {
  view: LearningScheduleJob;
  input?: ScheduledLearningInput;
  /** A snooze is a full idle interval, not a wall-clock deadline retained through work. */
  delayMs: number;
  immediate: boolean;
}
interface Active {
  entry: Entry;
  controller: AbortController;
  done: Promise<void>;
  generation: number;
  entered: boolean;
  interruption?: 'busy' | 'shutdown';
}
export interface LearningScheduleOptions {
  now?(): number;
  setTimer?(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimer?(timer: ReturnType<typeof setTimeout>): void;
  onChange?(snapshot: LearningScheduleSnapshot): void;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => key in value) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
function meetingResult(value: unknown): value is LearningMeetingResult {
  if (!record(value) || !keys(value, ['outcome', 'knowledge'], ['meetingId', 'notePath', 'problem'])
    || !['completed', 'cancelled', 'failed', 'unknown'].includes(String(value.outcome))
    || !['saved', 'unavailable', 'failed'].includes(String(value.knowledge))) return false;
  if (value.meetingId !== undefined && !text(value.meetingId) || value.problem !== undefined && !text(value.problem, 1_000)) return false;
  return value.knowledge === 'saved' ? text(value.notePath, 4_096) : value.notePath === undefined;
}
function skillNotice(value: unknown): value is LearningSkillNotice {
  if (!record(value) || !keys(value, ['id', 'profileId', 'workspaceId', 'sessionId', 'runId', 'createdAt', 'kind', 'packageId', 'revisionId', 'state', 'change', 'activationPerformed'], ['label', 'partial'])
    || !['id', 'profileId', 'workspaceId', 'sessionId', 'runId', 'packageId', 'revisionId', 'state'].every(key => text(value[key]))
    || !text(value.createdAt, 40) || !Number.isFinite(Date.parse(value.createdAt)) || value.kind !== 'skill-candidate'
    || value.activationPerformed !== false || !['new', 'revised', 'saved'].includes(String(value.change))) return false;
  return (value.label === undefined || text(value.label, 200)) && (value.partial === undefined || typeof value.partial === 'boolean');
}

/** Profile-aware admission queue. Nothing starts a Rust job or acquires a vault pin while waiting. */
export class LearningSchedule {
  private readonly entries = new Map<string, Entry>();
  /** Recent IDs only; durable publication receipts remain owned by Rust. */
  private readonly admitted = new Set<string>();
  private readonly epoch = randomUUID();
  private serial = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private timerGeneration = 0;
  private generation = 0;
  private foregroundHolds = 0;
  private readonly profileForegroundHolds = new Map<string, number>();
  private active?: Active;
  private reconciling = false;
  private wakeAgain = false;
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
    return { revision: `${this.epoch}:${this.serial}`, jobs: [...this.entries.values()].map(({ view }) => structuredClone(view)), delaySeconds: 60, snoozeSeconds: 600 };
  }

  schedule(input: ScheduledLearningInput): boolean {
    if (this.closed || this.admitted.has(input.id)) return false;
    const kind = input.kind ?? 'learning';
    const replaced = kind === 'knowledge-meeting'
      ? [...this.entries.values()].filter(entry => entry.view.state === 'scheduled' && entry.view.kind === kind && entry.view.workspaceId === input.workspaceId)
      : [];
    if ([...this.entries.values()].filter(entry => entry.view.state === 'scheduled').length - replaced.length >= 16) return false;
    const createdAt = new Date(this.now()).toISOString();
    const { id, workspaceId, profileId, profileName, sessionId, workspaceName, sessionName } = input;
    const delayMs = replaced.at(-1)?.delayMs ?? 60_000;
    // Replaced source identities remain in the bounded dedupe window. No old
    // callback can resurrect evidence superseded by the latest workspace work.
    for (const entry of replaced) this.entries.delete(entry.view.id);
    this.admitted.add(id);
    this.entries.set(id, { input: { ...input }, delayMs, immediate: false, view: {
      id, workspaceId, profileId, profileName, sessionId, kind,
      ...(workspaceName ? { workspaceName } : {}), ...(sessionName ? { sessionName } : {}),
      state: 'scheduled', createdAt, dueAt: createdAt, waitingForIdle: true, reason: 'busy',
    } });
    for (const previous of this.admitted) {
      if (this.admitted.size <= 256) break;
      if (!this.entries.has(previous)) this.admitted.delete(previous);
    }
    this.changed();
    this.wake();
    return true;
  }

  /** Admission is synchronous and never waits for a model or storage effect. */
  act(input: LearningScheduleAction): LearningScheduleSnapshot {
    if (this.closed || input.revision !== this.snapshot().revision) throw new Error('Learning schedules changed. Refresh before trying again.');
    const entry = this.entries.get(input.id);
    if (!entry || entry.view.state !== 'scheduled') throw new Error('That learning job is no longer waiting.');
    if (input.action !== 'snooze' && input.action !== 'run-now') throw new Error('Choose a supported learning action.');
    if (input.action === 'snooze') entry.delayMs = 600_000;
    entry.immediate = input.action === 'run-now';
    entry.view.waitingForIdle = true;
    entry.view.reason = 'busy';
    entry.view.dueAt = new Date(this.now()).toISOString();
    this.changed();
    this.wake();
    return this.snapshot();
  }

  /** Acknowledged artifacts remain visible even if later execution or cleanup fails. */
  recordResult(id: string, result: LearningScheduleResult): void {
    const entry = this.entries.get(id);
    if (!entry || this.active?.entry !== entry || !this.active.entered) throw new Error('That learning invocation is no longer recording results.');
    if (!record(result) || !keys(result, [], ['meeting', 'skill']) || result.meeting === undefined && result.skill === undefined
      || result.meeting !== undefined && !meetingResult(result.meeting) || result.skill !== undefined && !skillNotice(result.skill))
      throw new Error('Invalid learning artifact receipt.');
    if (result.skill && (result.skill.workspaceId !== entry.view.workspaceId || result.skill.profileId !== entry.view.profileId || result.skill.sessionId !== entry.view.sessionId))
      throw new Error('The learning receipt belongs to another source.');
    entry.view.result = { ...entry.view.result,
      ...(result.meeting ? { meeting: structuredClone(result.meeting) } : {}),
      ...(result.skill ? { skill: structuredClone(result.skill) } : {}),
    };
    this.changed();
  }

  /** Configuration mutations invalidate old destinations rather than redirecting source evidence. */
  invalidatePending(): void {
    for (const entry of this.entries.values()) if (entry.view.state === 'scheduled') this.terminal(entry, 'cancelled', 'changed');
    this.arm();
  }

  /** A fresh foreground prompt restarts the workspace's quiet period without changing provenance. */
  deferWorkspace(workspaceId: string): void {
    let changed = false;
    for (const entry of this.entries.values()) if (entry.view.state === 'scheduled' && entry.view.workspaceId === workspaceId) {
      this.waitForIdle(entry, true); changed = true;
    }
    if (changed) this.changed();
    this.wake();
  }

  /** Recheck real host lifetimes; empty or unchanged wakes do not claim busy ownership. */
  wake(): void {
    if (this.closed || ![...this.entries.values()].some(entry => entry.view.state === 'scheduled')) return;
    // A curator's own worker/pin/persistence pulses are not new foreground
    // activity. Explicit foreground yielding fences pending work separately.
    if (this.active) return;
    if (this.reconciling) { this.wakeAgain = true; return; }
    this.reconciling = true;
    try {
      for (const entry of this.entries.values()) {
        if (entry.view.state !== 'scheduled') continue;
        let ready: boolean;
        try { ready = !this.held(entry) && entry.input!.ready(); }
        catch { this.terminal(entry, 'failed', 'failed'); continue; }
        if (!ready) {
          if (!entry.view.waitingForIdle) { this.waitForIdle(entry, true); this.changed(); }
        } else if (entry.view.waitingForIdle) {
          entry.view.waitingForIdle = false;
          delete entry.view.reason;
          entry.view.dueAt = new Date(this.now() + (entry.immediate ? 0 : entry.delayMs)).toISOString();
          this.changed();
        }
      }
      this.arm();
    } finally {
      this.reconciling = false;
      if (this.wakeAgain) { this.wakeAgain = false; this.wake(); }
    }
  }

  /**
   * Foreground ownership must be reserved before calling. Fence timers before
   * the first await, abort the conflicting executor, and await its actual effects.
   * A profile scope leaves independent other profiles' deadlines and work intact.
   * Unproven/shared jobs retain the global foreground conflict boundary.
   */
  async yieldForForeground(profileId?: string): Promise<void> {
    if (this.closed) throw new Error('The learning schedule is closing.');
    if (profileId === undefined) { this.foregroundHolds++; this.generation++; }
    else this.profileForegroundHolds.set(profileId, (this.profileForegroundHolds.get(profileId) ?? 0) + 1);
    this.stopTimer();
    let changed = false;
    for (const entry of this.entries.values()) if (entry.view.state === 'scheduled' && this.conflicts(entry, profileId)) {
      this.waitForIdle(entry, true); changed = true;
    }
    const active = this.active && this.conflicts(this.active.entry, profileId) ? this.active : undefined;
    if (active) { active.interruption = 'busy'; active.controller.abort(); }
    if (changed) this.changed();
    this.arm();
    try {
      await active?.done;
      if (this.closed) throw new Error('The learning schedule is closing.');
    } finally {
      if (profileId === undefined) this.foregroundHolds--;
      else {
        const remaining = this.profileForegroundHolds.get(profileId)! - 1;
        if (remaining) this.profileForegroundHolds.set(profileId, remaining);
        else this.profileForegroundHolds.delete(profileId);
      }
      this.wake();
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.generation++; this.stopTimer();
    for (const entry of this.entries.values()) if (entry.view.state === 'scheduled') this.terminal(entry, 'cancelled', 'shutdown');
    if (this.active) { this.active.interruption = 'shutdown'; this.active.controller.abort(); }
    return this.closePromise = this.active?.done ?? Promise.resolve();
  }

  private changed(): void {
    this.serial++;
    try { this.options.onChange?.(this.snapshot()); } catch { /* Presentation cannot release job ownership. */ }
  }

  private terminal(entry: Entry, state: 'completed' | 'failed' | 'cancelled', reason?: LearningScheduleJob['reason']): void {
    entry.view.state = state;
    entry.view.waitingForIdle = false;
    if (reason) entry.view.reason = reason; else delete entry.view.reason;
    delete entry.input;
    const terminal = [...this.entries.values()].filter(item => !['scheduled', 'running'].includes(item.view.state));
    for (const old of terminal.slice(0, Math.max(0, terminal.length - 8))) this.entries.delete(old.view.id);
    this.changed();
  }

  private stopTimer(): void {
    this.timerGeneration++;
    if (this.timer !== undefined) { this.clearTimer(this.timer); this.timer = undefined; }
  }

  private arm(): void {
    this.stopTimer();
    if (this.closed || this.active || this.foregroundHolds) return;
    const waiting = [...this.entries.values()].filter(entry => entry.view.state === 'scheduled');
    if (!waiting.length) return;
    const next = Math.min(...waiting.map(entry => entry.view.waitingForIdle ? this.now() + 1_000 : Date.parse(entry.view.dueAt)));
    const generation = this.timerGeneration;
    this.timer = this.setTimer(() => {
      if (generation !== this.timerGeneration) return;
      this.timer = undefined;
      this.wake(); this.dispatch();
    }, Math.max(0, next - this.now()));
    this.timer.unref?.();
  }

  private waitForIdle(entry: Entry, resetImmediate: boolean): void {
    entry.view.state = 'scheduled';
    entry.view.waitingForIdle = true;
    entry.view.reason = 'busy';
    entry.view.dueAt = new Date(this.now()).toISOString();
    if (resetImmediate) entry.immediate = false;
  }

  private held(entry: Entry): boolean {
    return this.foregroundHolds > 0 || this.profileForegroundHolds.has(entry.view.profileId)
      || this.profileForegroundHolds.size > 0 && entry.input?.independent !== true;
  }

  private conflicts(entry: Entry, profileId?: string): boolean {
    return profileId === undefined || entry.view.profileId === profileId || entry.input?.independent !== true;
  }

  private dispatch(): void {
    if (this.closed || this.active || this.foregroundHolds) return;
    const due = [...this.entries.values()].filter(entry => entry.view.state === 'scheduled' && !entry.view.waitingForIdle && Date.parse(entry.view.dueAt) <= this.now());
    for (const entry of due) {
      const input = entry.input!;
      let ready: boolean;
      try { ready = !this.held(entry) && input.ready(); } catch { this.terminal(entry, 'failed', 'failed'); continue; }
      if (!ready) { this.waitForIdle(entry, true); this.changed(); continue; }
      const controller = new AbortController();
      const active: Active = { entry, controller, done: Promise.resolve(), generation: this.generation, entered: false };
      // Defer the callback to install ownership before authorization starts or subscribers react.
      active.done = Promise.resolve().then(async () => {
        try {
          if (controller.signal.aborted || active.generation !== this.generation) { this.interrupted(active); return; }
          if (!await input.validate()) { this.terminal(entry, 'cancelled', 'changed'); return; }
          if (controller.signal.aborted || active.generation !== this.generation) { this.interrupted(active); return; }
          if (this.held(entry) || !input.ready()) { this.waitForIdle(entry, true); this.changed(); return; }
          active.entered = true;
          await input.execute(controller.signal);
          if (controller.signal.aborted) this.interrupted(active);
          else this.terminal(entry, 'completed');
        } catch {
          if (controller.signal.aborted) this.interrupted(active);
          else this.terminal(entry, 'failed', 'failed');
        } finally {
          if (this.active === active) this.active = undefined;
          this.changed();
          this.wake(); this.arm();
        }
      });
      this.active = active;
      entry.view.state = 'running';
      entry.view.waitingForIdle = false;
      delete entry.view.reason;
      this.changed();
      return;
    }
    this.arm();
  }

  private interrupted(active: Active): void {
    if (!this.closed && active.interruption === 'busy' && !active.entered) {
      // Validation owns no provider or publication. Only this unentered case
      // can safely resume; executed or uncertain sources are never replayed.
      this.waitForIdle(active.entry, true); this.changed();
    } else this.terminal(active.entry, 'cancelled', active.interruption ?? 'shutdown');
  }
}
