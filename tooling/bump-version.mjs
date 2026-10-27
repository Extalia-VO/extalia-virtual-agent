#!/usr/bin/env node
/**
 * Bump the patch version of the root, every workspace package (and any pinned
 * `@extalia/daemon-*` dependency) and every Rust crate (Cargo.toml and the crates'
 * Cargo.lock entries) together, and turn the changelog's
 * Unreleased notes into a section for the new version.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lockEntry, ROOT, rustCrates, setTomlVersion, workspacePackages } from './workspace.mjs';

const rootPath = path.join(ROOT, 'package.json');
const root = JSON.parse(await readFile(rootPath, 'utf8'));
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(root.version);
if (!match) { console.error(`Cannot bump non-release version ${root.version}.`); process.exit(1); }
const next = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;

async function setVersion(file) {
  const text = await readFile(file, 'utf8');
  // The CLI's per-platform daemon packages (@extalia/daemon-*, ADR 0021) are pinned to the lockstep version too.
  await writeFile(file, text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`).replace(/("@extalia\/daemon-[a-z0-9-]+"\s*:\s*")[^"]+(")/g, `$1${next}$2`));
}

await setVersion(rootPath);
for (const { manifestPath } of await workspacePackages()) await setVersion(manifestPath);

const crates = await rustCrates();
if (crates.length) {
  const cargoPath = path.join(ROOT, 'Cargo.toml');
  await writeFile(cargoPath, setTomlVersion(await readFile(cargoPath, 'utf8'), 'workspace.package', next));
  for (const { manifestPath, text, inherited } of crates) if (!inherited) await writeFile(manifestPath, setTomlVersion(text, 'package', next));
  const lockPath = path.join(ROOT, 'Cargo.lock');
  let lock = await readFile(lockPath, 'utf8');
  for (const { name } of crates) lock = lock.replace(lockEntry(name), `$1${next}$3`);
  await writeFile(lockPath, lock);
}

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
