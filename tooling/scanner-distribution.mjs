/** Build-time pairing of a verified scanner bundle with the daemon that embeds its pin. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readExecutableKind } from './daemon.mjs';

export const SCANNER_BINDING = 'scanner-binding.json';
const HASH = /^[a-f0-9]{64}$/;
export function scannerTarget(target) {
  const os = { darwin: 'macos', linux: 'linux', win32: 'windows' }[target.platform];
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[target.arch];
  if (!os || !arch) throw new Error('Unsupported scanner distribution target.');
  return `${os}-${arch}`;
}

async function digest(file) {
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 128 * 1024 * 1024) throw new Error('Invalid daemon artifact.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Uses the stager's exact-file verification, never an adjacent claimed digest as authority. */
export async function verifyScannerBundle(root, target, expectedSha256) {
  const { verifySkillSpectorBundle } = await import('./skillspector/build.mjs');
  return verifySkillSpectorBundle(root, { target: scannerTarget(target), ...(expectedSha256 ? { expectedSha256 } : {}) });
}

/** Native files are signed before the manifest; later signing may not alter them. */
export async function verifyScannerSignatures(root, target, requireDeveloperId = false, run = spawnSync) {
  if (target.platform !== 'darwin') return;
  if (process.platform !== 'darwin') throw new Error('macOS scanner signatures require a macOS packaging runner.');
  const manifest = JSON.parse(await readFile(path.join(root, 'bundle-manifest.json'), 'utf8'));
  for (const entry of manifest.files) {
    const file = path.join(root, 'payload', entry.path);
    if ((await readExecutableKind(file))?.platform !== 'darwin') continue;
    if (run('/usr/bin/codesign', ['--verify', '--strict', file], { stdio: 'ignore' }).status !== 0) throw new Error('Scanner native signature verification failed.');
    if (requireDeveloperId) {
      const result = run('/usr/bin/codesign', ['--display', '--verbose=4', file], { encoding: 'utf8' });
      const identity = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      if (result.status !== 0 || !identity.includes('Authority=Developer ID Application:') || !/^TeamIdentifier=[A-Z0-9]{10}$/m.test(identity)) {
        throw new Error('Notarized releases require scanner native files pre-signed with Developer ID before the daemon is built.');
      }
    }
  }
}

export async function createScannerBinding(binary, bundle, target) {
  const verified = await verifyScannerBundle(bundle, target);
  const manifestSha256 = verified.manifestSha256;
  if (!HASH.test(manifestSha256)) throw new Error('Invalid verified scanner digest.');
  return { schema: 'extalia.scanner-distribution.v1', platform: target.platform, arch: target.arch,
    daemonSha256: await digest(binary), manifestSha256 };
}

export async function writeScannerBinding(file, binding) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, { flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

export async function verifyScannerBinding({ binary, bundle, bindingFile, target, verifyDaemon = true }) {
  const daemon = await lstat(binary);
  if (!daemon.isFile() || daemon.isSymbolicLink()) throw new Error('Invalid daemon artifact.');
  const entry = await lstat(bindingFile);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024) throw new Error('Invalid scanner distribution binding.');
  const binding = JSON.parse(await readFile(bindingFile, 'utf8'));
  if (Object.keys(binding).sort().join(',') !== 'arch,daemonSha256,manifestSha256,platform,schema'
    || binding.schema !== 'extalia.scanner-distribution.v1' || binding.platform !== target.platform || binding.arch !== target.arch
    || !HASH.test(binding.daemonSha256) || !HASH.test(binding.manifestSha256)) throw new Error('Invalid scanner distribution binding.');
  if (verifyDaemon && await digest(binary) !== binding.daemonSha256) throw new Error('The daemon does not match its scanner distribution binding.');
  await verifyScannerBundle(bundle, target, binding.manifestSha256);
  return binding;
}

/** Replaces only a bundle whose existing verified manifest establishes this tool's ownership. */
export async function copyScannerBundle(source, destination, target, expectedSha256) {
  if (path.resolve(source) === path.resolve(destination)) { await verifyScannerBundle(source, target, expectedSha256); return; }
  await verifyScannerBundle(source, target, expectedSha256);
  const parent = path.dirname(destination); await mkdir(parent, { recursive: true });
  const existing = await lstat(destination).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Refusing to replace an unrelated scanner destination.');
    await verifyScannerBundle(destination, target);
  }
  const temporary = `${destination}.${randomUUID()}.tmp`, backup = `${destination}.${randomUUID()}.backup`;
  let moved = false;
  try {
    await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
    await verifyScannerBundle(temporary, target, expectedSha256);
    if (existing) { await rename(destination, backup); moved = true; }
    await rename(temporary, destination);
    if (moved) await rm(backup, { recursive: true });
  } catch (error) {
    if (moved && !(await lstat(destination).catch(() => undefined))) await rename(backup, destination);
    throw error;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
