/** Internal attribution for unbound observed conversations; never a filesystem grant. */
export const GLOBAL_OBSERVE_WORKSPACE_ID = 'global-observe';

/** A real discussion and its independently acknowledged knowledge export. */
export interface LearningMeetingResult {
  outcome: 'completed' | 'cancelled' | 'failed' | 'unknown';
  meetingId?: string;
  knowledge: 'saved' | 'unavailable' | 'failed';
  /** Present only after the exporter acknowledged the durable note. */
  notePath?: string;
  /** Index refresh after the saved note; absence does not confirm indexing. */
  indexed?: boolean;
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

/** Source-grounded project publication; verification refers to file/citation checks, not universal factual truth. */
export interface ProjectKnowledgeBuildResult {
  status: 'saved' | 'unchanged' | 'partial' | 'failed';
  overviewPath?: string;
  inventory: number;
  read: number;
  unique: number;
  created: number;
  updated: number;
  unchanged: number;
  deduplicated: number;
  excluded: number;
  notes: number;
  topics: number;
  conflicts: number;
  modelRequests: number;
  synthesizedSources: number;
  /** Sources represented in this build's bounded Native input; full reads are counted separately. */
  modelSources?: number;
  truncatedSources?: number;
  /** Proposed quotations omitted by the per-topic bound; full source snapshots remain available. */
  omittedCitations?: number;
  indexed?: boolean;
}

export interface LearningScheduleResult {
  meeting?: LearningMeetingResult;
  project?: ProjectKnowledgeBuildResult;
  skill?: LearningSkillNotice;
  knowledge?: { status: 'saved' | 'failed' | 'skipped'; path?: string; indexed?: boolean };
  problem?: 'connection' | 'provider' | 'timeout' | 'invalid-request' | 'authority' | 'publication';
}

/** Host admission timers; learning execution and artifact publication remain Rust-owned. */
export interface LearningScheduleJob {
  id: string;
  workspaceId: string;
  profileId: string;
  profileName: string;
  sessionId: string;
  /** Absence on older hosts means ordinary post-task learning. */
  kind?: 'learning' | 'knowledge-meeting' | 'knowledge-build';
  workspaceName?: string;
  sessionName?: string;
  state: 'scheduled' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  /** Effective only while waitingForIdle is false; the UI never dispatches on this deadline. */
  dueAt: string;
  /** A full selected quiet interval starts once actual foreground work settles. */
  waitingForIdle?: boolean;
  /** Selected quiet interval, including snooze, shown while no effective deadline exists. */
  delaySeconds?: number;
  reason?: 'busy' | 'changed' | 'failed' | 'shutdown';
  createdAt: string;
  /** Positive receipts survive a later executor, export or cleanup failure. */
  result?: LearningScheduleResult;
  /** Retained checkpoint metadata. Queued, resumable and publication states permit explicit admission. */
  recovery?: {
    state: 'queued' | 'resumable' | 'publication' | 'uncertain' | 'expired';
    modelRequests: number;
    reads: number;
    skillReviewRequired: boolean;
  };
}

export interface LearningScheduleSnapshot {
  revision: string;
  jobs: LearningScheduleJob[];
  delaySeconds: 60;
  snoozeSeconds: 600;
  /** Scheduling still works; retained checkpoints could not be inspected. */
  recoveryUnavailable?: boolean;
  /** Visible work is usable; other records are unreadable or outside the bounded listing. */
  recoveryIncomplete?: boolean;
}

export interface LearningScheduleAction {
  id: string;
  revision: string;
  action: 'snooze' | 'run-now' | 'resume';
}

export function normalizeLearningScheduleAction(value: unknown): LearningScheduleAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a scheduled learning job.');
  const input = value as Record<string, unknown>;
  const text = (item: unknown): item is string => typeof item === 'string' && item.length > 0 && item.length <= 200 && !/\p{Cc}/u.test(item);
  if (Object.keys(input).some(key => !['id', 'revision', 'action'].includes(key)) || !text(input.id) || !text(input.revision)
    || !['snooze', 'run-now', 'resume'].includes(input.action as string)) throw new Error('Invalid scheduled learning action.');
  return { id: input.id, revision: input.revision, action: input.action as LearningScheduleAction['action'] };
}
