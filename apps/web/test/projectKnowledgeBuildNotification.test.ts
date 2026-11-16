import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, LearningScheduleJob, LearningScheduleSnapshot, ProjectKnowledgeBuildResult } from '@extalia/platform';
import { describe, expect, it, vi } from 'vitest';
import { LearningCountdownPlacement, LearningCountdownView } from '../src/knowledge/LearningCountdown';
import { KnowledgeUpdateButton } from '../src/knowledge/KnowledgeUpdateButton';
import { MESSAGES, type Language } from '../src/i18n';

vi.mock('react-dom', () => ({ createPortal: (view: ReactElement) => view }));
const at = Date.parse('2026-11-16T03:00:00.000Z');
const job = (patch: Partial<LearningScheduleJob> = {}): LearningScheduleJob => ({
  id: 'project-build', kind: 'knowledge-build', workspaceId: 'workspace', sessionId: 'session', profileId: 'profile', profileName: 'Project notes',
  state: 'scheduled', delaySeconds: 10, dueAt: new Date(at + 10_000).toISOString(), createdAt: new Date(at).toISOString(), ...patch,
});
const receipt = (patch: Partial<ProjectKnowledgeBuildResult> = {}): ProjectKnowledgeBuildResult => ({
  status: 'saved', inventory: 18, read: 15, unique: 13, deduplicated: 2, excluded: 3,
  created: 4, updated: 2, unchanged: 7, notes: 13, topics: 7, conflicts: 0, modelRequests: 3, synthesizedSources: 11, indexed: true, ...patch,
});
const snapshot = (jobs: LearningScheduleJob[]): LearningScheduleSnapshot => ({ revision: 'r1', jobs, delaySeconds: 60, snoozeSeconds: 600 });
function render(jobs: LearningScheduleJob[], language: Language = 'en', compact = false) {
  return renderToStaticMarkup(createElement(LearningCountdownView, { t: MESSAGES[language], snapshot: snapshot(jobs), now: at,
    compact, onAction: vi.fn(), onDismiss: vi.fn() }));
}

