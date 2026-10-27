import type { AgentTeam } from '@extalia/core';
import {
  heuristicMissionPlan, normalizeHostMissionRequest, normalizeMissionPlanRequest,
  type HostMissionRun, type HostMissionTask, type HostState, type MissionPlan, type MissionPlanCandidate,
} from '@extalia/platform';
import { createEvent, type EventBody, type ExtaliaEvent, type TaskState } from '@extalia/protocol';

/**
 * Development-only native missions for the mock host: a deterministic plan
 * (no model is asked) and a simulated read-only run whose task states change
 * over time. Answers say plainly that they are demo text; nothing is verified.
 */
export interface MockMissionDeps {
  state: HostState;
  events: Map<string, ExtaliaEvent[]>;
  listeners: Set<(event: ExtaliaEvent) => void>;
  teams: Map<string, AgentTeam>;
  /** Models a connection's endpoint would list (for the plan's `models` filter). */
  listModels(connectionId: string): string[];
  /** Milliseconds per simulated task step; 0 settles immediately (seeded history). */
  stepMs?: number;
  /** A mission ended; write-capable tasks get their demo worktrees (ADR 0028). */
  onFinished?(run: HostMissionRun): void;
}

interface LiveMission { run: HostMissionRun; cancelled: boolean; dependsOn: Map<string, string[]>; fail: Set<string>; maxConcurrency: number }

const uuid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function demoAnswer(task: HostMissionTask, predecessors: string[]): string {
  return [
    `**Demo answer from the mock host** — no model was called for “${task.title}”.`,
    '',
    `- Worker: \`${task.model}\``,
    ...(predecessors.length ? [`- Used unverified findings from: ${predecessors.join(', ')}`] : []),
    '- A real run reads workspace files only and reports findings here as unverified model output.',
  ].join('\n');
}

