import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtaliaEvent } from '@extalia/protocol';
import { normalizeClaudeHook } from '../src/hooks/normalize.js';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const active = new Set<Observations>();
afterEach(async () => { await Promise.all([...active].map(observer => observer.close())); active.clear(); });
async function fixture() {
  const root = await temp('extalia-observed-workspace-link-');
  const home = path.join(root, 'home'), project = path.join(root, 'project'), state = path.join(root, 'state');
  await Promise.all([mkdir(home), mkdir(project)]);
  const source = await NativeImportService.create({ homeDirectory: home, env: {} });
  const events: ExtaliaEvent[] = [];
  const open = async () => {
    const observer = await Observations.create(state, source, event => events.push(event), 60_000, { homeDirectory: home });
    active.add(observer); return observer;
  };
  const observer = await open();
  const hook = (cwd: string) => normalizeClaudeHook({ session_id: 'workspace-link-native', hook_event_name: 'SessionStart', cwd })!;
  await observer.receiveHook(hook(project));
  const id = observer.summaries()[0]!.id;
  const link = { workspaceId: 'w_example', projectCanonicalPath: project, root };
  return { root, project, state, source, observer, events, open, hook, id, link, index: path.join(state, 'observations.json') };
}
async function close(observer: Observations) { await observer.close(); active.delete(observer); }
const summaryLink = (observer: Observations, id: string) => observer.summaries().find(session => session.id === id)!.observation!.workspaceLink;

