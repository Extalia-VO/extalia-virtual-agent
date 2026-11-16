import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
async function unlock(directory: string): Promise<void> {
  const info = await lstat(directory).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return;
  await chmod(directory, info.isDirectory() ? 0o700 : 0o600);
  if (info.isDirectory()) for (const name of await readdir(directory)) await unlock(path.join(directory, name));
}

describe.skipIf(!HAS_DAEMON || process.platform === 'win32')('global skill upgrade through the actual host', () => {
  it('retains registry history, source bytes and W0 folders across migration, new imports and restart', async () => {
    const directory = await temp('extalia-skill-upgrade-');
    const data = path.join(directory, 'data'), home = path.join(directory, 'home'), source = path.join(directory, 'source');
    await mkdir(home); await mkdir(source);
    const body = '---\nname: upgrade-procedure\ndescription: Validate input before publishing\n---\nValidate all input before publishing.\n';
    await writeFile(path.join(source, 'SKILL.md'), body);
    const globalRoot = path.join(data, 'skills'), oldRoot = path.join(data, 'profiles/default/skills');
    const w0 = path.join(globalRoot, 'local-policy');
    await mkdir(w0, { recursive: true }); await writeFile(path.join(w0, 'SKILL.md'), '# Local policy\n');
    const open = () => createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
      observationIntervalMs: 60_000, knowledge: { watcher: false }, daemon: { log: () => undefined },
      env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_DAEMON_PATH: DAEMON_BINARY, EXTALIA_NATIVE_CORE: 'typescript', PATH: '' } });
    let runtime: AgentHostRuntime | undefined;
    try {
      runtime = await open();
      const imported = await runtime.host.importSkill({ kind: 'folder', path: source });
      const before = await runtime.host.inspectSkill(imported.revisionId!);
      expect(before.revision).toMatchObject({ state: 'quarantined', active: false });
      expect(before.approvals).toEqual([]);
      const oldFile = path.join(oldRoot, 'objects', before.revision.treeSha256, 'SKILL.md');
      const newFile = path.join(globalRoot, 'objects', before.revision.treeSha256, 'SKILL.md');
      const originalMode = (await lstat(newFile)).mode & 0o777;
      await runtime.close(); runtime = undefined;

      // Recreate a valid pre-upgrade layout without changing its actual registry DB.
      await mkdir(oldRoot, { recursive: true });
      await rename(path.join(globalRoot, 'objects'), path.join(oldRoot, 'objects'));
      await rm(path.join(globalRoot, 'layout-v1'));
      const abandoned = path.join(data, 'profiles/default/skill-imports/abandoned');
      await mkdir(abandoned, { recursive: true }); await writeFile(path.join(abandoned, 'SKILL.md'), body);

      runtime = await open();
      expect((await runtime.host.skillRegistry()).status).toBe('ready');
      expect(await runtime.host.inspectSkill(imported.revisionId!)).toEqual(before);
      expect(await readFile(newFile, 'utf8')).toBe(body);
      expect(await readFile(oldFile, 'utf8')).toBe(body);
      expect((await lstat(newFile)).mode & 0o777).toBe(originalMode);
      expect(await readFile(path.join(w0, 'SKILL.md'), 'utf8')).toBe('# Local policy\n');
      expect(await readdir(path.join(globalRoot, 'imports'))).toEqual([]);
      expect(await readFile(path.join(abandoned, 'SKILL.md'), 'utf8')).toBe(body);

      await writeFile(path.join(source, 'SKILL.md'), `${body}Use a dry run before writing.\n`);
      const updated = await runtime.host.importSkill({ kind: 'folder', path: source });
      expect(updated.created).toBe(true); expect(updated.revisionId).not.toBe(imported.revisionId);
      const next = await runtime.host.inspectSkill(updated.revisionId!);
      expect(await readFile(path.join(globalRoot, 'objects', next.revision.treeSha256, 'SKILL.md'), 'utf8')).toContain('dry run');
      await expect(lstat(path.join(oldRoot, 'objects', next.revision.treeSha256))).rejects.toMatchObject({ code: 'ENOENT' });
      await runtime.close(); runtime = undefined;

      runtime = await open();
      const report = await runtime.host.skillRegistry();
      expect(report.status).toBe('ready');
      expect(report.revisions.map(revision => revision.revisionId).sort()).toEqual([imported.revisionId, updated.revisionId].sort());
      expect(await runtime.host.inspectSkill(imported.revisionId!)).toEqual(before);
      expect(await runtime.host.inspectSkill(updated.revisionId!)).toEqual(next);
    } finally {
      await runtime?.close(); await unlock(globalRoot); await unlock(path.join(data, 'profiles'));
    }
  }, 20_000);
});
