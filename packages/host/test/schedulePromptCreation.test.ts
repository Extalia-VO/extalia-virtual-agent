import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SaveGeneralScheduleInput } from '@extalia/platform';
import { GeneralScheduleManager } from '../src/schedules.js';
import * as jsonStore from '../src/jsonStore.js';

const roots: string[] = [], managers: GeneralScheduleManager[] = [], releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const manager of managers.splice(0)) await manager.close();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const input = (): SaveGeneralScheduleInput => ({ workspaceId: 'workspace-one', name: 'Project review', prompt: 'Review project changes and report evidence.',
  trigger: { kind: 'interval', intervalMinutes: 60 }, sessionTarget: { mode: 'create-and-reuse' } });
const hostKey = 'host-session-one:accepted-run-one:tool-call-one';
async function fixture(initial?: unknown) {
  const directory = await mkdtemp(path.join(tmpdir(), 'extalia-prompt-schedule-')); roots.push(directory);
  const file = path.join(directory, 'schedules.json');
  if (initial !== undefined) await writeFile(file, JSON.stringify(initial));
  const timers = vi.fn((_callback: () => void, _delay: number) => ({}) as ReturnType<typeof setTimeout>);
  const notify = vi.fn(), dispatch = vi.fn(async () => undefined);
  const validate = vi.fn((id: string) => { if (id !== 'workspace-one') throw new Error('Unknown workspace.'); });
  const open = async () => {
    const manager = new GeneralScheduleManager({ directory, now: () => Date.parse('2026-01-02T10:00:00Z'), setTimer: timers, clearTimer: () => undefined,
      callbacks: { validateWorkspace: validate, resolveSession: async () => ({ sessionId: 's_fixture', boundSessionId: 's_fixture' }), dispatchPrompt: dispatch, onChange: notify } });
    managers.push(manager); await manager.initialize(); return manager;
  };
  const manager = await open();
  return { manager, file, open, timers, notify, dispatch, validate };
}

