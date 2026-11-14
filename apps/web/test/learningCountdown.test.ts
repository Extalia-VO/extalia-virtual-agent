import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LearningScheduleSnapshot } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { createLearningNoticeMemory, LearningCountdownView, learningCountdownDuration, learningCountdownTime } from '../src/knowledge/LearningCountdown';
import { MESSAGES, type Language } from '../src/i18n';

const at = Date.parse('2026-11-11T06:00:00.000Z');
function snapshot(state: LearningScheduleSnapshot['jobs'][number]['state'] = 'scheduled'): LearningScheduleSnapshot {
  return { revision: 'r1', delaySeconds: 60, snoozeSeconds: 600, jobs: [{ id: 'job', workspaceId: 'workspace', profileId: 'profile', profileName: 'Research', sessionId: 'session',
    state, dueAt: new Date(at + 60_000).toISOString(), createdAt: new Date(at).toISOString() }] };
}
function render(value: LearningScheduleSnapshot, language: Language = 'en', overrides: Partial<Parameters<typeof LearningCountdownView>[0]> = {}) {
  return renderToStaticMarkup(createElement(LearningCountdownView, { t: MESSAGES[language], snapshot: value, now: at, onAction: () => undefined, onDismiss: () => undefined, ...overrides }));
}
const receipt = (change: 'new' | 'revised' | 'saved' = 'saved') => ({ id: 'receipt', profileId: 'profile', workspaceId: 'workspace', sessionId: 'session',
  runId: 'run', createdAt: new Date(at).toISOString(), kind: 'skill-candidate' as const, packageId: 'example-skill', revisionId: 'saved-revision',
  state: 'quarantined', change, activationPerformed: false as const });

