import type { ConnectionView, HostMissionRun, HostState, SessionSummary } from '@extalia/platform';
import { normalizeHostMissionRequest } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/i18n';
import {
  allowedConnections, allowedPairs, blankPlan, cycleMembers, dagLevels, draftFromPlan, eligibleSessions, missionEligibility, missionGraphTasks, missionPlanner, missionProgress,
  isNeverStarted, rememberSubmitted, removeTask, renameTask, requestFromDraft, taskTone, toggleDependency, validatePlan, type DraftPlan,
  budgetFromDraft, emptyBudget, missionBudgetView,
} from '../src/missions/missionModel';

const at = '2026-10-17T00:00:00.000Z';
const connection = (id: string, model: string, tiers: Record<string, string> = {}): ConnectionView => ({
  id, name: id.toUpperCase(), preset: 'openai-compatible' as ConnectionView['preset'], api: 'openai-chat', baseUrl: 'https://example.com/v1', model,
  credential: { kind: 'none' }, features: { memory: 'extalia', skills: 'off' }, orchestration: { enabled: true, maxDelegations: 3, tiers }, createdAt: at, updatedAt: at, credentialStatus: 'not-needed',
});
const session = (id: string, workspaceId: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id, workspaceId, connectionId: 'a', title: id, control: 'managed', createdAt: at, lastActiveAt: at, running: false, ...extra,
});
const state = (): HostState => ({
  setupComplete: true, dataDirectory: '/tmp/x', profile: { id: 'p', name: 'p' },
  connections: [connection('a', 'model-a', { quick: 'model-a-mini' }), connection('b', 'model-b'), connection('c', 'model-c')],
  workspaces: [
    { id: 'w1', profileId: 'p', name: 'app', projectLocation: '/Users/<name>/app', providerProfileId: 'a', missionConnectionIds: ['b', 'gone'], createdAt: at, updatedAt: at },
    { id: 'w2', profileId: 'p', name: 'lab', projectLocation: '/Users/<name>/lab', runtimeId: 'hermes', createdAt: at, updatedAt: at },
    { id: 'w3', profileId: 'p', name: 'nofolder', providerProfileId: 'a', createdAt: at, updatedAt: at },
  ],
  sessions: [
    session('s1', 'w1'), session('s2', 'w2', { runtime: { id: 'hermes', profile: 'default' } }), session('s3', 'w1', { control: 'observed' }), session('s4', 'w3'),
  ],
  library: [], storage: { dataDirectory: '/tmp/x', secretStore: 'memory' }, host: { kind: 'bridge', version: '0' },
});

const plan = (overrides: Partial<DraftPlan> = {}): DraftPlan => draftFromPlan({
  title: 'Review', maxConcurrency: 3, source: 'model', leadModel: 'model-a',
  tasks: [
    { id: 'survey', title: 'Survey', role: 'Scout', rationale: 'first', instructions: 'Map the project.', connectionId: 'a', model: 'model-a', dependsOn: [], timeoutMs: 180_000, maxSteps: 8 },
    { id: 'deep', title: 'Deep dive', instructions: 'Inspect auth.', connectionId: 'b', model: 'model-b', dependsOn: ['survey'] },
    { id: 'synth', title: 'Synthesis', instructions: 'Combine.', connectionId: 'a', model: 'model-a-mini', dependsOn: ['survey', 'deep'] },
  ],
  ...overrides as object,
});

describe('missions: eligibility and allowed pairs', () => {
  it('admits only managed native sessions with a project folder', () => {
    const value = state();
    expect(eligibleSessions(value).map(item => item.id)).toEqual(['s1']);
    expect(missionEligibility(value, value.sessions[1]!)).toBe('hermes');
    expect(missionEligibility(value, value.sessions[2]!)).toBe('observed');
    expect(missionEligibility(value, value.sessions[3]!)).toBe('no-folder');
  });

  it('allows the primary plus the saved allowlist, never unknown or hermes', () => {
    const value = state();
    expect(allowedConnections(value, value.workspaces[0]).map(item => item.id)).toEqual(['a', 'b']);
    expect(allowedConnections(value, value.workspaces[1])).toEqual([]);
    const pairs = allowedPairs(allowedConnections(value, value.workspaces[0]), { primaryId: 'a', primaryExtra: ['model-x'] });
    expect(pairs.get('a')).toEqual(['model-a', 'model-a-mini', 'model-x']);
    expect(pairs.get('b')).toEqual(['model-b']);
    expect(pairs.has('c')).toBe(false);
    const narrowed = allowedPairs(allowedConnections(value, value.workspaces[0]), { models: ['model-b'] });
    expect([...narrowed.keys()]).toEqual(['b']);
  });
});

