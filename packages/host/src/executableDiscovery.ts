import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveHermesLocations } from './agentLocations.js';

export type ExecutableEnvironment = Readonly<Record<string, string | undefined>>;
export interface ExecutableDiscoveryOptions {
  env: ExecutableEnvironment;
  platform: string;
  homeDirectory?: string;
  /** An explicit invalid override never falls back to a different installation. */
  override?: string;
  check?(file: string): Promise<boolean>;
  /** PATH-only callers and standalone Node resolution can narrow discovery. */
  includeFallbacks?: boolean;
  nativeOnly?: boolean;
}

const clean = (value: string) => value.length <= 4096 && !/\p{Cc}/u.test(value);
const paths = (platform: string, base?: string) => platform === 'win32'
  ? base && path.posix.isAbsolute(base) ? path.posix : path.win32 : path;
export function environmentValue(env: ExecutableEnvironment, name: string, platform: string): string | undefined {
  if (env[name] !== undefined || platform !== 'win32') return env[name];
  return Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
}

export async function isExecutableFile(file: string, platform: string = process.platform): Promise<boolean> {
  try { if (!(await stat(file)).isFile()) return false; await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK); return true; }
  catch { return false; }
}

/** Absolute PATH entries only: a project/current directory never implicitly supplies a runtime. */
export function executablePathDirectories(env: ExecutableEnvironment, platform: string): string[] {
  const style = paths(platform);
  return (environmentValue(env, 'PATH', platform) ?? '').split(platform === 'win32' ? ';' : ':').slice(0, 256)
    .map(raw => raw.trim().replace(/^"(.*)"$/, '$1')).filter(value => clean(value) && style.isAbsolute(value));
}

async function versionedDirectories(root: string, pattern: RegExp, suffix: string[], platform: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && pattern.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true })).slice(0, 64)
      .map(entry => paths(platform, root).join(root, entry.name, ...suffix));
  } catch { return []; }
}

/** Known executable installation directories only, never source-app configuration directories. */
export async function executableFallbackDirectories(options: ExecutableDiscoveryOptions, name: string): Promise<string[]> {
  const { env, platform } = options, style = paths(platform), windows = platform === 'win32';
  const value = (key: string) => environmentValue(env, key, platform)?.trim();
  const absolute = (candidate: string | undefined): candidate is string => Boolean(candidate && clean(candidate) && style.isAbsolute(candidate));
  const home = options.homeDirectory ?? value(windows ? 'USERPROFILE' : 'HOME');
  const join = (base: string, ...parts: string[]) => paths(platform, base).join(base, ...parts);
  const directories: string[] = windows ? [] : platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'] : ['/usr/local/bin', '/usr/bin', '/bin'];
  const add = (base: string | undefined, ...parts: string[]) => { if (absolute(base)) directories.push(join(base, ...parts)); };
  if (name.toLowerCase() === 'hermes' && (absolute(home) || absolute(value('HERMES_HOME')))) {
    // Directory hints only: do not inspect config roots to choose the binary search.
    const selected = resolveHermesLocations({ env, homeDirectory: home ?? '', platform: platform as NodeJS.Platform, existsDirectory: () => false });
    if (!selected.problem) { add(selected.rootHome, 'bin'); add(selected.rootHome, 'hermes-agent', 'venv', windows ? 'Scripts' : 'bin'); }
  }
  for (const key of ['PNPM_HOME', 'UV_TOOL_BIN_DIR', 'PIPX_BIN_DIR', 'NVM_BIN']) add(value(key));
  add(value('npm_config_prefix') ?? value('NPM_CONFIG_PREFIX'), ...(windows ? [] : ['bin']));
  add(value('PREFIX'), ...(windows ? [] : ['bin']));
  add(value('VOLTA_HOME'), 'bin'); add(value('BUN_INSTALL'), 'bin'); add(value('PIP_USER_BASE'), windows ? 'Scripts' : 'bin');
  if (windows) {
    add(value('NVM_SYMLINK'));
    add(value('APPDATA'), 'npm'); add(value('LOCALAPPDATA'), 'pnpm');
    add(value('LOCALAPPDATA'), 'Programs', 'nodejs'); add(value('PROGRAMFILES'), 'nodejs');
    add(value('LOCALAPPDATA'), 'Microsoft', 'WinGet', 'Links');
    if (name.toLowerCase() === 'hermes') {
      const local = value('LOCALAPPDATA') ?? (absolute(home) ? join(home, 'AppData', 'Local') : undefined);
      add(local, 'hermes', 'bin');
      add(local, 'hermes', 'hermes-agent', 'venv', 'Scripts');
      add(home, '.hermes', 'hermes-agent', 'venv', 'Scripts');
    }
    add(home, '.local', 'bin'); add(home, '.volta', 'bin'); add(home, '.bun', 'bin');
    add(value('APPDATA'), 'Python', 'Scripts');
    for (const root of [absolute(value('APPDATA')) ? join(value('APPDATA')!, 'Python') : undefined,
      absolute(value('LOCALAPPDATA')) ? join(value('LOCALAPPDATA')!, 'Programs', 'Python') : undefined]) {
      if (root) directories.push(...await versionedDirectories(root, /^Python\d{2,3}(?:-\d+)?$/, ['Scripts'], platform));
    }
    if (absolute(value('NVM_HOME'))) directories.push(...await versionedDirectories(value('NVM_HOME')!, /^v\d+\.\d+\.\d+$/, [], platform));
  } else {
    add(home, '.local', 'bin'); add(home, '.npm-global', 'bin'); add(home, '.npm', 'bin');
    add(home, '.volta', 'bin'); add(home, '.bun', 'bin');
    add(home, ...(platform === 'darwin' ? ['Library', 'pnpm'] : ['.local', 'share', 'pnpm']));
    add(value('XDG_DATA_HOME'), 'pnpm');
    if (name === 'hermes') add(home, '.hermes', 'hermes-agent', 'venv', 'bin');
    const nvmRoots = [absolute(value('NVM_DIR')) ? join(value('NVM_DIR')!, 'versions', 'node') : undefined,
      absolute(home) ? join(home, '.nvm', 'versions', 'node') : undefined,
      platform === 'darwin' && absolute(home) ? join(home, 'Library', 'Application Support', 'Herd', 'config', 'nvm', 'versions', 'node') : undefined];
    for (const root of new Set(nvmRoots.filter((root): root is string => root !== undefined)))
      directories.push(...await versionedDirectories(root, /^v\d+\.\d+\.\d+$/, ['bin'], platform));
    if (platform === 'darwin' && absolute(home)) directories.push(...await versionedDirectories(join(home, 'Library', 'Python'), /^\d+\.\d+$/, ['bin'], platform));
  }
  return directories;
}

