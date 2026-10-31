import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expectedReleaseArtifacts, npmArtifactNames, packageWebRelease, releaseVersion, stageReleaseTree, verifyNpmArtifacts, writeReleaseChecksums } from '../package-release-assets.mjs';

const roots: string[] = [];
const version = '1.2.3', tag = `v${version}`;
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'extalia-release-assets-'))); roots.push(root);
  for (const name of ['package.json', 'apps/web/package.json', 'apps/desktop/package.json', 'apps/cli/package.json']) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), JSON.stringify({ version }));
  }
  const directory = path.join(root, 'artifacts'); await mkdir(directory);
  return { root, directory };
}
async function fill(directory: string, names: string[]) {
  for (const name of names) await writeFile(path.join(directory, name), `Synthetic artifact ${name}\n`);
}

describe('draft release asset assembly', () => {
  it('refuses wrong tags and drift between root/Web/Desktop/CLI versions', async () => {
    const { root } = await fixture();
    expect(await releaseVersion(root, tag)).toBe(version);
    await expect(releaseVersion(root, 'v1.2.4')).rejects.toThrow(/must match/);
    await writeFile(path.join(root, 'apps/cli/package.json'), JSON.stringify({ version: '1.2.4' }));
    await expect(releaseVersion(root, tag)).rejects.toThrow(/must match/);
  });

  it('copies a plain Web tree into a new staging directory and refuses hidden/unreadable entries', async () => {
    const { root, directory } = await fixture(); await mkdir(path.join(directory, 'assets'));
    await writeFile(path.join(directory, 'index.html'), '<html>Public build</html>');
    await writeFile(path.join(directory, 'assets', 'app.js'), 'export const publicBuild = true;');
    const staged = path.join(root, 'staged'); await stageReleaseTree(directory, staged);
    expect(await readFile(path.join(staged, 'assets', 'app.js'), 'utf8')).toContain('publicBuild');
    await writeFile(path.join(directory, '.private'), 'must not ship');
    await expect(stageReleaseTree(directory, path.join(root, 'hidden'))).rejects.toThrow(/entry name/);
    if (process.platform !== 'win32') {
      await rm(path.join(directory, '.private')); const file = path.join(directory, 'unreadable.txt');
      await writeFile(file, 'data'); await chmod(file, 0);
      try { await expect(stageReleaseTree(directory, path.join(root, 'unreadable'))).rejects.toThrow(/Invalid release file/); }
      finally { await chmod(file, 0o600); }
    }
  });

  it.skipIf(process.platform === 'win32')('rejects symlinked and hard-linked Web files rather than archiving their targets', async () => {
    const { root, directory } = await fixture(); const source = path.join(root, 'private.txt'); await writeFile(source, 'private');
    await symlink(source, path.join(directory, 'linked.txt'));
    await expect(stageReleaseTree(directory, path.join(root, 'symlink-stage'))).rejects.toThrow(/Invalid release file/);
    await rm(path.join(directory, 'linked.txt')); await link(source, path.join(directory, 'hardlink.txt'));
    await expect(stageReleaseTree(directory, path.join(root, 'hardlink-stage'))).rejects.toThrow(/Invalid release file/);
  });

  it('accepts exactly six matching packed npm files and refuses extras or another version', async () => {
    const { root, directory } = await fixture(); const names = npmArtifactNames(version); await fill(directory, names);
    expect(await verifyNpmArtifacts(root, directory, tag)).toEqual(names.map((name: string) => path.join(directory, name)));
    await writeFile(path.join(directory, 'extalia-vo-1.2.4.tgz'), 'stale version');
    await expect(verifyNpmArtifacts(root, directory, tag)).rejects.toThrow(/exactly six/);
  });

  for (const mode of ['preview', 'notarized']) it(`hashes every completed ${mode} draft asset, including npm/Web/feeds and optional allowed maps, but never itself`, async () => {
    const { root, directory } = await fixture(); const inventory = expectedReleaseArtifacts(version, mode);
    const map = `Extalia-${version}-win-x64-setup.exe.blockmap`;
    const names = [...inventory.required, map]; await fill(directory, names);
    const sums = await writeReleaseChecksums(root, directory, tag, mode);
    const expected = names.sort().map(name => `${createHash('sha256').update(`Synthetic artifact ${name}\n`).digest('hex')}  ${name}\n`).join('');
    expect(await readFile(sums, 'utf8')).toBe(expected); expect(expected).not.toContain('SHA256SUMS.txt');
    expect(await writeReleaseChecksums(root, directory, tag, mode)).toBe(sums);
    expect(await readFile(sums, 'utf8')).toBe(expected);
    expect((await readdir(directory)).some(name => name.startsWith('.checksums-'))).toBe(false);
  });

  it('does not create complete checksums for missing files, unexpected files or a trusted Mac feed in preview mode', async () => {
    const { root, directory } = await fixture(); const names = expectedReleaseArtifacts(version, 'preview').required;
    await fill(directory, names.slice(1));
    await expect(writeReleaseChecksums(root, directory, tag, 'preview')).rejects.toThrow(/missing/);
    await expect(lstat(path.join(directory, 'SHA256SUMS.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await fill(directory, names.slice(0, 1)); await writeFile(path.join(directory, 'latest-mac.yml'), 'trusted feed');
    await expect(writeReleaseChecksums(root, directory, tag, 'preview')).rejects.toThrow(/Mac release mode/);
    await rm(path.join(directory, 'latest-mac.yml')); await mkdir(path.join(directory, 'nested'));
    await expect(writeReleaseChecksums(root, directory, tag, 'preview')).rejects.toThrow(/Invalid release file/);
  });

  it.skipIf(process.platform === 'win32')('refuses an existing symlinked checksum destination before replacing it', async () => {
    const { root, directory } = await fixture(); await fill(directory, expectedReleaseArtifacts(version, 'preview').required);
    const outside = path.join(root, 'outside.txt'); await writeFile(outside, 'untouched');
    await symlink(outside, path.join(directory, 'SHA256SUMS.txt'));
    await expect(writeReleaseChecksums(root, directory, tag, 'preview')).rejects.toThrow(/Invalid release file/);
    expect(await readFile(outside, 'utf8')).toBe('untouched');
  });

  const hasZip = spawnSync('zip', ['-v']).status === 0 && spawnSync('unzip', ['-v']).status === 0;
  it.skipIf(!hasZip)('archives only the validated public dist tree, and refuses unregistered models or replacement archives', async () => {
    const { root, directory } = await fixture();
    const publicAssets = path.join(root, 'apps/web/public-assets'), dist = path.join(root, 'apps/web/dist');
    await mkdir(path.join(publicAssets, 'building'), { recursive: true }); await mkdir(dist); await mkdir(path.join(root, 'tooling'));
    const license = await readFile(new URL('../../LICENSE', import.meta.url), 'utf8');
    await writeFile(path.join(root, 'LICENSE'), license); await writeFile(path.join(publicAssets, 'LICENSE.md'), license);
    await writeFile(path.join(root, 'tooling/generate.py'), '# Synthetic project model.\n');
    const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }] })); const padded = Math.ceil(json.length / 4) * 4;
    const model = Buffer.alloc(32 + padded); model.write('glTF'); model.writeUInt32LE(2, 4); model.writeUInt32LE(model.length, 8);
    model.writeUInt32LE(padded, 12); model.writeUInt32LE(0x4e4f534a, 16); model.fill(0x20, 20, 20 + padded); json.copy(model, 20);
    model.writeUInt32LE(4, 20 + padded); model.writeUInt32LE(0x004e4942, 24 + padded);
    await writeFile(path.join(publicAssets, 'building/shell.glb'), model);
    const manifest = { schemaVersion: 1, license: 'MIT', models: [{ path: 'building/shell.glb', sha256: createHash('sha256').update(model).digest('hex'), bytes: model.length, license: 'MIT', provenance: { kind: 'project-generated', generator: 'tooling/generate.py' } }] };
    await writeFile(path.join(publicAssets, 'models.json'), JSON.stringify(manifest));
    await writeFile(path.join(dist, 'index.html'), '<html>Public distribution</html>');
    await writeFile(path.join(dist, 'models.json'), JSON.stringify(manifest));
    await writeFile(path.join(dist, 'OFFICE_ASSETS_LICENSE.md'), license); await copyFile(path.join(publicAssets, 'building/shell.glb'), path.join(dist, 'registered.glb'));
    const archive = await packageWebRelease(root, directory, tag);
    expect(path.basename(archive)).toBe(`Extalia-${version}-web.zip`);
    expect(spawnSync('unzip', ['-p', archive, 'index.html'], { encoding: 'utf8' }).stdout).toBe('<html>Public distribution</html>');
    await expect(packageWebRelease(root, directory, tag)).rejects.toThrow(/replace/);
    await rm(archive); await writeFile(path.join(dist, 'unregistered.glb'), Buffer.concat([model, Buffer.from('modified')]));
    await expect(packageWebRelease(root, directory, tag)).rejects.toThrow(/unregistered|modified/);
    await expect(lstat(archive)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
