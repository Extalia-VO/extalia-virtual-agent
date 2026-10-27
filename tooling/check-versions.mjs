#!/usr/bin/env node
/**
 * All workspace packages and Rust crates (manifests and Cargo.lock entries) share the root
 * version (lockstep releases), and the changelog knows it. A manifest that pins the CLI's
 * per-platform daemon packages (`@extalia/daemon-*`) pins all of them to that version.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DAEMON_TARGETS, npmPackageName } from './daemon.mjs';
import { lockEntry, ROOT, rustCrates, tomlVersion, workspacePackages } from './workspace.mjs';

const root = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const problems = [];
const daemonPackages = DAEMON_TARGETS.map(npmPackageName);
for (const { manifest, manifestPath } of await workspacePackages()) {
  const file = path.relative(ROOT, manifestPath);
  if (manifest.version !== root.version) problems.push(`${file}: ${manifest.version} (expected ${root.version})`);
  // Per-platform daemon packages (ADR 0021): when a manifest lists them, it lists all, at the lockstep version.
  const pinned = Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies }).filter(([name]) => name.startsWith('@extalia/daemon-'));
  for (const [name, range] of pinned) if (range !== root.version) problems.push(`${file}: ${name} ${range} (expected ${root.version})`);
  const missing = pinned.length ? daemonPackages.filter(name => !pinned.some(([listed]) => listed === name)) : [];
  if (missing.length) problems.push(`${file}: missing optional dependencies ${missing.join(', ')}`);
}
const crates = await rustCrates();
if (crates.length) {
  const read = async file => { try { return await readFile(path.join(ROOT, file), 'utf8'); } catch { problems.push(`${file}: missing`); return ''; } };
  const workspaceVersion = tomlVersion(await read('Cargo.toml'), 'workspace.package');
  if (workspaceVersion !== root.version) problems.push(`Cargo.toml [workspace.package]: ${workspaceVersion ?? 'no version'} (expected ${root.version})`);
  const lock = await read('Cargo.lock');
  for (const { name, manifestPath, inherited, version } of crates) {
    const declared = inherited ? workspaceVersion : version;
    if (declared !== root.version) problems.push(`${path.relative(ROOT, manifestPath)}: ${declared ?? 'no version'} (expected ${root.version})`);
    const locked = lockEntry(name).exec(lock)?.[2];
    if (locked !== root.version) problems.push(`Cargo.lock ${name}: ${locked ?? 'no entry'} (expected ${root.version})`);
  }
}
const changelog = await readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
if (root.version !== '0.0.0' && !changelog.includes(`## [${root.version}]`)) problems.push(`CHANGELOG.md: missing a section for ${root.version}`);

if (problems.length) {
  console.error(`Version check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`Versions consistent at ${root.version}.`);