describe('private observed workspace association storage', () => {
  it('persists an explicit source-bound link and clear, invalidates control, and changes the notification revision', async () => {
    const f = await fixture();
    const originalTarget = f.observer.controlTarget(f.id)!;
    await f.observer.setWorkspaceLink(f.id, originalTarget.fingerprint, f.link);
    expect(summaryLink(f.observer, f.id)).toEqual({ ...f.link, sourceMatches: true });
    expect(JSON.stringify(f.observer.summaries())).not.toContain(originalTarget.fingerprint);
    expect(f.observer.controlTarget(f.id)).toEqual({ ...originalTarget, revision: originalTarget.revision + 1 });
    const linkedEvent = f.events.filter(event => event.body.type === 'session.updated').at(-1)!;
    const saved = JSON.parse(await readFile(f.index, 'utf8')) as { workspaceLink: unknown; projectPath: string }[];
    expect(saved[0]!.workspaceLink).toEqual({ ...f.link, sourceFingerprint: originalTarget.fingerprint });
    expect(saved[0]!.projectPath).toBe(f.project);
    await close(f.observer);
    const reopened = await f.open();
    expect(summaryLink(reopened, f.id)).toEqual({ ...f.link, sourceMatches: true });
    const current = reopened.controlTarget(f.id)!;
    await reopened.setWorkspaceLink(f.id, current.fingerprint, null);
    expect(summaryLink(reopened, f.id)).toBeUndefined();
    expect(reopened.controlTarget(f.id)).toEqual({ ...current, revision: current.revision + 1 });
    const clearedEvent = f.events.filter(event => event.body.type === 'session.updated').at(-1)!;
    expect(clearedEvent.body).not.toEqual(linkedEvent.body);
    expect(JSON.parse(await readFile(f.index, 'utf8'))[0]).not.toHaveProperty('workspaceLink');
    await close(reopened);
    const again = await f.open(); expect(summaryLink(again, f.id)).toBeUndefined();
  });

  it('retains the old explicit association as a source mismatch instead of silently reassociating after cwd drift', async () => {
    const f = await fixture();
    const originalTarget = f.observer.controlTarget(f.id)!;
    await f.observer.setWorkspaceLink(f.id, originalTarget.fingerprint, f.link);
    const changedProject = path.join(f.root, 'changed-project'); await mkdir(changedProject);
    await f.observer.receiveHook(f.hook(changedProject));
    expect(f.observer.controlTarget(f.id)!.fingerprint).not.toBe(originalTarget.fingerprint);
    expect(summaryLink(f.observer, f.id)).toEqual({ ...f.link, sourceMatches: false });
    await expect(f.observer.setWorkspaceLink(f.id, originalTarget.fingerprint, null)).rejects.toThrow(/source changed/);
    expect(summaryLink(f.observer, f.id)).toEqual({ ...f.link, sourceMatches: false });
    await close(f.observer);
    const reopened = await f.open();
    expect(summaryLink(reopened, f.id)).toEqual({ ...f.link, sourceMatches: false });
    expect(reopened.summaries()[0]!.observation!.projectPath).toBe(changedProject);
  });

  it('rejects malformed persisted associations without deleting them or writing a replacement registry', async () => {
    const f = await fixture();
    const fingerprint = f.observer.controlTarget(f.id)!.fingerprint;
    await f.observer.setWorkspaceLink(f.id, fingerprint, f.link);
    await close(f.observer);
    const original = JSON.parse(await readFile(f.index, 'utf8')) as Record<string, unknown>[];
    for (const invalid of [null, [], {}, { ...f.link, sourceFingerprint: 'wrong' },
      { ...f.link, sourceFingerprint: fingerprint, workspaceId: '../foreign' },
      { ...f.link, sourceFingerprint: fingerprint, root: 'relative' },
      { ...f.link, sourceFingerprint: fingerprint, projectCanonicalPath: `${f.project}\n` },
      { ...f.link, sourceFingerprint: fingerprint, permission: 'read-write' }]) {
      const damaged = JSON.stringify([{ ...original[0], workspaceLink: invalid }]);
      await writeFile(f.index, damaged);
      await expect(f.open()).rejects.toThrow(/association is invalid.*preserved/);
      expect(await readFile(f.index, 'utf8')).toBe(damaged);
    }
    await writeFile(f.index, JSON.stringify(original));
    const restored = await f.open(); expect(summaryLink(restored, f.id)?.sourceMatches).toBe(true);
  });

  it('refuses unknown sources and malformed metadata before persistence or control invalidation', async () => {
    const f = await fixture(), target = f.observer.controlTarget(f.id)!;
    await f.observer.setWorkspaceLink(f.id, target.fingerprint, f.link);
    const before = await readFile(f.index, 'utf8'), control = f.observer.controlTarget(f.id)!;
    await expect(f.observer.setWorkspaceLink('missing-observation', target.fingerprint, f.link)).rejects.toThrow(/source changed/);
    await expect(f.observer.setWorkspaceLink(f.id, '0'.repeat(64), f.link)).rejects.toThrow(/source changed/);
    for (const invalid of [{ ...f.link, workspaceId: '../escape' }, { ...f.link, root: 'relative' },
      { ...f.link, projectCanonicalPath: path.join(f.root, 'project') + '/..' }, { ...f.link, root: `${f.root}\0` },
      { ...f.link, root: '/'.repeat(4100) }]) {
      await expect(f.observer.setWorkspaceLink(f.id, target.fingerprint, invalid)).rejects.toThrow(/Invalid observed workspace association/);
    }
    expect(await readFile(f.index, 'utf8')).toBe(before);
    expect(f.observer.controlTarget(f.id)).toEqual(control);
    expect(summaryLink(f.observer, f.id)).toEqual({ ...f.link, sourceMatches: true });
  });

  it('rolls back only the failed link mutation when atomic persistence fails, then accepts the next serialized change', async () => {
    const f = await fixture(), target = f.observer.controlTarget(f.id)!;
    await f.observer.setWorkspaceLink(f.id, target.fingerprint, f.link);
    const originalBytes = await readFile(f.index, 'utf8'), originalControl = f.observer.controlTarget(f.id)!;
    const eventCount = f.events.length, backup = `${f.index}.backup`;
    await rename(f.index, backup); await mkdir(f.index);
    try {
      await expect(f.observer.setWorkspaceLink(f.id, target.fingerprint, { ...f.link, workspaceId: 'w_second' })).rejects.toThrow();
      await expect(f.observer.setWorkspaceLink(f.id, target.fingerprint, null)).rejects.toThrow();
      expect(summaryLink(f.observer, f.id)).toEqual({ ...f.link, sourceMatches: true });
      expect(f.observer.controlTarget(f.id)).toEqual(originalControl);
      expect(f.events).toHaveLength(eventCount);
      expect(await readFile(backup, 'utf8')).toBe(originalBytes);
    } finally { await rm(f.index, { recursive: true }); await rename(backup, f.index); }
    await f.observer.setWorkspaceLink(f.id, target.fingerprint, { ...f.link, workspaceId: 'w_second' });
    expect(summaryLink(f.observer, f.id)?.workspaceId).toBe('w_second');
    expect(f.observer.controlTarget(f.id)!.revision).toBe(originalControl.revision + 1);
    await close(f.observer);
    const reopened = await f.open(); expect(summaryLink(reopened, f.id)?.workspaceId).toBe('w_second');
  });
});
