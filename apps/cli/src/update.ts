import { realpathSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { UpdateStatus } from '@extalia/platform';

export const PACKAGE_NAME = 'extalia-vo';
export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
export const UPDATE_COMMAND = `npm i -g ${PACKAGE_NAME}@latest --prefer-online`;
export const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 5000;
export const SOURCE_DETAIL = 'Running from source; update with git pull and pnpm install.';
export const NPX_DETAIL = `Running through npx; start it with npx ${PACKAGE_NAME}@latest to get the latest version.`;

// --- Versions -----------------------------------------------------------------

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface Version { core: [number, number, number]; prerelease: string[] }

export function parseVersion(value: string): Version | undefined {
  const match = SEMVER.exec(value.trim());
  if (!match) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ? match[4].split('.') : [] };
}

function compareIdentifiers(a: string, b: string): number {
  const numericA = /^\d+$/.test(a), numericB = /^\d+$/.test(b);
  if (numericA && numericB) return Math.sign(Number(a) - Number(b));
  if (numericA !== numericB) return numericA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semantic Versioning 2.0 precedence: -1, 0 or 1. Throws on invalid versions. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) throw new Error(`Invalid version: ${left ? b : a}`);
  for (let index = 0; index < 3; index++) {
    const difference = Math.sign(left.core[index]! - right.core[index]!);
    if (difference) return difference;
  }
  // A release outranks its prereleases.
  if (!left.prerelease.length || !right.prerelease.length) return Math.sign(right.prerelease.length - left.prerelease.length);
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index++) {
    const x = left.prerelease[index], y = right.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const difference = compareIdentifiers(x, y);
    if (difference) return difference;
  }
  return 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  try { return compareVersions(candidate, current) > 0; } catch { return false; }
}

// --- Installation ---------------------------------------------------------------

export type InstallKind = 'global' | 'npx' | 'source';

/**
 * How the running bin was installed. Only a copy inside `node_modules/extalia-vo/`
 * can be replaced by `npm i -g`; npx caches and source checkouts cannot.
 */
export function installKind(binPath: string, realpath: (path: string) => string = realpathSync): InstallKind {
  let resolved = binPath;
  try { resolved = realpath(binPath); } catch { /* keep the path as given */ }
  const normalized = resolved.replace(/\\/g, '/');
  if (!normalized.includes(`/node_modules/${PACKAGE_NAME}/`)) return 'source';
  return normalized.includes('/_npx/') ? 'npx' : 'global';
}

export function isGlobalInstall(binPath: string, realpath?: (path: string) => string): boolean {
  return installKind(binPath, realpath) === 'global';
}

