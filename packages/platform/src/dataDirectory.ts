/**
 * Where Extalia keeps user data (config, profiles, sessions, cache, state).
 * Pure function: callers pass the OS, environment and home directory, so the
 * result is testable and never hardcodes a user name.
 */

export interface DataDirectoryInput {
  /** Node's `process.platform` value. */
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  homeDirectory: string;
}

export const DATA_DIRECTORY_OVERRIDE = 'EXTALIA_HOME';

function join(separator: '/' | '\\', ...parts: string[]): string {
  const [first = '', ...rest] = parts;
  // Keep a bare root ("/") as the head instead of dropping it.
  const head = first.replace(/[\\/]+$/, '') || first.slice(0, 1);
  const tail = rest.map(part => part.replace(/^[\\/]+|[\\/]+$/g, '')).filter(Boolean);
  return [head, ...tail].join(separator).replace(/^([\\/])[\\/]+/, '$1');
}

/** Name of the data directory inside the user's home folder (all platforms). */
export const DATA_DIRECTORY_NAME = '.extalia-vo';

/**
 * The Extalia profile: `~/.extalia-vo` on macOS and Linux, `%USERPROFILE%\.extalia-vo`
 * on Windows. Web (through the Bridge) and Desktop share it. `EXTALIA_HOME` overrides it.
 */
export function resolveDataDirectory({ platform, env, homeDirectory }: DataDirectoryInput): string {
  const override = env[DATA_DIRECTORY_OVERRIDE]?.trim();
  if (override) return override;
  return join(platform === 'win32' ? '\\' : '/', homeDirectory, DATA_DIRECTORY_NAME);
}

/**
 * Where Extalia 0.0.20 and older kept user data (the operating system's
 * application-data folder). Read once to migrate into `resolveDataDirectory`;
 * never written by current versions. The first entry is the most likely one.
 */
export function legacyDataDirectories({ platform, env, homeDirectory }: DataDirectoryInput): string[] {
  if (platform === 'darwin') return [join('/', homeDirectory, 'Library', 'Application Support', 'Extalia')];
  if (platform === 'win32') {
    const fallback = join('\\', homeDirectory, 'AppData', 'Roaming', 'Extalia');
    const appData = env.APPDATA?.trim();
    return [...new Set([...(appData ? [join('\\', appData, 'Extalia')] : []), fallback])];
  }
  const fallback = join('/', homeDirectory, '.local', 'share', 'extalia');
  const xdg = env.XDG_DATA_HOME?.trim();
  return [...new Set([...(xdg && xdg.startsWith('/') ? [join('/', xdg, 'extalia')] : []), fallback])];
}

/** Standard layout below the data directory. */
export const DATA_LAYOUT = ['config', 'profiles', 'workspaces', 'sessions', 'cache', 'state'] as const;
