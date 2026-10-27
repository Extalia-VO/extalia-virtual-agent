/**
 * Where the `extalia-daemon` binary lives (shared convention with the packaging, ADR 0021):
 *
 * 1. `EXTALIA_DAEMON_PATH`: an absolute path; when set, nothing else is tried.
 * 2. Packaged Desktop: `<process.resourcesPath>/daemon/extalia-daemon[.exe]`.
 * 3. CLI: the optional npm package `@extalia/daemon-<platform>-<arch>` (for example
 *    `@extalia/daemon-darwin-arm64`), whose main module exports the absolute binary path
 *    as a string (an object with a string `path` is accepted too).
 * 4. Development checkout: `<repo>/target/debug/extalia-daemon`, then `target/release`.
 *
 * Every candidate must be an absolute path to an existing file.
 */
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export type DaemonBinarySource = 'env' | 'resources' | 'package' | 'debug' | 'release';
export interface DaemonBinary { path: string; source: DaemonBinarySource }

export interface DaemonBinaryOptions {
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Packaged Desktop only: `process.resourcesPath`. */
  resourcesPath?: string;
  /** A file to resolve the per-platform npm package from (the CLI bundle). */
  packageFrom?: string;
  /** A development checkout; used only when it contains the daemon crate. */
  repoRoot?: string;
  /** Injected for tests. */
  isFile?(file: string): boolean;
  /** Injected for tests: the package's exported value, or undefined when it is not installed. */
  loadPackage?(name: string, from: string): unknown;
}

export const DAEMON_BINARY_ENV = 'EXTALIA_DAEMON_PATH';

export function daemonExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'extalia-daemon.exe' : 'extalia-daemon';
}
export function daemonPackageName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `@extalia/daemon-${platform}-${arch}`;
}

const isFile = (file: string) => { try { return statSync(file).isFile(); } catch { return false; } };
const loadPackage = (name: string, from: string): unknown => {
  const require = createRequire(from);
  try { require.resolve(name); } catch { return undefined; }
  return require(name) as unknown;
};

export function resolveDaemonBinary(options: DaemonBinaryOptions = {}): DaemonBinary | undefined {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const file = options.isFile ?? isFile, executable = daemonExecutableName(platform);
  const usable = (candidate: unknown): candidate is string => typeof candidate === 'string' && path.isAbsolute(candidate) && file(candidate);
  const explicit = env[DAEMON_BINARY_ENV]?.trim();
  if (explicit) return usable(explicit) ? { path: explicit, source: 'env' } : undefined;
  if (options.resourcesPath) {
    const packaged = path.join(options.resourcesPath, 'daemon', executable);
    if (usable(packaged)) return { path: packaged, source: 'resources' };
  }
  if (options.packageFrom) {
    let exported: unknown;
    try { exported = (options.loadPackage ?? loadPackage)(daemonPackageName(platform, arch), options.packageFrom); } catch { exported = undefined; }
    const candidate = exported && typeof exported === 'object' ? (exported as { path?: unknown }).path : exported;
    if (usable(candidate)) return { path: candidate, source: 'package' };
  }
  if (options.repoRoot && file(path.join(options.repoRoot, 'crates', 'extalia-daemon', 'Cargo.toml'))) {
    for (const source of ['debug', 'release'] as const) {
      const built = path.join(options.repoRoot, 'target', source, executable);
      if (usable(built)) return { path: built, source };
    }
  }
  return undefined;
}
