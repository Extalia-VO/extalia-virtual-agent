import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentHost } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();

describe('workspace directory selection through the host', () => {
  it('starts in the configured host home and validates a selected folder through the workspace boundary', async () => {
    const root = await temp('extalia-directory-host-');
    const home = path.join(root, 'home');
    const project = path.join(home, 'Project with spaces');
    await mkdir(project, { recursive: true });
    const canonicalHome = await realpath(home);
    const canonicalProject = await realpath(project);
    await writeFile(path.join(home, 'private-file.txt'), 'not part of the directory listing');
    const runtime = await createAgentHost({ kind: 'bridge', version: '0.0.0-test', homeDirectory: home, importHome: home,
      dataDirectory: path.join(root, 'data'), env: { EXTALIA_SECRET_STORE: 'memory', PATH: '' } });
    try {
      const listing = await runtime.host.browseDirectories();
      expect(listing.entries).toEqual([{ name: 'Project with spaces', path: canonicalProject }]);
      expect(listing.path).toBe(canonicalHome);
      expect(await runtime.host.checkFolder(listing.entries[0]!.path)).toMatchObject({ ok: true, path: canonicalProject });
      await expect(runtime.host.browseDirectories('../')).rejects.toThrow('absolute');
    } finally { await runtime.close(); }
  });
});