export function createMockMissions(deps: MockMissionDeps) {
  const missions = new Map<string, HostMissionRun[]>();
  const live = new Map<string, LiveMission>();
  const stepMs = deps.stepMs ?? 900;

  const session = (id: string) => {
    const found = deps.state.sessions.find(item => item.id === id);
    if (!found) throw new Error('That managed session no longer exists.');
    return found;
  };
  /** A managed Extalia Native session in a native workspace with a project folder. */
  function nativeSession(id: string) {
    const summary = session(id);
    if (summary.control !== 'managed') throw new Error('Native missions need a managed Extalia Native session. Observed sessions run in their own app.');
    if (summary.runtime) throw new Error('Hermes Agent sessions cannot run native missions. Start an Extalia Native session.');
    const workspace = deps.state.workspaces.find(item => item.id === summary.workspaceId);
    if (!workspace || workspace.runtimeId === 'hermes' || !workspace.projectLocation) throw new Error('Native missions need an Extalia Native workspace with a project folder.');
    const allowed = [...new Set([workspace.providerProfileId, ...(workspace.missionConnectionIds ?? [])].filter((value): value is string => Boolean(value)))];
    return { summary, workspace, allowed };
  }

  function emit(sessionId: string, body: EventBody, extra: { agentId?: string; taskId?: string; correlationId?: string; at?: Date } = {}) {
    const list = deps.events.get(sessionId) ?? [];
    const event = createEvent({
      sessionId, source: { runtime: 'mock', channel: 'stream' }, agentId: extra.agentId ?? 'primary', body,
      ...(extra.taskId ? { taskId: extra.taskId } : {}), ...(extra.correlationId ? { correlationId: extra.correlationId } : {}),
    }, () => extra.at ?? new Date());
    event.seq = list.length + 1;
    list.push(event);
    deps.events.set(sessionId, list);
    const summary = deps.state.sessions.find(item => item.id === sessionId);
    if (summary) summary.lastActiveAt = event.at;
    for (const listener of deps.listeners) listener(event);
  }

  function save(run: HostMissionRun) {
    const list = (missions.get(run.sessionId) ?? []).filter(item => item.id !== run.id);
    missions.set(run.sessionId, [structuredClone(run), ...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 16));
  }

  function plan(sessionId: string, raw: unknown): MissionPlan {
    const request = normalizeMissionPlanRequest(raw);
    const { summary, allowed } = nativeSession(sessionId);
    if (request.connectionIds?.some(id => !allowed.includes(id))) throw new Error('A selected connection is not allowed for this workspace’s missions. Allow it in the workspace settings first.');
    const selected = request.connectionIds ? allowed.filter(id => request.connectionIds!.includes(id)) : allowed;
    const team = deps.teams.get(sessionId);
    const leadModel = summary.options?.model || deps.state.connections.find(item => item.id === summary.connectionId)?.model;
    const candidates: MissionPlanCandidate[] = [];
    for (const id of [...selected].sort((a, b) => Number(b === summary.connectionId) - Number(a === summary.connectionId))) {
      const connection = deps.state.connections.find(item => item.id === id);
      if (!connection || connection.credentialStatus === 'missing') continue;
      const lead = id === summary.connectionId;
      let models = [connection.model, ...(lead ? [leadModel, ...(team?.allowedModels ?? [])] : [])];
      if (request.models) models = [...models, ...deps.listModels(id)].filter(model => model !== undefined && request.models!.includes(model));
      for (const model of [...new Set(models.filter((value): value is string => Boolean(value)))].slice(0, 8)) {
        candidates.push({ connectionId: id, model, provider: connection.api, label: connection.name, ...(lead && model === leadModel ? { lead: true } : {}) });
      }
    }
    if (!candidates.length) throw new Error('No allowed connection and model can run this mission. Check the chosen models, credentials and the workspace’s mission connections.');
    const planned = heuristicMissionPlan({
      goal: request.goal, maxTasks: request.maxTasks, candidates,
      ...(team?.members.length ? { hints: team.members.map(member => ({ role: member.role, ...(member.task ? { task: member.task } : {}), models: member.models })) } : {}),
    });
    return { ...planned, note: 'Mock host: a standard plan was used; no model was asked.', ...(leadModel ? { leadModel } : {}) };
  }

  function start(sessionId: string, raw: unknown, options: { at?: Date; fail?: string[] } = {}): HostMissionRun {
    let request: ReturnType<typeof normalizeHostMissionRequest>;
    try { request = normalizeHostMissionRequest(raw); } catch { throw new Error('Invalid native mission request.'); }
    const { summary, allowed } = nativeSession(sessionId);
    if (summary.running || live.has(sessionId)) throw new Error('This session is still working. Wait for it or stop it first.');
    if (request.tasks.some(task => !allowed.includes(task.connectionId))) throw new Error('A selected connection is not authorized for this workspace.');
    const at = (options.at ?? new Date()).toISOString();
    const run: HostMissionRun = {
      id: uuid(), sessionId, workspaceId: summary.workspaceId, title: request.title, state: 'running', createdAt: at, updatedAt: at, transient: false,
      tasks: request.tasks.map(task => ({ id: task.id, taskId: uuid(), agentId: uuid(), title: task.title, connectionId: task.connectionId, model: task.model, dependsOn: [...task.dependsOn], state: 'queued' as TaskState, evidenceIds: [], ...(task.access === 'write' ? { access: 'write' as const } : {}) })),
    };
    const fail = new Set([...(options.fail ?? []), ...request.tasks.filter(task => /\bfail\b/i.test(`${task.title} ${task.instructions}`)).map(task => task.id)]);
    const mission: LiveMission = { run, cancelled: false, dependsOn: new Map(request.tasks.map(task => [task.id, task.dependsOn])), fail, maxConcurrency: request.maxConcurrency ?? 3 };
    live.set(sessionId, mission);
    summary.running = true;
    save(run);
    const correlation = { correlationId: run.id, ...(options.at ? { at: options.at } : {}) };
    emit(sessionId, { type: 'prompt.submitted', text: `Native mission: ${run.title}`, via: 'extalia' }, correlation);
    emit(sessionId, { type: 'agent.state', state: 'delegating', activity: 'delegate', summary: 'Supervising a read-only native mission.' }, correlation);
    for (const task of run.tasks) {
      emit(sessionId, { type: 'subagent.spawned', subagentId: task.agentId, role: task.access === 'write' ? 'write-worker' : 'read-only-worker', label: task.title, model: task.model }, correlation);
      emit(sessionId, { type: 'task.created', title: task.title }, { ...correlation, taskId: task.taskId });
    }
    void execute(mission, options.at);
    return structuredClone(run);
  }

  async function execute(mission: LiveMission, seededAt?: Date) {
    const { run } = mission, sessionId = run.sessionId;
    let clock = seededAt?.getTime() ?? 0;
    const at = () => (seededAt ? new Date(clock += 1_500) : new Date());
    const pause = (factor: number) => (seededAt || stepMs === 0 ? Promise.resolve() : sleep(stepMs * factor));
    const set = (task: HostMissionTask, patch: Partial<HostMissionTask>) => {
      Object.assign(task, patch);
      run.updatedAt = at().toISOString();
      save(run);
    };
    const event = (task: HostMissionTask, body: EventBody, agentId = task.agentId) => emit(sessionId, body, { agentId, taskId: task.taskId, correlationId: run.id, at: at() });
    const byId = new Map(run.tasks.map(task => [task.id, task]));
    const done = (task: HostMissionTask) => !['queued', 'running'].includes(task.state);
    const runTask = async (task: HostMissionTask, index: number) => {
      set(task, { state: 'running' });
      event(task, { type: 'task.assigned', assigneeAgentId: task.agentId });
      event(task, { type: 'agent.state', state: 'working', activity: 'read', summary: 'Reading workspace files' });
      event(task, { type: 'tool.started', tool: 'read_file', kind: 'read', label: 'read_file' });
      await pause(1 + (index % 3) * 0.6);
      if (mission.cancelled) return;
      event(task, { type: 'tool.completed', tool: 'read_file', kind: 'read', label: 'read_file', ok: true });
      if (task.access === 'write') {
        // Journal-shaped edit activity (ADR 0028): tool name and a worktree-relative path, never content.
        const target = `src/${task.id}.ts`;
        event(task, { type: 'agent.state', state: 'working', activity: 'edit' });
        event(task, { type: 'tool.started', tool: 'edit_file', kind: 'edit', label: 'edit_file', target });
        event(task, { type: 'tool.completed', tool: 'edit_file', kind: 'edit', label: 'edit_file', ok: true, target });
      }
      event(task, { type: 'agent.state', state: 'thinking' });
      await pause(1.2 + (index % 2) * 0.8);
      if (mission.cancelled) return;
      if (mission.fail.has(task.id)) {
        set(task, { state: 'failed', reason: 'provider-failed' });
        event(task, { type: 'task.completed', ok: false, summary: 'Task failed.' });
        event(task, { type: 'agent.state', state: 'idle', phase: 'error', summary: 'Task failed.' });
        return;
      }
      const predecessors = (mission.dependsOn.get(task.id) ?? []).map(id => byId.get(id)!.title);
      set(task, { state: 'completed', answer: demoAnswer(task, predecessors), verification: 'unverified' });
      event(task, { type: 'task.completed', ok: true, summary: 'Completed with unverified model output.' });
      event(task, { type: 'agent.state', state: 'idle' });
    };
    const active = new Map<string, Promise<void>>();
    let started = 0;
    while (run.tasks.some(task => !done(task)) && !mission.cancelled) {
      let changed = false;
      for (const task of run.tasks) {
        if (task.state !== 'queued') continue;
        const deps = (mission.dependsOn.get(task.id) ?? []).map(id => byId.get(id)!);
        if (deps.some(dep => done(dep) && dep.state !== 'completed')) {
          set(task, { state: 'blocked', reason: 'dependency-failed' });
          event(task, { type: 'task.completed', ok: false, summary: 'This task was not started because required work or capacity is unavailable.' });
          event(task, { type: 'agent.state', state: 'blocked', summary: 'This task was not started because required work or capacity is unavailable.' });
          changed = true;
          continue;
        }
        if (active.size >= mission.maxConcurrency || deps.some(dep => dep.state !== 'completed')) continue;
        active.set(task.id, runTask(task, started++).finally(() => { active.delete(task.id); }));
        changed = true;
      }
      if (active.size) await Promise.race(active.values());
      else if (!changed) break;
    }
    await Promise.all(active.values());
    if (mission.cancelled) {
      for (const task of run.tasks) if (!done(task)) {
        set(task, { state: 'cancelled', reason: 'cancelled' });
        event(task, { type: 'task.completed', ok: false, summary: 'Task cancelled.' });
        event(task, { type: 'agent.state', state: 'idle', phase: 'interrupted', summary: 'Task cancelled.' });
      }
    }
    run.state = mission.cancelled ? 'cancelled' : run.tasks.every(task => task.state === 'completed') ? 'completed' : 'failed';
    run.updatedAt = at().toISOString();
    save(run);
    const end = { correlationId: run.id, at: at() };
    if (run.state === 'completed') emit(sessionId, { type: 'turn.completed', summary: 'Native mission completed. Model responses remain unverified.' }, end);
    else emit(sessionId, { type: 'turn.failed', error: run.state === 'cancelled' ? 'Native mission cancelled.' : 'Native mission failed.' }, end);
    emit(sessionId, { type: 'agent.state', state: 'idle' }, end);
    live.delete(sessionId);
    const summary = deps.state.sessions.find(item => item.id === sessionId);
    if (summary) summary.running = false;
    if (run.tasks.some(task => task.access === 'write')) deps.onFinished?.(structuredClone(run));
  }

  return {
    plan,
    start,
    run(sessionId: string, missionId: string): HostMissionRun {
      session(sessionId);
      const found = missions.get(sessionId)?.find(item => item.id === missionId);
      if (!found) throw new Error('That native mission no longer exists.');
      return structuredClone(found);
    },
    list(sessionId: string): HostMissionRun[] { session(sessionId); return structuredClone(missions.get(sessionId) ?? []); },
    /** Cooperative cancel through the session's `cancel`; true when a mission was running. */
    cancel(sessionId: string): boolean {
      const mission = live.get(sessionId);
      if (!mission || mission.cancelled) return false;
      mission.cancelled = true;
      emit(sessionId, { type: 'user.intervention', action: 'cancel' }, { correlationId: mission.run.id });
      return true;
    },
    remove(sessionId: string) { missions.delete(sessionId); },
  };
}
