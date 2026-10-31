#!/usr/bin/env node
/** Draft-only release assembly. This tool never publishes a release or an npm package. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { releaseArtifactNames, macReleaseMode } from '../apps/desktop/scripts/release.mjs';
import { verifyModelBuild } from './public-models.mjs';
import { ROOT } from './workspace.mjs';

const execute = promisify(execFile);
const SUMS = 'SHA256SUMS.txt';
const SAFE_NAME = /^(?!\.)[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/;

export async function releaseVersion(root, tag) {
  const manifests = await Promise.all(['package.json', 'apps/web/package.json', 'apps/desktop/package.json', 'apps/cli/package.json']
    .map(async file => JSON.parse(await readFile(path.join(root, file), 'utf8'))));
  const version = manifests[0].version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
    || manifests.some(manifest => manifest.version !== version) || tag !== `v${version}`) throw new Error('Release tag and Web/Desktop/CLI versions must match.');
  return version;
}

/** Read the checked regular file through an owned descriptor, never a filesystem link. */
async function regularBytes(file, allowEmpty = false) {
  const before = await lstat(file);
  if (!before.isFile() || before.nlink !== 1 || !(before.mode & 0o444) || (!allowEmpty && before.size === 0)) throw new Error(`Invalid release file: ${path.basename(file)}.`);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('Release file changed during assembly.');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Release file changed during assembly.');
    return bytes;
  } finally { await handle.close(); }
}

/** Copy only readable regular files/directories to a new private staging tree. */
export async function stageReleaseTree(source, destination) {
  const info = await lstat(source);
  if (!info.isDirectory() || info.isSymbolicLink() || !(info.mode & 0o444)) throw new Error('The Web distribution must be a readable plain directory.');
  await mkdir(destination, { mode: 0o700 });
  for (const name of (await readdir(source)).sort()) {
    if (!SAFE_NAME.test(name)) throw new Error('Unexpected Web distribution entry name.');
    const from = path.join(source, name), to = path.join(destination, name), entry = await lstat(from);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await stageReleaseTree(from, to);
    else await writeFile(to, await regularBytes(from, true), { flag: 'wx', mode: 0o600 });
  }
}

export async function packageWebRelease(root, destination, tag) {
  const version = await releaseVersion(root, tag);
  await mkdir(destination, { recursive: true });
  const target = path.resolve(destination, `Extalia-${version}-web.zip`);
  if (await lstat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; })) throw new Error('Refusing to replace an existing Web archive.');
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'extalia-web-release-')));
  try {
    const staging = path.join(temporary, 'web');
    await stageReleaseTree(path.join(root, 'apps/web/dist'), staging);
    await regularBytes(path.join(staging, 'index.html'));
    // Validate the archived copy, including every model hash/license receipt, not private/local assets.
    verifyModelBuild(staging, { root, requireAll: true });
    const archive = path.join(temporary, 'web.zip');
    await execute('zip', ['-q', '-X', '-r', archive, '.'], { cwd: staging });
    await writeFile(target, await regularBytes(archive), { flag: 'wx', mode: 0o600 });
    return target;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export function npmArtifactNames(version) {
  return ['extalia-vo', ...['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'].map(target => `extalia-daemon-${target}`)]
    .map(name => `${name}-${version}.tgz`).sort();
}

async function flatInventory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Artifacts must be in a plain directory.');
  const entries = [];
  for (const name of (await readdir(directory)).sort()) {
    if (!SAFE_NAME.test(name)) throw new Error('Unexpected release artifact name.');
    entries.push({ name, sha256: createHash('sha256').update(await regularBytes(path.join(directory, name))).digest('hex') });
  }
  return entries;
}

export async function verifyNpmArtifacts(root, directory, tag) {
  const version = await releaseVersion(root, tag), actual = await flatInventory(directory), expected = npmArtifactNames(version);
  if (actual.length !== expected.length || actual.some((entry, index) => entry.name !== expected[index])) throw new Error('Expected exactly six version-matched npm tarballs.');
  return actual.map(entry => path.join(directory, entry.name));
}

export function expectedReleaseArtifacts(version, mode) {
  macReleaseMode(mode);
  const desktop = ['darwin', 'win32', 'linux'].map(platform => releaseArtifactNames(platform, version));
  const required = [...desktop.flatMap(item => item.payloads), ...npmArtifactNames(version), `Extalia-${version}-web.zip`, desktop[1].metadata, desktop[2].metadata,
    mode === 'preview' ? `Extalia-${version}-mac-PREVIEW.txt` : desktop[0].metadata];
  const maps = desktop.flatMap((item, index) => index === 0 && mode === 'preview' ? [] : item.payloads.map(name => `${name}.blockmap`));
  return { required, allowed: new Set([...required, ...maps]) };
}

/** Every completed draft asset is covered; preview Mac update feeds remain forbidden. */
export async function writeReleaseChecksums(root, directory, tag, mode) {
  const version = await releaseVersion(root, tag), { required, allowed } = expectedReleaseArtifacts(version, mode);
  const entries = (await flatInventory(directory)).filter(entry => entry.name !== SUMS);
  const names = new Set(entries.map(entry => entry.name));
  if (required.some(name => !names.has(name)) || entries.some(entry => !allowed.has(entry.name))) throw new Error('Release assets are missing, unexpected, version-mismatched or incompatible with the Mac release mode.');
  const output = entries.map(entry => `${entry.sha256}  ${entry.name}\n`).join('');
  const temporary = await mkdtemp(path.join(directory, '.checksums-'));
  try {
    await writeFile(path.join(temporary, SUMS), output, { flag: 'wx', mode: 0o600 });
    await rename(path.join(temporary, SUMS), path.join(directory, SUMS));
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return path.join(directory, SUMS);
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, directory: { type: 'string' }, 'mac-mode': { type: 'string' } } });
  const tag = process.env.GITHUB_REF_NAME;
  if (positionals.length !== 1) throw new Error('Choose web, npm, checksums or draft.');
  switch (positionals[0]) {
    case 'web':
      if (!values.out) throw new Error('A Web archive output directory is required.');
      console.log(await packageWebRelease(ROOT, path.resolve(values.out), tag)); break;
    case 'npm':
      if (!values.directory) throw new Error('The packed npm directory is required.');
      console.log((await verifyNpmArtifacts(ROOT, path.resolve(values.directory), tag)).join('\n')); break;
    case 'checksums':
      if (!values.directory || !values['mac-mode']) throw new Error('Artifact directory and Mac release mode are required.');
      console.log(await writeReleaseChecksums(ROOT, path.resolve(values.directory), tag, values['mac-mode'])); break;
    case 'draft': {
      await releaseVersion(ROOT, tag);
      const { stdout } = await execute('gh', ['release', 'view', tag, '--json', 'isDraft,tagName']);
      const release = JSON.parse(stdout);
      if (release.isDraft !== true || release.tagName !== tag) throw new Error('Release upload requires the matching draft.');
      break;
    }
    default: throw new Error('Choose web, npm, checksums or draft.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`release-assets: ${error.message}`); process.exitCode = 1; });
}
