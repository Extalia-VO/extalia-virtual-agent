import type { AgentHostApi, LearningScheduleSnapshot } from '@extalia/platform';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Messages } from '../i18n';
import { errorMessage } from '../host/remote';
import { Icon } from '../ui/Icon';
import './LearningCountdown.css';

type Job = LearningScheduleSnapshot['jobs'][number];
type Action = 'snooze' | 'run-now';
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

/** Only the host deadline is authoritative; reaching zero does not claim execution. */
export function learningCountdownTime(dueAt: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(dueAt) - now) / 1000));
  if (!Number.isFinite(seconds)) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Shared presentation for the live notification and isolated browser QA. */
export function LearningCountdownView({ t, snapshot, now, busyId, error, dismissed = [], dismissedSkills = [], embedded = false, noticeMemory, onAction, onDismiss, onDismissSkill }: {
  t: Messages; snapshot: LearningScheduleSnapshot; now: number; busyId?: string | undefined; error?: string | undefined;
  dismissed?: readonly string[]; onAction: (job: Job, action: Action) => void; onDismiss: (id: string) => void;
  dismissedSkills?: readonly string[]; embedded?: boolean; noticeMemory?: NoticeMemory; onDismissSkill?: (id: string) => void;
}) {
  const text = t.learningCountdown;
  const jobs = [...new Map(snapshot.jobs.map(job => [job.id, job])).values()];
  const visible = jobs.filter(job => !dismissed.includes(job.id) && (job.state !== 'completed' || job.kind === 'knowledge-meeting'));
  // Artifact receipts are independent of execution state, including a later failure or cancellation.
  const receipts = [...new Map(jobs.flatMap(job => job.result?.skill && !dismissedSkills.includes(job.result.skill.id)
    ? [[job.result.skill.id, { job, notice: job.result.skill }] as const] : [])).values()];
  if (!visible.length && !receipts.length) return null;
  return <aside className={`learning-countdown${embedded ? ' is-embedded' : ''}`} aria-label={text.title}>
    <div className="learning-countdown-heading"><Icon name="bulb" /><strong>{text.title}</strong></div>
    <p className="learning-countdown-help muted small">{text.help}</p>
    <ul className="learning-countdown-jobs">
      {visible.map(job => {
        const pending = job.state === 'scheduled';
        const running = job.state === 'running';
        const meeting = job.kind === 'knowledge-meeting';
        const waiting = waitingForIdle(job);
        const due = Date.parse(job.dueAt) <= now;
        const status = running ? meeting ? text.meetingRunning : text.running : pending
          ? waiting ? meeting ? text.meetingWaiting : text.busy : due ? text.starting : meeting ? text.meetingScheduled : text.scheduled
          : job.state === 'completed' ? job.result?.meeting?.outcome === 'completed' ? text.meetingCompleted
            : job.result?.meeting?.outcome === 'failed' ? text.failed
              : job.result?.meeting?.outcome === 'cancelled' ? text.cancelled : text.meetingUnconfirmed
            : job.state === 'failed' ? text.failed : text.cancelled;
        return <li key={job.id} className="learning-countdown-job" data-state={job.state} data-kind={job.kind ?? 'learning'} aria-busy={busyId === job.id || running}>
          <div className="learning-countdown-job-heading">
            <span className="learning-countdown-profile">{job.profileName}</span>
            {pending && !waiting && <time className="learning-countdown-clock" dateTime={job.dueAt} aria-label={text.timeRemaining} aria-live="off">{learningCountdownTime(job.dueAt, now)}</time>}
            {!pending && !running && <button type="button" className="icon-button" aria-label={text.dismiss} onClick={() => onDismiss(job.id)}><Icon name="close" /></button>}
          </div>
          <LearningScope t={t} job={job} />
          <p className="learning-countdown-status small" role="status">{status}</p>
          {pending && <p className="learning-countdown-quiet muted small">{text.quietPeriod}</p>}
          {job.result?.meeting && <MeetingResult t={t} job={job} />}
          {!pending && !running && job.reason === 'changed' && <p className="muted small">{text.changed}</p>}
          {!pending && !running && job.reason === 'shutdown' && <p className="muted small">{text.interrupted}</p>}
          {!pending && !running && job.reason === 'busy' && <p className="muted small">{text.foregroundPriority}</p>}
          {pending && <div className="learning-countdown-actions">
            <button type="button" className="button small" disabled={Boolean(busyId)} onClick={() => onAction(job, 'snooze')}>{text.snooze(Math.round(snapshot.snoozeSeconds / 60))}</button>
            <button type="button" className="button small primary" disabled={Boolean(busyId) || waiting} onClick={() => onAction(job, 'run-now')}>{text.runNow}</button>
          </div>}
        </li>;
      })}
      {receipts.map(({ job, notice }) => <SkillSavedNotice key={notice.id} t={t} job={job} notice={notice} memory={noticeMemory} onDismiss={onDismissSkill} />)}
    </ul>
    {error && <p className="form-error small" role="alert">{error}</p>}
  </aside>;
}

