import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isExecutable, type Env } from './util.js';

export interface NodeRuntimeOptions {
  execPath: string;
  electron?: boolean;
  env: Env;
  platform: string;
  homeDirectory?: string;
  /** Injectable filesystem check; discovery never starts a shell or another process. */
  executable?: (file: string) => Promise<boolean>;
}

const MAX_VERSION_CANDIDATES = 64;
const VERSION = /^v(\d+)\.(\d+)\.(\d+)$/;

/** Newest stable version first, scanning only this installation's direct children. */
async function versionedNodes(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && VERSION.test(entry.name))
      .sort((a, b) => {
        const left = a.name.slice(1).split('.').map(BigInt);
        const right = b.name.slice(1).split('.').map(BigInt);
        for (let i = 0; i < 3; i++) {
          if (left[i]! !== right[i]!) return left[i]! > right[i]! ? -1 : 1;
        }
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      })
      .slice(0, MAX_VERSION_CANDIDATES)
      .map(entry => path.join(directory, entry.name, 'bin', 'node'));
  } catch { return []; }
}

/** Resolve hook Node without depending on an interactive shell's startup configuration. */
export async function resolveNodePath(options: NodeRuntimeOptions): Promise<string | undefined> {
  // A Node-hosted Bridge already has the runtime that runs its own hook forwarder.
  if (!options.electron) return options.execPath;
  const executable = options.executable ?? isExecutable;
  const electronPath = await realpath(options.execPath).catch(() => path.resolve(options.execPath));
  const seen = new Set<string>();
  const usable = async (candidate: string): Promise<boolean> => {
    if (!path.isAbsolute(candidate) || seen.has(candidate)) return false;
    seen.add(candidate);
    if (!await executable(candidate)) return false;
    const resolved = await realpath(candidate).catch(() => path.resolve(candidate));
    return resolved !== electronPath;
  };

  const separator = options.platform === 'win32' ? ';' : ':';
  const extensions = options.platform === 'win32' ? (options.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of (options.env.PATH ?? '').split(separator).filter(Boolean)) {
    if (!path.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `node${extension}`);
      if (await usable(candidate)) return candidate;
    }
  }
  if (options.platform !== 'darwin') return undefined;

  const home = options.homeDirectory ?? options.env.HOME;
  const absoluteHome = home && path.isAbsolute(home) ? home : undefined;
  const volta = options.env.VOLTA_HOME;
  const directories = [
    '/opt/homebrew/bin', '/usr/local/bin',
    ...(volta && path.isAbsolute(volta) ? [path.join(volta, 'bin')] : []),
    ...(absoluteHome ? [path.join(absoluteHome, '.volta', 'bin'), path.join(absoluteHome, '.local', 'bin')] : []),
  ];
  for (const directory of directories) {
    const candidate = path.join(directory, 'node');
    if (await usable(candidate)) return candidate;
  }
  const nvm = options.env.NVM_DIR;
  const versionRoots = [
    ...(nvm && path.isAbsolute(nvm) ? [path.join(nvm, 'versions', 'node')] : []),
    ...(absoluteHome ? [
      path.join(absoluteHome, '.nvm', 'versions', 'node'),
      path.join(absoluteHome, 'Library', 'Application Support', 'Herd', 'config', 'nvm', 'versions', 'node'),
    ] : []),
  ];
  for (const root of new Set(versionRoots)) {
    for (const candidate of await versionedNodes(root)) if (await usable(candidate)) return candidate;
  }
  return undefined;
}