/** Version of the package that contains the bin (`<package>/dist/extalia.mjs`), read after npm replaced it. */
export async function readInstalledVersion(binPath: string, realpath: (path: string) => string = realpathSync): Promise<string | undefined> {
  let resolved = binPath;
  try { resolved = realpath(binPath); } catch { /* keep the path as given */ }
  try {
    const manifest = JSON.parse(await readFile(path.join(path.dirname(resolved), '..', 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
    return manifest.name === PACKAGE_NAME && typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/** The npm invocation for UPDATE_COMMAND. Windows runs npm through its .cmd shim, which needs a shell. */
export function npmInstallCommand(platform: string): { command: string; args: string[]; shell: boolean } {
  const args = ['i', '-g', `${PACKAGE_NAME}@latest`, '--prefer-online'];
  return platform === 'win32' ? { command: ['npm.cmd', ...args].join(' '), args: [], shell: true } : { command: 'npm', args, shell: false };
}

// --- Registry and cache ---------------------------------------------------------

export async function fetchLatestVersion(fetchImpl: typeof fetch, timeoutMs = UPDATE_CHECK_TIMEOUT_MS): Promise<string> {
  const response = await fetchImpl(REGISTRY_LATEST_URL, { cache: 'no-store', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`the npm registry answered ${response.status}`);
  const body = await response.json() as { version?: unknown };
  if (typeof body.version !== 'string' || !parseVersion(body.version)) throw new Error('the npm registry returned no valid version');
  return body.version;
}

export interface UpdateCheckCache { checkedAt: string; latest: string }

export function isCacheFresh(cache: UpdateCheckCache | undefined, now: number, interval = UPDATE_CHECK_INTERVAL_MS): cache is UpdateCheckCache {
  if (!cache) return false;
  const checkedAt = Date.parse(cache.checkedAt);
  // A timestamp from the future (clock changes) counts as stale.
  return Number.isFinite(checkedAt) && checkedAt <= now && now - checkedAt < interval;
}

export async function readUpdateCache(file: string): Promise<UpdateCheckCache | undefined> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Partial<UpdateCheckCache>;
    return typeof value.checkedAt === 'string' && typeof value.latest === 'string' && parseVersion(value.latest) ? { checkedAt: value.checkedAt, latest: value.latest } : undefined;
  } catch {
    return undefined;
  }
}

export async function writeUpdateCache(file: string, cache: UpdateCheckCache): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`);
  await rename(temporary, file);
}

// --- Updater --------------------------------------------------------------------

export interface UpdaterOptions {
  current: string;
  kind: InstallKind;
  /** `<dataDirectory>/state/update-check.json` */
  cacheFile: string;
  fetch: typeof fetch;
  /** Run UPDATE_COMMAND; resolves to npm's exit code. */
  runInstall(): Promise<number>;
  /** Version on disk after npm finished. */
  installedVersion(): Promise<string | undefined>;
  now?: () => number;
  timeoutMs?: number;
}

export interface Updater {
  status(): UpdateStatus;
  /** Ask the registry, or the 12-hour cache unless `force` is set. */
  check(options?: { force?: boolean }): Promise<UpdateStatus>;
  /** Run npm. Sets `installing` synchronously; resolves to `ready` or `error`. */
  install(): Promise<UpdateStatus>;
}

function message(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'the npm registry did not answer in time';
  return error instanceof Error ? error.message : String(error);
}

/** Why an install cannot start now, or undefined when it can. */
export function installBlocker(status: UpdateStatus, busy: boolean): string | undefined {
  if (status.state === 'unsupported') return status.detail ?? 'Updates are not supported for this installation.';
  if (status.state === 'installing' || status.state === 'ready') return 'An update is already being installed.';
  if (status.state === 'checking') return 'Still checking for updates; try again in a moment.';
  if (!status.latest || !isNewerVersion(status.latest, status.current)) return 'No update is available. Check for updates first.';
  if (busy) return 'Agents are still working. Install the update when they finish.';
  return undefined;
}

export function createUpdater(options: UpdaterOptions): Updater {
  const now = options.now ?? Date.now;
  const base = { current: options.current, channel: 'stable' as const, command: UPDATE_COMMAND };
  let latest: string | undefined;
  let pending: Promise<UpdateStatus> | undefined;
  let status: UpdateStatus = options.kind === 'global'
    ? { ...base, state: 'idle' }
    : { ...base, state: 'unsupported', detail: options.kind === 'npx' ? NPX_DETAIL : SOURCE_DETAIL };

  const settle = (next: Pick<UpdateStatus, 'state' | 'detail'>): UpdateStatus => (status = { ...base, ...(latest ? { latest } : {}), ...next });
  const versionState = (): UpdateStatus => settle({ state: latest && isNewerVersion(latest, options.current) ? 'available' : 'up-to-date' });

  async function runCheck(force: boolean): Promise<UpdateStatus> {
    if (!force) {
      const cache = await readUpdateCache(options.cacheFile);
      if (isCacheFresh(cache, now())) { latest = cache.latest; return versionState(); }
    }
    try {
      latest = await fetchLatestVersion(options.fetch, options.timeoutMs);
    } catch (error) {
      return settle({ state: 'error', detail: `Could not check for updates: ${message(error)}.` });
    }
    // The cache is an optimization; a read-only data directory must not fail the check.
    await writeUpdateCache(options.cacheFile, { checkedAt: new Date(now()).toISOString(), latest }).catch(() => undefined);
    return versionState();
  }

  return {
    status: () => status,
    check({ force = false } = {}) {
      if (status.state === 'unsupported' || status.state === 'installing' || status.state === 'ready') return Promise.resolve(status);
      if (!pending) {
        settle({ state: 'checking' });
        pending = runCheck(force).finally(() => { pending = undefined; });
      }
      return pending;
    },
    async install() {
      settle({ state: 'installing' });
      let code: number;
      try { code = await options.runInstall(); }
      catch (error) { return settle({ state: 'error', detail: `Could not run npm: ${message(error)}. Run it yourself: ${UPDATE_COMMAND}` }); }
      if (code !== 0) return settle({ state: 'error', detail: `npm exited with code ${code}. Run it yourself: ${UPDATE_COMMAND}` });
      const installed = await options.installedVersion().catch(() => undefined);
      // npm can succeed for a different prefix than the one this copy runs from.
      if (!installed || !isNewerVersion(installed, options.current)) {
        return settle({ state: 'error', detail: `npm finished, but this copy of Extalia is still ${installed ?? options.current}. Check which npm prefix provides the extalia command.` });
      }
      latest = installed;
      return settle({ state: 'ready' });
    },
  };
}

// --- `extalia update` -----------------------------------------------------------

export async function runUpdateCommand(options: { check: boolean }, updater: Updater, io: { out(line: string): void; err(line: string): void }): Promise<number> {
  const status = await updater.check({ force: true });
  if (status.state === 'unsupported' || status.state === 'error') { io.err(status.detail ?? 'Could not check for updates.'); return 1; }
  if (status.state !== 'available' || !status.latest) { io.out(`Extalia ${status.current} is up to date.`); return 0; }
  if (options.check) { io.out(`Extalia ${status.latest} is available (installed: ${status.current}). Run: extalia update`); return 0; }
  io.out(`Installing Extalia ${status.latest}: ${UPDATE_COMMAND}`);
  const result = await updater.install();
  if (result.state !== 'ready') { io.err(result.detail ?? 'The update failed.'); return 1; }
  io.out(`Extalia updated to ${result.latest}. Restart running Extalia instances to use it.`);
  return 0;
}
