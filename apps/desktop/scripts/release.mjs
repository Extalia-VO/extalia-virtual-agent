/** Release-only packaging and upload gates. Local `pnpm dist` remains unsigned-capable. */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIGNING_ENV = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
const OPTIONAL_SIGNING_ENV = ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'];
const ARCH_FAILURES = new Set(['tool-unavailable', 'input-unavailable', 'permission-denied', 'architecture-mismatch', 'invalid-object', 'invalid-arguments', 'tool-failure']);

/** Fixed categories only; never retain or print arbitrary subprocess stderr. */
function architectureFailure(error, stderr) {
  if (error.code === 'ENOENT') return 'tool-unavailable';
  if (error.code === 'EACCES' || error.code === 'EPERM') return 'permission-denied';
  const text = typeof stderr === 'string' ? stderr.slice(0, 4_096).toLowerCase() : '';
  if (/no such file|cannot open|can't open/.test(text)) return 'input-unavailable';
  if (/permission denied|operation not permitted/.test(text)) return 'permission-denied';
  if (/unknown argument|unknown option|unrecognized option|invalid argument|usage:/.test(text)) return 'invalid-arguments';
  if (/does not contain|do not contain|missing architecture|architecture.*not found/.test(text)) return 'architecture-mismatch';
  if (/not an object file|not a mach-o|can't figure out the architecture|invalid object/.test(text)) return 'invalid-object';
  return 'tool-failure';
}

export function macReleaseMode(value = 'preview') {
  if (value !== 'preview' && value !== 'notarized') throw new Error('EXTALIA_MAC_RELEASE_MODE must be preview or notarized.');
  return value;
}

/** Never include subprocess output, arguments or environment in a failure: they may contain credentials. */
export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 20 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        const category = path.basename(command) === 'lipo' ? architectureFailure(error, stderr) : undefined;
        const failure = new Error(`${path.basename(command)} failed (${error.code ?? 'unknown exit'}${category ? `; ${category}` : ''}).`);
        if (category) failure.releaseArchitectureFailure = category;
        reject(failure);
      }
      else resolve({ stdout, stderr });
    });
  });
}

export function releaseBuildOptions(platform, environment) {
  const mode = macReleaseMode(environment.EXTALIA_MAC_RELEASE_MODE);
  const env = { ...environment };
  for (const name of [...SIGNING_ENV, ...OPTIONAL_SIGNING_ENV]) if (!env[name]?.trim()) delete env[name];
  // Packaging has no reason to hold an upload token. Publishing happens only after all gates pass.
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const args = ['exec', 'electron-builder', '--publish', 'never'];
  if (platform === 'darwin') {
    args.push(`--config.extraMetadata.extaliaMacReleaseMode=${mode}`);
    if (mode === 'notarized') {
      const missing = SIGNING_ENV.filter(name => !env[name]);
      if (missing.length) throw new Error(`macOS notarized release requires repository signing/notarization secrets: ${missing.join(', ')}.`);
      env.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
      // Supported by electron-builder 26.15.3; flags apply only to this release invocation.
      args.push('--config.forceCodeSigning=true', '--config.mac.notarize=true', '--config.mac.type=distribution');
    } else {
      // MacTargetHelper.findSigningIdentity explicitly supports "-" as an ad-hoc identity.
      // Do not import a certificate or discover a real identity for a free preview build.
      for (const name of SIGNING_ENV) delete env[name];
      env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
      args.push('--config.mac.identity=-', '--config.mac.notarize=false');
    }
  }
  return { args, env };
}

/** Exact configured installers/update payloads, never release/** or a shell glob. */
export function releaseArtifactNames(platform, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version.');
  // GitHub publish config has no explicit channel: electron-builder emits latest*.yml
  // even for prerelease tags (GitHub's release flag selects the prerelease channel).
  const channel = 'latest';
  const base = `Extalia-${version}`;
  switch (platform) {
    case 'darwin': return { payloads: ['arm64', 'x64'].flatMap(arch => [`${base}-mac-${arch}.dmg`, `${base}-mac-${arch}.zip`]), metadata: `${channel}-mac.yml` };
    case 'win32': return { payloads: [`${base}-win-x64-setup.exe`], metadata: `${channel}.yml` };
    // electron-builder's getArtifactArchName maps x64 by target extension.
    case 'linux': return { payloads: [`${base}-linux-x86_64.AppImage`, `${base}-linux-amd64.deb`], metadata: `${channel}-linux.yml` };
    default: throw new Error('Unsupported release platform.');
  }
}

async function requireFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.size === 0) throw new Error(`Missing or invalid release artifact: ${path.basename(file)}.`);
}

