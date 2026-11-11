import type { AgentHostApi, LearningScheduleSnapshot } from '@extalia/platform';
import { useEffect, useRef, useState } from 'react';
import type { Messages } from '../i18n';
import { errorMessage } from '../host/remote';
import { Icon } from '../ui/Icon';
import './LearningCountdown.css';

type Job = LearningScheduleSnapshot['jobs'][number];
type Action = 'snooze' | 'run-now';

/** Only the host deadline is authoritative; reaching zero does not claim execution. */
export function learningCountdownTime(dueAt: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(dueAt) - now) / 1000));
  if (!Number.isFinite(seconds)) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Shared presentation for the live notification and isolated browser QA. */
export function LearningCountdownView({ t, snapshot, now, busyId, error, dismissed = [], onAction, onDismiss }: {
  t: Messages; snapshot: LearningScheduleSnapshot; now: number; busyId?: string | undefined; error?: string | undefined;
  dismissed?: readonly string[]; onAction: (job: Job, action: Action) => void; onDismiss: (id: string) => void;
}) {
  const text = t.learningCountdown;
  const visible = snapshot.jobs.filter(job => !dismissed.includes(job.id) && job.state !== 'completed');
  if (!visible.length) return null;
  return <aside className="learning-countdown" aria-label={text.title}>
    <div className="learning-countdown-heading"><Icon name="bulb" /><strong>{text.title}</strong></div>
    <p className="learning-countdown-help muted small">{text.help}</p>
    <ul className="learning-countdown-jobs">
      {visible.map(job => {
        const pending = job.state === 'scheduled';
        const running = job.state === 'running';
        const due = Date.parse(job.dueAt) <= now;
        const status = running ? text.running : pending
          ? job.reason === 'busy' ? text.busy : due ? text.starting : text.scheduled
          : job.state === 'failed' ? text.failed : text.cancelled;
        return <li key={job.id} className="learning-countdown-job" data-state={job.state} aria-busy={busyId === job.id || running}>
          <div className="learning-countdown-job-heading">
            <span className="learning-countdown-profile">{job.profileName}</span>
            {pending && <time className="learning-countdown-clock" dateTime={job.dueAt} aria-label={text.timeRemaining} aria-live="off">{learningCountdownTime(job.dueAt, now)}</time>}
            {!pending && !running && <button type="button" className="icon-button" aria-label={text.dismiss} onClick={() => onDismiss(job.id)}><Icon name="close" /></button>}
          </div>
          <p className="learning-countdown-status small" role="status">{status}</p>
          {!pending && !running && job.reason === 'changed' && <p className="muted small">{text.changed}</p>}
          {!pending && !running && job.reason === 'shutdown' && <p className="muted small">{text.interrupted}</p>}
          {pending && <div className="learning-countdown-actions">
            <button type="button" className="button small" disabled={Boolean(busyId)} onClick={() => onAction(job, 'snooze')}>{text.snooze(Math.round(snapshot.snoozeSeconds / 60))}</button>
            <button type="button" className="button small primary" disabled={Boolean(busyId)} onClick={() => onAction(job, 'run-now')}>{text.runNow}</button>
          </div>}
        </li>;
      })}
    </ul>
    {error && <p className="form-error small" role="alert">{error}</p>}
  </aside>;
}

/** One host-owned countdown across Office, Chat, Knowledge and Settings. */
export function LearningCountdown({ agents, t }: { agents: AgentHostApi; t: Messages }) {
  const [snapshot, setSnapshot] = useState<LearningScheduleSnapshot>();
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [dismissed, setDismissed] = useState<string[]>([]);
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

  const active = snapshot?.jobs.some(job => job.state === 'scheduled');
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const act = async (job: Job, action: Action) => {
    if (!snapshot || changing.current || !agents.changeLearningSchedule) return;
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
      if (mounted.current) setBusyId(undefined);
    }
  };
  if (!snapshot) return null;
  return <LearningCountdownView t={t} snapshot={snapshot} now={now} busyId={busyId} error={error} dismissed={dismissed}
    onAction={(job, action) => { void act(job, action); }} onDismiss={id => setDismissed(previous => [...previous.slice(-15), id])} />;
}
