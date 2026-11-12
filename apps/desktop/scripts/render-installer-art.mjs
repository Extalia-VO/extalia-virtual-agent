/** Maintainer-only asset rendering: `electron scripts/render-installer-art.mjs`. No real user profile is opened. */
import { app, BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALLER_ART, installerArtwork } from './installer-artwork.mjs';
import { installerBrand, installerCopy, installerPhotos } from './installer-copy.mjs';

const destination = fileURLToPath(new URL('../build/installer/', import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'extalia-installer-art-'));
app.setPath('userData', temporary);
app.setPath('sessionData', temporary);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => { /* Render all media before quitting. */ });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Opaque SVG artwork becomes a standard 24-bit, bottom-up NSIS bitmap. */
function bitmap(image, width, height) {
  const raw = image.toBitmap(), stride = (width * 3 + 3) & ~3;
  const bytes = Buffer.alloc(54 + stride * height);
  bytes.write('BM'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(width, 18); bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28); bytes.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = (y * width + x) * 4, to = 54 + (height - y - 1) * stride + x * 3;
    raw.copy(bytes, to, from, from + 3);
  }
  return bytes;
}

async function main() { try {
  await app.whenReady();
  await mkdir(destination, { recursive: true });
  const copy = await installerCopy(), brand = await installerBrand(), photos = await installerPhotos();
  const assets = [];
  for (const spec of INSTALLER_ART) {
    const svg = installerArtwork(spec, copy, brand, photos);
    const window = new BrowserWindow({ show: false, width: spec.width, height: spec.height,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `installer-art-${process.pid}` } });
    try {
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await window.loadURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      await window.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
      const captured = await window.webContents.capturePage();
      const image = captured.resize({ width: spec.width, height: spec.height, quality: 'best' });
      const data = spec.format === 'bmp' ? bitmap(image, spec.width, spec.height) : image.toPNG();
      const name = `${spec.name}.${spec.format}`;
      await writeFile(path.join(destination, name), data);
      await writeFile(path.join(destination, `${spec.name}.svg`), svg);
      assets.push({ name, width: spec.width, height: spec.height, sha256: digest(data), svgSha256: digest(svg) });
    } finally { window.destroy(); }
  }
  const source = await readFile(new URL('./installer-artwork.mjs', import.meta.url));
  await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify({ schema: 'extalia.installer-art.v1', language: 'en',
    copySha256: digest(JSON.stringify(copy)), brandSha256: digest(JSON.stringify(brand)), photosSha256: digest(JSON.stringify(photos)), sourceSha256: digest(source), assets }, null, 2)}\n`);
  console.log(`Rendered ${assets.length} English installer assets.`);
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
  app.quit();
} }
void main();
