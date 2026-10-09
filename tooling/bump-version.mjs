#!/usr/bin/env node
/**
 * Bump the patch version of the root and every workspace package together, and
 * turn the changelog's Unreleased notes into a section for the new version.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, workspacePackages } from './workspace.mjs';

const rootPath = path.join(ROOT, 'package.json');
const root = JSON.parse(await readFile(rootPath, 'utf8'));
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(root.version);
if (!match) { console.error(`Cannot bump non-release version ${root.version}.`); process.exit(1); }
const next = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;

async function setVersion(file) {
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`));
}

await setVersion(rootPath);
for (const { manifestPath } of await workspacePackages()) await setVersion(manifestPath);

const changelogPath = path.join(ROOT, 'CHANGELOG.md');
const changelog = await readFile(changelogPath, 'utf8');
const heading = '## [Unreleased]';
const start = changelog.indexOf(heading);
if (start >= 0) {
  const bodyStart = start + heading.length;
  const nextSection = changelog.indexOf('\n## [', bodyStart);
  const end = nextSection >= 0 ? nextSection : changelog.length;
  const notes = changelog.slice(bodyStart, end).trim() || '- No notable changes.';
  const date = new Date().toISOString().slice(0, 10);
  const updated = `${changelog.slice(0, start)}${heading}\n\n## [${next}] - ${date}\n\n${notes}\n${changelog.slice(end)}`;
  await writeFile(changelogPath, updated.replace(/\n{3,}/g, '\n\n'));
}

console.log(`Version ${root.version} → ${next}`);