describe('missions: plan editing and validation', () => {
  const value = state();
  const pairs = allowedPairs(allowedConnections(value, value.workspaces[0]), { primaryId: 'a' });

  it('converts a planned DAG into a request the host normalizer accepts', () => {
    const draft = plan();
    expect(draft.tasks[0]!.timeoutSeconds).toBe(180);
    expect(validatePlan(draft, pairs)).toEqual([]);
    const request = requestFromDraft(draft);
    expect(request.tasks[0]).not.toHaveProperty('role');
    expect(request.tasks[0]!.timeoutMs).toBe(180_000);
    expect(normalizeHostMissionRequest(request).tasks).toHaveLength(3);
  });

  it('reports cycles, missing dependencies and disallowed pairs inline', () => {
    let draft = plan();
    const [survey, deep, synth] = draft.tasks;
    draft = toggleDependency(draft, survey!.key, 'synth');
    const codes = validatePlan(draft, pairs).map(issue => `${issue.code}:${draft.tasks.find(task => task.key === issue.taskKey)?.id}`);
    expect(codes).toEqual(expect.arrayContaining(['cycle:survey', 'cycle:deep', 'cycle:synth']));
    expect(cycleMembers(draft.tasks)).toEqual(new Set(['survey', 'deep', 'synth']));

    draft = { ...plan(), tasks: plan().tasks.map(task => task.id === 'deep' ? { ...task, connectionId: 'c', dependsOn: ['nope'] } : task) };
    const issues = validatePlan(draft, pairs);
    expect(issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['connectionNotAllowed', 'dependencyMissing']));
    expect(issues.find(issue => issue.code === 'dependencyMissing')?.detail).toBe('nope');

    draft = { ...plan(), tasks: plan().tasks.map(task => task.id === 'synth' ? { ...task, model: 'model-b' } : task) };
    expect(validatePlan(draft, pairs).map(issue => issue.code)).toEqual(['modelNotAllowed']);
    expect(deep && synth).toBeTruthy();
  });

  it('rejects bad aliases, duplicates, bounds and empty fields', () => {
    const base = plan();
    const draft: DraftPlan = { ...base, title: ' ', maxConcurrency: 9, tasks: base.tasks.map((task, index) => index === 0 ? { ...task, id: 'Bad id', instructions: ' ', timeoutSeconds: 0, maxSteps: 21 } : index === 1 ? { ...task, id: 'synth' } : task) };
    const codes = validatePlan(draft, pairs).map(issue => issue.code);
    expect(codes).toEqual(expect.arrayContaining(['titleRequired', 'concurrency', 'idInvalid', 'instructionsRequired', 'timeout', 'maxSteps', 'idDuplicate']));
  });

  it('renames and removes tasks without dangling dependencies', () => {
    const draft = plan();
    const renamed = renameTask(draft, draft.tasks[0]!.key, 'scan');
    expect(renamed.tasks[2]!.dependsOn).toEqual(['scan', 'deep']);
    const removed = removeTask(renamed, renamed.tasks[1]!.key);
    expect(removed.tasks.map(task => task.id)).toEqual(['scan', 'synth']);
    expect(removed.tasks[1]!.dependsOn).toEqual(['scan']);
    expect(validatePlan(removed, pairs)).toEqual([]);
  });

  it('starts a manual plan from the goal on the first allowed pair', () => {
    const draft = blankPlan('Find slow queries\nmore detail', pairs);
    expect(draft.source).toBe('manual');
    expect(draft.title).toBe('Find slow queries');
    expect(draft.tasks[0]).toMatchObject({ id: 'task-1', connectionId: 'a', model: 'model-a' });
    expect(validatePlan(draft, pairs)).toEqual([]);
  });
});

