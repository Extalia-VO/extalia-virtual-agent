/** Verify committed artwork and prepare small catalog-derived files before native packaging. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALLER_ART, installerArtwork } from './installer-artwork.mjs';
import { installerBrand, installerCopy, installerPhotos } from './installer-copy.mjs';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const DMG_SUPPORT_ITEMS = ['.background.tiff', '.background.png', '.VolumeIcon.icns', '.DS_Store'];

/**
 * dmgbuild puts support files at the volume root. Finder can expose dotfiles;
 * keep their saved icon positions outside the artwork even in that mode.
 * The pinned dmg-builder accepts position-only entries, although electron-builder's
 * JSON schema omits that type. Add them after configuration validation in beforePack,
 * before the target computes its settings/signature/blockmap. No files are copied.
 */
export function configureDmgSupportLayout(dmg) {
  if (!dmg || !Array.isArray(dmg.contents)) throw new Error('The branded DMG requires an explicit content layout.');
  const reserved = new Set(DMG_SUPPORT_ITEMS);
  const contents = dmg.contents.filter(item => !(item.type === 'position' && reserved.has(item.name ?? item.path)));
  if (contents.some(item => reserved.has(item.name ?? item.path))) throw new Error('DMG support names are reserved for generated resources.');
  const x = Math.max(1600, (dmg.window?.width ?? 900) + 300);
  dmg.contents = [...contents, ...DMG_SUPPORT_ITEMS.map((name, index) => ({ path: name, name, type: 'position', x, y: 100 + index * 140 }))];
}

export async function verifyInstallerArtwork(directory = path.join(desktop, 'build/installer')) {
  const copy = await installerCopy(), brand = await installerBrand(), photos = await installerPhotos();
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schema !== 'extalia.installer-art.v1' || manifest.language !== 'en' || manifest.copySha256 !== digest(JSON.stringify(copy))
    || manifest.brandSha256 !== digest(JSON.stringify(brand)) || manifest.photosSha256 !== digest(JSON.stringify(photos)) || manifest.sourceSha256 !== digest(await readFile(new URL('./installer-artwork.mjs', import.meta.url)))
    || manifest.assets?.length !== INSTALLER_ART.length) throw new Error('Installer artwork is stale. Run pnpm --filter @extalia/desktop installer:art.');
  for (const spec of INSTALLER_ART) {
    const name = `${spec.name}.${spec.format}`, entry = manifest.assets.find(asset => asset.name === name);
    const data = await readFile(path.join(directory, name));
    const svg = await readFile(path.join(directory, `${spec.name}.svg`));
    const expectedSvg = installerArtwork(spec, copy, brand, photos);
    const width = spec.format === 'png' ? data.readUInt32BE(16) : data.readInt32LE(18);
    const height = spec.format === 'png' ? data.readUInt32BE(20) : data.readInt32LE(22);
    if (!entry || entry.width !== width || entry.height !== height || width !== spec.width || height !== spec.height
      || entry.sha256 !== digest(data) || entry.svgSha256 !== digest(svg) || digest(svg) !== digest(expectedSvg)) throw new Error(`Invalid installer artwork: ${name}.`);
  }
}
const nsis = value => value.replace(/\$/g, () => '$$').replace(/"/g, '$\\"').replace(/\r?\n/g, '$\\r$\\n');
export async function prepareInstallerFiles(projectDirectory = desktop, mode = 'preview') {
  if (mode !== 'preview' && mode !== 'notarized') throw new Error('Unknown installer signing mode.');
  await verifyInstallerArtwork(path.join(projectDirectory, 'build/installer'));
  const copy = await installerCopy(), directory = path.join(projectDirectory, 'build-resources/installer');
  await mkdir(directory, { recursive: true });
  const guide = `${copy.guideTitle}\n\n${copy.guideSteps}\n\n${copy.guideUpdate}\n\n${mode === 'preview' ? `${copy.guidePreview}\n\n` : ''}${copy.guideSupport}\n`;
  // Welcome is opt-in in electron-builder's assisted template. Keep its built-in finish/run
  // handling so update launches and desktop/menu shortcuts retain their existing semantics.
  const include = `; Generated from the English installer catalog.\n!macro customWelcomePage\n  !define MUI_WELCOMEPAGE_TITLE "${nsis(copy.windowsWelcomeTitle)}"\n  !define MUI_WELCOMEPAGE_TEXT "${nsis(copy.windowsWelcome)}"\n  !insertmacro MUI_PAGE_WELCOME\n!macroend\n!define MUI_FINISHPAGE_TITLE "${nsis(copy.windowsFinishTitle)}"\n!define MUI_FINISHPAGE_TEXT "${nsis(copy.windowsFinish)}"\n`;
  for (const [name, text] of [[copy.guideName, guide], ['windows-installer.nsh', include]]) {
    const target = path.join(directory, name), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { flag: 'wx' }); await rename(temporary, target);
  }
  return directory;
}
export default async function beforePack(context) {
  await prepareInstallerFiles(context.packager.projectDir, context.packager.config.extraMetadata?.extaliaMacReleaseMode ?? 'preview');
  if (context.electronPlatformName === 'darwin') configureDmgSupportLayout(context.packager.config.dmg);
}
