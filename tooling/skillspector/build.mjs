#!/usr/bin/env node
/** Build-time only. End users never download packages or require system Python/uv. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildPythonBundle, candidatePins } from '../python-bundle/build.mjs';
import { readExecutableKind } from '../daemon.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = 'https://github.com/NVIDIA/SkillSpector.git';
const COMMIT = '54824463814a0be01360792523ec7245a69190fc';
const VERSION = '2.13.4';
const NORMALIZER = 'extalia-skillspector-v1';
const UV_VERSION = '0.13.7';
const MAX_FILES = 32768, MAX_BYTES = 512 * 1024**2, MAX_FILE = 128 * 1024**2;
const TARGETS = { 'macos-aarch64': 'aarch64-apple-darwin', 'macos-x86_64': 'x86_64-apple-darwin', 'linux-x86_64': 'x86_64-unknown-linux-gnu', 'linux-aarch64': 'aarch64-unknown-linux-gnu', 'windows-x86_64': 'x86_64-pc-windows-msvc' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const refusal = () => new Error('SkillSpector bundle validation or staging refused.');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

async function removeOwned(directory) {
  const stat = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!stat) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    await chmod(directory, 0o700);
    for (const name of await readdir(directory)) await removeOwned(path.join(directory, name));
  }
  await rm(directory, { recursive: true, force: true });
}

function run(command, args, environment, cwd, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let bytes = 0, output = '';
    const collect = chunk => { bytes += chunk.length; if (bytes > 1024**2) child.kill(); else output += chunk.toString('utf8'); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill(), timeout);
    child.once('error', () => { clearTimeout(timer); reject(refusal()); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0 && bytes <= 1024**2) resolve(output);
      else reject(new Error(`SkillSpector staging command ${path.basename(command)} failed (${code ?? 'signal'}).`));
    });
  });
}

function validPath(relative) {
  return typeof relative === 'string' && relative.length > 0 && relative.length <= 512
    && !relative.includes('\\') && !relative.includes(':') && !relative.includes('\0')
    && relative.split('/').length <= 32 && relative.split('/').every(part => part && part !== '.' && part !== '..');
}

async function inventory(root) {
  const records = []; let total = 0;
  async function walk(directory, prefix = '') {
    const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw refusal();
    for (const name of (await readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (!validPath(relative)) throw refusal();
      const file = path.join(directory, name), meta = await lstat(file);
      if (meta.isSymbolicLink()) throw refusal();
      if (meta.isDirectory()) { await walk(file, relative); continue; }
      if (!meta.isFile() || meta.nlink !== 1 || meta.size > MAX_FILE || records.length >= MAX_FILES) throw refusal();
      total += meta.size; if (total > MAX_BYTES) throw refusal();
      records.push({ path: relative, bytes: meta.size, sha256: await hashFile(file), executable: Boolean(meta.mode & 0o111) });
    }
  }
  await walk(root);
  return records.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

async function copyTree(source, destination) {
  const meta = await lstat(source); if (!meta.isDirectory() || meta.isSymbolicLink()) throw refusal();
  await mkdir(destination, { mode: 0o700 });
  for (const item of await inventory(source)) {
    const target = path.join(destination, item.path); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(path.join(source, item.path), target); await chmod(target, item.executable ? 0o755 : 0o644);
  }
}

async function copyPinnedSource(source, destination, env, cwd) {
  // Copy only committed blobs, never ignored caches or an untracked local .py.
  const listed = await run('git', ['-C', source, 'ls-tree', '-r', '-z', COMMIT, '--', 'src/skillspector'], env, cwd);
  const prefix = 'src/skillspector/'; let count = 0;
  for (const item of listed.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(item);
    if (!match || !match[3].startsWith(prefix) || !validPath(match[3])) throw refusal();
    const relative = match[3].slice(prefix.length), file = path.join(source, match[3]), meta = await lstat(file);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.nlink !== 1 || meta.size > MAX_FILE || ++count > MAX_FILES) throw refusal();
    const bytes = await readFile(file);
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (blob !== match[2]) throw refusal();
    const target = path.join(destination, relative); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: match[1] === '100755' ? 0o755 : 0o644 });
  }
  if (!count) throw refusal();
}

function exactKeys(value, keys) { return plain(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'); }

/** Build-time verification only. Runtime additionally requires the compiled manifest digest. */
export async function verifySkillSpectorBundle(root, { expectedSha256, target } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw refusal();
  const rootStat = await lstat(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw refusal();
  const file = path.join(root, 'bundle-manifest.json'), stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * 1024**2) throw refusal();
  const bytes = await readFile(file), manifestSha256 = digest(bytes);
  if (expectedSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(expectedSha256) || expectedSha256 !== manifestSha256)) throw refusal();
  const value = JSON.parse(bytes.toString('utf8'));
  if (!exactKeys(value, ['schema_version', 'target', 'runtime_version', 'scanner_version', 'source_commit', 'normalizer_version', 'interpreter', 'entry_script', 'files'])
    || value.schema_version !== 1 || value.runtime_version !== '3.13.18' || value.scanner_version !== VERSION
    || value.source_commit !== COMMIT || value.normalizer_version !== NORMALIZER
    || !exactKeys(value.target, ['os', 'arch']) || !TARGETS[`${value.target.os}-${value.target.arch}`]
    || (target !== undefined && target !== `${value.target.os}-${value.target.arch}`)
    || value.interpreter !== (value.target.os === 'windows' ? 'python/python.exe' : 'python/bin/python3.13')
    || value.entry_script !== 'worker/scan.py' || !Array.isArray(value.files) || !value.files.length || value.files.length > MAX_FILES) throw refusal();
  const observed = await inventory(path.join(root, 'payload'));
  if (observed.length !== value.files.length) throw refusal();
  for (let i = 0; i < observed.length; i++) {
    const expected = value.files[i], actual = observed[i];
    if (!exactKeys(expected, ['path', 'bytes', 'sha256', 'executable']) || !validPath(expected.path)
      || expected.path !== actual.path || expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256
      || typeof expected.executable !== 'boolean'
      // Windows filesystems do not expose POSIX execute bits. The pinned manifest
      // still declares target modes; POSIX packaging/runtime verifies actual modes.
      || (process.platform !== 'win32' && expected.executable !== actual.executable)) throw refusal();
  }
  if (!value.files.some(item => item.path === value.interpreter && item.executable) || !observed.some(item => item.path === value.entry_script)) throw refusal();
  const executable = await readExecutableKind(path.join(root, 'payload', value.interpreter));
  if (executable?.platform !== ({ macos: 'darwin', linux: 'linux', windows: 'win32' })[value.target.os]
    || executable?.arch !== (value.target.arch === 'aarch64' ? 'arm64' : 'x64')) throw refusal();
  return { manifestSha256, manifest: value, fileCount: observed.length, totalBytes: observed.reduce((sum, item) => sum + item.bytes, 0) };
}

