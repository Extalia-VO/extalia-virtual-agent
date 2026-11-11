/** Host admission timers; learning execution and artifact publication remain Rust-owned. */
export interface LearningScheduleJob {
  id: string;
  workspaceId: string;
  profileId: string;
  profileName: string;
  sessionId: string;
  state: 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';
  dueAt: string;
  reason?: 'busy' | 'changed' | 'failed' | 'shutdown';
  createdAt: string;
}

export interface LearningScheduleSnapshot {
  revision: string;
  jobs: LearningScheduleJob[];
  delaySeconds: 60;
  snoozeSeconds: 600;
}

export interface LearningScheduleAction {
  id: string;
  revision: string;
  action: 'snooze' | 'run-now';
}

export function normalizeLearningScheduleAction(value: unknown): LearningScheduleAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a scheduled learning job.');
  const input = value as Record<string, unknown>;
  const text = (item: unknown): item is string => typeof item === 'string' && item.length > 0 && item.length <= 200 && !/\p{Cc}/u.test(item);
  if (Object.keys(input).some(key => !['id', 'revision', 'action'].includes(key)) || !text(input.id) || !text(input.revision)
    || !['snooze', 'run-now'].includes(input.action as string)) throw new Error('Invalid scheduled learning action.');
  return { id: input.id, revision: input.revision, action: input.action as LearningScheduleAction['action'] };
}
