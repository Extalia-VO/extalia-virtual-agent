/**
 * electron-builder `afterPack` hook (runs before signing): checks the daemon binary that
 * `extraResources` copied to `<resources>/daemon/`. It must be an executable for the
 * packaged OS and architecture; it is marked executable for the archive formats.
 *
 * Without a staged binary the app is still packaged (the daemon flag is off by default and
 * the host ignores a missing binary), with a warning. Release builds set
 * EXTALIA_REQUIRE_DAEMON=1 so a missing or wrong binary fails the build instead.
 */
import { chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { daemonBinaryName, readExecutableKind } from '../../../tooling/daemon.mjs';

// builder-util's Arch enum.
const ARCH = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];
const PLATFORM = { darwin: 'darwin', mas: 'darwin', win32: 'win32', linux: 'linux' };

export default async function afterPack(context) {
  const platform = PLATFORM[context.electronPlatformName];
  const arch = ARCH[context.arch];
  const binary = path.join(context.packager.getResourcesDir(context.appOutDir), 'daemon', daemonBinaryName(platform));
  const required = process.env.EXTALIA_REQUIRE_DAEMON === '1';
  const problem = message => {
    if (required) throw new Error(`extalia-daemon: ${message} (EXTALIA_REQUIRE_DAEMON=1).`);
    console.warn(`  • extalia-daemon: ${message}; packaging without it. Run \`node tooling/build-daemon.mjs\` first to include it.`);
  };

  const info = await stat(binary).catch(() => undefined);
  if (!info?.isFile()) return problem(`no binary for ${platform}-${arch} at ${path.relative(context.appOutDir, binary)}`);
  const kind = await readExecutableKind(binary);
  // A universal macOS app merges the two per-arch packs; each of those is checked on its own.
  const archOk = arch === 'universal' ? kind?.platform === 'darwin' : kind?.arch === arch;
  if (kind?.platform !== platform || !archOk) return problem(`${path.basename(binary)} is ${kind ? `${kind.platform}-${kind.arch ?? 'unknown'}` : 'not an executable'}, expected ${platform}-${arch}`);
  if (platform !== 'win32') await chmod(binary, 0o755);
  console.log(`  • extalia-daemon ${platform}-${arch}: ${info.size} bytes`);
}
