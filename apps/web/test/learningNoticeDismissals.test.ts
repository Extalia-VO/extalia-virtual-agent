import type { LearningScheduleJob, LearningSkillNotice } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { createLearningNoticeDismissals, learningJobNoticeKey } from '../src/knowledge/learningNoticeDismissals';

const stamp = '2026-11-16T00:00:00.000Z';
const job = (patch: Partial<LearningScheduleJob> = {}): LearningScheduleJob => ({ id: 'job', workspaceId: 'workspace', profileId: 'profile', profileName: 'Example',
  sessionId: 'session', kind: 'knowledge-meeting', state: 'completed', createdAt: stamp, dueAt: stamp,
  result: { meeting: { outcome: 'completed', knowledge: 'saved', notePath: 'Meetings/workspace/note.md', indexed: true } }, ...patch });
const skill = (patch: Partial<LearningSkillNotice> = {}): LearningSkillNotice => ({ id: 'skill-receipt', profileId: 'profile', workspaceId: 'workspace', sessionId: 'session',
  runId: 'run', createdAt: stamp, kind: 'skill-candidate', packageId: 'validation', revisionId: 'revision-1', state: 'quarantined', change: 'saved', activationPerformed: false, ...patch });
function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
const scope = JSON.stringify(['profile', '/example/profile']);

describe('durable explicit learning notice dismissals', () => {
  it('survives a fresh store while keeping other hosts, new attempts and changed terminal outcomes visible', () => {
    const cache = storage(), first = createLearningNoticeDismissals(scope, () => cache);
    first.dismissJob(job());
    const reloaded = createLearningNoticeDismissals(scope, () => cache);
    expect(reloaded.hasJob(job())).toBe(true);
    expect(createLearningNoticeDismissals(`${scope}-other-host`, () => cache).hasJob(job())).toBe(false);
    expect(reloaded.hasJob(job({ id: 'new-job' }))).toBe(false);
    expect(reloaded.hasJob(job({ createdAt: '2026-11-17T00:00:00.000Z' }))).toBe(false);
    expect(reloaded.hasJob(job({ state: 'partial' }))).toBe(false);
    expect(reloaded.hasJob(job({ result: { meeting: { outcome: 'completed', knowledge: 'saved', indexed: false } } }))).toBe(false);
    expect(reloaded.hasJob(job({ state: 'running' }))).toBe(false);
    expect(reloaded.hasJob(job({ state: 'scheduled' }))).toBe(false);
    expect(reloaded.hasJob(job({ dueAt: '2026-12-01T00:00:00.000Z', profileName: 'Renamed' }))).toBe(true);
  });

  it('keeps an immutable skill closed despite recovery/enrichment but shows a new revision', () => {
    const cache = storage(), first = createLearningNoticeDismissals(scope, () => cache);
    first.dismissSkill(skill());
    const reloaded = createLearningNoticeDismissals(scope, () => cache);
    expect(reloaded.hasSkill(skill({ createdAt: '2026-11-17T00:00:00.000Z', sessionId: 'recovered-session', runId: 'recovered-run', workspaceId: 'other-workspace',
      state: 'approved', change: 'new', label: 'Enriched name' }))).toBe(true);
    expect(reloaded.hasSkill(skill({ revisionId: 'revision-2' }))).toBe(false);
    expect(reloaded.hasSkill(skill({ profileId: 'other-profile' }))).toBe(false);
    expect(reloaded.hasJob(job())).toBe(false);
  });

  it('persists explicit closes only, merges concurrent tab writes, and refreshes external acknowledgement', () => {
    const cache = storage(), first = createLearningNoticeDismissals(scope, () => cache), second = createLearningNoticeDismissals(scope, () => cache);
    expect(cache.data.size).toBe(0);
    first.dismissJob(job({ state: 'running' })); first.dismissJob(job({ state: 'scheduled' }));
    expect(cache.data.size).toBe(0);
    first.dismissJob(job()); second.dismissJob(job({ id: 'another-job' }));
    expect(first.hasJob(job({ id: 'another-job' }))).toBe(false);
    first.refresh();
    expect(first.hasJob(job())).toBe(true);
    expect(first.hasJob(job({ id: 'another-job' }))).toBe(true);
    expect(createLearningNoticeDismissals(scope, () => cache).hasJob(job())).toBe(true);
  });

  it.each(['not-json', '{}', '{"version":2,"jobs":[],"skills":[]}', '{"version":1,"jobs":["*"],"skills":[]}',
    '{"version":1,"jobs":[],"skills":[],"unexpected":true}'])('ignores malformed storage and allows a valid subsequent close (%s)', raw => {
    const cache = storage(), first = createLearningNoticeDismissals(scope, () => cache);
    cache.setItem(first.key!, raw);
    const reloaded = createLearningNoticeDismissals(scope, () => cache);
    expect(reloaded.hasJob(job())).toBe(false);
    reloaded.dismissJob(job());
    expect(createLearningNoticeDismissals(scope, () => cache).hasJob(job())).toBe(true);
  });

  it('bounds retained acknowledgements and refuses oversized stored values', () => {
    const cache = storage(), first = createLearningNoticeDismissals(scope, () => cache);
    for (let index = 0; index < 520; index++) first.dismissJob(job({ id: `job-${index}` }));
    const saved = JSON.parse(cache.getItem(first.key!)!) as { jobs: string[] };
    expect(saved.jobs).toHaveLength(512);
    expect(saved.jobs).toContain(learningJobNoticeKey(job({ id: 'job-519' })));
    expect(saved.jobs).not.toContain(learningJobNoticeKey(job({ id: 'job-0' })));
    cache.setItem(first.key!, 'x'.repeat(1_048_577));
    expect(createLearningNoticeDismissals(scope, () => cache).hasJob(job({ id: 'job-519' }))).toBe(false);
  });

  it('closes within the mounted owner when browser storage is unavailable and avoids unscoped writes', () => {
    const failing = () => { throw new Error('Storage is unavailable.'); };
    const first = createLearningNoticeDismissals(scope, failing);
    expect(() => { first.dismissJob(job()); first.dismissSkill(skill()); }).not.toThrow();
    expect(first.hasJob(job())).toBe(true); expect(first.hasSkill(skill())).toBe(true);
    expect(createLearningNoticeDismissals(scope, failing).hasJob(job())).toBe(false);
    const cache = storage(), unscoped = createLearningNoticeDismissals(undefined, () => cache);
    unscoped.dismissJob(job());
    expect(unscoped.hasJob(job())).toBe(true); expect(cache.data.size).toBe(0);
  });
});
