/** electron-builder hook: the interactive download supplements the existing AppImage/deb update targets. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLinuxInstaller, verifyLinuxInstaller } from './linux-installer.mjs';

export default async function afterAllArtifactBuild(result) {
  const images = result.artifactPaths.filter(file => file.endsWith('-linux-x86_64.AppImage'));
  if (!images.length) return [];
  if (images.length !== 1) throw new Error('Expected one Linux AppImage for the interactive installer.');
  const appImage = images[0], match = /^Extalia-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-linux-x86_64\.AppImage$/.exec(path.basename(appImage));
  if (!match) throw new Error('Unexpected Linux AppImage artifact name.');
  const version = match[1], output = path.join(path.dirname(appImage), `Extalia-${version}-linux-x64-setup.run`);
  const icon = fileURLToPath(new URL('../build/icon.png', import.meta.url));
  await buildLinuxInstaller({ appImage, output, icon, version });
  await verifyLinuxInstaller({ installer: output, appImage, icon, version });
  return [output];
}
