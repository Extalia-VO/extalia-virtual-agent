/** A real discussion and its independently acknowledged knowledge export. */
export interface LearningMeetingResult {
  outcome: 'completed' | 'cancelled' | 'failed' | 'unknown';
  meetingId?: string;
  knowledge: 'saved' | 'unavailable' | 'failed';
  /** Present only after the exporter acknowledged the durable note. */
  notePath?: string;
  problem?: string;
}

/** A durable candidate receipt, never an activation or a model-authored success claim. */
export interface LearningSkillNotice {
  id: string;
  profileId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  createdAt: string;
  kind: 'skill-candidate';
  packageId: string;
  revisionId: string;
  state: string;
  /** New/revised need registry history; an isolated receipt only proves saved. */
  change: 'new' | 'revised' | 'saved';
  activationPerformed: false;
  label?: string;
  /** A candidate was saved even though another part of learning did not complete. */
  partial?: boolean;
}

export interface LearningScheduleResult {
  meeting?: LearningMeetingResult;
  skill?: LearningSkillNotice;
}

/** Host admission timers; learning execution and artifact publication remain Rust-owned. */
export interface LearningScheduleJob {
  id: string;
  workspaceId: string;
  profileId: string;
  profileName: string;
  sessionId: string;
  /** Absence on older hosts means ordinary post-task learning. */
  kind?: 'learning' | 'knowledge-meeting';
  workspaceName?: string;
  sessionName?: string;
  state: 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** Effective only while waitingForIdle is false; the UI never dispatches on this deadline. */
  dueAt: string;
  /** A full selected quiet interval starts once actual foreground work settles. */
  waitingForIdle?: boolean;
  reason?: 'busy' | 'changed' | 'failed' | 'shutdown';
  createdAt: string;
  /** Positive receipts survive a later executor, export or cleanup failure. */
  result?: LearningScheduleResult;
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
