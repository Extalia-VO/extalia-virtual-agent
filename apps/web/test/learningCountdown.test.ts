import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LearningScheduleSnapshot } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { LearningCountdownView, learningCountdownTime } from '../src/knowledge/LearningCountdown';
import { MESSAGES, type Language } from '../src/i18n';

const at = Date.parse('2026-11-11T06:00:00.000Z');
function snapshot(state: LearningScheduleSnapshot['jobs'][number]['state'] = 'scheduled'): LearningScheduleSnapshot {
  return { revision: 'r1', delaySeconds: 60, snoozeSeconds: 600, jobs: [{ id: 'job', workspaceId: 'workspace', profileId: 'profile', profileName: 'Research', sessionId: 'session',
    state, dueAt: new Date(at + 60_000).toISOString(), createdAt: new Date(at).toISOString() }] };
}
function render(value: LearningScheduleSnapshot, language: Language = 'en', overrides: Partial<Parameters<typeof LearningCountdownView>[0]> = {}) {
  return renderToStaticMarkup(createElement(LearningCountdownView, { t: MESSAGES[language], snapshot: value, now: at, onAction: () => undefined, onDismiss: () => undefined, ...overrides }));
}

describe('learning countdown notification', () => {
  it('formats the host deadline without a negative countdown or claiming a dispatch', () => {
    expect(learningCountdownTime(new Date(at + 59_001).toISOString(), at)).toBe('1:00');
    expect(learningCountdownTime(new Date(at + 59_000).toISOString(), at)).toBe('0:59');
    expect(learningCountdownTime(new Date(at - 1).toISOString(), at)).toBe('0:00');
    expect(learningCountdownTime('invalid', at)).toBe('0:00');
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
});