describe('durable host-owned prompt schedule creation', () => {
  it('serializes concurrent retries into one durable job and one timer, without exposing its private receipt', async () => {
    const f = await fixture();
    const jobs = await Promise.all(Array.from({ length: 12 }, () => f.manager.createFromPrompt(input(), hostKey)));
    expect(new Set(jobs.map(job => job.id)).size).toBe(1);
    expect(jobs[0]?.id).toMatch(/^sch_[a-f0-9]{64}$/);
    expect(jobs.every(job => job.revision === 1)).toBe(true);
    expect(f.timers).toHaveBeenCalledOnce(); expect(f.notify).toHaveBeenCalledOnce(); expect(f.dispatch).not.toHaveBeenCalled();
    const disk = await readFile(f.file, 'utf8');
    const stored = JSON.parse(disk) as { schedules: unknown[]; promptCreations: Array<{ fingerprint: string }> };
    expect(stored.schedules).toHaveLength(1); expect(stored.promptCreations).toHaveLength(1);
    expect(disk).not.toContain(hostKey);
    const catalog = JSON.stringify(await f.manager.list());
    expect(catalog).not.toContain('promptCreations'); expect(catalog).not.toContain(stored.promptCreations[0]!.fingerprint);
  });

  it('replays the same creation after restart without rewriting storage, rearming timers or notifying again', async () => {
    const f = await fixture(), first = await f.manager.createFromPrompt(input(), hostKey);
    await f.manager.close(); const reopened = await f.open();
    const disk = await readFile(f.file, 'utf8'); f.timers.mockClear(); f.notify.mockClear();
    expect(await reopened.createFromPrompt({ ...input(), enabled: true, assignment: { teamMode: 'workspace' }, missedPolicy: 'run-once' }, hostKey)).toEqual(first);
    expect(await readFile(f.file, 'utf8')).toBe(disk);
    expect(f.timers).not.toHaveBeenCalled(); expect(f.notify).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('keeps creation replay valid after normal scheduled state advances, without repeating work', async () => {
    const f = await fixture(), first = await f.manager.createFromPrompt(input(), hostKey);
    const afterRun = (await f.manager.runNow(first.id, first.revision)).schedules[0]!;
    const disk = await readFile(f.file, 'utf8'); f.timers.mockClear();
    expect(await f.manager.createFromPrompt(input(), hostKey)).toEqual(afterRun);
    expect(afterRun.runCount).toBe(1); expect(f.dispatch).toHaveBeenCalledOnce(); expect(f.timers).not.toHaveBeenCalled();
    expect(await readFile(f.file, 'utf8')).toBe(disk);
  });

  it('refuses a different payload for the same host invocation and permits a distinct invocation', async () => {
    const f = await fixture(), first = await f.manager.createFromPrompt(input(), hostKey);
    const before = await readFile(f.file, 'utf8');
    await expect(f.manager.createFromPrompt({ ...input(), prompt: 'A different requested task.' }, hostKey)).rejects.toThrow(/invocation changed/);
    expect(await readFile(f.file, 'utf8')).toBe(before);
    const other = await f.manager.createFromPrompt(input(), `${hostKey}:distinct`);
    expect(other.id).not.toBe(first.id); expect((await f.manager.list()).schedules).toHaveLength(2);
  });

  it.each(['edit', 'pause', 'delete'] as const)('never overwrites or recreates a job the user chose to %s, including after restart', async action => {
    const f = await fixture(), first = await f.manager.createFromPrompt(input(), hostKey);
    if (action === 'edit') await f.manager.save({ ...input(), id: first.id, expectedRevision: first.revision, name: 'User-edited project review' });
    else if (action === 'pause') await f.manager.setEnabled(first.id, false, first.revision);
    else await f.manager.delete(first.id, first.revision);
    await f.manager.close(); const reopened = await f.open(), disk = await readFile(f.file, 'utf8'); f.timers.mockClear();
    await expect(reopened.createFromPrompt(input(), hostKey)).rejects.toThrow(/edited or removed/);
    expect(await readFile(f.file, 'utf8')).toBe(disk); expect(f.timers).not.toHaveBeenCalled();
    const jobs = (await reopened.list()).schedules;
    expect(jobs).toHaveLength(action === 'delete' ? 0 : 1);
    if (action === 'edit') expect(jobs[0]?.name).toBe('User-edited project review');
    if (action === 'pause') expect(jobs[0]?.enabled).toBe(false);
  });

  it('checks current invocation admission after waiting in the serialized lane', async () => {
    const f = await fixture(), entered = deferred(), release = deferred(); releases.push(release.resolve);
    const write = jsonStore.writeJsonAtomic;
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return write(...args); });
    const holding = f.manager.save({ ...input(), name: 'Existing queue occupant' }); await entered.promise;
    const abort = new AbortController(), guard = vi.fn(() => abort.signal.throwIfAborted());
    const pending = f.manager.createFromPrompt(input(), hostKey, guard); const rejected = expect(pending).rejects.toThrow();
    expect(guard).not.toHaveBeenCalled(); abort.abort(); release.resolve();
    await Promise.all([holding, rejected]); expect(guard).toHaveBeenCalledOnce();
    expect((await f.manager.list()).schedules.map(job => job.name)).toEqual(['Existing queue occupant']);
    expect(await readFile(f.file, 'utf8')).not.toContain('promptCreations');
  });

  it('does not acknowledge an unpublished in-memory job after a failed write', async () => {
    const f = await fixture();
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockRejectedValueOnce(new Error('Controlled publication failure.'));
    await expect(f.manager.createFromPrompt(input(), hostKey)).rejects.toThrow('Controlled publication failure.');
    expect(await f.manager.list()).toMatchObject({ schedules: [], problem: 'storage-unavailable' });
    await expect(f.manager.createFromPrompt(input(), hostKey)).rejects.toThrow(/storage is unavailable/);
    expect(f.timers).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('refuses uncertain publication until restart, then reads the exact durable receipt without recreating the job', async () => {
    const f = await fixture(), write = jsonStore.writeJsonAtomic;
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementationOnce(async (...args) => { await write(...args); throw new Error('Publication acknowledgement lost.'); });
    await expect(f.manager.createFromPrompt(input(), hostKey)).rejects.toThrow('Publication acknowledgement lost.');
    await expect(f.manager.createFromPrompt(input(), hostKey)).rejects.toThrow(/storage is unavailable/);
    expect((await f.manager.list()).schedules).toHaveLength(0);
    const disk = await readFile(f.file, 'utf8'); expect(JSON.parse(disk).schedules).toHaveLength(1);
    await f.manager.close(); const reopened = await f.open(); f.timers.mockClear();
    const recovered = await reopened.createFromPrompt(input(), hostKey);
    expect(recovered.id).toBe(JSON.parse(disk).schedules[0].id);
    expect(await readFile(f.file, 'utf8')).toBe(disk); expect(f.timers).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('retains all 1024 private receipts at capacity while normal UI creation remains available', async () => {
    const receipts = Array.from({ length: 1024 }, (_, index) => ({ scheduleId: `sch_${createHash('sha256').update(`prior-${index}`).digest('hex')}`, fingerprint: 'a'.repeat(64), invalidated: true }));
    const f = await fixture({ schema: 'extalia.schedules.v1', schedules: [], promptCreations: receipts });
    await expect(f.manager.createFromPrompt(input(), hostKey)).rejects.toThrow(/receipt limit reached \(1024\)/);
    expect((await f.manager.list()).schedules).toEqual([]);
    const manual = await f.manager.save(input()); expect(manual.schedules).toHaveLength(1);
    expect(JSON.parse(await readFile(f.file, 'utf8')).promptCreations).toEqual(receipts);
  });

  it('revalidates workspace access even for a replay and rejects prompt attempts to update a chosen job ID', async () => {
    const f = await fixture(), first = await f.manager.createFromPrompt(input(), hostKey);
    f.validate.mockImplementation(() => { throw new Error('Workspace revoked.'); });
    await expect(f.manager.createFromPrompt(input(), hostKey)).rejects.toThrow('Workspace revoked.');
    await expect(f.manager.createFromPrompt({ ...input(), id: first.id, expectedRevision: first.revision }, hostKey)).rejects.toThrow(/creates a new job/);
    expect((await f.manager.list()).schedules).toHaveLength(1);
  });
});
