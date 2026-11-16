import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GeneralScheduleManager } from '../src/schedules.js';

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('GeneralScheduleManager', () => {
  it('creates, persists, pauses, resumes, and executes schedules with session reuse', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'extalia-schedules-'));
    tempDirs.push(directory);

    let nowMs = Date.parse('2026-11-14T10:00:00.000Z');
    const dispatched: { sessionId: string; prompt: string; leadModel?: string }[] = [];
    let createdCount = 0;

    const createManager = () => new GeneralScheduleManager({
      directory,
      now: () => nowMs,
      setTimer: () => setTimeout(() => undefined, 3_600_000),
      clearTimer: timer => clearTimeout(timer),
      callbacks: {
        validateWorkspace: id => {
          if (id !== 'ws-1') throw new Error('Unknown workspace.');
        },
        resolveSession: async schedule => {
          if (schedule.sessionTarget.mode === 'create-and-reuse') {
            const id = schedule.boundSessionId ?? `s_created_${++createdCount}`;
            return { sessionId: id, boundSessionId: id };
          }
          if (schedule.sessionTarget.mode === 'existing') {
            return { sessionId: schedule.sessionTarget.sessionId };
          }
          const id = `s_run_${++createdCount}`;
          return { sessionId: id };
        },
        dispatchPrompt: async (sessionId, prompt, assignment) => {
          dispatched.push({ sessionId, prompt, ...(assignment.leadModel ? { leadModel: assignment.leadModel } : {}) });
        },
      },
    });

    const manager = createManager();
    await manager.initialize();

    const saved = await manager.save({
      workspaceId: 'ws-1',
      name: 'Hourly Summary',
      prompt: 'Summarize repository changes.',
      enabled: true,
      trigger: { kind: 'interval', intervalMinutes: 60 },
      sessionTarget: { mode: 'create-and-reuse' },
      assignment: {
        leadModel: 'gpt-5',
        teamMode: 'custom',
        workers: [{ name: 'Aria', role: 'Reviewer' }],
      },
      missedPolicy: 'skip',
    });

    expect(saved.schedules).toHaveLength(1);
    const first = saved.schedules[0]!;
    expect(first.state).toBe('scheduled');
    expect(first.nextRunAt).toBe('2026-11-14T11:00:00.000Z');

    // Run now creates the session on first execution and reuses it on the second
    const afterFirstRun = await manager.runNow(first.id, first.revision);
    const updated1 = afterFirstRun.schedules[0]!;
    expect(updated1.boundSessionId).toBe('s_created_1');
    expect(updated1.lastSessionId).toBe('s_created_1');
    expect(updated1.runCount).toBe(1);
    expect(updated1.lastOutcome).toBe('succeeded');
    expect(dispatched).toEqual([{ sessionId: 's_created_1', prompt: 'Summarize repository changes.', leadModel: 'gpt-5' }]);

    nowMs += 10_000;
    const afterSecondRun = await manager.runNow(updated1.id, updated1.revision);
    const updated2 = afterSecondRun.schedules[0]!;
    expect(updated2.boundSessionId).toBe('s_created_1');
    expect(updated2.runCount).toBe(2);
    expect(createdCount).toBe(1);

    // Pause and verify persistence across restart
    const paused = await manager.setEnabled(updated2.id, false, updated2.revision);
    expect(paused.schedules[0]?.state).toBe('paused');
    await manager.close();

    const reloaded = createManager();
    await reloaded.initialize();
    const listAfterRestart = await reloaded.list();
    expect(listAfterRestart.schedules).toHaveLength(1);
    expect(listAfterRestart.schedules[0]?.boundSessionId).toBe('s_created_1');
    expect(listAfterRestart.schedules[0]?.state).toBe('paused');
    await reloaded.close();
  });

  it('applies skip missed-run policy when due time passed while offline', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'extalia-schedules-missed-'));
    tempDirs.push(directory);

    let nowMs = Date.parse('2026-11-14T10:00:00.000Z');
    const make = () => new GeneralScheduleManager({
      directory,
      now: () => nowMs,
      setTimer: () => setTimeout(() => undefined, 3_600_000),
      clearTimer: timer => clearTimeout(timer),
      callbacks: {
        validateWorkspace: () => undefined,
        resolveSession: async () => ({ sessionId: 's_1' }),
        dispatchPrompt: async () => undefined,
      },
    });

    const first = make();
    await first.initialize();
    await first.save({
      workspaceId: 'ws-1',
      name: 'Interval Check',
      prompt: 'Ping',
      enabled: true,
      trigger: { kind: 'interval', intervalMinutes: 30 },
      sessionTarget: { mode: 'existing', sessionId: 's_1' },
      missedPolicy: 'skip',
    });
    await first.close();

    // Advance 2 hours while offline
    nowMs = Date.parse('2026-11-14T12:00:00.000Z');
    const second = make();
    await second.initialize();
    const catalog = await second.list();
    expect(catalog.schedules[0]?.lastOutcome).toBe('missed');
    expect(catalog.schedules[0]?.nextRunAt).toBe('2026-11-14T12:30:00.000Z');
    await second.close();
  });
});