function LearningScope({ t, job }: { t: Messages; job: Job }) {
  return <p className="learning-countdown-scope muted small">{t.learningCountdown.project(job.workspaceName || job.workspaceId)}
    <span aria-hidden="true"> · </span>{t.learningCountdown.session(job.sessionName || job.sessionId)}</p>;
}

function MeetingResult({ t, job }: { t: Messages; job: Job }) {
  const result = job.result?.meeting;
  if (!result) return null;
  const saved = result.knowledge === 'saved';
  const incomplete = result.outcome !== 'completed' || job.state === 'failed' || job.state === 'cancelled';
  return <div className="learning-countdown-result" data-saved={saved || undefined} role="status" aria-atomic="true">
    <p className="small">{saved ? t.learningCountdown.knowledgeSaved : result.knowledge === 'failed'
      ? t.learningCountdown.knowledgeFailed : t.learningCountdown.knowledgeUnavailable}</p>
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
      {(notice.partial || job.state === 'failed' || job.state === 'cancelled') && <p className="muted small">{text.skillPartial}</p>}
    </div>
  </li>;
}

/** One host-owned countdown across Office, Chat, Knowledge and Settings. */
export function LearningCountdown({ agents, t, target }: { agents: AgentHostApi; t: Messages; target?: HTMLElement | null }) {
  const [snapshot, setSnapshot] = useState<LearningScheduleSnapshot>();
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [dismissedSkills, setDismissedSkills] = useState<string[]>([]);
  const [noticeMemory] = useState(createLearningNoticeMemory);
  const serial = useRef(0);
  const changing = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    if (!agents.learningSchedule || !agents.changeLearningSchedule) return;
    mounted.current = true;
    serial.current++;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      let nextDelay = 5000;
      if (!changing.current) {
        const request = ++serial.current;
        try {
          const value = await agents.learningSchedule!();
          if (!stopped && request === serial.current) {
            setSnapshot(value); setNow(Date.now()); setError(undefined);
            nextDelay = value.jobs.some(job => job.state === 'scheduled' || job.state === 'running') ? 1000 : 5000;
          }
        } catch (failure) {
          if (!stopped && request === serial.current) setError(errorMessage(failure));
        }
      } else nextDelay = 1000;
      if (!stopped) timer = setTimeout(() => { void refresh(); }, nextDelay);
    };
    void refresh();
    return () => { stopped = true; mounted.current = false; clearTimeout(timer); };
  }, [agents]);

  const active = snapshot?.jobs.some(job => job.state === 'scheduled' && !waitingForIdle(job));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const act = async (job: Job, action: Action) => {
    if (!snapshot || changing.current || !agents.changeLearningSchedule || job.state !== 'scheduled' || action === 'run-now' && waitingForIdle(job)) return;
    changing.current = true;
    const request = ++serial.current;
    setBusyId(job.id); setError(undefined);
    try {
      const value = await agents.changeLearningSchedule(job.id, snapshot.revision, action);
      if (mounted.current && request === serial.current) { setSnapshot(value); setNow(Date.now()); }
    } catch (failure) {
      if (mounted.current && request === serial.current) setError(errorMessage(failure));
      // A stale revision is resolved from the host, never by altering a local countdown.
      try {
        const value = await agents.learningSchedule!();
        if (mounted.current && request === serial.current) { setSnapshot(value); setNow(Date.now()); }
      } catch { /* The next bounded poll retries after a connection failure. */ }
    } finally {
      changing.current = false;
      if (mounted.current && request === serial.current) setBusyId(undefined);
    }
  };
  if (!snapshot) return null;
  const view = <LearningCountdownView t={t} snapshot={snapshot} now={now} busyId={busyId} error={error} dismissed={dismissed}
    dismissedSkills={dismissedSkills} noticeMemory={noticeMemory} embedded={Boolean(target)}
    onAction={(job, action) => { void act(job, action); }} onDismiss={id => setDismissed(previous => [...previous.slice(-31), id])}
    onDismissSkill={id => setDismissedSkills(previous => [...previous.slice(-63), id])} />;
  // Keep polling, command guards and dismissals in this one App owner while its view changes placement.
  return target ? createPortal(view, target) : view;
}