describe('missions: DAG levels and progress', () => {
  const graphRun = (id: string, edges = true): HostMissionRun => ({
    id, sessionId: 's1', workspaceId: 'w1', title: 'Review', state: 'completed', createdAt: at, updatedAt: at, transient: false,
    tasks: requestFromDraft(plan()).tasks.map(task => ({
      id: task.id, taskId: `task-${task.id}`, agentId: `agent-${task.id}`, title: task.title, connectionId: task.connectionId, model: task.model,
      state: 'completed', evidenceIds: [], ...(edges ? { dependsOn: task.dependsOn ?? [] } : {}),
    })),
  });

  it('draws a reopened run from retained edges without any submitted plan', () => {
    const run = graphRun('retained-graph');
    const graph = missionGraphTasks(run)!;
    expect(graph.map(task => task.dependsOn)).toEqual([[], ['survey'], ['survey', 'deep']]);
    expect(dagLevels(graph).map(column => column.map(task => task.id))).toEqual([['survey'], ['deep'], ['synth']]);
    graph[0]!.dependsOn.push('changed');
    expect(run.tasks[0]!.dependsOn).toEqual([]);
  });

  it('prefers host edges over local cached plans and keeps missing legacy graphs unknown', () => {
    const run = graphRun('authoritative-graph');
    rememberSubmitted(run.id, { ...requestFromDraft(plan()), tasks: requestFromDraft(plan()).tasks.map(task => ({ ...task, dependsOn: [] })) });
    expect(missionGraphTasks(run)![2]!.dependsOn).toEqual(['survey', 'deep']);
    expect(missionGraphTasks(graphRun('legacy-without-cache', false))).toBeUndefined();
    const partial = graphRun('partial-graph');
    delete partial.tasks[1]!.dependsOn;
    expect(missionGraphTasks(partial)).toBeUndefined();
  });

  it('supports an older host only when a complete matching submitted plan is known', () => {
    const run = graphRun('legacy-local', false);
    rememberSubmitted(run.id, requestFromDraft(plan()));
    expect(missionGraphTasks(run)![1]!.dependsOn).toEqual(['survey']);
    run.tasks[1]!.id = 'unmatched';
    expect(missionGraphTasks(run)).toBeUndefined();
  });

  it('orders tasks by dependency depth and puts cycles last', () => {
    expect(dagLevels(plan().tasks).map(column => column.map(task => task.id))).toEqual([['survey'], ['deep'], ['synth']]);
    const cyclic = [{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: [] }];
    expect(dagLevels(cyclic).map(column => column.map(task => task.id))).toEqual([['c'], ['a', 'b']]);
  });

  it('counts task states only and never claims evidence', () => {
    const run = { tasks: [
      { state: 'completed', evidenceIds: [] }, { state: 'running', evidenceIds: [] }, { state: 'failed', evidenceIds: [] }, { state: 'unknown', evidenceIds: [] },
    ] } as unknown as HostMissionRun;
    expect(missionProgress(run)).toEqual({ total: 4, completed: 1, running: 1, failed: 1, unresolved: 1, evidence: 0 });
    expect(MESSAGES.en.missions.run.progress(1, 4)).toBe('1 of 4 tasks completed');
    expect(MESSAGES.id.missions.run.progress(1, 4)).toBe('1 dari 4 tugas selesai');
    expect(taskTone('recovering')).toBe('warn');
    expect(taskTone('unknown')).toBe('warn');
    expect(taskTone('completed')).toBe('ok');
  });

  it('shows a task still queued in a recovering run as never started, not as pending work', () => {
    // Restart recovery rewrites only in-flight work to unknown; a recovering run admits nothing new.
    expect(isNeverStarted({ state: 'recovering' }, { state: 'queued' })).toBe(true);
    expect(isNeverStarted({ state: 'running' }, { state: 'queued' })).toBe(false);
    for (const state of ['blocked', 'unknown', 'completed'] as const) expect(isNeverStarted({ state: 'recovering' }, { state })).toBe(false);
    const run = { tasks: [{ state: 'completed', evidenceIds: [] }, { state: 'unknown', evidenceIds: [] }, { state: 'queued', evidenceIds: [] }, { state: 'blocked', evidenceIds: [] }] } as unknown as HostMissionRun;
    expect(missionProgress(run)).toEqual({ total: 4, completed: 1, running: 0, failed: 0, unresolved: 1, evidence: 0 });
    expect([MESSAGES.en.missions.run.notStarted, MESSAGES.id.missions.run.notStarted]).toEqual(['Not started', 'Tidak dimulai']);
  });

  it('feature-detects the lead planner', () => {
    expect(missionPlanner({} as never)).toBeUndefined();
    const host = { planNativeMission(this: unknown) { return Promise.resolve(this); } };
    expect(missionPlanner(host as never)).toBeTypeOf('function');
  });
});

