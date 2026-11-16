import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NativeMeetingMinutes } from '@extalia/runtime';
import { pinMeetingNotes as pinNativeMeetingNotes } from '../src/meetingNotes.js';

import { useRustLearningBackend } from './rustLearningFixture.js';
import { HAS_DAEMON } from './daemonBackend.js';

const rustBackend = useRustLearningBackend();
const pinMeetingNotes = async (options: Omit<Parameters<typeof pinNativeMeetingNotes>[0], 'backend'>) => pinNativeMeetingNotes({ ...options, backend: await rustBackend() });
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const value = await mkdtemp(path.join(tmpdir(), 'extalia-meeting-notes-')); roots.push(value); return value; }
const minutes: NativeMeetingMinutes = {
  meetingId: 'meeting-one', topic: 'Review the project plan', roomId: 'meeting-a', outcome: 'completed',
  participants: [{ agentId: 'primary', name: 'Lead', role: 'Lead' }, { agentId: 'member-one', name: 'Reviewer', role: 'Review' }],
  contributions: [{ agentId: 'member-one', round: 1, text: 'The input still needs validation.' }, { agentId: 'member-one', round: 2, text: 'Validate before starting the task.' }],
  startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:00.000Z',
};
describe.skipIf(!HAS_DAEMON || process.platform === 'win32')('profile-bound meeting note exports', () => {
  it('keeps different profile vaults separate while workspaces in one profile share its vault', async () => {
    const base = await root(); const one = path.join(base, 'profile-one'), two = path.join(base, 'profile-two');
    await mkdir(one); await mkdir(two);
    for (const [vault, profileId, workspaceId] of [[one, 'profile-one', 'workspace-one'], [one, 'profile-one', 'workspace-two'], [two, 'profile-two', 'workspace-three']] as const) {
      const save = await pinMeetingNotes({ context: { workspaceId, sessionId: 'session-one' }, resolve: async () => ({ root: vault, profileId, revision: 'one' }) });
      const note = await save(minutes);
      const content = await readFile(path.join(vault, note), 'utf8');
      expect(content).toContain(`profile: "${profileId}"`);
      expect(content).toContain('kind: meeting');
      expect(content).toContain('tags: [meeting, team-knowledge]');
    }
    expect((await readdir(path.join(one, 'Meetings'))).sort()).toEqual(['workspace-one', 'workspace-two']);
    expect(await readdir(path.join(two, 'Meetings'))).toEqual(['workspace-three']);
    expect(await readdir(one)).not.toContain('.obsidian');
  });
  it('pins configuration and refuses to retarget an in-flight meeting', async () => {
    const vault = await root(); let revision = 'one';
    const save = await pinMeetingNotes({ context: { workspaceId: 'workspace-one', sessionId: 'session-one' }, resolve: async () => ({ root: vault, profileId: 'profile-one', revision }) });
    revision = 'two';
    await expect(save(minutes)).rejects.toThrow('destination changed');
    expect(await readdir(vault)).toEqual([]);
  });
  it('refuses a replaced vault directory even when its path and binding are unchanged', async () => {
    const base = await root(); const vault = path.join(base, 'vault'); await mkdir(vault);
    const save = await pinMeetingNotes({ context: { workspaceId: 'workspace-one', sessionId: 'session-one' }, resolve: async () => ({ root: vault, profileId: 'profile-one', revision: 'one' }) });
    await rename(vault, path.join(base, 'old-vault')); await mkdir(vault);
    await expect(save(minutes)).rejects.toThrow('changed on disk');
    expect(await readdir(vault)).toEqual([]);
  });
  it('does not overwrite an existing note and allows an exact idempotent retry', async () => {
    const vault = await root();
    const save = await pinMeetingNotes({ context: { workspaceId: 'workspace-one', sessionId: 'session-one' }, resolve: async () => ({ root: vault, profileId: 'profile-one', revision: 'one' }) });
    const relative = await save(minutes);
    expect(await save(minutes)).toBe(relative);
    await writeFile(path.join(vault, relative), 'User changes');
    await expect(save(minutes)).rejects.toThrow('not overwritten');
    expect(await readFile(path.join(vault, relative), 'utf8')).toBe('User changes');
    expect(await readdir(path.dirname(path.join(vault, relative)))).toEqual(['meeting-one.md']);
  });
  it('checks destination write authority before making any note folders', async () => {
    const vault = await root();
    const save = await pinMeetingNotes({ context: { workspaceId: 'workspace-one', sessionId: 'session-one' }, resolve: async () => ({ root: vault, profileId: 'profile-one', revision: 'one' }), authorize: async () => { throw new Error('Read-only destination'); } });
    await expect(save(minutes)).rejects.toThrow('Read-only');
    expect(await readdir(vault)).toEqual([]);
  });
  it('rejects foreign contributions, traversal identities and linked note directories', async () => {
    const vault = await root(); const outside = await root();
    const options = { context: { workspaceId: 'workspace-one', sessionId: 'session-one' }, resolve: async () => ({ root: vault, profileId: 'profile-one', revision: 'one' }) };
    await expect(pinMeetingNotes({ ...options, context: { ...options.context, workspaceId: '../workspace' } })).rejects.toThrow('identity');
    const save = await pinMeetingNotes(options);
    await expect(save({ ...minutes, contributions: [{ agentId: 'foreign', round: 1, text: 'Unrelated source' }] })).rejects.toThrow('unknown participant');
    await symlink(outside, path.join(vault, 'Meetings'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(save(minutes)).rejects.toThrow('regular directory');
    expect(await readdir(outside)).toEqual([]);
  });
});