describe('source-grounded project knowledge builds', () => {
  it.each(['en', 'id'] as const)('distinguishes source-build states from automatic meetings in %s', language => {
    const text = MESSAGES[language].learningCountdown;
    expect(render([job()], language)).toContain(text.buildScheduled);
    expect(render([job({ waitingForIdle: true })], language)).toContain(text.buildWaiting);
    expect(render([job({ dueAt: new Date(at).toISOString() })], language)).toContain(text.buildStarting);
    const running = render([job({ state: 'running' })], language);
    expect(running).toContain(text.buildRunning);
    expect(running).not.toContain(text.meetingRunning);
    expect(running).not.toContain(text.buildCompleted);
  });

  it.each(['en', 'id'] as const)('never claims publication from executor completion alone in %s', language => {
    const text = MESSAGES[language].learningCountdown;
    const html = render([job({ state: 'completed' })], language, true);
    expect(html).toContain(text.buildUnconfirmed);
    expect(html).not.toContain(text.buildCompleted);
    expect(html).not.toContain(text.completed);
    expect(html).not.toContain(text.buildSources(0, 0, 0, 0, 0));
  });

  it.each(['en', 'id'] as const)('shows actual source, synthesis, note and deduplication counts in the compact receipt in %s', language => {
    const text = MESSAGES[language].learningCountdown;
    const html = render([job({ state: 'completed', result: { project: receipt() } })], language, true);
    expect(html).toContain('is-compact');
    expect(html).toContain(text.buildCompleted);
    expect(html).toContain(text.buildSources(15, 18, 13, 2, 3));
    expect(html).toContain(text.buildNotes(4, 2, 7));
    expect(html).toContain(text.buildCoverage(13, 7, 0));
    expect(html).toContain(text.buildSynthesis(11, 3));
    expect(html).toContain(text.buildVerification);
    expect(html).not.toContain(text.buildIndexUnconfirmed);
    expect(html).not.toContain(text.meetingCompleted);
  });

  it.each(['en', 'id'] as const)('retains unchanged, partial and failed receipts without inventing full success in %s', language => {
    const text = MESSAGES[language].learningCountdown;
    const unchanged = render([job({ state: 'completed', result: { project: receipt({ status: 'unchanged', created: 0, updated: 0, unchanged: 13, modelRequests: 0 }) } })], language);
    expect(unchanged).toContain(text.buildUnchanged);
    expect(unchanged).toContain(text.buildNotes(0, 0, 13));
    expect(unchanged).not.toContain(text.buildCompleted);
    const partial = render([job({ state: 'completed', result: { project: receipt({ status: 'partial', indexed: false }) } })], language);
    expect(partial).toContain(text.buildPartial);
    expect(partial).toContain(text.buildIndexUnconfirmed);
    expect(partial).not.toContain(text.buildCompleted);
    const failed = render([job({ state: 'failed', result: { project: receipt({ status: 'failed', created: 0, updated: 0, unchanged: 0, indexed: false }) } })], language);
    expect(failed).toContain(text.buildFailed);
    expect(failed).not.toContain(text.buildIndexUnconfirmed);
    expect(failed).not.toContain(text.buildCompleted);
  });

  it.each(['en', 'id'] as const)('reports flagged source conflicts as partial rather than full completion in %s', language => {
    const text = MESSAGES[language].learningCountdown;
    const html = render([job({ state: 'completed', result: { project: receipt({ conflicts: 2 }) } })], language, true);
    expect(html).toContain(text.buildPartial);
    expect(html).toContain(text.buildCoverage(13, 7, 2));
    expect(html).not.toContain(text.buildCompleted);
    expect(html).not.toContain(text.buildUnchanged);
  });

  it('keeps saved publication confirmed when only indexing is unconfirmed', () => {
    const text = MESSAGES.en.learningCountdown;
    const html = render([job({ state: 'completed', result: { project: receipt({ indexed: false }) } })], 'en', true);
    expect(html).toContain(text.buildCompleted);
    expect(html).toContain(text.buildIndexUnconfirmed);
    expect(html).not.toContain(text.buildFailed);
    expect(html).not.toContain(text.buildUnconfirmed);
  });

  it('keeps legacy learning, automatic meetings and new builds distinct in a mixed host snapshot', () => {
    const text = MESSAGES.en.learningCountdown;
    const legacy = job({ id: 'legacy', state: 'running' }); delete legacy.kind;
    const html = render([
      legacy,
      job({ id: 'meeting', profileId: 'other-profile', kind: 'knowledge-meeting', state: 'running' }),
      job({ id: 'source-build', state: 'running' }),
    ]);
    expect(html).toContain(text.running);
    expect(html).toContain(text.meetingRunning);
    expect(html).toContain(text.buildRunning);
    expect(html).toContain('data-kind="learning"');
    expect(html).toContain('data-kind="knowledge-meeting"');
    expect(html).toContain('data-kind="knowledge-build"');
  });

  it('places the accepted ten-second build directly in the corner while unaccepted learning stays inline', () => {
    const tree = LearningCountdownPlacement({ t: MESSAGES.en, snapshot: snapshot([job(), job({ id: 'waiting-learning', kind: 'learning', delaySeconds: 60 })]),
      target: {} as HTMLElement, now: at, onAction: vi.fn(), onDismiss: vi.fn() });
    const views = (tree.props.children as unknown[]).filter(isValidElement) as ReactElement<Parameters<typeof LearningCountdownView>[0]>[];
    expect(views[0]!.props.snapshot.jobs.map(job => job.id)).toEqual(['waiting-learning']);
    expect(views[1]!.props.snapshot.jobs.map(job => job.id)).toEqual(['project-build']);
    expect(views[1]!.props.compact).toBe(true);
  });

  it.each(['en', 'id'] as const)('describes reading project Markdown and reusing unchanged linked notes on the manual action in %s', language => {
    const t = MESSAGES[language];
    const html = renderToStaticMarkup(createElement(KnowledgeUpdateButton, { t, agents: { requestKnowledgeUpdate: vi.fn() } as unknown as AgentHostApi, workspaceId: 'workspace' }));
    expect(html).toContain(t.knowledge.updateTeam);
    expect(html).toContain(t.knowledge.updateTeamHint);
    expect(html).not.toContain(t.learningCountdown.meetingRunning);
  });
});


