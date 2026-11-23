import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Env } from './util.js';
import { findExecutable, isExecutableFile } from '../executableDiscovery.js';

export interface NodeRuntimeOptions {
  execPath: string;
  electron?: boolean;
  env: Env;
  platform: string;
  homeDirectory?: string;
  /** Injectable filesystem check; discovery never starts a shell or another process. */
  executable?: (file: string) => Promise<boolean>;
}

const HOMEBREW_CELLAR_NODE = /^(.+)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/;

/**
 * Prefer a stable Homebrew symlink (for example `/opt/homebrew/bin/node` or
 * `<prefix>/opt/<formula>/bin/node`) over an ephemeral versioned Cellar path
 * when the symlink is executable and resolves to the exact same binary.
 */
export async function preferStableNodePath(
  candidate: string,
  options: { platform: string; executable?: (file: string) => Promise<boolean> },
): Promise<string> {
  if (options.platform === 'win32' || !candidate) return candidate;
  const match = HOMEBREW_CELLAR_NODE.exec(candidate);
  if (!match) return candidate;
  const prefix = match[1] as string;
  const formula = match[2] as string;
  const executable = options.executable ?? (file => isExecutableFile(file, options.platform));
  const actual = await realpath(candidate).catch(() => undefined);
  if (!actual) return candidate;
  const stableCandidates = [
    path.posix.join(prefix, 'bin', 'node'),
    path.posix.join(prefix, 'opt', formula, 'bin', 'node'),
  ];
  for (const stable of stableCandidates) {
    if (!await executable(stable)) continue;
    const stableReal = await realpath(stable).catch(() => undefined);
    if (stableReal === actual) return stable;
  }
  return candidate;
}

/** Resolve hook Node without executing shell startup files or accepting a batch wrapper as Node. */
export async function resolveNodePath(options: NodeRuntimeOptions): Promise<string | undefined> {
  if (!options.electron) {
    return preferStableNodePath(options.execPath, { platform: options.platform, ...(options.executable ? { executable: options.executable } : {}) });
  }
  const style = options.platform === 'win32' ? path.win32 : path;
  const executable = options.executable ?? (file => isExecutableFile(file, options.platform));
  const electronPath = await realpath(options.execPath).catch(() => style.resolve(options.execPath));
  const fold = (file: string) => options.platform === 'win32' ? file.toLowerCase() : file;
  const found = await findExecutable('node', { env: options.env, platform: options.platform, homeDirectory: options.homeDirectory,
    nativeOnly: options.platform === 'win32', check: async candidate => {
      if (options.platform === 'win32' && !/\.exe$/i.test(candidate)) return false;
      if (!await executable(candidate)) return false;
      const resolved = await realpath(candidate).catch(() => style.resolve(candidate));
      return fold(resolved) !== fold(electronPath);
    },
  });
  return found ? preferStableNodePath(found, { platform: options.platform, executable }) : undefined;
}
