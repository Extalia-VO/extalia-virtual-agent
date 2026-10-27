import { describe, expect, it } from 'vitest';
import {
  checkMissionPlan, heuristicMissionPlan, missionPlanPrompt, missionPlanToRequest, missionTaskLevels, normalizeMissionPlanRequest, parseMissionPlanReply,
  type MissionPlanCandidate, type MissionPlanContext,
} from '../src/missionPlan.js';
import { normalizeHostMissionRequest } from '../src/missions.js';

const candidates: MissionPlanCandidate[] = [
  { connectionId: 'c_a', model: 'model-a', provider: 'openai-chat', label: 'Provider A', lead: true },
  { connectionId: 'c_a', model: 'model-a-mini', provider: 'openai-chat', label: 'Provider A' },
  { connectionId: 'c_b', model: 'model-b', provider: 'anthropic-messages', label: 'Provider B' },
];
const context: MissionPlanContext = { goal: 'Review the login flow for risks.', maxTasks: 6, candidates };
const task = (id: string, worker: unknown, dependsOn: string[] = [], extra: Record<string, unknown> = {}) => ({ id, title: `Task ${id}`, role: 'Reviewer', instructions: `Inspect ${id}.`, worker, dependsOn, rationale: 'Fits.', ...extra });
const reply = (tasks: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ title: 'Login review', tasks, ...extra });
const pairs = new Set(candidates.map(candidate => `${candidate.connectionId}|${candidate.model}`));

describe('normalizeMissionPlanRequest', () => {
  it('applies defaults and validates bounds', () => {
    expect(normalizeMissionPlanRequest({ goal: '  Goal  ' })).toEqual({ goal: 'Goal', maxTasks: 6 });
    expect(normalizeMissionPlanRequest({ goal: 'g', maxTasks: 16, connectionIds: ['c_a'], models: ['model-a'] })).toEqual({ goal: 'g', maxTasks: 16, connectionIds: ['c_a'], models: ['model-a'] });
    for (const bad of [null, [], { goal: '' }, { goal: 'x'.repeat(4_001) }, { goal: 'g', maxTasks: 0 }, { goal: 'g', maxTasks: 17 }, { goal: 'g', maxTasks: 2.5 },
      { goal: 'g', connectionIds: [] }, { goal: 'g', connectionIds: ['a', 'a'] }, { goal: 'g', connectionIds: ['../x'] }, { goal: 'g', models: ['--flag'] },
      { goal: 'g', baseUrl: 'https://example.com' }, { goal: 'g', tools: [] }]) expect(() => normalizeMissionPlanRequest(bad)).toThrow();
  });
});

describe('heuristicMissionPlan', () => {
  it('builds survey → parallel analyses → synthesis across two providers that the host normalizer accepts', () => {
    const plan = heuristicMissionPlan(context);
    expect(plan.source).toBe('heuristic');
    expect(plan.tasks).toHaveLength(6);
    expect(missionTaskLevels(plan.tasks)).toEqual([['survey'], plan.tasks.slice(1, 5).map(item => item.id), ['synthesis']]);
    expect(new Set(plan.tasks.map(item => item.connectionId)).size).toBe(2);
    expect(plan.tasks.every(item => pairs.has(`${item.connectionId}|${item.model}`))).toBe(true);
    expect(plan.tasks.at(-1)).toMatchObject({ connectionId: 'c_a', model: 'model-a' });
    expect(plan.maxConcurrency).toBe(4);
    expect(() => normalizeHostMissionRequest(missionPlanToRequest(plan))).not.toThrow();
    expect(missionPlanToRequest(plan).tasks.every(item => !('role' in item) && !('rationale' in item))).toBe(true);
  });

  it('handles one and two tasks, all sixteen, and team role hints', () => {
    expect(heuristicMissionPlan({ ...context, maxTasks: 1 }).tasks.map(item => item.id)).toEqual(['analyze']);
    const two = heuristicMissionPlan({ ...context, maxTasks: 2 });
    expect(two.tasks.map(item => [item.id, item.connectionId])).toEqual([['survey', 'c_b'], ['synthesis', 'c_a']]);
    const sixteen = heuristicMissionPlan({ ...context, maxTasks: 16 });
    expect(new Set(sixteen.tasks.map(item => item.id)).size).toBe(16);
    const hinted = heuristicMissionPlan({ ...context, maxTasks: 4, hints: [{ role: 'Security', task: 'Audit tokens', models: ['model-a-mini'] }] });
    expect(hinted.tasks[1]).toMatchObject({ id: 'review-security', role: 'Security' });
  });

  it('redacts secrets and host-known values echoed from the goal', () => {
    const plan = heuristicMissionPlan({ ...context, goal: 'Check api_key=abcdefgh12345 and opaque-host-value', mask: text => text.split('opaque-host-value').join('[redacted]') }); // extalia-allow-secret
    const text = JSON.stringify(plan);
    expect(text).not.toContain('abcdefgh12345');
    expect(text).not.toContain('opaque-host-value');
  });
});

