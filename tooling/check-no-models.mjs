#!/usr/bin/env node
// Refuses to publish a build that contains 3D model files. Source-derived avatar models are local-only
// (apps/web/local-assets/, git-ignored); a build made on a machine that has them would carry them along.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const MODEL = /\.(glb|gltf|fbx)$/i;
const roots = process.argv.slice(2);
if (!roots.length) { console.error('Usage: check-no-models.mjs <directory>…'); process.exit(2); }

const found = [];
const walk = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (MODEL.test(entry.name)) found.push(full);
  }
};
for (const root of roots) {
  try { if (statSync(root).isDirectory()) walk(root); } catch { /* nothing built yet */ }
}
if (found.length) {
  console.error(`Refusing to publish: ${found.length} 3D model file(s) in the build, probably local avatar assets.\n` +
    found.slice(0, 10).map(file => `  ${file}`).join('\n') +
    '\nRebuild from a clean checkout (or move apps/web/local-assets/ aside) before publishing.');
  process.exit(1);
}
console.log(`No 3D model files in ${roots.join(', ')}.`);