export async function verifyMacApp(app, arch, run = runCommand, mode = 'preview') {
  macReleaseMode(mode);
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported macOS release architecture.');
  const expected = arch === 'x64' ? 'x86_64' : 'arm64';
  const executable = path.join(app, 'Contents', 'MacOS', 'Extalia');
  const actual = await macExecutableArchitectures(executable);
  const observed = actual.join('+');
  if (!actual.includes(expected)) throw new Error(`macOS executable architecture mismatch (expected ${expected}; observed ${observed}).`);
  // Check the actual distributed executable, not just its archive's name.
  let failureCategory;
  try { await run('lipo', ['-verify_arch', expected, executable]); }
  catch (error) {
    // Only a fixed category crosses this diagnostic boundary, never the original error or its cause.
    failureCategory = ARCH_FAILURES.has(error?.releaseArchitectureFailure) ? error.releaseArchitectureFailure : 'tool-failure';
  }
  if (failureCategory) {
    const location = await lipoLocation();
    throw new Error(`macOS lipo verification failed (expected ${expected}; observed ${observed}; tool ${location}; developer override ${process.env.DEVELOPER_DIR ? 'set' : 'unset'}; ${failureCategory}).`);
  }
  const identity = await run('codesign', ['--display', '--verbose=4', app]);
  const details = `${identity.stdout}\n${identity.stderr}`;
  if (mode === 'preview' && !/^Signature=adhoc\s*$/m.test(details)) {
    throw new Error('macOS preview app requires an explicit ad-hoc signature.');
  }
  if (mode === 'notarized' && (/^Signature=adhoc\s*$/m.test(details) || !/^Authority=Developer ID Application: .+$/m.test(details) || !/^TeamIdentifier=[A-Z0-9]{10}\s*$/m.test(details))) {
    throw new Error('macOS release app requires a Developer ID Application signature and team identifier.');
  }
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  if (mode === 'notarized') {
    await run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
    await run('xcrun', ['stapler', 'validate', app]);
  }
}

/** Pure bounded Mach-O header diagnostics supplement lipo; they never substitute for its success. */
async function macExecutableArchitectures(file) {
  let before;
  try { before = await lstat(file); } catch { throw new Error('macOS archive executable is missing or inaccessible.'); }
  if (!before.isFile() || before.size === 0) throw new Error('macOS archive executable is not a nonempty regular file.');
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error('changed');
    const buffer = Buffer.alloc(4_096), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    const labels = new Map([[0x01000007, 'x86_64'], [0x0100000c, 'arm64']]);
    if (bytes.length < 8) throw new Error('header');
    const magic = bytes.readUInt32BE(0);
    if ([0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface].includes(magic)) {
      const little = magic === 0xcffaedfe || magic === 0xcefaedfe;
      const width = magic === 0xcffaedfe || magic === 0xfeedfacf ? 32 : 28;
      if (bytes.length < width) throw new Error('header');
      return [labels.get(little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4)) ?? 'unsupported'];
    }
    if (![0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) throw new Error('header');
    const little = magic === 0xbebafeca || magic === 0xbfbafeca, wide = magic === 0xcafebabf || magic === 0xbfbafeca;
    const uint32 = offset => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
    const uint64 = offset => little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset);
    const count = uint32(4), entryBytes = wide ? 32 : 20, tableEnd = 8 + count * entryBytes;
    if (count < 1 || count > 32 || tableEnd > bytes.length) throw new Error('header');
    const architectures = [];
    for (let index = 0; index < count; index++) {
      const offset = 8 + index * entryBytes, start = wide ? uint64(offset + 8) : BigInt(uint32(offset + 8));
      const size = wide ? uint64(offset + 16) : BigInt(uint32(offset + 12));
      if (start < BigInt(tableEnd) || size < 28n || start + size > BigInt(before.size)) throw new Error('header');
      architectures.push(labels.get(uint32(offset)) ?? 'unsupported');
    }
    return [...new Set(architectures)].sort();
  } catch { throw new Error('macOS archive executable is inaccessible, changed or not a valid Mach-O.'); }
  finally { await handle?.close(); }
}

/** Describe the inherited executable selection without exposing PATH or developer-directory values. */
async function lipoLocation() {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const file = path.resolve(directory || '.', 'lipo');
    try {
      await access(file, constants.X_OK);
      const resolved = await realpath(file);
      if (resolved === '/usr/bin/lipo') return 'system-lipo';
      if (resolved.startsWith('/Applications/') && resolved.includes('.app/Contents/Developer/')) return 'xcode-lipo';
      if (resolved.startsWith('/Library/Developer/')) return 'developer-tools-lipo';
      if (resolved.startsWith('/opt/homebrew/') || resolved.startsWith('/usr/local/Cellar/')) return 'homebrew-lipo';
      return 'other-path-lipo';
    } catch { /* Keep the same inherited PATH search order as execFile. */ }
  }
  return 'unresolved-path-lipo';
}

