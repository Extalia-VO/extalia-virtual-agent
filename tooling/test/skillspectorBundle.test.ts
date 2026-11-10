import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSkillSpectorBundle, verifySkillSpectorBundle, type SkillSpectorManifest } from '../skillspector/build.mjs';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'extalia-skillspector-fixture-')); temporary.push(root);
  const header = Buffer.alloc(32); header.writeUInt32LE(0xfeedfacf, 0); header.writeUInt32LE(0x0100000c, 4);
  const files = [{ path: 'python/bin/python3.13', data: header, executable: true }, { path: 'worker/scan.py', data: Buffer.from('# Synthetic nonexecuting fixture\n'), executable: false }];
  for (const file of files) { const target = path.join(root, 'payload', file.path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.data); await chmod(target, file.executable ? 0o755 : 0o644); }
  const manifest: SkillSpectorManifest = { schema_version: 1, target: { os: 'macos', arch: 'aarch64' }, runtime_version: '3.13.18', scanner_version: '2.13.4', source_commit: '54824463814a0be01360792523ec7245a69190fc', normalizer_version: 'extalia-skillspector-v1', interpreter: 'python/bin/python3.13', entry_script: 'worker/scan.py', files: files.map(file => ({ path: file.path, bytes: file.data.length, sha256: sha(file.data), executable: file.executable })) };
  const save = async () => { const bytes = JSON.stringify(manifest); await writeFile(path.join(root, 'bundle-manifest.json'), bytes); return sha(bytes); };
  return { root, manifest, save, hash: await save() };
}

describe('pinned SkillSpector build boundary', () => {
  it('verifies the exact manifest, file inventory, executable mode and platform header', async () => {
    const f = await fixture();
    const result = await verifySkillSpectorBundle(f.root, { expectedSha256: f.hash, target: 'macos-aarch64' });
    expect(result.manifestSha256).toBe(f.hash); expect(result.fileCount).toBe(2); expect(result.totalBytes).toBeGreaterThan(0);
  });
  it('refuses changed manifest authority and target mismatch', async () => {
    const f = await fixture();
    await expect(verifySkillSpectorBundle(f.root, { expectedSha256: '0'.repeat(64) })).rejects.toThrow();
    await expect(verifySkillSpectorBundle(f.root, { target: 'macos-x86_64' })).rejects.toThrow();
  });
  it('refuses tampered payload and additional unlisted files', async () => {
    const f = await fixture(); await writeFile(path.join(f.root, 'payload/worker/scan.py'), 'changed');
    await expect(verifySkillSpectorBundle(f.root)).rejects.toThrow();
    const next = await fixture(); await writeFile(path.join(next.root, 'payload/extra'), 'unlisted');
    await expect(verifySkillSpectorBundle(next.root)).rejects.toThrow();
  });
  it('refuses traversal, duplicate paths and stale source versions', async () => {
    for (const change of ['path', 'duplicate', 'version'] as const) {
      const f = await fixture();
      if (change === 'path') f.manifest.files[0]!.path = '../outside';
      if (change === 'duplicate') f.manifest.files.push({ ...f.manifest.files[0]! });
      if (change === 'version') f.manifest.scanner_version = '2.13.2';
      await f.save(); await expect(verifySkillSpectorBundle(f.root)).rejects.toThrow();
    }
  });
  it('refuses extra manifest fields and missing files', async () => {
    const f = await fixture(); await writeFile(path.join(f.root, 'bundle-manifest.json'), JSON.stringify({ ...f.manifest, extra: true }));
    await expect(verifySkillSpectorBundle(f.root)).rejects.toThrow();
    const next = await fixture(); await rm(path.join(next.root, 'payload/worker/scan.py'));
    await expect(verifySkillSpectorBundle(next.root)).rejects.toThrow();
  });
  it('refuses an executable mode mismatch or a wrong interpreter architecture', async () => {
    const f = await fixture(); f.manifest.files[0]!.executable = false; await f.save();
    await expect(verifySkillSpectorBundle(f.root)).rejects.toThrow();
    const next = await fixture(); next.manifest.target.arch = 'x86_64'; await next.save();
    await expect(verifySkillSpectorBundle(next.root)).rejects.toThrow();
  });
  it.skipIf(process.platform === 'win32')('refuses aliases and symbolic manifest paths', async () => {
    const f = await fixture(); await link(path.join(f.root, 'payload/worker/scan.py'), path.join(f.root, 'alias'));
    await expect(verifySkillSpectorBundle(f.root)).rejects.toThrow();
    const next = await fixture(); const source = path.join(next.root, 'bundle-manifest.json'); await rm(source); await symlink(path.join(f.root, 'bundle-manifest.json'), source);
    await expect(verifySkillSpectorBundle(next.root)).rejects.toThrow();
  });
  it('requires explicit valid inputs before reserving an output location', async () => {
    const f = await fixture(), out = path.join(f.root, 'out');
    await expect(buildSkillSpectorBundle({ target: 'unknown', out, uv: process.execPath })).rejects.toThrow();
    await expect(readFile(path.join(out, 'marker'))).rejects.toThrow();
  });
  it('never replaces existing output and removes only its own failed reservation', async () => {
    const f = await fixture(), out = path.join(f.root, 'out'); await mkdir(out); await writeFile(path.join(out, 'marker'), 'keep');
    await expect(buildSkillSpectorBundle({ target: 'linux-x86_64', out, uv: process.execPath })).rejects.toThrow();
    expect(await readFile(path.join(out, 'marker'), 'utf8')).toBe('keep');
    const failed = path.join(f.root, 'failed'); await expect(buildSkillSpectorBundle({ target: 'linux-x86_64', out: failed, uv: process.execPath })).rejects.toThrow();
    await expect(readFile(path.join(failed, 'bundle-manifest.json'))).rejects.toThrow();
  });
});
