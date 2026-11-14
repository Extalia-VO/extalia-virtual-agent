import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pinLearningNotes as pinNativeLearningNotes, type LearningNoteRecord } from '../src/learningNotes.js';
import { useTempDirs } from './helpers.js';
import { useRustLearningBackend } from './rustLearningFixture.js';
import { HAS_DAEMON } from './daemonBackend.js';

const temp = useTempDirs();
const rustBackend = useRustLearningBackend();
const pinLearningNotes = async (options: Omit<Parameters<typeof pinNativeLearningNotes>[0], 'backend'>) => pinNativeLearningNotes({ ...options, backend: await rustBackend() });
const record: LearningNoteRecord = {
  profileId: 'profile-one', revision: 'revision-one', sessionId: 'session-one', workspaceId: 'workspace-one', runId: 'run-one', promptSha256: 'a'.repeat(64),
  title: 'Validate before saving', lesson: 'Validate input before saving generated files.',
  evidence: [{ id: 'read-one', name: 'read_file', content: 'The validation check runs before saving.' }],
};
const context = { workspaceId: record.workspaceId, sessionId: record.sessionId };
const destination = (root: string) => ({ root, profileId: record.profileId, revision: record.revision });

describe.skipIf(!HAS_DAEMON || process.platform === 'win32')('immutable profile-bound learning notes', () => {
  it('writes each workspace finding only to its pinned vault and leaves Obsidian settings unchanged', async () => {
    const base = await temp(), first = path.join(base, 'first'), second = path.join(base, 'second');
    for (const [root, profileId, workspaceId, sentinel] of [
      [first, 'profile-first', 'workspace-first', 'First-vault sentinel'],
      [second, 'profile-second', 'workspace-second', 'Second-vault sentinel'],
    ] as const) {
      await mkdir(path.join(root, '.obsidian'), { recursive: true });
      await writeFile(path.join(root, '.obsidian', 'preferences.json'), '{"unchanged":true}\n');
      const save = await pinLearningNotes({ context: { workspaceId, sessionId: record.sessionId },
        resolve: async () => ({ root, profileId, revision: record.revision }) });
      try {
        const relative = await save({ ...record, profileId, workspaceId, lesson: sentinel });
        const body = await readFile(path.join(root, relative), 'utf8');
        expect(body).toContain(sentinel); expect(body).toContain(`profile: "${profileId}"`);
        expect(await readdir(path.join(root, 'Learning'))).toEqual([workspaceId]);
        expect(await readFile(path.join(root, '.obsidian', 'preferences.json'), 'utf8')).toBe('{"unchanged":true}\n');
      } finally { await save.close(); }
    }
    expect(await readFile(path.join(first, 'Learning', 'workspace-first', 'run-one.md'), 'utf8')).not.toContain('Second-vault sentinel');
    expect(await readFile(path.join(second, 'Learning', 'workspace-second', 'run-one.md'), 'utf8')).not.toContain('First-vault sentinel');
  });

  it('writes generated findings, current source evidence and actual user-library skill receipts', async () => {
    const root = await temp(); const authorize = vi.fn();
    const save = await pinLearningNotes({ context, resolve: async () => destination(root), authorize });
    const note = await save({ ...record, skill: { packageId: 'validate-input', revisionId: 'revision-one', state: 'quarantined', inspection: 'unavailable', created: true, activationPerformed: false, cancellationObserved: false } });
    expect(note).toBe('Learning/workspace-one/run-one.md');
    const body = await readFile(path.join(root, note), 'utf8');
    for (const part of ['type: generated-learning', 'kind: learning', 'tags: [learning, automatic-learning, skill-candidate]', 'profile: "profile-one"', 'policy_revision: "revision-one"', 'session: "session-one"', 'run_id: "run-one"', record.promptSha256, record.evidence[0]!.content, 'User-library package:', 'no activation or profile-specific skill isolation']) expect(body).toContain(part);
    expect(authorize).toHaveBeenCalledTimes(2); expect(await readdir(root)).toEqual(['Learning']);
  });

  it('allows exact retries and refuses all overwrites or existing symlink targets', async () => {
    const root = await temp(), outside = path.join(await temp(), 'outside.md');
    const save = await pinLearningNotes({ context, resolve: async () => destination(root) });
    const relative = await save(record); expect(await save(record)).toBe(relative);
    await writeFile(path.join(root, relative), 'Human edits');
    await expect(save(record)).rejects.toThrow('not overwritten');
    expect(await readFile(path.join(root, relative), 'utf8')).toBe('Human edits');
    await writeFile(outside, 'Private external content');
    await symlink(outside, path.join(root, 'Learning', record.workspaceId, 'run-two.md'));
    await expect(save({ ...record, runId: 'run-two' })).rejects.toThrow('not overwritten');
    expect(await readFile(outside, 'utf8')).toBe('Private external content');
    expect((await readdir(path.dirname(path.join(root, relative)))).sort()).toEqual(['run-one.md', 'run-two.md']);
  });

  it('rejects changed policy bindings before creating any note folders', async () => {
    const root = await temp(); let revision = record.revision;
    const save = await pinLearningNotes({ context, resolve: async () => ({ ...destination(root), revision }) });
    revision = 'revision-two';
    await expect(save(record)).rejects.toThrow('destination changed'); expect(await readdir(root)).toEqual([]);
  });

  it('rejects replaced root identities and linked note directories', async () => {
    const base = await temp(), root = path.join(base, 'vault'), outside = await temp(); await mkdir(root);
    const save = await pinLearningNotes({ context, resolve: async () => destination(root) });
    await rename(root, path.join(base, 'old')); await mkdir(root);
    await expect(save(record)).rejects.toThrow('changed on disk');
    const second = await pinLearningNotes({ context, resolve: async () => destination(root) });
    await symlink(outside, path.join(root, 'Learning'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(second(record)).rejects.toThrow('regular directory'); expect(await readdir(outside)).toEqual([]);
  });

  it('authorizes before note folders and again before publishing', async () => {
    const root = await temp();
    const denied = await pinLearningNotes({ context, resolve: async () => destination(root), authorize: async () => { throw new Error('Denied workspace.'); } });
    await expect(denied(record)).rejects.toThrow('Denied workspace'); expect(await readdir(root)).toEqual([]);
    const authorize = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('Write authority revoked.'));
    const save = await pinLearningNotes({ context, resolve: async () => destination(root), authorize });
    await expect(save(record)).rejects.toThrow('revoked');
    expect(await readdir(path.join(root, 'Learning', record.workspaceId))).toEqual([]);
  });

  it('checks cancellation before folders and after temporary content before publication', async () => {
    const root = await temp(), controller = new AbortController();
    const save = await pinLearningNotes({ context, resolve: async () => destination(root) });
    controller.abort(); await expect(save(record, controller.signal)).rejects.toThrow('cancelled'); expect(await readdir(root)).toEqual([]);
    const during = new AbortController(); let calls = 0;
    const second = await pinLearningNotes({ context, resolve: async () => destination(root), authorize: async () => { if (++calls === 2) during.abort(); } });
    await expect(second(record, during.signal)).rejects.toThrow('cancelled');
    expect(await readdir(path.join(root, 'Learning', record.workspaceId))).toEqual([]);
  });

  it('rejects foreign profile/workspace/source records and traversal identities', async () => {
    const root = await temp(); const save = await pinLearningNotes({ context, resolve: async () => destination(root) });
    for (const change of [{ profileId: 'profile-two' }, { workspaceId: 'workspace-two' }, { sessionId: 'session-two' }, { revision: 'revision-two' }, { runId: '../outside' }, { promptSha256: 'invalid' }, { evidence: [] }, { evidence: [record.evidence[0]!, record.evidence[0]!] }]) await expect(save({ ...record, ...change })).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it('does not publish when cancellation arrives during the final asynchronous folder check', async () => {
    const root = await temp(), controller = new AbortController(); let resolutions = 0;
    const save = await pinLearningNotes({ context, resolve: async () => {
      if (++resolutions === 5) controller.abort();
      return destination(root);
    } });
    await expect(save(record, controller.signal)).rejects.toThrow('cancelled');
    expect(resolutions).toBe(5); expect(await readdir(path.join(root, 'Learning', record.workspaceId))).toEqual([]);
  });

  it('redacts generated text and evidence on export', async () => {
    const root = await temp(), save = await pinLearningNotes({ context, resolve: async () => destination(root) });
    const relative = await save({ ...record, lesson: 'Never reuse password=synthetic-secret', evidence: [{ ...record.evidence[0]!, content: 'token=synthetic-secret' }] });
    const body = await readFile(path.join(root, relative), 'utf8'); expect(body).toContain('[redacted]'); expect(body).not.toContain('synthetic-secret');
  });
});