describe('learning countdown notification', () => {
  it('formats the host deadline without a negative countdown or claiming a dispatch', () => {
    expect(learningCountdownTime(new Date(at + 59_001).toISOString(), at)).toBe('1:00');
    expect(learningCountdownTime(new Date(at + 59_000).toISOString(), at)).toBe('0:59');
    expect(learningCountdownTime(new Date(at - 1).toISOString(), at)).toBe('0:00');
    expect(learningCountdownTime('invalid', at)).toBe('0:00');
    expect(learningCountdownDuration(60)).toBe('1:00');
    expect(learningCountdownDuration(600)).toBe('10:00');
    const html = render(snapshot(), 'en', { now: at + 60_001 });
    expect(html).toContain(MESSAGES.en.learningCountdown.starting);
    expect(html).not.toContain(MESSAGES.en.learningCountdown.running);
  });

  for (const language of ['en', 'id'] as const) it(`shows profile context, remaining time and two native controls in ${language}`, () => {
    const html = render(snapshot(), language);
    const text = MESSAGES[language].learningCountdown;
    expect(html).toContain(text.title);
    expect(html).toContain(text.scheduled);
    expect(html).toContain(text.help);
    expect(html).toContain('Research');
    expect(html).toContain('1:00');
    expect(html).toContain(text.runNow);
    expect(html).toContain(text.snooze(10));
    expect(html).toContain('aria-live="off"');
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).not.toContain('disabled');
  });

  it('shows busy deferral and disables conflicting actions while a command is pending', () => {
    const value = snapshot(); value.jobs[0]!.reason = 'busy';
    const html = render(value, 'en', { busyId: 'job' });
    expect(html).toContain(MESSAGES.en.learningCountdown.busy);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain('aria-busy="true"');
  });

  it('does not offer snooze/run-now for executing or failed effects and explains changed destinations', () => {
    const running = render(snapshot('running'));
    expect(running).toContain(MESSAGES.en.learningCountdown.running);
    expect(running).not.toContain('<button');
    expect(running).not.toContain('<time');
    const failed = snapshot('failed'); failed.jobs[0]!.reason = 'changed';
    const html = render(failed);
    expect(html).toContain(MESSAGES.en.learningCountdown.failed);
    expect(html).toContain(MESSAGES.en.learningCountdown.changed);
    expect(html).toContain(MESSAGES.en.learningCountdown.dismiss);
    expect(html).not.toContain(MESSAGES.en.learningCountdown.runNow);
  });

  it('hides completed and dismissed jobs and escapes profile names/errors as text', () => {
    expect(render(snapshot('completed'))).toBe('');
    expect(render(snapshot(), 'en', { dismissed: ['job'] })).toBe('');
    const value = snapshot(); value.jobs[0]!.profileName = '<img src=x onerror=alert(1)>';
    const html = render(value, 'en', { error: '<script>bad()</script>' });
    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
  });

  for (const language of ['en', 'id'] as const) it(`keeps meeting, project, session and idle status explicit in ${language}`, () => {
    const value = snapshot(); const job = value.jobs[0]!;
    Object.assign(job, { kind: 'knowledge-meeting', workspaceName: 'Project A', sessionName: 'Task A' });
    value.jobs.push({ ...job, id: 'other-project', workspaceId: 'workspace-b', workspaceName: 'Project B', sessionId: 'session-b', sessionName: 'Task B' });
    const text = MESSAGES[language].learningCountdown;
    const html = render(value, language, { embedded: true });
    expect(html).toContain('learning-countdown is-embedded');
    expect(html).toContain(text.meetingScheduled);
    for (const project of ['Project A', 'Project B']) expect(html).toContain(text.project(project));
    for (const session of ['Task A', 'Task B']) expect(html).toContain(text.session(session));
    expect(html).toContain(text.snooze(10));
    expect(html).toContain(text.quietPeriod);
    job.waitingForIdle = true;
    value.jobs = [job];
    const waiting = render(value, language, { now: at + 999_000 });
    expect(waiting).toContain(text.meetingWaiting);
    // Older hosts expose only the generic snapshot default; it cannot reveal a prior snooze.
    expect(waiting).toContain(text.waitingCountdownUnknown);
    expect(waiting).not.toContain(text.waitingCountdown('1:00'));
    expect(waiting).not.toContain('<time');
    expect(waiting).not.toContain(text.starting);
    expect(waiting.match(/disabled=""/g)).toHaveLength(1);
    expect(waiting).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${text.runNow}<\\/button>`));
    job.delaySeconds = 60;
    expect(render(value, language, { now: at + 999_000 })).toContain(text.waitingCountdown('1:00'));
    job.delaySeconds = 600;
    expect(render(value, language, { now: at + 999_000 })).toContain(text.waitingCountdown('10:00'));
  });

  it('shows the live host deadline once a quiet period is armed', () => {
    const value = snapshot();
    value.jobs[0]!.dueAt = new Date(at + 60_000).toISOString();
    expect(render(value, 'en', { now: at })).toContain('>1:00</time>');
    expect(render(value, 'en', { now: at + 59_000 })).toContain('>0:01</time>');
    expect(render(value, 'en', { now: at + 59_000 })).not.toContain(MESSAGES.en.learningCountdown.waitingCountdown('1:00'));
  });

  it('only confirms saved knowledge from the exporter receipt, including durable partial success', () => {
    const value = snapshot('running'); const job = value.jobs[0]!; job.kind = 'knowledge-meeting';
    const text = MESSAGES.en.learningCountdown;
    expect(render(value)).toContain(text.meetingRunning);
    expect(render(value)).not.toContain(text.knowledgeSaved);
    job.state = 'completed';
    expect(render(value)).toContain(text.meetingUnconfirmed);
    expect(render(value)).not.toContain(text.meetingCompleted);
    job.result = { meeting: { outcome: 'unknown', knowledge: 'unavailable' } };
    expect(render(value)).toContain(text.meetingUnconfirmed);
    expect(render(value)).not.toContain(text.meetingCompleted);
    job.result = { meeting: { outcome: 'completed', knowledge: 'unavailable' } };
    expect(render(value)).toContain(text.meetingCompleted);
    expect(render(value)).toContain(text.knowledgeUnavailable);
    expect(render(value)).not.toContain(text.knowledgeSaved);
    job.result.meeting = { outcome: 'completed', knowledge: 'saved', notePath: 'meetings/example.md' };
    expect(render(value)).toContain(text.knowledgeSaved);
    job.state = 'failed';
    job.result.meeting.outcome = 'failed';
    expect(render(value)).toContain(text.knowledgePartial);
    expect(render(value)).not.toContain(text.meetingCompleted);
    expect(render(value, 'en', { dismissed: ['job'] })).toBe('');
  });

  it('keeps a saved skill receipt visible independently of running, failed or cancelled execution', () => {
    const value = snapshot(); const job = value.jobs[0]!;
    job.result = { skill: receipt() };
    const text = MESSAGES.en.learningCountdown;
    for (const state of ['running', 'failed', 'cancelled', 'completed'] as const) {
      job.state = state;
      const html = render(value, 'en', { onDismissSkill: () => undefined });
      expect(html).toContain(text.skillSaved);
      expect(html).toContain(text.candidateReview);
      expect(html).toContain(MESSAGES.en.skillCenter.states.quarantined);
      expect(html).not.toContain(text.skillNew);
      expect(html).not.toContain(text.skillRevised);
      expect(html).not.toContain(text.meetingCompleted);
      expect(html.includes(text.skillPartial)).toBe(state === 'failed' || state === 'cancelled');
    }
    job.state = 'cancelled'; job.reason = 'busy';
    expect(render(value)).toContain(text.foregroundPriority);
    job.result.skill = receipt('new'); expect(render(value)).toContain(text.skillNew);
    job.result.skill = receipt('revised'); expect(render(value)).toContain(text.skillRevised);
  });

  it('deduplicates durable IDs and keeps job dismissal separate from a saved receipt', () => {
    const value = snapshot('failed'); const job = value.jobs[0]!;
    job.result = { skill: { ...receipt(), label: '<script>sample</script>', partial: true } };
    value.jobs.push({ ...job }, { ...job, id: 'second-job' });
    const html = render(value, 'en', { dismissed: ['job', 'second-job'] });
    expect(html.match(/data-receipt-id="receipt"/g)).toHaveLength(1);
    expect(html).toContain('&lt;script&gt;sample&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain(MESSAGES.en.learningCountdown.skillPartial);
    expect(render(value, 'en', { dismissed: ['job', 'second-job'], dismissedSkills: ['receipt'] })).toBe('');
  });

  it('uses bounded host-ID memory so rerendering or changing placement does not replay the saved flash', () => {
    const memory = createLearningNoticeMemory();
    const value = snapshot('completed'); value.jobs[0]!.result = { skill: receipt() };
    expect(render(value, 'en', { noticeMemory: memory })).toContain('data-flash="true"');
    memory.record('receipt');
    expect(render(value, 'en', { noticeMemory: memory, embedded: true })).not.toContain('data-flash');
    for (let i = 0; i < 128; i++) memory.record(`later-${i}`);
    expect(memory.has('receipt')).toBe(false);
    expect(memory.has('later-127')).toBe(true);
  });
});
