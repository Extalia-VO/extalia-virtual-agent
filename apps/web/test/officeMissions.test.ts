import { describe, expect, it } from 'vitest';
import { generateFullName } from '@extalia/core';
import type { HostMissionRun, SessionSummary } from '@extalia/platform';
import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { MESSAGES } from '../src/i18n';
import { createMockPlatform } from '../src/host/mockHost';
import { activityFromEvent } from '../src/office/activityFeed';
import { foldMissionWorkers, missionInfo } from '../src/office/missionPresence';
import { missionSignatures } from '../src/office/useOfficeMissions';
import { officeHistoryIds } from '../src/office/historyIds';
import { isAdmitted, projectOfficePresence, subagentLingerMs, type OfficeAgent } from '../src/office/presence';
import { boardRows } from '../src/office/overlay/boardTree';
import { activityBucket, inOffice, officeKpis } from '../src/office/overlay/kpis';
import { popoverSummary } from '../src/office/overlay/popoverModel';
import { agentStatusLabel, statusTone } from '../src/office/overlay/status';
import { lookIdentity } from '../src/office/scene/avatars/appearance';
import { allocateOfficeAgents } from '../src/office/scene/interior/seating';
import { ADMISSION_SPACING_MS, MovementDirector, SETTLE_MS } from '../src/office/scene/movement/director';
import { officeNavigation } from '../src/office/scene/movement/navGraph';
import { gaitParameters } from '../src/office/scene/avatars/gait';

const t = MESSAGES.en;
const MISSION = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const worker = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const task = (index: number) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const BASE = Date.parse('2026-10-18T08:00:00.000Z');

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id: 's1', workspaceId: 'ws', connectionId: 'connection-seed', title: 'Audit', control: 'managed', agentName: 'Mara Quill',
    createdAt: '2026-10-18T07:00:00.000Z', lastActiveAt: '2026-10-18T08:00:00.000Z', running: true, ...overrides } as SessionSummary;
}

/** A mission timeline as the host projects it into the v0 session log (`correlationId` = mission id). */
function timeline() {
  const events: ExtaliaEvent[] = [];
  let seconds = 0;
  const push = (body: EventBody, extra: { agentId?: string; taskId?: string } = {}) => {
    events.push(createEvent({ id: `e${events.length + 1}`, seq: events.length + 1, at: new Date(BASE + seconds++ * 1000).toISOString(), sessionId: 's1',
      agentId: extra.agentId ?? 'primary', ...(extra.taskId ? { taskId: extra.taskId } : {}), correlationId: MISSION, source: { runtime: 'test', channel: 'stream' }, body }));
    return events.at(-1)!;
  };
  return {
    events,
    launch(count: number) {
      push({ type: 'prompt.submitted', text: 'Native mission: Review auth errors', via: 'extalia' });
      push({ type: 'agent.state', state: 'delegating', activity: 'delegate', summary: 'Supervising a read-only native mission.' });
      for (let index = 1; index <= count; index++) {
        push({ type: 'subagent.spawned', subagentId: worker(index), role: 'read-only-worker', label: `Task ${index}`, model: index % 2 ? 'claude-opus-5-5' : 'local-coder' });
        push({ type: 'task.created', title: `Task ${index}` }, { taskId: task(index) });
      }
    },
    start(index: number, activity: 'read' | 'search' = 'read') {
      const scope = { agentId: worker(index), taskId: task(index) };
      push({ type: 'task.assigned', assigneeAgentId: worker(index) }, scope);
      push({ type: 'agent.state', state: 'working', activity }, scope);
      push({ type: 'tool.started', tool: activity === 'read' ? 'read_file' : 'search_files', kind: activity, label: activity === 'read' ? 'read_file' : 'search_files' }, scope);
    },
    complete(index: number) {
      const scope = { agentId: worker(index), taskId: task(index) };
      push({ type: 'task.completed', ok: true, summary: 'Completed with unverified model output.' }, scope);
      return events.at(-1)!;
    },
    /** How the host projects failed, cancelled, blocked and unknown task states. */
    stop(index: number, state: 'failed' | 'cancelled' | 'blocked' | 'unknown') {
      const scope = { agentId: worker(index), taskId: task(index) };
      const summary = state === 'unknown' ? 'Execution state is unknown; reconciliation is required.' : state === 'blocked' ? 'This task was not started because required work or capacity is unavailable.' : `Task ${state}.`;
      push({ type: 'task.completed', ok: false, summary }, scope);
      push(state === 'unknown' || state === 'blocked' ? { type: 'agent.state', state: 'blocked', summary } : { type: 'agent.state', state: 'idle', phase: state === 'cancelled' ? 'interrupted' : 'error', summary }, scope);
    },
    end(ok: boolean) { push(ok ? { type: 'turn.completed', summary: 'Native mission completed.' } : { type: 'turn.failed', error: 'Native mission failed.' }); push({ type: 'agent.state', state: 'idle' }); },
    at: () => BASE + seconds * 1000,
  };
}

