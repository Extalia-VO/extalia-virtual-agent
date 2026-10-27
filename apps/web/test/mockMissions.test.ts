import { describe, expect, it } from 'vitest';
import { missionPlanToRequest, normalizeHostMissionRequest, type HostMissionRun } from '@extalia/platform';
import { createMockPlatform } from '../src/host/mockHost';

type Agents = NonNullable<ReturnType<typeof createMockPlatform>['capabilities']['agents']>;

async function idleNativeSession(agents: Agents) {
  for (let i = 0; i < 100; i++) {
    const state = await agents.getState();
    const session = state.sessions.find(item => item.control === 'managed' && !item.runtime && !item.running && item.workspaceId === state.workspaces[0]!.id);
    if (session) return session;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('No idle session.');
}
async function settle(agents: Agents, sessionId: string, missionId: string, states: string[][] = []): Promise<HostMissionRun> {
  for (let i = 0; i < 400; i++) {
    const run = await agents.nativeMissionRun(sessionId, missionId);
    states.push(run.tasks.map(task => task.state));
    if (run.state !== 'running') return run;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Mission did not settle.');
}

describe('mock host native missions (v0.0.43)', () => {
  it('plans a two-provider read-only mission without a model and runs it with live task states and unverified demo answers', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const session = await idleNativeSession(agents);
    const plan = await agents.planNativeMission(session.id, { goal: 'Review the build setup.', maxTasks: 3 });
    expect(plan).toMatchObject({ source: 'heuristic', leadModel: 'claude-opus-5-5' });
    expect(plan.note).toMatch(/no model was asked/);
    expect(plan.tasks.map(task => task.id)).toEqual(['survey', 'review-architecture', 'synthesis']);
    expect(new Set(plan.tasks.map(task => task.connectionId))).toEqual(new Set(['connection-seed', 'connection-local']));
    const request = missionPlanToRequest(plan);
    expect(() => normalizeHostMissionRequest(request)).not.toThrow();

    const before = (await agents.sessionEvents(session.id)).length;
    const started = await agents.startNativeMission(session.id, request);
    expect(started.state).toBe('running');
    await expect(agents.sendPrompt(session.id, 'hello')).rejects.toThrow(/still working/);
    const states: string[][] = [];
    const run = await settle(agents, session.id, started.id, states);
    expect(run.state).toBe('completed');
    expect(run.tasks.map(task => task.dependsOn)).toEqual(request.tasks.map(task => task.dependsOn ?? []));
    expect(states.some(list => list.includes('running'))).toBe(true);
    expect(run.tasks.every(task => task.verification === 'unverified' && task.answer?.includes('no model was called') && task.evidenceIds.length === 0)).toBe(true);
    expect((await agents.listNativeMissions(session.id)).map(item => item.id)).toEqual([started.id]);
    const events = (await agents.sessionEvents(session.id)).slice(before);
    expect(events.filter(event => event.body.type === 'subagent.spawned')).toHaveLength(3);
    expect(events.every(event => event.correlationId === started.id)).toBe(true);
    expect(events.filter(event => event.body.type === 'task.completed').every(event => event.taskId)).toBe(true);
  }, 30_000);

  it('rejects unallowed connections, cancels through the session, and seeds a failed branch as blocked', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge', missions: true }).capabilities.agents!;
    const session = await idleNativeSession(agents);
    await expect(agents.planNativeMission(session.id, { goal: 'x', connectionIds: ['connection-unknown'] })).rejects.toThrow(/not allowed/);
    const plan = await agents.planNativeMission(session.id, { goal: 'Review.', maxTasks: 4 });
    const started = await agents.startNativeMission(session.id, missionPlanToRequest(plan));
    await agents.cancel(session.id);
    const cancelled = await settle(agents, session.id, started.id);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.tasks.some(task => task.state === 'cancelled')).toBe(true);

    let failed: HostMissionRun | undefined;
    for (let i = 0; i < 100 && !failed; i++) {
      const state = await agents.getState();
      for (const item of state.sessions.filter(entry => entry.control === 'managed')) {
        failed ??= (await agents.listNativeMissions(item.id)).find(run => run.state === 'failed');
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(failed).toBeDefined();
    expect(failed!.tasks.find(task => task.id === 'review-risks')).toMatchObject({ state: 'failed', reason: 'provider-failed' });
    expect(failed!.tasks.find(task => task.id === 'synthesis')).toMatchObject({ state: 'blocked', reason: 'dependency-failed' });
  }, 30_000);
});
