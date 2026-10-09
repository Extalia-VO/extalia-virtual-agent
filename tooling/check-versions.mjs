#!/usr/bin/env node
/** All workspace packages share the root version (lockstep releases), and the changelog knows it. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, workspacePackages } from './workspace.mjs';

const root = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const problems = [];
for (const { manifest, manifestPath } of await workspacePackages()) {
  if (manifest.version !== root.version) problems.push(`${path.relative(ROOT, manifestPath)}: ${manifest.version} (expected ${root.version})`);
}
const changelog = await readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
if (root.version !== '0.0.0' && !changelog.includes(`## [${root.version}]`)) problems.push(`CHANGELOG.md: missing a section for ${root.version}`);

if (problems.length) {
  console.error(`Version check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`Versions consistent at ${root.version}.`);