const byAgent = (presences: OfficeAgent[]) => new Map(presences.map(agent => [agent.agentId, agent]));

describe('Office projection of native mission workers (v0.0.47, ADR 0016)', () => {
  it('lists queued workers under the lead with stable names and looks, but does not admit them into the office', () => {
    const mission = timeline();
    mission.launch(3);
    const presences = projectOfficePresence([session()], mission.events, mission.at());
    const agents = byAgent(presences);
    const lead = agents.get('primary')!;
    expect(lead).toMatchObject({ status: 'delegating', displayName: 'Mara Quill' });
    const used = new Set(['Mara Quill']);
    for (let index = 1; index <= 3; index++) {
      const agent = agents.get(worker(index))!;
      const expected = generateFullName(worker(index), used);
      used.add(expected.name);
      expect(agent).toMatchObject({ displayName: expected.name, look: lookIdentity(expected.name, expected.gender), parentId: 's1:primary', title: `Task ${index}`, status: 'idle', running: false,
        mission: { missionId: MISSION, missionTitle: 'Review auth errors', taskId: task(index), taskTitle: `Task ${index}`, state: 'queued', admitted: false } });
      expect(agent.model).toBe(index % 2 ? 'claude-opus-5-5' : 'local-coder');
      expect(isAdmitted(agent)).toBe(false);
      expect(inOffice(agent)).toBe(false);
      expect(agent.earlier).toBeUndefined();
      expect(agentStatusLabel(t, agent)).toBe('Queued');
    }
    // Deterministic: the same events give the same names and looks.
    expect(projectOfficePresence([session()], mission.events, mission.at())).toEqual(presences);
    // Nested under the lead on the board.
    const rows = boardRows(presences);
    expect(rows.map(row => [row.agent.agentId, row.depth])).toEqual([['primary', 0], [worker(1), 1], [worker(2), 1], [worker(3), 1]]);
    expect(officeKpis(presences)).toMatchObject({ working: 1, idle: 0, errors: 0 });
    // The announcement is the lead's hand-off, not work by a worker that has not started.
    expect(activityFromEvent(mission.events.find(event => event.body.type === 'subagent.spawned')!)).toMatchObject({ characterId: 's1:primary', kind: 'delegated' });
  });

  it('maps running, completed, failed, cancelled, blocked and unknown tasks to truthful presence states', () => {
    const mission = timeline();
    mission.launch(6);
    for (const index of [1, 2, 3, 4, 6]) mission.start(index, index === 2 ? 'search' : 'read');
    const done = mission.complete(1);
    mission.stop(3, 'failed');
    mission.stop(4, 'cancelled');
    mission.stop(5, 'blocked');
    mission.stop(6, 'unknown');
    const now = mission.at();
    const agents = byAgent(projectOfficePresence([session()], mission.events, now));

    const searching = agents.get(worker(2))!;
    expect(searching).toMatchObject({ status: 'working', activity: 'search', running: true, mission: { state: 'running', admitted: true } });
    expect(agentStatusLabel(t, searching)).toBe('Searching');
    expect(activityBucket(searching)).toBe('working');

    const completed = agents.get(worker(1))!;
    expect(completed).toMatchObject({ status: 'idle', running: false, mission: { state: 'completed', admitted: true, endedAt: Date.parse(done.at) } });
    expect(completed.activity).toBeUndefined();
    expect(agentStatusLabel(t, completed)).toBe('Ready');

    const failed = agents.get(worker(3))!;
    expect(failed).toMatchObject({ status: 'idle', phase: 'error', mission: { state: 'failed' } });
    expect(agentStatusLabel(t, failed)).toBe('Error');
    expect(activityBucket(failed)).toBe('errors');

    const cancelled = agents.get(worker(4))!;
    expect(cancelled).toMatchObject({ status: 'idle', mission: { state: 'cancelled', admitted: true } });
    expect(agentStatusLabel(t, cancelled)).toBe('Ready');

    const blocked = agents.get(worker(5))!;
    expect(blocked).toMatchObject({ status: 'idle', mission: { state: 'blocked', admitted: false } });
    expect(agentStatusLabel(t, blocked)).toBe('Not started');
    expect(inOffice(blocked)).toBe(false);

    const unknown = agents.get(worker(6))!;
    expect(unknown).toMatchObject({ status: 'blocked', mission: { state: 'unknown', admitted: true } });
    expect(unknown.mission?.endedAt).toBeUndefined();
    expect(agentStatusLabel(t, unknown)).toBe('Unknown');
    expect(statusTone(unknown)).toBe('warn');
    expect(activityBucket(unknown)).toBe('errors');
    expect(popoverSummary(t, unknown)).toBe(t.officeMissions.unknownSummary);

    // Lead delegating + searching worker = working 2; completed + cancelled = Ready 2; failed + unknown = errors 2; blocked/queued not counted.
    expect(officeKpis([...agents.values()])).toMatchObject({ working: 2, idle: 2, errors: 2, waiting: 0 });

    // After their linger, ended workers leave (Earlier); unknown work stays, never idle.
    const later = byAgent(projectOfficePresence([session()], mission.events, now + 21 * 60_000));
    for (const index of [1, 3, 4, 5]) expect(later.get(worker(index))).toMatchObject({ status: 'offline', earlier: true });
    expect(later.get(worker(6))).toMatchObject({ status: 'blocked', mission: { state: 'unknown' } });
    expect(later.get(worker(6))?.earlier).toBeUndefined();
    // Linger is the existing per-character subagent linger.
    const linger = subagentLingerMs('s1:' + worker(1));
    expect(byAgent(projectOfficePresence([session()], mission.events, Date.parse(done.at) + linger - 1000)).get(worker(1))?.status).toBe('idle');
    expect(byAgent(projectOfficePresence([session()], mission.events, Date.parse(done.at) + linger + 1000)).get(worker(1))?.status).toBe('offline');
  });

  it('uses the retained mission record for titles, connections, exact reasons and recovering runs', () => {
    const mission = timeline();
    mission.launch(3);
    mission.start(1); mission.start(2);
    mission.stop(1, 'failed');
    const run: HostMissionRun = {
      id: MISSION, sessionId: 's1', workspaceId: 'ws', title: 'Retained title', state: 'recovering', createdAt: '2026-10-18T08:00:00.000Z', updatedAt: '2026-10-18T08:01:00.000Z', transient: false,
      tasks: [1, 2, 3].map(index => ({ id: `t${index}`, taskId: task(index), agentId: worker(index), title: `Retained ${index}`, connectionId: index === 1 ? 'connection-seed' : 'connection-local',
        model: 'exact-model', state: index === 1 ? 'failed' as const : index === 2 ? 'running' as const : 'queued' as const, ...(index === 1 ? { reason: 'provider-failed' } : {}), evidenceIds: [] })),
    };
    const missions = new Map([[MISSION, missionInfo(run, id => ({ 'connection-seed': 'Anthropic', 'connection-local': 'Local' })[id])]]);
    const agents = byAgent(projectOfficePresence([session()], mission.events, mission.at(), new Map(), missions));
    const failed = agents.get(worker(1))!;
    expect(failed).toMatchObject({ title: 'Retained 1', model: 'exact-model', mission: { missionTitle: 'Retained title', provider: 'Anthropic', reason: 'provider-failed', state: 'failed' } });
    expect(agentStatusLabel(t, failed)).toBe('Error · provider failed');
    // A recovering run is never replayed: work in progress has an unknown outcome; a task still queued in it never started.
    expect(agents.get(worker(2))).toMatchObject({ status: 'blocked', mission: { state: 'unknown', provider: 'Local' } });
    expect(agents.get(worker(3))).toMatchObject({ status: 'idle', mission: { state: 'blocked', admitted: false } });
    expect(agentStatusLabel(t, agents.get(worker(3))!)).toBe('Not started');
  });

  it('marks work that never confirmed its end as unknown when the mission ended or its session stopped', () => {
    const mission = timeline();
    mission.launch(2);
    mission.start(1);
    // The session stopped (e.g. host restart) without the worker reporting an end.
    expect(foldMissionWorkers(mission.events, false).get(worker(1))).toMatchObject({ state: 'unknown', admitted: true });
    expect(foldMissionWorkers(mission.events, true).get(worker(1))).toMatchObject({ state: 'running' });
    mission.end(false);
    const folded = foldMissionWorkers(mission.events, true);
    expect(folded.get(worker(1))?.state).toBe('unknown');
    expect(folded.get(worker(2))).toMatchObject({ state: 'unknown', admitted: true });
  });

  it('re-reads retained records only when mission events change and keeps mission sessions loaded while workers remain', () => {
    const mission = timeline();
    mission.launch(2);
    const first = missionSignatures(mission.events, new Set(['s1']));
    expect([...first.keys()]).toEqual(['s1']);
    mission.start(1);
    expect(missionSignatures(mission.events, new Set(['s1'])).get('s1')).not.toBe(first.get('s1'));
    expect(missionSignatures(mission.events, new Set()).get('s1')).not.toBe(missionSignatures(mission.events, new Set(['s1'])).get('s1'));
    expect(officeHistoryIds([session({ running: false })])).toEqual([]);
    expect(officeHistoryIds([session({ running: false })], undefined, undefined, new Set(['s1']))).toEqual(['s1']);
  });

  it('admits a 12-task mission through the spawn queue (at most about three per second) without dropping any worker', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    let state = await agents.getState();
    for (let i = 0; i < 100 && !state.sessions.some(item => item.control === 'managed' && !item.runtime && !item.running && item.workspaceId === state.workspaces[0]!.id); i++) {
      await new Promise(resolve => setTimeout(resolve, 20)); state = await agents.getState();
    }
    const summary = state.sessions.find(item => item.control === 'managed' && !item.runtime && !item.running && item.workspaceId === state.workspaces[0]!.id)!;
    const connections = ['connection-seed', 'connection-local'];
    const models = new Map(state.connections.map(connection => [connection.id, connection.model!]));
    const run = await agents.startNativeMission(summary.id, {
      title: 'Twelve readers', maxConcurrency: 8,
      tasks: Array.from({ length: 12 }, (_, index) => ({ id: `t${index + 1}`, title: `Read area ${index + 1}`, instructions: 'Read the files.', connectionId: connections[index % 2]!, model: models.get(connections[index % 2]!)!, dependsOn: [] })),
    });
    const snapshot = async () => {
      const current = await agents.getState();
      const events = await agents.sessionEvents(summary.id);
      return projectOfficePresence(current.sessions.filter(item => item.id === summary.id), events, Date.now()).filter(agent => agent.mission?.missionId === run.id);
    };
    // Every worker is on the board right after the launch, queued until its task starts.
    const launched = await snapshot();
    expect(launched).toHaveLength(12);
    let peak: OfficeAgent[] = [];
    const seenStates = new Set<string>();
    // The mock runs in real time; under a loaded parallel run it can take well over 20 s to finish.
    for (let i = 0; i < 1000; i++) {
      const workers = await snapshot();
      expect(workers).toHaveLength(12);
      for (const agent of workers) seenStates.add(agent.mission!.state);
      const admitted = workers.filter(isAdmitted);
      if (admitted.length > peak.length) peak = admitted;
      if (workers.every(agent => agent.mission!.state === 'completed')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect([...seenStates]).toEqual(expect.arrayContaining(['queued', 'running', 'completed']));
    expect(peak.length).toBeGreaterThanOrEqual(8);

    // The director admits the burst of arrivals through the spawn queue: spaced, never more than three per second.
    let now = 0;
    const director = new MovementDirector({ navigation: officeNavigation(), elevators: { request() {}, waitingSlot: () => 0, canBoard: () => false, standingPosition: () => null, confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) } }, () => now);
    const lead: OfficeAgent = { id: `${summary.id}:primary`, sessionId: summary.id, agentId: 'primary', displayName: 'Lead', control: 'managed', status: 'delegating', running: true };
    const gaitOf = () => gaitParameters();
    director.update({ allocations: allocateOfficeAgents([lead]), agents: [lead], reducedMotion: false, gaitOf });
    now = SETTLE_MS + 1;
    const crowd = [lead, ...peak];
    director.update({ allocations: allocateOfficeAgents(crowd, allocateOfficeAgents([lead])), agents: crowd, reducedMotion: false, gaitOf });
    const appeared = new Map<string, number>();
    for (let step = 0; step < 15 * 30; step++) {
      now += 1000 / 30;
      director.tick(1 / 30);
      for (const agent of peak) if (!appeared.has(agent.id) && director.position(agent.id)) appeared.set(agent.id, now);
    }
    expect(appeared.size).toBe(peak.length);
    const times = [...appeared.values()].sort((a, b) => a - b);
    for (let index = 1; index < times.length; index++) expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(ADMISSION_SPACING_MS - 40);
    // Appearance times are sampled at 30 fps, so a 340 ms spacing can read as 333 ms; allow one frame of quantization.
    const frame = 1000 / 30;
    for (const time of times) expect(times.filter(other => other >= time && other < time + 1000 - frame).length).toBeLessThanOrEqual(3);
  }, 90_000);
});