async function detachVolume(mount, run) {
  try { await run('hdiutil', ['detach', mount]); }
  catch {
    // Force a detach for a partially attached image or a busy verification process.
    try { await run('hdiutil', ['detach', '-force', mount]); }
    catch { throw new Error('Could not detach release verification volume.'); }
  }
}

export async function verifyMacArchive(file, arch, { run = runCommand, temporaryDirectory = os.tmpdir(), mode = 'preview' } = {}) {
  macReleaseMode(mode);
  const temporary = await mkdtemp(path.join(temporaryDirectory, 'extalia-release-'));
  const app = path.join(temporary, 'Extalia.app');
  const verify = async appPath => {
    try { await verifyMacApp(appPath, arch, run, mode); }
    catch (error) {
      // Artifact names/architecture are public; subprocess output remains redacted by runCommand.
      throw new Error(`${path.basename(file)} (${arch}): ${error instanceof Error ? error.message : 'archive verification failed'}`, { cause: error });
    }
  };
  if (file.endsWith('.dmg')) {
    // A fixed private mount point lets finally attempt detach even if attach fails part way through.
    const mount = path.join(temporary, 'volume');
    await mkdir(mount);
    try {
      await run('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, file]);
      await verify(path.join(mount, 'Extalia.app'));
    } finally {
      // Do not recursively remove a directory that might still be a mounted volume.
      await detachVolume(mount, run);
      await rm(temporary, { recursive: true, force: true });
    }
  } else {
    try {
      await run('ditto', ['-x', '-k', file, temporary]);
      await verify(app);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

/** All payloads must pass before the first upload. Only exact, non-empty regular files are allowed. */
export async function uploadRelease({ platform, version, tag, directory, run = runCommand, temporaryDirectory, mode = 'preview' }) {
  macReleaseMode(mode);
  if (tag !== `v${version}`) throw new Error('Release tag does not match the Desktop version.');
  const { payloads, metadata } = releaseArtifactNames(platform, version);
  const preview = platform === 'darwin' && mode === 'preview';
  const files = [];
  // Preview installers are manual downloads and must never replace the trusted update feed.
  for (const name of [...payloads, ...(preview ? [] : [metadata])]) {
    const file = path.join(directory, name);
    await requireFile(file);
    files.push(file);
  }
  // External block maps are generated for some targets; include only maps of allowed payloads.
  for (const name of preview ? [] : payloads) {
    const file = path.join(directory, `${name}.blockmap`);
    try { await requireFile(file); files.push(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (platform === 'darwin') {
    for (const name of payloads) {
      const arch = name.includes('-arm64.') ? 'arm64' : 'x64';
      await verifyMacArchive(path.join(directory, name), arch, { run, temporaryDirectory, mode });
    }
  }
  const release = await run('gh', ['release', 'view', tag, '--json', 'isDraft,tagName,assets']);
  const info = JSON.parse(release.stdout);
  if (info.isDraft !== true || info.tagName !== tag) throw new Error('Release upload requires the matching draft release.');
  if (preview) {
    if (info.assets?.some(asset => asset.name === metadata)) throw new Error('Preview upload cannot replace payloads in a draft with a trusted macOS update feed.');
    const notice = path.join(directory, `Extalia-${version}-mac-PREVIEW.txt`);
    await writeFile(notice, 'macOS preview: ad-hoc signed, not notarized. macOS may show an unidentified-developer warning. These previews are installed manually and are not offered through the trusted automatic-update feed.\n', { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW });
    files.push(notice);
  }
  await run('gh', ['release', 'upload', tag, ...files, '--clobber']);
  return files;
}

async function main() {
  const action = process.argv[2];
  const mode = macReleaseMode(process.env.EXTALIA_MAC_RELEASE_MODE);
  const label = process.platform === 'darwin' ? `macOS ${mode}${mode === 'preview' ? ' (ad-hoc, not notarized)' : ''}` : process.platform;
  console.log(`release: ${label}; ${action ?? 'unknown action'}`);
  if (action === 'preflight' || action === 'package') {
    const options = releaseBuildOptions(process.platform, process.env);
    if (action === 'package') await runCommand(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', options.args, { cwd: DESKTOP, env: options.env, ...(process.platform === 'win32' ? { shell: true } : {}) });
    console.log(`release: ${action} passed`);
  } else if (action === 'upload') {
    const { version } = JSON.parse(await readFile(path.join(DESKTOP, 'package.json'), 'utf8'));
    const files = await uploadRelease({ platform: process.platform, version, tag: process.env.GITHUB_REF_NAME, directory: path.join(DESKTOP, 'release'), mode });
    console.log(`release: uploaded ${files.length} validated artifacts to the draft`);
  } else throw new Error('Usage: node scripts/release.mjs <preflight|package|upload>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`release: ${error.message}`); process.exitCode = 1; });
}
