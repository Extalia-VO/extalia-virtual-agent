import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { installerCopy } from './installer-copy.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function payload(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error('Installer payload must be a nonempty regular file.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { file, size: stat.size, hash: hash.digest('hex') };
}

async function installerParts({ appImage, icon, version, copy }) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid installer version.');
  const app = await payload(appImage);
  const image = icon ? await payload(icon) : { size: 0, hash: '-' };
  const labels = { ...await installerCopy(), ...copy };
  let template = await readFile(new URL('../installer/linux-install.sh', import.meta.url), 'utf8');
  const values = { ...Object.fromEntries(Object.entries(labels).filter(([key]) => key.startsWith('linux')).map(([key, value]) => [key, quote(value)])), VERSION: quote(version), APP_SIZE: String(app.size), ICON_SIZE: String(image.size), APP_HASH: quote(app.hash), ICON_HASH: quote(image.hash) };
  template = template.replace(/@@([A-Za-z_]+)@@/g, (token, key) => values[key] ?? token);
  // Fixed-width offsets keep header length stable while describing raw payloads.
  const headerSize = Buffer.byteLength(template.replaceAll('@@APP_OFFSET@@', '0000000000000000').replaceAll('@@ICON_OFFSET@@', '0000000000000000').replaceAll('@@TOTAL_SIZE@@', '0000000000000000'));
  template = template.replaceAll('@@APP_OFFSET@@', String(headerSize + 1).padStart(16, '0')).replaceAll('@@ICON_OFFSET@@', String(headerSize + app.size + 1).padStart(16, '0')).replaceAll('@@TOTAL_SIZE@@', String(headerSize + app.size + image.size).padStart(16, '0'));
  if (/@@[A-Za-z_]+@@/.test(template)) throw new Error('Missing installer copy.');
  async function* contents() {
    yield Buffer.from(template);
    for (const item of [app, image]) {
      if (!item.file) continue;
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(item.file)) { hash.update(chunk); yield chunk; }
      if (hash.digest('hex') !== item.hash) throw new Error('Installer payload changed during generation.');
    }
  }
  return { contents, size: headerSize + app.size + image.size };
}

/** @param {import('./linux-installer.mjs').LinuxInstallerOptions} options */
export async function buildLinuxInstaller(options) {
  const { output } = options;
  if ([options.appImage, options.icon].some(file => file && path.resolve(file) === path.resolve(output))) throw new Error('Installer output must differ from its payload.');
  const { contents } = await installerParts(options);
  const temporary = path.join(path.dirname(output), `.extalia-installer-${randomBytes(12).toString('hex')}`);
  try {
    await pipeline(contents(), createWriteStream(temporary, { flags: 'wx', mode: 0o700 }));
    await chmod(temporary, 0o755);
    await rename(temporary, output);
  } finally { await rm(temporary, { force: true }); }
}

/** Verify exact generated header and pinned payloads without running the installer. */
export async function verifyLinuxInstaller({ installer, ...options }) {
  const { contents, size } = await installerParts(options);
  const stat = await lstat(installer);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== size) throw new Error('Linux installer is incomplete or does not match this release.');
  const expected = createHash('sha256');
  for await (const chunk of contents()) expected.update(chunk);
  const actual = createHash('sha256');
  for await (const chunk of createReadStream(installer)) actual.update(chunk);
  if (actual.digest('hex') !== expected.digest('hex')) throw new Error('Linux installer is corrupted or does not match this release.');
}
