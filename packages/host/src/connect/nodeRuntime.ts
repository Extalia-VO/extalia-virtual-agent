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

/** Resolve hook Node without executing shell startup files or accepting a batch wrapper as Node. */
export async function resolveNodePath(options: NodeRuntimeOptions): Promise<string | undefined> {
  if (!options.electron) return options.execPath;
  const style = options.platform === 'win32' ? path.win32 : path;
  const executable = options.executable ?? (file => isExecutableFile(file, options.platform));
  const electronPath = await realpath(options.execPath).catch(() => style.resolve(options.execPath));
  const fold = (file: string) => options.platform === 'win32' ? file.toLowerCase() : file;
  return findExecutable('node', { env: options.env, platform: options.platform, homeDirectory: options.homeDirectory,
    nativeOnly: options.platform === 'win32', check: async candidate => {
      if (options.platform === 'win32' && !/\.exe$/i.test(candidate)) return false;
      if (!await executable(candidate)) return false;
      const resolved = await realpath(candidate).catch(() => style.resolve(candidate));
      return fold(resolved) !== fold(electronPath);
    },
  });
}
