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

export function resolveDataDirectory({ platform, env, homeDirectory }: DataDirectoryInput): string {
  const override = env[DATA_DIRECTORY_OVERRIDE]?.trim();
  if (override) return override;
  if (platform === 'darwin') return join('/', homeDirectory, 'Library', 'Application Support', 'Extalia');
  if (platform === 'win32') return join('\\', env.APPDATA?.trim() || join('\\', homeDirectory, 'AppData', 'Roaming'), 'Extalia');
  const xdg = env.XDG_DATA_HOME?.trim();
  return join('/', xdg && xdg.startsWith('/') ? xdg : join('/', homeDirectory, '.local', 'share'), 'extalia');
}

/** Standard layout below the data directory. */
export const DATA_LAYOUT = ['config', 'profiles', 'workspaces', 'sessions', 'cache', 'state'] as const;