describe('one Knowledge notice per workspace and vault profile', () => {
  const older = new Date(at - 2_000).toISOString();
  it.each(['failed', 'partial', 'completed'] as const)('replaces an older %s notice through a new build and unchanged rerun', previousState => {
    const previous = job({ id: 'previous', profileName: 'Previous output', state: previousState, createdAt: older });
    for (const state of ['scheduled', 'running', 'completed'] as const) {
      const current = job({ id: 'current', profileName: 'Current output', state,
        ...(state === 'completed' ? { result: { project: receipt({ status: 'unchanged' }) } } : {}) });
      const html = render([current, previous]);
      expect(html.match(/class="learning-countdown-job"/g)).toHaveLength(1);
      expect(html).toContain('Current output');
      expect(html).not.toContain('Previous output');
      if (state === 'completed') expect(html).toContain(MESSAGES.en.learningCountdown.buildUnchanged);
    }
  });

  it('keeps active work visible even when terminal records are newer or later in the snapshot', () => {
    for (const state of ['scheduled', 'running'] as const) {
      const html = render([job({ id: 'active', state, profileName: 'Active output', createdAt: older }),
        job({ id: 'terminal', state: 'completed', profileName: 'Terminal output' })]);
      expect(html.match(/class="learning-countdown-job"/g)).toHaveLength(1);
      expect(html).toContain('Active output');
      expect(html).not.toContain('Terminal output');
    }
  });

  it('preserves notices from other workspaces and profiles', () => {
    const html = render([
      job({ id: 'old', profileName: 'Superseded output', state: 'failed', createdAt: older }),
      job({ id: 'current', profileName: 'Current output', state: 'running' }),
      job({ id: 'other-workspace', workspaceId: 'other-workspace', profileName: 'Other workspace output', state: 'completed' }),
      job({ id: 'other-profile', profileId: 'other-profile', profileName: 'Other profile output', state: 'failed' }),
    ]);
    expect(html.match(/class="learning-countdown-job"/g)).toHaveLength(3);
    expect(html).not.toContain('Superseded output');
    for (const label of ['Current output', 'Other workspace output', 'Other profile output']) expect(html).toContain(label);
  });

  it.each(['knowledge-build', 'knowledge-meeting'] as const)('replaces a previous %s with the current update across the inline and compact owners', previousKind => {
    const old = job({ id: 'old', kind: previousKind, state: 'completed', profileName: 'Previous output', createdAt: older });
    const current = job({ id: 'current', kind: previousKind === 'knowledge-build' ? 'knowledge-meeting' : 'knowledge-build',
      profileName: 'Current output', delaySeconds: 60 });
    const tree = LearningCountdownPlacement({ t: MESSAGES.en, snapshot: snapshot([old, current]),
      target: {} as HTMLElement, now: at, onAction: vi.fn(), onDismiss: vi.fn() });
    const views = (tree.props.children as unknown[]).filter(isValidElement) as ReactElement<Parameters<typeof LearningCountdownView>[0]>[];
    const html = views.map(view => renderToStaticMarkup(view)).join('');
    expect(html.match(/class="learning-countdown-job"/g)).toHaveLength(1);
    expect(html).toContain('Current output');
    expect(html).not.toContain('Previous output');
    expect(snapshot([old, current]).jobs.map(job => job.id)).toEqual(['old', 'current']);
  });

  it('preserves a skill artifact from superseded Knowledge work and does not resurrect old notices after dismissal', () => {
    const old = job({ id: 'old', state: 'completed', profileName: 'Previous output', createdAt: older, result: { skill: {
      id: 'skill-receipt', profileId: 'profile', workspaceId: 'workspace', sessionId: 'session', runId: 'run', createdAt: older,
      kind: 'skill-candidate', packageId: 'reusable-validation', revisionId: 'revision', state: 'quarantined', change: 'saved', activationPerformed: false,
    } } });
    const current = job({ id: 'current', profileName: 'Current output', state: 'completed', result: { project: receipt({ status: 'unchanged' }) } });
    const html = renderToStaticMarkup(createElement(LearningCountdownView, { t: MESSAGES.en, snapshot: snapshot([old, current]), now: at,
      dismissed: ['current'], onAction: vi.fn(), onDismiss: vi.fn() }));
    expect(html).toContain('data-receipt-id="skill-receipt"');
    expect(html).toContain('reusable-validation');
    expect(html).not.toContain('class="learning-countdown-job"');
    expect(html).not.toContain('Previous output');
    expect(html).not.toContain('Current output');
  });
});
