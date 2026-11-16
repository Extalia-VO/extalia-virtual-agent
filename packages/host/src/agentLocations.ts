import { statSync } from 'node:fs';
import path from 'node:path';

type Env = Readonly<Record<string, string | undefined>>;
export type AgentLocationApp = 'codex' | 'claude' | 'gemini' | 'antigravity' | 'hermes';
export interface AgentLocationOptions {
  env: Env;
  homeDirectory: string;
  platform?: NodeJS.Platform;
  /** Metadata-only lookup; callers/tests never need to read a configuration. */
  existsDirectory?(directory: string): boolean;
}
export interface HermesLocations {
  /** The explicit profile home, or the selected installation's default home. */
  selectedHome: string;
  /** Installation home containing config.yaml and the profiles directory. */
  rootHome: string;
  namedProfile?: string;
  problem?: string;
}
export interface AgentLocations {
  codexHome: string;
  claudeHome: string;
  geminiHome: string;
  geminiSandboxHome: string;
  antigravityHome: string;
  antigravityConfigHome: string;
  hermes: HermesLocations;
  problems?: Partial<Record<AgentLocationApp, string>>;
}

function environment(options: AgentLocationOptions, name: string): string | undefined {
  const value = options.env[name] ?? ((options.platform ?? process.platform) === 'win32'
    ? Object.entries(options.env).find(([key]) => key.toUpperCase() === name)?.[1] : undefined);
  return value?.trim() || undefined;
}
function pathsFor(value: string, platform: NodeJS.Platform) {
  // Native Windows paths also stay testable without accessing a Windows drive.
  return platform === 'win32' && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) ? path.win32 : path.posix;
}
function join(options: AgentLocationOptions, root: string, ...children: string[]): string {
  return pathsFor(root, options.platform ?? process.platform).join(root, ...children);
}
function expanded(options: AgentLocationOptions, value: string): string {
  const home = options.homeDirectory;
  return value.replace(/^~(?=$|[\\/])/, () => home).replace(/%([^%]+)%|\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, windows: string | undefined, braced: string | undefined, plain: string | undefined) => environment(options, windows ?? braced ?? plain!) ?? match);
}
function override(options: AgentLocationOptions, name: string): string | undefined {
  const value = environment(options, name);
  return value ? expanded(options, value) : undefined;
}
function directoryExists(directory: string): boolean {
  try { return statSync(directory).isDirectory(); } catch { return false; }
}
function rootProblem(options: AgentLocationOptions, value: string, setting: string): string | undefined {
  if (/%[^%]+%|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(value)) return `${setting} contains an unresolved environment variable. Set it to a full absolute folder path.`;
  if (!pathsFor(value, options.platform ?? process.platform).isAbsolute(value)) return `${setting} must be a full absolute folder path. Relative folders are not used for agent configuration or history.`;
  return undefined;
}

/** Read-only resolution. Explicit overrides never fall back to another installation. */
export function resolveHermesLocations(options: AgentLocationOptions): HermesLocations {
  const explicit = override(options, 'HERMES_HOME');
  let selectedHome: string;
  if (explicit) {
    const problem = rootProblem(options, explicit, 'HERMES_HOME');
    if (problem) return { selectedHome: explicit, rootHome: explicit, problem };
    selectedHome = explicit;
  }
  else {
    const suffix = environment(options, 'HERMES_DATA_DIR_SUFFIX') ?? '';
    const legacy = join(options, options.homeDirectory, `.hermes${suffix}`);
    if ((options.platform ?? process.platform) !== 'win32') selectedHome = legacy;
    else {
      const local = override(options, 'LOCALAPPDATA') ?? join(options, options.homeDirectory, 'AppData', 'Local');
      const official = join(options, local, `hermes${suffix}`);
      const problem = rootProblem(options, local, 'LOCALAPPDATA') ?? rootProblem(options, official, 'Hermes home');
      if (problem) return { selectedHome: official, rootHome: official, problem };
      const exists = options.existsDirectory ?? directoryExists;
      selectedHome = !exists(official) && !rootProblem(options, legacy, 'Hermes legacy home') && exists(legacy) ? legacy : official;
    }
  }
  const problem = rootProblem(options, selectedHome, 'Hermes home');
  if (problem) return { selectedHome, rootHome: selectedHome, problem };
  const paths = pathsFor(selectedHome, options.platform ?? process.platform);
  selectedHome = paths.normalize(selectedHome);
  const parent = paths.dirname(selectedHome);
  const parentName = paths.basename(parent);
  const profileDirectory = (options.platform ?? process.platform) === 'win32' ? parentName.toLowerCase() : parentName;
  return profileDirectory === 'profiles'
    ? { selectedHome, rootHome: paths.dirname(parent), namedProfile: paths.basename(selectedHome) }
    : { selectedHome, rootHome: selectedHome };
}

/** Shared roots for Connect, transcript observation and managed runtime discovery. */
export function resolveAgentLocations(options: AgentLocationOptions): AgentLocations {
  const geminiBase = override(options, 'GEMINI_CLI_HOME') ?? options.homeDirectory;
  const geminiHome = join(options, geminiBase, '.gemini');
  const locations: AgentLocations = {
    codexHome: override(options, 'CODEX_HOME') ?? join(options, options.homeDirectory, '.codex'),
    claudeHome: override(options, 'CLAUDE_CONFIG_DIR') ?? join(options, options.homeDirectory, '.claude'),
    geminiHome,
    geminiSandboxHome: join(options, geminiBase, '.cache', '.gemini'),
    // Antigravity overrides name its own verified home/config roots, rather than Gemini's base home.
    antigravityHome: override(options, 'ANTIGRAVITY_HOME') ?? join(options, options.homeDirectory, '.gemini', 'antigravity'),
    antigravityConfigHome: override(options, 'ANTIGRAVITY_CONFIG_DIR') ?? join(options, options.homeDirectory, '.gemini', 'config'),
    hermes: resolveHermesLocations(options),
  };
  const problems: Partial<Record<AgentLocationApp, string>> = {};
  const check = (app: AgentLocationApp, root: string, setting: string) => {
    const problem = rootProblem(options, root, setting);
    if (problem) problems[app] ??= problem;
  };
  check('codex', locations.codexHome, 'CODEX_HOME');
  check('claude', locations.claudeHome, 'CLAUDE_CONFIG_DIR');
  check('gemini', geminiBase, 'GEMINI_CLI_HOME');
  check('gemini', locations.geminiHome, 'Gemini home');
  check('antigravity', locations.antigravityHome, 'ANTIGRAVITY_HOME');
  check('antigravity', locations.antigravityConfigHome, 'ANTIGRAVITY_CONFIG_DIR');
  if (locations.hermes.problem) problems.hermes = locations.hermes.problem;
  if (Object.keys(problems).length) locations.problems = problems;
  return locations;
}