describe('missionPlanPrompt', () => {
  it('refers to workers by number and never includes endpoints', () => {
    const prompt = missionPlanPrompt({ ...context, goal: 'Use token=supersecretvalue1 please', hints: [{ role: 'QA', models: [] }] }); // extalia-allow-secret
    expect(prompt.user).toContain('1. model model-a on connection "Provider A" (openai-chat) — your own model');
    expect(prompt.user).toContain('3. model model-b');
    expect(prompt.user).toContain('at least two different connections');
    expect(prompt.user).toContain('- QA');
    expect(prompt.user).not.toContain('supersecretvalue1');
    expect(prompt.user).not.toContain('c_a');
  });
});

describe('parseMissionPlanReply', () => {
  it('accepts a strict plan, maps workers to pairs and keeps review labels', () => {
    const plan = parseMissionPlanReply(reply([task('survey', 2), task('backend', 1, ['survey']), task('frontend', 3, ['survey']), task('synthesis', 1, ['backend', 'frontend'])]), context);
    expect(plan).toMatchObject({ source: 'model', title: 'Login review', maxConcurrency: 2 });
    expect(plan.note).toBeUndefined();
    expect(plan.tasks.map(item => [item.id, item.connectionId, item.model])).toEqual([['survey', 'c_a', 'model-a-mini'], ['backend', 'c_a', 'model-a'], ['frontend', 'c_b', 'model-b'], ['synthesis', 'c_a', 'model-a']]);
    expect(plan.tasks[0]).toMatchObject({ role: 'Reviewer', rationale: 'Fits.', timeoutMs: 180_000, maxSteps: 8 });
    expect(checkMissionPlan(plan, candidates)).toEqual(plan);
  });

  it('tolerates one code fence or reasoning block but no surrounding prose', () => {
    const body = reply([task('only', 1)]);
    expect(parseMissionPlanReply(`<think>plan</think>\n\`\`\`json\n${body}\n\`\`\``, context).tasks).toHaveLength(1);
    expect(() => parseMissionPlanReply(`Here is the plan: ${body}`, context)).toThrow();
  });

  it('moves one parallel task to a second provider when the lead used only one', () => {
    const plan = parseMissionPlanReply(reply([task('survey', 1), task('one', 1, ['survey']), task('two', 2, ['survey']), task('synthesis', 1, ['one', 'two'])]), context);
    expect(plan.tasks.find(item => item.id === 'two')).toMatchObject({ connectionId: 'c_b', model: 'model-b' });
    expect(plan.note).toMatch(/two providers/);
  });

  it('rejects adversarial replies', () => {
    const bad = [
      reply([task('a', 1, ['b']), task('b', 1, ['a'])]), // cycle
      reply([task('a', 1, ['missing'])]),
      reply([task('a', 1, ['a'])]),
      reply([task('a', 9)]), // unknown worker
      reply([task('a', 0)]),
      reply([task('a', '1')]),
      reply([task('a', 1, [], { connectionId: 'c_other', model: 'model-z' })]), // injected connection
      reply([task('a', 1, [], { baseUrl: 'https://evil.example.com/v1' })]), // injected endpoint
      reply([task('a', 1, [], { tools: [{ name: 'run_command' }] })]),
      reply([task('a', 1)], { endpoint: 'https://evil.example.com' }),
      reply([task('Bad-ID', 1)]),
      reply([task('a', 1), task('a', 2)]),
      reply([task('a', 1, [], { instructions: 'x'.repeat(4_001) })]), // oversized
      reply([task('a', 1, [], { title: 'x'.repeat(201) })]),
      reply(Array.from({ length: 7 }, (_, index) => task(`t${index}`, 1))), // more than maxTasks
      reply([]),
      JSON.stringify({ title: 'x', tasks: [task('a', 1)] }) + ' '.repeat(64_000),
      '[]', 'not json', '{"title":"x","tasks":"a"}',
    ];
    for (const value of bad) expect(() => parseMissionPlanReply(value, context), value.slice(0, 120)).toThrow();
  });

  it('redacts secrets and masked host values echoed in titles and instructions', () => {
    const plan = parseMissionPlanReply(reply([task('a', 1, [], { title: 'Use sk-proj-abcdefghijklmnopqrstu', instructions: 'Key opaque-host-value here.' })]), { ...context, mask: text => text.split('opaque-host-value').join('[redacted]') }); // extalia-allow-secret
    expect(JSON.stringify(plan)).not.toMatch(/abcdefghijklmnopqrstu|opaque-host-value/);
    expect(plan.tasks[0]!.instructions).toContain('[redacted]');
  });
});

describe('missionTaskLevels', () => {
  it('returns undefined for cycles and missing dependencies', () => {
    expect(missionTaskLevels([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }])).toBeUndefined();
    expect(missionTaskLevels([{ id: 'a', dependsOn: ['x'] }])).toBeUndefined();
    expect(missionTaskLevels([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: [] }])).toEqual([['a', 'c'], ['b']]);
  });
});
