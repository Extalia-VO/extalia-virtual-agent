import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installerCopy } from '../scripts/installer-copy.mjs';
import { prepareInstallerFiles, verifyInstallerArtwork } from '../scripts/installer-assets.mjs';
import afterAllArtifactBuild from '../scripts/create-linux-installer.mjs';
import { verifyLinuxInstaller } from '../scripts/linux-installer.mjs';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'extalia-installer-assets-')); temporary.push(root);
  await cp(new URL('../build/installer', import.meta.url), path.join(root, 'build/installer'), { recursive: true });
  return root;
}

describe('English native installer media', () => {
  it('verifies the committed standard/retina artwork and exact native bitmap dimensions', async () => {
    await expect(verifyInstallerArtwork()).resolves.toBeUndefined();
    const copy = await installerCopy();
    expect(copy.macInstallTitle).toBe('Drag. Drop. Get started.');
    const configuration = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8');
    expect(configuration).toContain('oneClick: false');
    expect(configuration).toContain('allowToChangeInstallationDirectory: true');
    expect(configuration).toContain('installerLanguages: [en_US]');
    expect(configuration).toContain('multiLanguageInstaller: false');
    expect(configuration).toContain('afterAllArtifactBuild: ./scripts/create-linux-installer.mjs');
  });
  it('rejects modified media before preparing installer files', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'build/installer/dmg-background.png'), 'changed image');
    await expect(prepareInstallerFiles(root)).rejects.toThrow();
  });
  it('prepares English native copy and discloses preview signing only for preview media', async () => {
    const root = await fixture();
    const output = await prepareInstallerFiles(root, 'preview');
    const copy = await installerCopy();
    expect(await readFile(path.join(output, copy.guideName!), 'utf8')).toContain(copy.guidePreview);
    const include = await readFile(path.join(output, 'windows-installer.nsh'), 'utf8');
    expect(include).toContain('!macro customWelcomePage');
    expect(include).toContain('Welcome to Extalia');
    expect(include).toContain('MUI_PAGE_WELCOME');
    expect(include).not.toContain('customFinishPage'); // Keep built-in update/launch handling.
    await prepareInstallerFiles(root, 'notarized');
    expect(await readFile(path.join(output, copy.guideName!), 'utf8')).not.toContain(copy.guidePreview);
  });
  it('adds the offline Linux setup after packaging while leaving other OS targets alone', async () => {
    await expect(afterAllArtifactBuild({ artifactPaths: ['Extalia-1.2.3-mac-arm64.dmg'] })).resolves.toEqual([]);
    const root = await fixture(), appImage = path.join(root, 'Extalia-1.2.3-linux-x86_64.AppImage');
    await writeFile(appImage, 'Synthetic AppImage bytes; never executed.');
    const [installer] = await afterAllArtifactBuild({ artifactPaths: [appImage, path.join(root, 'Extalia-1.2.3-linux-amd64.deb')] });
    expect(path.basename(installer!)).toBe('Extalia-1.2.3-linux-x64-setup.run');
    await expect(verifyLinuxInstaller({ installer: installer!, appImage, version: '1.2.3', icon: fileURLToPath(new URL('../build/icon.png', import.meta.url)) })).resolves.toBeUndefined();
  });
});
