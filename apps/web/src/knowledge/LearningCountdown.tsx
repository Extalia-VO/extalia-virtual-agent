import { GLOBAL_OBSERVE_WORKSPACE_ID, type AgentHostApi, type LearningScheduleAction, type LearningScheduleSnapshot } from '@extalia/platform';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Messages } from '../i18n';
import { errorMessage } from '../host/remote';
import { Icon } from '../ui/Icon';
import './LearningCountdown.css';
import { createLearningNoticeDismissals, learningJobNoticeKey, learningSkillNoticeKey, terminalLearningNotice } from './learningNoticeDismissals';

export const LEARNING_SCHEDULE_REFRESH_EVENT = 'extalia:learning-schedule-refresh';

type Job = LearningScheduleSnapshot['jobs'][number];
type Action = LearningScheduleAction['action'];
type SkillNotice = NonNullable<NonNullable<Job['result']>['skill']>;

/** A bounded presentation memory, owned by the shared notification rather than the selected workspace. */
export function createLearningNoticeMemory() {
  const shown = new Set<string>();
  return {
    has: (id: string) => shown.has(id),
    record(id: string) { shown.add(id); while (shown.size > 128) shown.delete(shown.values().next().value!); },
  };
}
type NoticeMemory = ReturnType<typeof createLearningNoticeMemory>;
const waitingForIdle = (job: Job) => job.state === 'scheduled' && (job.waitingForIdle === true || job.reason === 'busy');

/** One current Knowledge notice per vault scope; stored jobs and artifact receipts remain intact. */
function latestKnowledgeNoticeIds(jobs: readonly Job[]): ReadonlySet<string> {
  const latest = new Map<string, Job>();
  const active = (job: Job) => job.state === 'scheduled' || job.state === 'running';
  const timestamp = (job: Job) => Number.isFinite(Date.parse(job.createdAt)) ? Date.parse(job.createdAt) : 0;
  for (const job of jobs) {
    if (job.kind !== 'knowledge-build' && job.kind !== 'knowledge-meeting') continue;
    const scope = JSON.stringify([job.workspaceId, job.profileId]), previous = latest.get(scope);
    if (!previous || active(job) && !active(previous) || active(job) === active(previous) && timestamp(job) >= timestamp(previous)) latest.set(scope, job);
  }
  return new Set([...latest.values()].map(job => job.id));
}


/** Validation may return to scheduled admission; once-started work stays in the corner. */
function rememberStartedLearning(previous: string[], snapshot: LearningScheduleSnapshot): string[] {
  const started = snapshot.jobs.filter(job => job.state === 'running').map(job => job.id);
  return started.every(id => previous.includes(id)) ? previous : [...new Set([...previous, ...started])].slice(-128);
}


/** Only the host deadline is authoritative; reaching zero does not claim execution. */
export function learningCountdownTime(dueAt: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(dueAt) - now) / 1000));
  if (!Number.isFinite(seconds)) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Show the selected quiet interval while waiting; it is not an ETA for conflicting work to end. */
