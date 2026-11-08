import { build } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { installerBrand, installerCopy } from './scripts/installer-copy.mjs';

// Main and preload run in Electron; `electron` itself is provided at runtime.
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true, logLevel: 'warning' };

await Promise.all([
  build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs',
    define: { __EXTALIA_INSTALLER_COPY__: JSON.stringify(await installerCopy()) } }),
  build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs' }),
  build({ ...common, entryPoints: ['src/installer/preload.ts'], outfile: 'dist/installer/preload.cjs' }),
  build({ bundle: true, platform: 'browser', format: 'iife', target: 'chrome142',
    entryPoints: ['src/installer/renderer.mjs'], outfile: 'dist/installer/renderer.js', logLevel: 'warning' }),
]);

await mkdir('dist/installer', { recursive: true });
const brand = await installerBrand();
await writeFile('dist/installer/brand.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1.41 1"><defs><linearGradient id="brand" x1="0" y1="1" x2="0" y2="0">${brand.gradient.map(([offset, color]) => `<stop offset="${offset}" stop-color="${color}"/>`).join('')}</linearGradient></defs><path d="${brand.symbol}" fill="url(#brand)"/></svg>`);
await Promise.all([
  ...['index.html', 'installer.css'].map(file => copyFile(`src/installer/${file}`, `dist/installer/${file}`)),
  ...['office-building.jpg', 'office-workspace.jpg', 'office-collaboration.jpg'].map(file =>
    copyFile(`installer/office/${file}`, `dist/installer/${file}`)),
]);