/** Filesystem-only discovery; no shell, version probe or application configuration reads. */
export async function findExecutable(name: string, options: ExecutableDiscoveryOptions): Promise<string | undefined> {
  const { env, platform } = options, style = paths(platform), windows = platform === 'win32';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name)) return undefined;
  const check = options.check ?? (file => isExecutableFile(file, platform));
  if (options.override !== undefined) {
    const override = options.override.trim();
    return clean(override) && style.isAbsolute(override) && (!windows || !options.nativeOnly || /\.(?:exe|com)$/i.test(override)) && await check(override) ? override : undefined;
  }
  const configured = (environmentValue(env, 'PATHEXT', platform) ?? '.EXE;.COM;.CMD;.BAT').split(';')
    .map(extension => extension.trim()).filter(extension => /^\.(?:exe|com|cmd|bat)$/i.test(extension));
  if (windows && options.nativeOnly && style.extname(name) && !/\.(?:exe|com)$/i.test(name)) return undefined;
  const extensions = windows ? options.nativeOnly ? ['.exe', '.com'] : configured.flatMap(extension => [extension, extension.toLowerCase()]) : [''];
  // Prefer a real Windows executable over an extensionless POSIX npm shim.
  const names = windows && style.extname(name) ? [name] : [...new Set(extensions.map(extension => name + extension).concat(windows && !options.nativeOnly ? [name] : []))];
  const seen = new Set<string>();
  const scan = async (directories: string[]): Promise<string | undefined> => {
    for (const directory of directories) {
      const key = windows ? directory.toLowerCase() : directory;
      if (seen.has(key)) continue; seen.add(key);
      for (const candidateName of names) {
        const candidate = paths(platform, directory).join(directory, candidateName);
        if (await check(candidate)) return candidate;
      }
    }
    return undefined;
  };
  return await scan(executablePathDirectories(env, platform))
    ?? (options.includeFallbacks !== false ? await scan(await executableFallbackDirectories(options, name)) : undefined);
}
