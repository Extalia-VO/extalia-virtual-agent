import type { GeneralSchedule, GeneralScheduleCatalog, SaveGeneralScheduleInput } from '@extalia/platform';
import { createScheduleJobsTool, type AnyTool } from '@extalia/runtime';

interface NativeScheduleJobsOptions {
  workspaceId: string;
  sessionId: string;
  invocationId: string;
  allowCreate: boolean;
  currentSessionPersistent: boolean;
  reusableNewSessionAvailable(): boolean;
  manager: {
    list(): Promise<GeneralScheduleCatalog>;
    createFromPrompt(input: SaveGeneralScheduleInput, invocationKey: string, assertCurrent?: () => void): Promise<GeneralSchedule>;
  };
  /** Retain workspace ownership and revalidate the originating Native run. */
  withinScope<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T>;
  assertCurrent(signal: AbortSignal): void;
  persist<T>(work: () => Promise<T>): Promise<T>;
}

const summary = (job: GeneralSchedule) => ({ id: job.id, name: job.name, enabled: job.enabled, trigger: job.trigger,
  sessionTarget: job.sessionTarget, missedPolicy: job.missedPolicy, state: job.state, ...(job.recovery ? { recovery: job.recovery } : {}), ...(job.nextRunAt ? { nextRunAt: job.nextRunAt } : {}),
  ...(job.lastSessionId ? { lastSessionId: job.lastSessionId } : {}) });

/** Only the user-facing lead turn receives this bound capability, never its workers. */
export function createNativeScheduleJobs(options: NativeScheduleJobsOptions): AnyTool {
  return createScheduleJobsTool({
    allowCreate: options.allowCreate,
    list: context => options.withinScope(context.signal, async () => {
      const catalog = await options.manager.list();
      options.assertCurrent(context.signal);
      const jobs = catalog.schedules.filter(job => job.workspaceId === options.workspaceId);
      return { now: new Date().toISOString(), timeZone: catalog.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        workspaceId: options.workspaceId, currentSessionId: options.sessionId,
        currentSessionPersistent: options.currentSessionPersistent, reusableNewSessionAvailable: options.reusableNewSessionAvailable(), runtime: 'host-must-remain-running',
        ...(catalog.problem ? { problem: catalog.problem } : {}),
        total: jobs.length, jobs: jobs.slice(0, 32).map(summary), omitted: Math.max(0, jobs.length - 32) };
    }),
    create: (input, context) => options.withinScope(context.signal, async () => {
      if (!options.allowCreate) throw new Error('This turn is read-only; no schedule was created.');
      const mode = input.sessionMode ?? 'current';
      if (mode === 'current' && !options.currentSessionPersistent)
        throw new Error('This conversation does not retain history. Ask the user to choose a new scheduled session instead.');
      if (mode === 'create-and-reuse' && !options.reusableNewSessionAvailable())
        throw new Error('This project’s new sessions do not retain history. Ask the user to choose a fresh session on every run instead.');
      const trigger = input.triggerKind === 'cron' ? { kind: 'cron' as const, cron: input.cron! }
        : input.triggerKind === 'interval' ? { kind: 'interval' as const, intervalMinutes: input.intervalMinutes! }
          : { kind: 'once' as const, runAt: input.runAt! };
      const job = await options.persist(() => options.manager.createFromPrompt({
        workspaceId: options.workspaceId, name: input.name, prompt: input.prompt, enabled: input.enabled ?? true, trigger,
        sessionTarget: mode === 'current' ? { mode: 'existing', sessionId: options.sessionId } : { mode },
        assignment: { teamMode: 'workspace' }, missedPolicy: input.missedPolicy ?? 'run-once',
      }, JSON.stringify(['native-schedule-v1', options.sessionId, options.invocationId, context.toolCallId]),
      () => {
        options.assertCurrent(context.signal);
        if (mode === 'create-and-reuse' && !options.reusableNewSessionAvailable())
          throw new Error('This project’s new sessions no longer retain history. Review the scheduled session choice.');
      }));
      // An acknowledged save remains a save even if cancellation arrives afterwards.
      return { status: 'saved', job: summary(job), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        runtime: 'host-must-remain-running' };
    }),
  });
}