describe('missions: budgets and usage (ADR 0015)', () => {
  const value = state();
  const pairs = allowedPairs(allowedConnections(value, value.workspaces[0]), { primaryId: 'a' });

  it('treats empty budget fields as no limit and sends a budget only when a limit is set', () => {
    expect(budgetFromDraft(emptyBudget())).toEqual({ limits: {}, issues: [] });
    expect(requestFromDraft({ ...plan(), budget: emptyBudget() })).not.toHaveProperty('budget');
    const draft: DraftPlan = { ...plan(), budget: { durationMinutes: '15', maxTokens: '50000', maxTaskTokens: ' 20000 ' } };
    expect(validatePlan(draft, pairs)).toEqual([]);
    const request = requestFromDraft(draft);
    expect(request.budget).toEqual({ maxDurationMs: 900_000, maxTokens: 50_000, maxTaskTokens: 20_000, maxConcurrency: 3 });
    expect(normalizeHostMissionRequest(request).budget).toEqual(request.budget);
  });

  it('reports invalid or contradictory budget fields inline instead of clamping', () => {
    const codes = (budget: DraftPlan['budget']) => validatePlan({ ...plan(), budget }, pairs).map(issue => issue.code);
    expect(codes({ durationMinutes: '0', maxTokens: '', maxTaskTokens: '' })).toEqual(['budgetDuration']);
    expect(codes({ durationMinutes: '1441', maxTokens: '1.5', maxTaskTokens: '' })).toEqual(['budgetDuration', 'budgetTokens']);
    expect(codes({ durationMinutes: '', maxTokens: '100', maxTaskTokens: '101' })).toEqual(['budgetTaskTokens']);
    expect(codes({ durationMinutes: '-3', maxTokens: '1e3', maxTaskTokens: 'abc' })).toEqual(['budgetDuration', 'budgetTokens', 'budgetTaskTokens']);
    for (const code of ['budgetDuration', 'budgetTokens', 'budgetTaskTokens'] as const) {
      expect(MESSAGES.en.missions.plan.errors[code]).toBeTruthy();
      expect(MESSAGES.id.missions.plan.errors[code]).toBeTruthy();
    }
  });

  it('shows reported usage, a lower bound for unreported tasks and unknown when nothing was reported', () => {
    expect(missionBudgetView({})).toEqual({ reported: false, unknownTasks: 0, lowerBound: false });
    expect(missionBudgetView({ usage: { unknownTasks: 2 } })).toEqual({ reported: true, unknownTasks: 2, lowerBound: true });
    expect(missionBudgetView({ usage: { inputTokens: 30, outputTokens: 12, unknownTasks: 0 }, budget: { maxTokens: 100, maxConcurrency: 2 } }))
      .toEqual({ reported: true, tokens: 42, inputTokens: 30, outputTokens: 12, unknownTasks: 0, lowerBound: false, maxTokens: 100 });
    expect(missionBudgetView({ usage: { inputTokens: 30, unknownTasks: 0 }, budgetExhausted: 'usage-unknown' }))
      .toMatchObject({ tokens: 30, lowerBound: true, exhausted: 'usage-unknown' });
    for (const reason of ['tokens', 'usage-unknown', 'duration']) {
      expect(MESSAGES.en.missions.run.exhausted[reason]).toBeTruthy();
      expect(MESSAGES.id.missions.run.exhausted[reason]).toBeTruthy();
    }
    for (const reason of ['budget-exhausted', 'usage-unknown', 'mission-deadline']) {
      expect(MESSAGES.en.missions.run.reasons[reason]).toBeTruthy();
      expect(MESSAGES.id.missions.run.reasons[reason]).toBeTruthy();
    }
  });
});
