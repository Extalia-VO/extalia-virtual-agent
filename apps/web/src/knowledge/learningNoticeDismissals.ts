import type { LearningScheduleJob, LearningSkillNotice } from '@extalia/platform';

type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
type SavedDismissals = { version: 1; jobs: string[]; skills: string[] };
const LIMIT = 512;
const MAX_KEY_LENGTH = 8192;
const MAX_STORAGE_LENGTH = 1_048_576;
const PREFIX = 'extalia.learning.dismissals.v1:';
const empty = (): SavedDismissals => ({ version: 1, jobs: [], skills: [] });
const browserStorage = (): StoragePort | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };
export const terminalLearningNotice = (job: LearningScheduleJob) => job.state !== 'scheduled' && job.state !== 'running';

/** Attempt identity and meaningful output changes, independent of polling revisions or display labels. */
export function learningJobNoticeKey(job: LearningScheduleJob): string {
  const project = job.result?.project, meeting = job.result?.meeting, knowledge = job.result?.knowledge, recovery = job.recovery;
  return JSON.stringify(['job', job.id, job.profileId, job.workspaceId, job.sessionId, job.createdAt, job.kind ?? 'learning', job.state, job.reason ?? null,
    project ? [project.status, project.overviewPath, project.inventory, project.read, project.unique, project.created, project.updated, project.unchanged,
      project.deduplicated, project.excluded, project.notes, project.topics, project.conflicts, project.modelRequests, project.synthesizedSources, project.indexed, project.omittedCitations] : null,
    meeting ? [meeting.outcome, meeting.meetingId, meeting.knowledge, meeting.notePath, meeting.indexed, meeting.problem] : null,
    knowledge ? [knowledge.status, knowledge.path, knowledge.indexed] : null, job.result?.problem ?? null,
    recovery ? [recovery.state, recovery.modelRequests, recovery.reads, recovery.skillReviewRequired] : null]);
}

/** Registry state, enriched labels and history classification do not create another saved artifact. */
export function learningSkillNoticeKey(notice: LearningSkillNotice): string {
  return JSON.stringify(['skill', notice.id, notice.profileId, notice.packageId, notice.revisionId]);
}

function validKey(value: unknown, kind: 'job' | 'skill'): value is string {
  if (typeof value !== 'string' || value.length > MAX_KEY_LENGTH) return false;
  try {
    const key: unknown = JSON.parse(value);
    return Array.isArray(key) && key[0] === kind && key.length === (kind === 'job' ? 14 : 5)
      && key.slice(1, kind === 'job' ? 8 : 5).every(value => typeof value === 'string' && value.length > 0);
  } catch { return false; }
}

/** Browser-local explicit acknowledgements; no history, run state or host settings are changed. */
export function createLearningNoticeDismissals(scope?: string, storage: () => StoragePort | undefined = browserStorage) {
  // Full encoding avoids collisions between separate profiles or hosts; runtime paths never enter source files.
  const key = typeof scope === 'string' && scope.length > 0 && scope.length <= MAX_KEY_LENGTH ? `${PREFIX}${encodeURIComponent(scope)}` : undefined;
  const read = (): SavedDismissals => {
    if (!key) return empty();
    try {
      const raw = storage()?.getItem(key);
      if (!raw || raw.length > MAX_STORAGE_LENGTH) return empty();
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return empty();
      const saved = value as Record<string, unknown>;
      if (Object.keys(saved).some(field => !['version', 'jobs', 'skills'].includes(field)) || saved.version !== 1
        || !Array.isArray(saved.jobs) || saved.jobs.length > LIMIT || !saved.jobs.every(value => validKey(value, 'job'))
        || !Array.isArray(saved.skills) || saved.skills.length > LIMIT || !saved.skills.every(value => validKey(value, 'skill'))) return empty();
      return { version: 1, jobs: [...new Set(saved.jobs as string[])], skills: [...new Set(saved.skills as string[])] };
    } catch { return empty(); }
  };
  let saved = read();
  const dismiss = (kind: 'jobs' | 'skills', identity: string) => {
    if (!validKey(identity, kind === 'jobs' ? 'job' : 'skill')) return;
    const current = read();
    saved = { version: 1, jobs: [...new Set([...saved.jobs, ...current.jobs])].slice(-LIMIT), skills: [...new Set([...saved.skills, ...current.skills])].slice(-LIMIT) };
    saved[kind] = [...saved[kind].filter(value => value !== identity), identity].slice(-LIMIT);
    let text = JSON.stringify(saved);
    while (text.length > MAX_STORAGE_LENGTH) {
      (saved.jobs.length >= saved.skills.length ? saved.jobs : saved.skills).shift();
      text = JSON.stringify(saved);
    }
    try { if (key) storage()?.setItem(key, text); } catch { /* Keep this mounted acknowledgement when browser storage is blocked or full. */ }
  };
  return {
    key,
    hasJob: (job: LearningScheduleJob) => terminalLearningNotice(job) && saved.jobs.includes(learningJobNoticeKey(job)),
    hasSkill: (notice: LearningSkillNotice) => saved.skills.includes(learningSkillNoticeKey(notice)),
    dismissJob(job: LearningScheduleJob) { if (terminalLearningNotice(job)) dismiss('jobs', learningJobNoticeKey(job)); },
    dismissSkill(notice: LearningSkillNotice) { dismiss('skills', learningSkillNoticeKey(notice)); },
    refresh() { saved = read(); },
  };
}