async function signNative(payload, records, identity, keychain, env) {
  const native = [];
  for (const item of records) {
    const bytes = await readFile(path.join(payload, item.path));
    const magic = bytes.length >= 4 ? bytes.readUInt32BE(0) : 0;
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) native.push(item.path);
  }
  for (const file of native) {
    const args = ['--force', '--options', 'runtime', identity === '-' ? '--timestamp=none' : '--timestamp', '--sign', identity];
    if (keychain) args.push('--keychain', keychain);
    if (file.startsWith('python/bin/')) args.push('--entitlements', path.join(HERE, 'entitlements.mac.plist'));
    args.push(path.join(payload, file)); await run('/usr/bin/codesign', args, env, payload);
    await run('/usr/bin/codesign', ['--verify', '--strict', path.join(payload, file)], env, payload);
  }
  return native.length;
}

/** Trusted maintainer inputs only. Out must be absent; downloads are explicit build-time actions. */
export async function buildSkillSpectorBundle({ target, out, runtimeBundle, sourceDirectory, uv, download = false, signIdentity, keychain, cacheDirectory, buildPython } = {}) {
  if (!TARGETS[target] || typeof out !== 'string' || !path.isAbsolute(out) || typeof uv !== 'string' || !path.isAbsolute(uv)
    || typeof download !== 'boolean' || (runtimeBundle !== undefined && !path.isAbsolute(runtimeBundle))
    || (sourceDirectory !== undefined && !path.isAbsolute(sourceDirectory)) || (cacheDirectory !== undefined && !path.isAbsolute(cacheDirectory)) || (buildPython !== undefined && !path.isAbsolute(buildPython))
    || (signIdentity !== undefined && (typeof signIdentity !== 'string' || !signIdentity.trim()))
    || (keychain !== undefined && (typeof keychain !== 'string' || !path.isAbsolute(keychain)))) throw refusal();
  if (target.startsWith('macos-') && process.platform !== 'darwin') throw refusal();
  await mkdir(out, { mode: 0o700 }); let temporary; let success = false;
  try {
    temporary = await mkdtemp(path.join(path.dirname(out), '.extalia-skillspector-build-'));
    const home = path.join(temporary, 'home'); await mkdir(home);
    const env = { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, SYSTEMROOT: process.env.SYSTEMROOT ?? '', WINDIR: process.env.WINDIR ?? '', LANG: 'C.UTF-8', UV_NO_CONFIG: '1', UV_PYTHON_DOWNLOADS: 'never', UV_CACHE_DIR: cacheDirectory ?? path.join(temporary, 'uv-cache'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', PYTHONDONTWRITEBYTECODE: '1' };
    const uvVersion = (await run(uv, ['--version'], env, temporary)).trim();
    if (uvVersion !== `uv ${UV_VERSION}` && !uvVersion.startsWith(`uv ${UV_VERSION} `)) throw refusal();
    let source = sourceDirectory;
    if (!source) {
      if (!download) throw refusal(); source = path.join(temporary, 'source');
      await run('git', ['clone', '--quiet', '-c', 'core.autocrlf=false', '--depth', '1', '--branch', `v${VERSION}`, SOURCE, source], env, temporary);
    }
    if ((await run('git', ['-C', source, 'rev-parse', 'HEAD'], env, temporary)).trim() !== COMMIT
      || (await run('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no', '--', 'src/skillspector', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'pyproject.toml'], env, temporary)).trim()) throw refusal();
    const project = await readFile(path.join(source, 'pyproject.toml'), 'utf8');
    if (!project.includes(`version = "${VERSION}"`) || !project.includes('license = "Apache-2.0"')) throw refusal();
    let runtime = runtimeBundle;
    if (!runtime) {
      if (!download) throw refusal(); runtime = path.join(temporary, 'runtime');
      await buildPythonBundle({ target, out: runtime, download: true });
    }
    const runtimeManifest = JSON.parse(await readFile(path.join(runtime, 'bundle-manifest.json'), 'utf8'));
    const sourceRecord = JSON.parse(await readFile(path.join(runtime, 'source-record.json'), 'utf8'));
    const runtimePin = (await candidatePins()).assets.find(item => `${item.target.os}-${item.target.arch}` === target);
    if (!runtimePin || sourceRecord.archive_sha256 !== runtimePin.sha256 || sourceRecord.manifest_sha256 !== await hashFile(path.join(runtime, 'bundle-manifest.json'))
      || runtimeManifest.runtime_version !== runtimePin.runtime_version || JSON.stringify(runtimeManifest.target) !== JSON.stringify(runtimePin.target)) throw refusal();
    const runtimeObserved = await inventory(path.join(runtime, 'payload'));
    if (runtimeObserved.length !== runtimeManifest.files.length || runtimeObserved.some(item => !runtimeManifest.files.some(record => record.path === item.path && record.bytes === item.bytes && record.sha256 === item.sha256))) throw refusal();
    const payload = path.join(out, 'payload'); await mkdir(payload);
    await copyTree(path.join(runtime, 'payload', 'python'), path.join(payload, 'python'));
    const dependencies = path.join(payload, 'deps'); await mkdir(dependencies);
    const hostTarget = `${({ darwin: 'macos', linux: 'linux', win32: 'windows' })[process.platform]}-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
    let python = buildPython;
    if (!python && target === hostTarget) python = path.join(payload, 'python', target.startsWith('windows-') ? 'python.exe' : 'bin/python3.13');
    if (!python) {
      if (!download) throw refusal();
      const hostRuntime = path.join(temporary, 'host-runtime'); await buildPythonBundle({ target: hostTarget, out: hostRuntime, download: true });
      python = path.join(hostRuntime, 'payload', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3.13');
    }
    if (target.startsWith('macos-')) env.MACOSX_DEPLOYMENT_TARGET = '14.0';
    const args = ['pip', 'install', '--python', python, '--target', dependencies, '--python-version', '3.13', '--python-platform', TARGETS[target], '--require-hashes', '--only-binary', ':all:', '--no-deps', '--index-url', 'https://pypi.org/simple', '-r', path.join(HERE, 'requirements.lock')];
    if (!download) args.push('--offline');
    await run(uv, args, env, temporary, 600000);
    await copyPinnedSource(source, path.join(dependencies, 'skillspector'), env, temporary);
    const dist = path.join(dependencies, `skillspector-${VERSION}.dist-info`); await mkdir(dist);
    await writeFile(path.join(dist, 'METADATA'), `Metadata-Version: 2.4\nName: skillspector\nVersion: ${VERSION}\nLicense-Expression: Apache-2.0\nRequires-Python: >=3.12,<3.15\n\nPinned NVIDIA source package; see bundled upstream notices and source record.\n`);
    const worker = path.join(payload, 'worker'); await mkdir(worker); await copyFile(path.join(HERE, 'worker.py'), path.join(worker, 'scan.py'));
    const notices = path.join(payload, 'notices'); await mkdir(notices);
    for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'pyproject.toml']) await copyFile(path.join(source, name), path.join(notices, `skillspector-${name}`));
    await copyFile(path.join(HERE, 'requirements.lock'), path.join(notices, 'requirements.lock'));
    const sbom = [];
    for (const name of (await readdir(dependencies)).filter(name => name.endsWith('.dist-info')).sort()) {
      const metadata = await readFile(path.join(dependencies, name, 'METADATA'), 'utf8');
      const field = key => metadata.match(new RegExp(`^${key}: (.*)$`, 'm'))?.[1] ?? null;
      sbom.push({ name: field('Name'), version: field('Version'), licenseExpression: field('License-Expression'), declaredLicense: field('License') });
    }
    await writeFile(path.join(notices, 'dependency-metadata.json'), JSON.stringify(sbom, null, 2) + '\n');
    let records = await inventory(payload), signedFiles = 0;
    if (target.startsWith('macos-')) signedFiles = await signNative(payload, records, signIdentity ?? '-', keychain, env);
    // pip's generated console wrappers contain the staging interpreter's
    // absolute path. The fixed scanner API never needs them. Remove them and
    // reconcile RECORD hashes after native signatures are final.
    const normalization = JSON.parse((await run(python, ['-I', '-S', '-B', path.join(HERE, 'prepare_deps.py'), dependencies], env, temporary)).trim());
    records = await inventory(payload);
    const manifest = { schema_version: 1, target: runtimePin.target, runtime_version: runtimePin.runtime_version, scanner_version: VERSION, source_commit: COMMIT, normalizer_version: NORMALIZER, interpreter: target.startsWith('windows-') ? 'python/python.exe' : 'python/bin/python3.13', entry_script: 'worker/scan.py', files: records };
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n'); if (bytes.length > 8 * 1024**2) throw refusal();
    await writeFile(path.join(out, 'bundle-manifest.json'), bytes, { flag: 'wx', mode: 0o444 });
    await writeFile(path.join(out, 'source-record.json'), JSON.stringify({ schema_version: 1, source: SOURCE, source_commit: COMMIT, scanner_version: VERSION, source_license_sha256: await hashFile(path.join(source, 'LICENSE')), requirements_sha256: await hashFile(path.join(HERE, 'requirements.lock')), worker_sha256: await hashFile(path.join(HERE, 'worker.py')), installation_normalizer_sha256: await hashFile(path.join(HERE, 'prepare_deps.py')), installation_normalization: normalization, uv_version: UV_VERSION, runtime_archive_sha256: runtimePin.sha256, manifest_sha256: digest(bytes), signed_native_files: signedFiles, signing_mode: target.startsWith('macos-') ? signIdentity && signIdentity !== '-' ? 'identity' : 'ad-hoc' : 'none', dependency_count: sbom.length, runtime_ready_platform: target.startsWith('macos-') ? 'macos-sandbox-required' : 'unsupported-until-native-isolation-verified' }, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
    const result = await verifySkillSpectorBundle(out, { expectedSha256: digest(bytes), target });
    success = true; return { manifestSha256: result.manifestSha256, fileCount: result.fileCount, totalBytes: result.totalBytes, signedFiles };
  } finally {
    try { if (temporary) await removeOwned(temporary); } finally { if (!success) await removeOwned(out); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { target: { type: 'string' }, out: { type: 'string' }, uv: { type: 'string' }, download: { type: 'boolean', default: false }, 'runtime-bundle': { type: 'string' }, 'source-directory': { type: 'string' }, 'sign-identity': { type: 'string' }, keychain: { type: 'string' }, 'cache-directory': { type: 'string' }, 'build-python': { type: 'string' } } });
    console.log(JSON.stringify(await buildSkillSpectorBundle({ ...values, runtimeBundle: values['runtime-bundle'], sourceDirectory: values['source-directory'], signIdentity: values['sign-identity'], cacheDirectory: values['cache-directory'], buildPython: values['build-python'] })));
  } catch { console.error('SkillSpector staging refused; verify explicit pin, inputs, target, build-tool version and an absent output directory.'); process.exitCode = 2; }
}