export function learningCountdownDuration(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

/** Shared presentation for the live notification and isolated browser QA. */
export function LearningCountdownView({ t, snapshot, now, busyId, error, dismissed = [], dismissedSkills = [], embedded = false, compact = false, relatedJobs, noticeMemory, onAction, onDismiss, onDismissSkill }: {
  t: Messages; snapshot: LearningScheduleSnapshot; now: number; busyId?: string | undefined; error?: string | undefined;
  dismissed?: readonly string[]; onAction: (job: Job, action: Action) => void; onDismiss: (id: string) => void;
  dismissedSkills?: readonly string[]; embedded?: boolean; compact?: boolean; relatedJobs?: readonly Job[]; noticeMemory?: NoticeMemory; onDismissSkill?: (id: string) => void;
}) {
  const text = t.learningCountdown;
  const jobs = [...new Map(snapshot.jobs.map(job => [job.id, job])).values()];
  const knowledgeNotices = latestKnowledgeNoticeIds(relatedJobs ?? jobs);
  const visible = jobs.filter(job => (!terminalLearningNotice(job) || !dismissed.includes(job.id))
    && (job.kind !== 'knowledge-build' && job.kind !== 'knowledge-meeting' || knowledgeNotices.has(job.id))
    && (job.state !== 'completed' || job.kind === 'knowledge-meeting' || job.kind === 'knowledge-build' || job.result?.knowledge?.status === 'saved'));
  // Artifact receipts are independent of execution state, including a later failure or cancellation.
  const receipts = [...new Map(jobs.flatMap(job => job.result?.skill && !dismissedSkills.includes(job.result.skill.id)
    ? [[job.result.skill.id, { job, notice: job.result.skill }] as const] : [])).values()];
  if (!visible.length && !receipts.length && !snapshot.recoveryUnavailable && !snapshot.recoveryIncomplete) return null;
  const heading = visible.length > 0 && visible.every(job => job.kind === 'knowledge-build') && !receipts.length ? text.buildTitle : text.title;
  return <aside className={`learning-countdown${embedded ? ' is-embedded' : ''}${compact ? ' is-compact' : ''}`} aria-label={heading}>
    <div className="learning-countdown-heading"><Icon name="bulb" /><strong>{heading}</strong></div>
    {!compact && <p className="learning-countdown-help muted small">{text.help}</p>}
    {snapshot.recoveryUnavailable && <p className="muted small" role="status">{text.recoveryUnavailable}</p>}
    {snapshot.recoveryIncomplete && <p className="muted small" role="status">{text.recoveryIncomplete}</p>}
    <ul className="learning-countdown-jobs">
      {visible.map(job => {
        const pending = job.state === 'scheduled';
        const running = job.state === 'running';
        const meeting = job.kind === 'knowledge-meeting';
        const build = job.kind === 'knowledge-build';
        const separateMeeting = !meeting && !build && (relatedJobs ?? jobs).some(other => other.kind === 'knowledge-meeting'
          && other.workspaceId === job.workspaceId && other.profileId === job.profileId && other.sessionId === job.sessionId);
        const taskLabel = build ? text.buildTitle : meeting ? text.knowledgeUpdate : separateMeeting ? text.skillLearning : undefined;
        const waiting = waitingForIdle(job);
        const selectedDelay = typeof job.delaySeconds === 'number' && Number.isFinite(job.delaySeconds) && job.delaySeconds > 0
          ? job.delaySeconds : undefined;
        const due = Date.parse(job.dueAt) <= now;
        const status = job.recovery ? text.recoveryStates[job.recovery.state] : build ? projectBuildStatus(job, t, now) : running ? meeting ? text.meetingRunning : text.running : pending
          ? waiting ? meeting ? text.meetingWaiting : text.busy : due ? text.starting : meeting ? text.meetingScheduled : text.scheduled
          : job.state === 'partial' ? text.partial
          : job.state === 'completed' && !meeting ? text.completed
          : job.state === 'completed' ? job.result?.meeting?.outcome === 'completed' ? text.meetingCompleted
            : job.result?.meeting?.outcome === 'failed' ? text.failed
              : job.result?.meeting?.outcome === 'cancelled' ? text.cancelled : text.meetingUnconfirmed
            : job.state === 'failed' ? text.failed : text.cancelled;
        return <li key={job.id} className="learning-countdown-job" data-state={job.state} data-kind={job.kind ?? 'learning'} aria-busy={busyId === job.id || running}>
          <div className="learning-countdown-job-heading">
            <span className="learning-countdown-profile">{taskLabel && <span className="learning-countdown-kind">{taskLabel}</span>}{job.profileName}</span>
            {pending && !waiting && <time className="learning-countdown-clock" dateTime={job.dueAt} aria-label={text.timeRemaining} aria-live="off">{learningCountdownTime(job.dueAt, now)}</time>}
            {!pending && !running && <button type="button" className="icon-button" aria-label={text.dismiss} onClick={() => onDismiss(job.id)}><Icon name="close" /></button>}
          </div>
          {!compact && <LearningScope t={t} job={job} />}
          <p className="learning-countdown-status small" role="status">{status}</p>
          {job.recovery && <p className="muted small">{text.recoveryProgress(job.recovery.modelRequests, job.recovery.reads)}</p>}
          {job.recovery?.skillReviewRequired && <p className="muted small">{text.recoverySkillReview}</p>}
          {pending && waiting && <p className="learning-countdown-quiet muted small">{selectedDelay === undefined
            ? text.waitingCountdownUnknown : text.waitingCountdown(learningCountdownDuration(selectedDelay))}</p>}
          {pending && <p className="learning-countdown-quiet muted small">{text.quietPeriod}</p>}
          {job.result?.project && <ProjectBuildResult t={t} job={job} />}
          {job.result?.meeting && <MeetingResult t={t} job={job} />}
          {job.result?.knowledge && <KnowledgeResult t={t} job={job} />}
          {job.result?.problem && <p className="muted small">{text.problems[job.result.problem]}</p>}
          {!pending && !running && job.reason === 'changed' && <p className="muted small">{text.changed}</p>}
          {!pending && !running && !job.recovery && job.reason === 'shutdown' && <p className="muted small">{text.interrupted}</p>}
          {!pending && !running && job.reason === 'busy' && <p className="muted small">{text.foregroundPriority}</p>}
          {pending && <div className="learning-countdown-actions">
            <button type="button" className="button small" disabled={Boolean(busyId)} onClick={() => onAction(job, 'snooze')}>{text.snooze(Math.round(snapshot.snoozeSeconds / 60))}</button>
            <button type="button" className="button small primary" disabled={Boolean(busyId) || waiting} onClick={() => onAction(job, 'run-now')}>{text.runNow}</button>
          </div>}
          {job.recovery && ['queued', 'resumable', 'publication'].includes(job.recovery.state) && <div className="learning-countdown-actions">
            <button type="button" className="button small primary" disabled={Boolean(busyId)} onClick={() => onAction(job, 'resume')}>{job.recovery.state === 'queued' ? text.queueSaved : text.resume}</button>
          </div>}
        </li>;
      })}
      {receipts.map(({ job, notice }) => <SkillSavedNotice key={notice.id} t={t} job={job} notice={notice} memory={noticeMemory} onDismiss={onDismissSkill} />)}
    </ul>
    {error && <p className="form-error small" role="alert">{error}</p>}
  </aside>;
}

function LearningScope({ t, job }: { t: Messages; job: Job }) {
  return <p className="learning-countdown-scope muted small">{job.workspaceId === GLOBAL_OBSERVE_WORKSPACE_ID ? t.learningCountdown.globalObserve : t.learningCountdown.project(job.workspaceName || job.workspaceId)}
    <span aria-hidden="true"> · </span>{t.learningCountdown.session(job.sessionName || job.sessionId)}</p>;
}

/** A completed executor is not proof that project notes were published. */
function projectBuildStatus(job: Job, t: Messages, now: number): string {
  const text = t.learningCountdown;
  if (job.state === 'scheduled') return waitingForIdle(job) ? text.buildWaiting : Date.parse(job.dueAt) <= now ? text.buildStarting : text.buildScheduled;
  if (job.state === 'running') return text.buildRunning;
  if (job.state === 'cancelled') return text.cancelled;
  if (job.state === 'failed' || job.result?.project?.status === 'failed') return text.buildFailed;
  if (job.state === 'partial' || job.result?.project?.status === 'partial' || (job.result?.project?.conflicts ?? 0) > 0) return text.buildPartial;
  if (!job.result?.project) return text.buildUnconfirmed;
  return job.result.project.status === 'unchanged' ? text.buildUnchanged : text.buildCompleted;
}

function ProjectBuildResult({ t, job }: { t: Messages; job: Job }) {
  const result = job.result?.project;
  if (!result) return null;
  const text = t.learningCountdown;
  const published = result.created + result.updated + result.unchanged > 0;
  return <div className="learning-countdown-result" data-project-status={result.status} data-saved={published || undefined} role="status">
    <p className="small">{text.buildSources(result.read, result.inventory, result.unique, result.deduplicated, result.excluded)}</p>
    <p className="small">{text.buildCoverage(result.notes, result.topics, result.conflicts)}</p>
    <p className="small">{text.buildNotes(result.created, result.updated, result.unchanged)}</p>
    <p className="muted small">{text.buildSynthesis(result.synthesizedSources, result.modelRequests)}</p>
    {published && result.indexed === false && <p className="small">{text.buildIndexUnconfirmed}</p>}
    <p className="muted small">{text.buildVerification}</p>
  </div>;
}

function KnowledgeResult({ t, job }: { t: Messages; job: Job }) {
  const result = job.result?.knowledge;
  if (!result || result.status === 'skipped') return null;
  return <div className="learning-countdown-result" data-saved={result.status === 'saved' || undefined} role="status">
    <p className="small">{result.status === 'saved' ? t.learningCountdown.learningNoteSaved : t.learningCountdown.learningNoteFailed}</p>
    {result.status === 'saved' && result.indexed === false && <p className="muted small">{t.learningCountdown.indexPending}</p>}
    {result.status === 'saved' && (job.state === 'partial' || job.state === 'cancelled' || job.state === 'failed')
      && <p className="muted small">{t.learningCountdown.knowledgePartial}</p>}
  </div>;
}

function MeetingResult({ t, job }: { t: Messages; job: Job }) {
  const result = job.result?.meeting;
  if (!result) return null;
  const saved = result.knowledge === 'saved';
  const incomplete = result.outcome !== 'completed' || job.state === 'partial' || job.state === 'failed' || job.state === 'cancelled';
  return <div className="learning-countdown-result" data-saved={saved || undefined} role="status" aria-atomic="true">
    <p className="small">{saved ? t.learningCountdown.knowledgeSaved : result.knowledge === 'failed'
      ? t.learningCountdown.knowledgeFailed : t.learningCountdown.knowledgeUnavailable}</p>
    {saved && result.indexed === false && <p className="muted small">{t.learningCountdown.indexPending}</p>}
    {saved && incomplete && <p className="muted small">{t.learningCountdown.knowledgePartial}</p>}
  </div>;
}

function SkillSavedNotice({ t, job, notice, memory, onDismiss }: {
  t: Messages; job: Job; notice: SkillNotice; memory?: NoticeMemory | undefined; onDismiss?: ((id: string) => void) | undefined;
}) {
  const [flash] = useState(() => Boolean(memory && !memory.has(notice.id)));
  useEffect(() => { memory?.record(notice.id); }, [memory, notice.id]);
  const text = t.learningCountdown;
  const title = notice.change === 'new' ? text.skillNew : notice.change === 'revised' ? text.skillRevised : text.skillSaved;
  return <li className="learning-countdown-receipt" data-receipt-id={notice.id} data-flash={flash || undefined}>
    <div className="learning-countdown-job-heading"><Icon name="spark" /><strong>{title}</strong>
      {onDismiss && <button type="button" className="icon-button" aria-label={text.dismissSkill(notice.label || notice.packageId)} onClick={() => onDismiss(notice.id)}><Icon name="close" /></button>}
    </div>
    <div role="status" aria-live="polite" aria-atomic="true">
      <p className="learning-countdown-skill-name small">{notice.label || notice.packageId}</p>
      <LearningScope t={t} job={job} />
      <p className="muted small">{text.candidateReview}<span className="learning-countdown-skill-state">{t.skillCenter.states[notice.state] ?? text.reviewPending}</span></p>
      {(notice.partial || job.state === 'partial' || job.state === 'failed' || job.state === 'cancelled') && <p className="muted small">{text.skillPartial}</p>}
    </div>
  </li>;
}

/** One host-owned countdown across Office, Chat, Knowledge and Settings. */
export function LearningCountdown({ agents, t, target, compactTarget, embedded, dismissalScope }: {
  agents: AgentHostApi; t: Messages; target?: HTMLElement | null; compactTarget?: HTMLElement | null; embedded?: boolean | undefined; dismissalScope?: string | undefined;
}) {
  const [snapshot, setSnapshot] = useState<LearningScheduleSnapshot>();
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [accepted, setAccepted] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState<{ id: string; identity: string }[]>([]);
  const [dismissedSkills, setDismissedSkills] = useState<{ id: string; identity: string }[]>([]);
  const [, setDismissalRevision] = useState(0);
  const [dismissalBinding, setDismissalBinding] = useState(() => ({ scope: dismissalScope, store: createLearningNoticeDismissals(dismissalScope) }));
  if (dismissalBinding.scope !== dismissalScope) {
    setDismissalBinding({ scope: dismissalScope, store: createLearningNoticeDismissals(dismissalScope) });
    setDismissed([]); setDismissedSkills([]); setAccepted([]);
  }
  const dismissalStore = dismissalBinding.store;
  const [noticeMemory] = useState(createLearningNoticeMemory);
  const serial = useRef(0);
  const changing = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    if (!agents.learningSchedule || !agents.changeLearningSchedule) return;
    mounted.current = true;
    serial.current++;
    let stopped = false, refreshing = false, refreshAgain = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (refreshing) { refreshAgain = true; return; }
      refreshing = true;
      let nextDelay = 5000;
      if (!changing.current) {
        const request = ++serial.current;
        try {
          const value = await agents.learningSchedule!();
          if (!stopped && request === serial.current) {
            setSnapshot(value); setNow(Date.now()); setAccepted(previous => rememberStartedLearning(previous, value)); setError(undefined);
            nextDelay = value.jobs.some(job => job.state === 'scheduled' || job.state === 'running') ? 1000 : 5000;
          }
        } catch (failure) {
          if (!stopped && request === serial.current) setError(errorMessage(failure));
        }
      } else nextDelay = 1000;
      refreshing = false;
      if (!stopped && refreshAgain) { refreshAgain = false; void refresh(); }
      else if (!stopped) timer = setTimeout(() => { void refresh(); }, nextDelay);
    };
    const requested = () => { clearTimeout(timer); void refresh(); };
    if (typeof window !== 'undefined') window.addEventListener(LEARNING_SCHEDULE_REFRESH_EVENT, requested);
    void refresh();
    return () => { stopped = true; mounted.current = false; clearTimeout(timer); if (typeof window !== 'undefined') window.removeEventListener(LEARNING_SCHEDULE_REFRESH_EVENT, requested); };
  }, [agents]);

  useEffect(() => {
    if (typeof window === 'undefined' || !dismissalStore.key) return;
    const changed = (event: StorageEvent) => {
      if (event.key !== dismissalStore.key && event.key !== null) return;
      dismissalStore.refresh(); setDismissalRevision(value => value + 1);
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [dismissalStore]);

  const active = snapshot?.jobs.some(job => job.state === 'scheduled' && !waitingForIdle(job));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const act = async (job: Job, action: Action) => {
    if (!snapshot || changing.current || !agents.changeLearningSchedule) return;
    if (action === 'resume' ? !job.recovery || !['queued', 'resumable', 'publication'].includes(job.recovery.state)
      : job.state !== 'scheduled' || action === 'run-now' && waitingForIdle(job)) return;
    changing.current = true;
    const request = ++serial.current;
    setBusyId(job.id); setError(undefined);
    try {
      const value = await agents.changeLearningSchedule(job.id, snapshot.revision, action);
      if (mounted.current && request === serial.current) {
        setSnapshot(value); setNow(Date.now()); setAccepted(previous => rememberStartedLearning(previous, value));
        if (action === 'run-now' || action === 'resume') setAccepted(previous => [...previous.slice(-127), job.id]);
      }
    } catch (failure) {
      if (mounted.current && request === serial.current) setError(errorMessage(failure));
      // A stale revision is resolved from the host, never by altering a local countdown.
      try {
        const value = await agents.learningSchedule!();
        if (mounted.current && request === serial.current) { setSnapshot(value); setNow(Date.now()); setAccepted(previous => rememberStartedLearning(previous, value)); }
      } catch { /* The next bounded poll retries after a connection failure. */ }
    } finally {
      changing.current = false;
      if (mounted.current && request === serial.current) setBusyId(undefined);
    }
  };
  if (!snapshot) return null;
  const jobs = [...new Map(snapshot.jobs.map(job => [job.id, job])).values()];
  const skillNotices = [...new Map(jobs.flatMap(job => job.result?.skill ? [[job.result.skill.id, job.result.skill] as const] : [])).values()];
  const dismissedIds = jobs.filter(job => terminalLearningNotice(job) && (dismissalStore.hasJob(job) || dismissed.some(item => item.id === job.id && item.identity === learningJobNoticeKey(job)))).map(job => job.id);
  const dismissedSkillIds = skillNotices.filter(notice => dismissalStore.hasSkill(notice) || dismissedSkills.some(item => item.id === notice.id && item.identity === learningSkillNoticeKey(notice))).map(notice => notice.id);
  return <LearningCountdownPlacement t={t} target={target} compactTarget={compactTarget} accepted={accepted} snapshot={snapshot} now={now} busyId={busyId} error={error} dismissed={dismissedIds}
    dismissedSkills={dismissedSkillIds} noticeMemory={noticeMemory} embedded={embedded ?? Boolean(target)}
    onAction={(job, action) => { void act(job, action); }} onDismiss={id => {
      const job = jobs.find(job => job.id === id); if (!job || !terminalLearningNotice(job)) return;
      dismissalStore.dismissJob(job);
      setDismissed(previous => [...previous.slice(-511), { id, identity: learningJobNoticeKey(job) }]);
    }} onDismissSkill={id => {
      const notice = skillNotices.find(notice => notice.id === id); if (!notice) return;
      dismissalStore.dismissSkill(notice);
      setDismissedSkills(previous => [...previous.slice(-511), { id, identity: learningSkillNoticeKey(notice) }]);
    }} />;
}

/** Pending decisions stay near the composer; accepted/background work has one compact corner owner. */
export function LearningCountdownPlacement({ target, compactTarget, accepted = [], ...props }: Parameters<typeof LearningCountdownView>[0] & {
  target?: HTMLElement | null | undefined; compactTarget?: HTMLElement | null | undefined; accepted?: readonly string[];
}) {
  const foreground = props.snapshot.jobs.filter(job => job.state === 'scheduled' && !accepted.includes(job.id)
    && !((job.kind === 'knowledge-meeting' || job.kind === 'knowledge-build') && job.delaySeconds === 10));
  const foregroundIds = new Set(foreground.map(job => job.id));
  const background = props.snapshot.jobs.filter(job => !foregroundIds.has(job.id));
  const pending = <LearningCountdownView {...props} relatedJobs={props.snapshot.jobs} snapshot={{ ...props.snapshot, jobs: foreground, recoveryUnavailable: false, recoveryIncomplete: false }} />;
  const compact = <LearningCountdownView {...props} relatedJobs={props.snapshot.jobs} embedded={false} compact snapshot={{ ...props.snapshot, jobs: background }} />;
  return <>
    {target ? createPortal(pending, target) : props.embedded ? null : pending}
    {compactTarget ? createPortal(compact, compactTarget) : compact}
  </>;
}
