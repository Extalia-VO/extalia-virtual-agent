/**
 * electron-builder `afterPack` hook (runs before signing): checks the daemon binary that
 * `extraResources` copied to `<resources>/daemon/`. It must be an executable for the
 * packaged OS and architecture; it is marked executable for the archive formats.
 *
 * Without a staged binary the app is still packaged (the daemon flag is off by default and
 * the host ignores a missing binary), with a warning. Release builds set
 * EXTALIA_REQUIRE_DAEMON=1 so a missing or wrong binary fails the build instead.
 */
import { chmod, lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { daemonBinaryName, readExecutableKind } from '../../../tooling/daemon.mjs';
import { verifyModelBuild } from '../../../tooling/public-models.mjs';
import { DAEMON_TARGETS } from '../../../tooling/daemon.mjs';
import { SCANNER_BINDING, verifyScannerBinding, verifyScannerSignatures } from '../../../tooling/scanner-distribution.mjs';

// builder-util's Arch enum.
const ARCH = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];
const PLATFORM = { darwin: 'darwin', mas: 'darwin', win32: 'win32', linux: 'linux' };

/** The exact same bundle is checked before and after outer application signing. */
export async function verifyPackagedScanner(context, verifyDaemon = true) {
  const platform = PLATFORM[context.electronPlatformName], arch = ARCH[context.arch];
  const target = { platform, arch };
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const binary = path.join(resources, 'daemon', daemonBinaryName(platform));
  const bundle = path.join(resources, 'skillspector');
  const bindingFile = path.join(resources, 'daemon', SCANNER_BINDING);
  const requiredTargets = (process.env.EXTALIA_REQUIRE_SKILLSPECTOR_TARGETS ?? '').split(',').filter(Boolean);
  if (requiredTargets.some(name => !DAEMON_TARGETS.some(item => `${item.platform}-${item.arch}` === name))) throw new Error('Invalid required scanner target.');
  const required = requiredTargets.includes(`${platform}-${arch}`);
  const hasBundle = Boolean(await lstat(bundle).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; }));
  const hasBinding = Boolean(await lstat(bindingFile).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; }));
  if (hasBundle !== hasBinding) throw new Error('Incomplete packaged scanner/daemon pair.');
  if (!hasBundle) {
    if (required) throw new Error(`A pinned SkillSpector bundle is required for ${platform}-${arch}.`);
    return;
  }
  await verifyScannerBinding({ binary, bundle, bindingFile, target, verifyDaemon });
  await verifyScannerSignatures(bundle, target, context.packager.config.extraMetadata?.extaliaMacReleaseMode === 'notarized');
  console.log(`  • verified pinned SkillSpector bundle ${platform}-${arch}`);
}

export default async function afterPack(context) {
  verifyModelBuild(path.join(context.packager.getResourcesDir(context.appOutDir), 'web'));
  const platform = PLATFORM[context.electronPlatformName];
  const arch = ARCH[context.arch];
  const binary = path.join(context.packager.getResourcesDir(context.appOutDir), 'daemon', daemonBinaryName(platform));
  const required = process.env.EXTALIA_REQUIRE_DAEMON === '1';
  const problem = message => {
    if (required) throw new Error(`extalia-daemon: ${message} (EXTALIA_REQUIRE_DAEMON=1).`);
    console.warn(`  • extalia-daemon: ${message}; packaging without it. Run \`node tooling/build-daemon.mjs\` first to include it.`);
  };

  const info = await stat(binary).catch(() => undefined);
  if (!info?.isFile()) {
    await verifyPackagedScanner(context);
    return problem(`no binary for ${platform}-${arch} at ${path.relative(context.appOutDir, binary)}`);
  }
  const kind = await readExecutableKind(binary);
  // A universal macOS app merges the two per-arch packs; each of those is checked on its own.
  const archOk = arch === 'universal' ? kind?.platform === 'darwin' : kind?.arch === arch;
  if (kind?.platform !== platform || !archOk) return problem(`${path.basename(binary)} is ${kind ? `${kind.platform}-${kind.arch ?? 'unknown'}` : 'not an executable'}, expected ${platform}-${arch}`);
  if (platform !== 'win32') await chmod(binary, 0o755);
  console.log(`  • extalia-daemon ${platform}-${arch}: ${info.size} bytes`);
  await verifyPackagedScanner(context);
}
