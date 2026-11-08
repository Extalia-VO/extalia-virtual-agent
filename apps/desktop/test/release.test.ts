import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { macReleaseMode, releaseArtifactNames, releaseBuildOptions, runCommand, uploadRelease, verifyMacApp, verifyMacArchive, type Runner } from '../scripts/release.mjs';
import { buildLinuxInstaller } from '../scripts/linux-installer.mjs';

const version = '1.2.3';
const tag = `v${version}`;
const developerId = 'Authority=Developer ID Application: Example Organization (ABCDEFGHIJ)\nTeamIdentifier=ABCDEFGHIJ';
const adHoc = 'Signature=adhoc\nTeamIdentifier=not set';
const secrets = { CSC_LINK: 'synthetic-certificate', CSC_KEY_PASSWORD: 'synthetic-password', APPLE_ID: 'release@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'synthetic-apple-password', APPLE_TEAM_ID: 'ABCDEFGHIJ' };
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(platform = 'darwin') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'extalia-release-test-'));
  temporary.push(root);
  const artifacts = releaseArtifactNames(platform, version);
  for (const file of [...artifacts.payloads, artifacts.metadata]) await writeFile(path.join(root, file), 'synthetic artifact');
  if (platform === 'linux') await buildLinuxInstaller({ appImage: path.join(root, `Extalia-${version}-linux-x86_64.AppImage`),
    output: path.join(root, `Extalia-${version}-linux-x64-setup.run`), icon: fileURLToPath(new URL('../build/icon.png', import.meta.url)), version });
  return root;
}
type Call = { command: string; args: string[] };
async function executableFixture(app: string, architecture: 'arm64' | 'x64' = 'arm64') {
  const directory = path.join(app, 'Contents', 'MacOS'); await mkdir(directory, { recursive: true });
  const bytes = Buffer.alloc(64); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(architecture === 'x64' ? 0x01000007 : 0x0100000c, 4);
  await writeFile(path.join(directory, 'Extalia'), bytes);
}
function runner(fail?: (command: string, args: string[], calls: Call[]) => boolean, identity = developerId) {
  const calls: Call[] = [];
  const run: Runner = async (command, args) => {
    calls.push({ command, args });
    if (fail?.(command, args, calls)) throw new Error('synthetic command failure');
    if (command === 'hdiutil' && args[0] === 'attach') await executableFixture(path.join(args[args.indexOf('-mountpoint') + 1]!, 'Extalia.app'), args.at(-1)?.includes('-x64.') ? 'x64' : 'arm64');
    if (command === 'ditto') await executableFixture(path.join(args.at(-1)!, 'Extalia.app'), args[2]?.includes('-x64.') ? 'x64' : 'arm64');
    if (command === 'codesign' && args[0] === '--display') return { stdout: '', stderr: identity };
    if (command === 'gh' && args[1] === 'view') return { stdout: JSON.stringify({ isDraft: true, tagName: tag }), stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('release packaging preflight', () => {
  it('runs the real preflight without installed build dependencies and still validates notarization credentials', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'extalia-release-preinstall-')));
    temporary.push(root);
    const scripts = path.join(root, 'apps', 'desktop', 'scripts');
    await mkdir(scripts, { recursive: true });
    // Retain the entire former eager import chain, but provide no node_modules or esbuild.
    for (const name of ['release.mjs', 'linux-installer.mjs', 'installer-copy.mjs']) {
      await copyFile(new URL(`../scripts/${name}`, import.meta.url), path.join(scripts, name));
    }
    const script = path.join(scripts, 'release.mjs');
    const execute = promisify(execFile);
    const env = { HOME: root, USERPROFILE: root, NODE_PATH: '', EXTALIA_MAC_RELEASE_MODE: 'preview',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
    expect(await readdir(root)).not.toContain('node_modules');
    await expect(execute(process.execPath, [script, 'preflight'], { cwd: root, env }))
      .resolves.toMatchObject({ stdout: expect.stringContaining('release: preflight passed'), stderr: '' });

    // Exercise the macOS credential gate on every CI OS, through the unchanged CLI entrypoint.
    const macOS = `data:text/javascript;base64,${Buffer.from('Object.defineProperty(process, "platform", { value: "darwin" });').toString('base64')}`;
    const args = ['--import', macOS, script, 'preflight'];
    const notarized = { ...env, EXTALIA_MAC_RELEASE_MODE: 'notarized' };
    await expect(execute(process.execPath, args, { cwd: root, env: notarized })).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining(`macOS notarized release requires repository signing/notarization secrets: ${Object.keys(secrets).join(', ')}.`),
    });
    await expect(execute(process.execPath, args, { cwd: root, env: { ...notarized, ...secrets } }))
      .resolves.toMatchObject({ stdout: expect.stringContaining('release: preflight passed'), stderr: '' });
  });

  it('defaults to explicit ad-hoc preview packaging without importing credentials', () => {
    const { args, env } = releaseBuildOptions('darwin', { ...secrets });
    expect(macReleaseMode()).toBe('preview');
    expect(args).toEqual(['exec', 'electron-builder', '--publish', 'never', '--config.extraMetadata.extaliaMacReleaseMode=preview', '--config.mac.identity=-', '--config.mac.notarize=false']);
    expect(env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
    for (const name of Object.keys(secrets)) expect(env).not.toHaveProperty(name);
  });

  it.each(['', 'unsigned', 'Preview', 'notarised'])('rejects invalid mode %s without falling back', value => {
    expect(() => macReleaseMode(value)).toThrow('must be preview or notarized');
    expect(() => releaseBuildOptions('darwin', { EXTALIA_MAC_RELEASE_MODE: value })).toThrow('must be preview or notarized');
  });

  it.each(Object.keys(secrets))('rejects a macOS release missing %s without echoing secret values', name => {
    const env = { ...secrets, EXTALIA_MAC_RELEASE_MODE: 'notarized', [name]: '' };
    expect(() => releaseBuildOptions('darwin', env)).toThrow(name);
    try { releaseBuildOptions('darwin', env); } catch (error) {
      for (const value of Object.values(secrets)) expect(String(error)).not.toContain(value);
    }
  });

  it('forces distribution signing and notarization without publishing or upload credentials', () => {
    const source = { ...secrets, EXTALIA_MAC_RELEASE_MODE: 'notarized', GH_TOKEN: 'synthetic-token', GITHUB_TOKEN: 'synthetic-token', CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
    const result = releaseBuildOptions('darwin', source);
    expect(result.args).toEqual(['exec', 'electron-builder', '--publish', 'never', '--config.extraMetadata.extaliaMacReleaseMode=notarized', '--config.forceCodeSigning=true', '--config.mac.notarize=true', '--config.mac.type=distribution']);
    expect(result.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('true');
    expect(result.env).not.toHaveProperty('GH_TOKEN');
    expect(result.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(source.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
  });

  it.each(['linux', 'win32'])('keeps %s packaging available without signing secrets and removes empty values', platform => {
    const result = releaseBuildOptions(platform, { CSC_LINK: '', APPLE_ID: ' ', WIN_CSC_LINK: '', EXTALIA_REQUIRE_DAEMON: '1' });
    expect(result.args).toEqual(['exec', 'electron-builder', '--publish', 'never']);
    expect(result.env).toEqual({ EXTALIA_REQUIRE_DAEMON: '1' });
  });

  it('does not add signing requirements to local packaging configuration', async () => {
    const desktop = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(desktop.scripts.dist).toContain('electron-builder --publish never');
    const configuration = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8');
    expect(configuration).not.toContain('forceCodeSigning: true');
  });

  it('does not expose subprocess arguments, output or credentials in command failures', async () => {
    await expect(runCommand(process.execPath, ['-e', 'process.stderr.write(process.env.SYNTHETIC_SECRET); process.exit(2)'], { env: { SYNTHETIC_SECRET: 'do-not-log-this-value' } })).rejects.toThrow(/^node(?:\.exe)? failed \(2\)\.$/);
  });
});

describe('bounded macOS executable diagnostics', () => {
  it('refuses a missing executable without invoking lipo or exposing its filesystem path', async () => {
    const directory = await fixture(); const { run, calls } = runner(undefined, adHoc);
    const promise = verifyMacApp(path.join(directory, 'private-source-marker.app'), 'arm64', run, 'preview');
    await expect(promise).rejects.toThrow('executable is missing or inaccessible');
    await expect(promise).rejects.not.toThrow('private-source-marker'); expect(calls).toEqual([]);
  });

  it('refuses empty, non-Mach-O and symlinked executable entries before lipo', async () => {
    const directory = await fixture(); const app = path.join(directory, 'Extalia.app'); await executableFixture(app);
    const executable = path.join(app, 'Contents', 'MacOS', 'Extalia'); const { run, calls } = runner(undefined, adHoc);
    await writeFile(executable, ''); await expect(verifyMacApp(app, 'arm64', run)).rejects.toThrow('nonempty regular file');
    await writeFile(executable, 'Untrusted text rather than a Mach-O.'); await expect(verifyMacApp(app, 'arm64', run)).rejects.toThrow('not a valid Mach-O');
    if (process.platform !== 'win32') {
      await rm(executable); await symlink(path.join(directory, 'unavailable'), executable);
      await expect(verifyMacApp(app, 'arm64', run)).rejects.toThrow('nonempty regular file');
    }
    expect(calls).toEqual([]);
  });

  it('reports fixed expected/observed architecture labels and refuses a mismatch before invoking the tool', async () => {
    const directory = await fixture(); const app = path.join(directory, 'Extalia.app'); await executableFixture(app, 'x64');
    const { run, calls } = runner(undefined, adHoc);
    await expect(verifyMacApp(app, 'arm64', run)).rejects.toThrow('expected arm64; observed x86_64'); expect(calls).toEqual([]);
  });

  it('recognizes both bounded universal Mach-O slices while still requiring lipo for each requested architecture', async () => {
    const directory = await fixture(); const app = path.join(directory, 'Extalia.app'); await executableFixture(app);
    const bytes = Buffer.alloc(128); bytes.writeUInt32BE(0xcafebabe, 0); bytes.writeUInt32BE(2, 4);
    for (const [index, cpu] of [0x0100000c, 0x01000007].entries()) {
      const entry = 8 + index * 20; bytes.writeUInt32BE(cpu, entry); bytes.writeUInt32BE(64 + index * 32, entry + 8); bytes.writeUInt32BE(32, entry + 12);
      bytes.writeUInt32LE(0xfeedfacf, 64 + index * 32); bytes.writeUInt32LE(cpu, 68 + index * 32);
    }
    await writeFile(path.join(app, 'Contents', 'MacOS', 'Extalia'), bytes);
    const { run, calls } = runner(undefined, adHoc);
    await verifyMacApp(app, 'arm64', run); await verifyMacApp(app, 'x64', run);
    expect(calls.filter(call => call.command === 'lipo').map(call => call.args[2])).toEqual(['arm64', 'x86_64']);
  });

  it('still requires lipo success after a matching pure Mach-O header and never echoes arbitrary tool errors', async () => {
    const directory = await fixture(); const app = path.join(directory, 'Extalia.app'); await executableFixture(app);
    const calls: string[] = [];
    const run: Runner = async command => { calls.push(command); throw new Error('private diagnostic payload'); };
    const promise = verifyMacApp(app, 'arm64', run);
    await expect(promise).rejects.toThrow(/lipo verification failed \(expected arm64; observed arm64; tool [a-z-]+; developer override (?:set|unset); tool-failure\)/);
    await expect(promise).rejects.not.toThrow('private diagnostic payload'); expect(calls).toEqual(['lipo']);
  });

  it('keeps lipo followed by identity and deep strict signature checks on success', async () => {
    const directory = await fixture(); const app = path.join(directory, 'Extalia.app'); await executableFixture(app);
    const { run, calls } = runner(undefined, adHoc); await verifyMacApp(app, 'arm64', run);
    expect(calls.map(call => call.command)).toEqual(['lipo', 'codesign', 'codesign']);
    expect(calls[0]!.args).toEqual([path.join(app, 'Contents', 'MacOS', 'Extalia'), '-verify_arch', 'arm64']);
    expect(calls[2]!.args).toEqual(['--verify', '--deep', '--strict', '--verbose=2', app]);
  });

  it.skipIf(process.platform === 'win32')('classifies lipo argument errors without leaking stderr or command arguments', async () => {
    const directory = await fixture(); const executable = path.join(directory, 'lipo'); await symlink(process.execPath, executable);
    const promise = runCommand(executable, ['-e', 'process.stderr.write("usage: private-release-marker"); process.exit(1)']);
    await expect(promise).rejects.toThrow('lipo failed (1; invalid-arguments)');
    await expect(promise).rejects.not.toThrow('private-release-marker');
  });
});

describe('free macOS preview distribution', () => {
  it('checks all four ad-hoc archives and uploads a notice without metadata or block maps', async () => {
    const directory = await fixture();
    // Metadata is not required for a preview, even when the builder would normally generate it.
    await rm(path.join(directory, 'latest-mac.yml'));
    const payloads = releaseArtifactNames('darwin', version).payloads;
    for (const name of payloads) await writeFile(path.join(directory, `${name}.blockmap`), 'unused preview block map');
    const { run, calls } = runner(undefined, adHoc);
    const files = await uploadRelease({ platform: 'darwin', version, tag, directory, run, temporaryDirectory: directory });
    expect(files.map(file => path.basename(file))).toEqual([...payloads, `Extalia-${version}-mac-PREVIEW.txt`]);
    expect(await readFile(files.at(-1)!, 'utf8')).toContain('unidentified-developer warning');
    expect(calls.filter(call => call.command === 'codesign' && call.args[0] === '--verify')).toHaveLength(4);
    expect(calls.filter(call => call.command === 'lipo').map(call => call.args[2])).toEqual(['arm64', 'arm64', 'x86_64', 'x86_64']);
    expect(calls.some(call => ['spctl', 'xcrun', 'xattr'].includes(call.command))).toBe(false);
    expect(calls.at(-1)?.args).toEqual(['release', 'upload', tag, ...files, '--clobber']);
  });

  it.each(['arm64.dmg', 'arm64.zip', 'x64.dmg', 'x64.zip'])('rejects invalid deep signatures/resources in %s before upload', async suffix => {
    const directory = await fixture();
    let targetStarted = false;
    const { run, calls } = runner((command, args) => {
      if ((command === 'hdiutil' && args[0] === 'attach' && args.at(-1)?.endsWith(suffix)) || (command === 'ditto' && args[2]?.endsWith(suffix))) targetStarted = true;
      return targetStarted && command === 'codesign' && args[0] === '--verify';
    }, adHoc);
    await expect(uploadRelease({ platform: 'darwin', version, tag, directory, run, temporaryDirectory: directory })).rejects.toThrow('synthetic command failure');
    expect(targetStarted).toBe(true);
    expect(calls.some(call => call.command === 'gh')).toBe(false);
    expect((await readdir(directory)).some(file => file.startsWith('extalia-release-'))).toBe(false);
  });

  it('rejects a preview without the explicit ad-hoc identity', async () => {
    const directory = await fixture();
    const { run, calls } = runner(undefined, developerId);
    await expect(uploadRelease({ platform: 'darwin', version, tag, directory, run, temporaryDirectory: directory })).rejects.toThrow('explicit ad-hoc signature');
    expect(calls.some(call => call.command === 'gh')).toBe(false);
  });

  it('does not replace payloads already referenced by a trusted macOS draft feed', async () => {
    const directory = await fixture();
    const base = runner(undefined, adHoc);
    const run: Runner = async (command, args) => {
      const result = await base.run(command, args);
      if (command === 'gh' && args[1] === 'view') result.stdout = JSON.stringify({ isDraft: true, tagName: tag, assets: [{ name: 'latest-mac.yml' }] });
      return result;
    };
    await expect(uploadRelease({ platform: 'darwin', version, tag, directory, run, temporaryDirectory: directory })).rejects.toThrow('trusted macOS update feed');
    expect(base.calls.some(call => call.command === 'gh' && call.args[1] === 'upload')).toBe(false);
  });

  it('does not overwrite a file through a preview notice symlink', async () => {
    const directory = await fixture();
    const preserved = path.join(directory, 'preserved');
    await mkdir(preserved);
    const target = path.join(preserved, 'preserved.txt');
    await writeFile(target, 'preserved content');
    // O_NOFOLLOW protects the macOS release path. Windows has no equivalent flag;
    // a directory junction still exercises rejection and preservation without it.
    await symlink(process.platform === 'win32' ? preserved : target, path.join(directory, `Extalia-${version}-mac-PREVIEW.txt`), process.platform === 'win32' ? 'junction' : 'file');
    const { run, calls } = runner(undefined, adHoc);
    await expect(uploadRelease({ platform: 'darwin', version, tag, directory, run, temporaryDirectory: directory })).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('preserved content');
    expect(calls.some(call => call.command === 'gh' && call.args[1] === 'upload')).toBe(false);
  });
});

describe('distributed macOS release checks', () => {
  it('checks both architectures in both DMGs and updater ZIPs before one explicit upload', async () => {
    const directory = await fixture();
    await writeFile(path.join(directory, 'builder-debug.yml'), 'must not upload');
    await writeFile(path.join(directory, 'unrelated.dmg'), 'must not upload');
    await writeFile(path.join(directory, `Extalia-${version}-mac-arm64.zip.blockmap`), 'block map');
    const { run, calls } = runner();
    const files = await uploadRelease({ platform: 'darwin', version, tag, directory, run, temporaryDirectory: directory, mode: 'notarized' });
    expect(files.map(file => path.basename(file))).toEqual([...releaseArtifactNames('darwin', version).payloads, 'latest-mac.yml', `Extalia-${version}-mac-arm64.zip.blockmap`]);
    const attachments = calls.filter(call => call.command === 'hdiutil' && call.args[0] === 'attach');
    expect(attachments).toHaveLength(2);
    for (const call of attachments) expect(call.args).toEqual(expect.arrayContaining(['-readonly', '-nobrowse', '-noautoopen', '-mountpoint']));
    expect(calls.filter(call => call.command === 'lipo').map(call => call.args[2])).toEqual(['arm64', 'arm64', 'x86_64', 'x86_64']);
    expect(calls.filter(call => call.command === 'codesign' && call.args[0] === '--verify')).toHaveLength(4);
    expect(calls.filter(call => call.command === 'spctl')).toHaveLength(4);
    expect(calls.filter(call => call.command === 'xcrun' && call.args[0] === 'stapler' && call.args[1] === 'validate')).toHaveLength(4);
    expect(calls.at(-1)).toEqual({ command: 'gh', args: ['release', 'upload', tag, ...files, '--clobber'] });
    expect((await readdir(directory)).some(file => file.startsWith('extalia-release-'))).toBe(false);
  });

  it.each(['Signature=adhoc\nTeamIdentifier=not set', 'Authority=Apple Development: Example\nTeamIdentifier=ABCDEFGHIJ', 'Authority=Developer ID Application: Example\nTeamIdentifier=not set'])('rejects an invalid signing identity and detaches without upload: %s', async identity => {
    const directory = await fixture();
    const { run, calls } = runner(undefined, identity);
    await expect(uploadRelease({ platform: 'darwin', version, tag, directory, run, temporaryDirectory: directory, mode: 'notarized' })).rejects.toThrow('Developer ID Application');
    expect(calls.some(call => call.command === 'hdiutil' && call.args[0] === 'detach')).toBe(true);
    expect(calls.some(call => call.command === 'gh')).toBe(false);
  });

  it.each(['lipo', 'codesign', 'spctl', 'xcrun'])('rejects %s failures on the second architecture and never uploads', async failingCommand => {
    const directory = await fixture();
    let x64Started = false;
    const { run, calls } = runner((command, args) => {
      if (command === 'hdiutil' && args.at(-1)?.endsWith('-x64.dmg')) x64Started = true;
      return x64Started && command === failingCommand && (command !== 'codesign' || args[0] === '--verify');
    });
    await expect(uploadRelease({ platform: 'darwin', version, tag, directory, run, temporaryDirectory: directory, mode: 'notarized' })).rejects.toThrow(failingCommand === 'lipo' ? 'lipo verification failed' : 'synthetic command failure');
    expect(x64Started).toBe(true);
    expect(calls.filter(call => call.command === 'hdiutil' && call.args[0] === 'detach')).toHaveLength(2);
    expect(calls.some(call => call.command === 'gh')).toBe(false);
    expect((await readdir(directory)).some(file => file.startsWith('extalia-release-'))).toBe(false);
  });

  it('attempts detach when attachment fails and force-detaches a busy mount', async () => {
    const directory = await fixture();
    const { run, calls } = runner((command, args) => command === 'hdiutil' && !args.includes('-force'));
    await expect(verifyMacArchive(path.join(directory, 'image.dmg'), 'arm64', { run, temporaryDirectory: directory, mode: 'notarized' })).rejects.toThrow('synthetic command failure');
    expect(calls.filter(call => call.command === 'hdiutil').map(call => call.args[0])).toEqual(['attach', 'detach', 'detach']);
    expect(calls.at(-1)?.args).toContain('-force');
  });

  it('fails closed and preserves the mount directory if both detach attempts fail', async () => {
    const directory = await fixture();
    const { run, calls } = runner((command, args) => command === 'hdiutil' && args[0] === 'detach');
    await expect(verifyMacArchive(path.join(directory, 'image.dmg'), 'arm64', { run, temporaryDirectory: directory, mode: 'notarized' })).rejects.toThrow('Could not detach');
    expect(calls.filter(call => call.command === 'hdiutil' && call.args[0] === 'detach')).toHaveLength(2);
    expect((await readdir(directory)).some(file => file.startsWith('extalia-release-'))).toBe(true);
  });

  it('cleans extracted updater ZIPs when verification fails', async () => {
    const directory = await fixture();
    const { run } = runner(command => command === 'spctl');
    await expect(verifyMacArchive(path.join(directory, 'update.zip'), 'arm64', { run, temporaryDirectory: directory, mode: 'notarized' })).rejects.toThrow('synthetic');
    expect((await readdir(directory)).some(file => file.startsWith('extalia-release-'))).toBe(false);
  });
});

describe('release artifact selection and draft upload', () => {
  it('matches electron-builder Linux target architecture names', () => {
    expect(releaseArtifactNames('linux', version)).toEqual({
      payloads: ['Extalia-1.2.3-linux-x86_64.AppImage', 'Extalia-1.2.3-linux-amd64.deb', 'Extalia-1.2.3-linux-x64-setup.run'],
      metadata: 'latest-linux.yml',
    });
  });

  it.each(['linux', 'win32'])('uploads only configured %s payloads and metadata after the workflow smoke step', async platform => {
    const directory = await fixture(platform);
    const { run, calls } = runner();
    await uploadRelease({ platform, version, tag, directory, run });
    expect(calls.map(call => call.command)).toEqual(['gh', 'gh']);
    expect(calls.at(-1)?.args).toContain(releaseArtifactNames(platform, version).metadata === 'latest.yml' ? path.join(directory, 'latest.yml') : path.join(directory, 'latest-linux.yml'));
    const workflow = await readFile(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8');
    expect(workflow.indexOf('scripts/release.mjs package')).toBeLessThan(workflow.indexOf('scripts/packaged-smoke.mjs'));
    expect(workflow.lastIndexOf('scripts/packaged-smoke.mjs')).toBeLessThan(workflow.indexOf('scripts/release.mjs upload'));
    expect(workflow).not.toContain('--publish always');
  });

  it.each(['missing', 'empty', 'symlink'])('rejects %s expected artifacts before running any commands', async kind => {
    const directory = await fixture('linux');
    const target = path.join(directory, `Extalia-${version}-linux-x86_64.AppImage`);
    await rm(target);
    if (kind === 'empty') await writeFile(target, '');
    if (kind === 'symlink') await symlink(path.join(directory, 'latest-linux.yml'), target);
    const { run, calls } = runner();
    await expect(uploadRelease({ platform: 'linux', version, tag, directory, run })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('rejects upload to an already published release', async () => {
    const directory = await fixture('linux');
    const calls: string[][] = [];
    const run: Runner = async (_command, args) => { calls.push(args); return { stdout: JSON.stringify({ isDraft: false, tagName: tag }), stderr: '' }; };
    await expect(uploadRelease({ platform: 'linux', version, tag, directory, run })).rejects.toThrow('matching draft');
    expect(calls).toHaveLength(1);
  });

  it('refuses a tampered interactive Linux installer before any draft lookup or upload', async () => {
    const directory = await fixture('linux');
    await writeFile(path.join(directory, `Extalia-${version}-linux-x64-setup.run`), 'unverified installer');
    const { run, calls } = runner();
    await expect(uploadRelease({ platform: 'linux', version, tag, directory, run })).rejects.toThrow(/Linux installer/);
    expect(calls).toHaveLength(0);
  });

  it('rejects tag/version mismatches and unsafe versions', async () => {
    const { run, calls } = runner();
    await expect(uploadRelease({ platform: 'linux', version, tag: 'v9.9.9', directory: '.', run })).rejects.toThrow('tag');
    expect(() => releaseArtifactNames('linux', '../1.2.3')).toThrow('Invalid release version');
    expect(calls).toHaveLength(0);
    expect(releaseArtifactNames('darwin', '1.2.3-beta.1').metadata).toBe('latest-mac.yml');
  });
});
