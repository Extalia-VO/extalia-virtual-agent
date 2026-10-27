import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { legacyDataDirectories } from '@extalia/platform';
import { errorCode, isNotFound, writeJsonAtomic } from './jsonStore.js';
import { ensurePrivateDirectory, PRIVATE_FILE_MODE } from './paths.js';

/**
 * One-time move of user data from the application-data folder used up to
 * 0.0.20 (`~/Library/Application Support/Extalia`, `%APPDATA%\Extalia`,
 * `$XDG_DATA_HOME/extalia`) to the shared profile `~/.extalia-vo`.
 *
 * - Copies, never moves or deletes: the old folder stays as it was, apart from
 *   a note file and the hook forwarder (see below).
 * - Runs only while the new folder has no `config/extalia.json`, and only once
 *   (`state/migrated-from.json` records it).
 * - Only Extalia's own folders are copied (`MIGRATED_ENTRIES`); `cache/`,
 *   runtime files (host lock, hook endpoint) and temporary files are skipped.
 *   File and folder modes (0600/0700) and modification times are kept, and no
 *   existing file in the new folder is overwritten.
 * - `config/extalia.json` is copied last with an atomic rename, so an
 *   interrupted copy is completed on the next start instead of being taken for
 *   a finished one.
 * - A lock file in the new folder keeps a Bridge and a Desktop that start at
 *   the same time from migrating twice; the second waits and then uses the result.
 * - Agent-app hooks connected before the move run `<old>/hooks/forward.mjs`.
 *   That file becomes a small shim that runs the forwarder in the new folder,
 *   so they keep working until `extalia connect <app>` points them there.
 */

/** Top-level folders of the old data directory that hold Extalia data. */
export const MIGRATED_ENTRIES = ['config', 'profiles', 'workspaces', 'sessions', 'state', 'skills', 'hooks', 'connect'] as const;
/** Relative paths (with `/`) that are never copied: runtime files of a host that ran there. */
const SKIPPED_FILES = new Set(['state/host.lock', 'hooks/endpoint.json', 'state/migrated-from.json']);
export const MIGRATION_MARKER = path.join('state', 'migrated-from.json');
export const MIGRATION_NOTE = 'MIGRATED_TO_EXTALIA_VO.txt';
const LOCK_FILE = '.migration.lock';
const CONFIG_FILE = path.join('config', 'extalia.json');
const SHIM_MARKER = '// extalia-hook-forwarder-shim';
const FORWARDER_MARKER = '// extalia-hook-forwarder';
const STALE_LOCK_MS = 5 * 60_000;

export interface MigrationMarker {
  from: string;
  at: string;
}

export interface LegacyMigrationOptions {
  /** The new data directory (`~/.extalia-vo`). */
  target: string;
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  homeDirectory: string;
  /** Old locations to look in; defaults to `legacyDataDirectories()`. */
  legacy?: readonly string[];
  now?: () => Date;
  /** How long to wait for another process's migration (default one minute). */
  waitMs?: number;
}

export type LegacyMigrationResult =
  | { status: 'not-needed' | 'no-legacy' }
  | { status: 'already-migrated' | 'migrated-elsewhere'; from?: string }
  | { status: 'migrated'; from: string; files: number; forwarderShim: boolean };

const exists = (file: string) => lstat(file).then(() => true, () => false);

export async function readMigrationMarker(dataDirectory: string): Promise<MigrationMarker | undefined> {
  try {
    const raw = JSON.parse(await readFile(path.join(dataDirectory, MIGRATION_MARKER), 'utf8')) as Partial<MigrationMarker>;
    return typeof raw.from === 'string' && typeof raw.at === 'string' ? { from: raw.from, at: raw.at } : undefined;
  } catch { return undefined; }
}

async function isDirectory(directory: string): Promise<boolean> {
  try { return (await stat(directory)).isDirectory(); } catch { return false; }
}

/** The first old location that holds Extalia data. */
async function findLegacy(candidates: readonly string[], target: string): Promise<string | undefined> {
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (resolved === path.resolve(target) || !(await isDirectory(resolved))) continue;
    // Copied once already: deleting the new folder must start fresh, not bring the old data back.
    if (await exists(path.join(resolved, MIGRATION_NOTE))) continue;
    for (const entry of MIGRATED_ENTRIES) if (await exists(path.join(resolved, entry))) return resolved;
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return errorCode(error) !== 'ESRCH'; }
}

async function lockIsStale(file: string): Promise<boolean> {
  try {
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    if (Date.now() - info.mtimeMs > STALE_LOCK_MS) return true;
    const pid = Number.parseInt(text, 10);
    return Number.isInteger(pid) && pid > 0 ? !isAlive(pid) : Date.now() - info.mtimeMs > 2000;
  } catch (error) { return isNotFound(error); }
}

/** Take the migration lock; resolves false when another process finished a migration meanwhile. */
async function acquire(target: string, waitMs: number): Promise<(() => Promise<void>) | false> {
  const file = path.join(target, LOCK_FILE);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(file, 'wx', PRIVATE_FILE_MODE);
      try { await handle.writeFile(`${process.pid}\n`, 'utf8'); } finally { await handle.close(); }
      return () => rm(file, { force: true });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    if (await lockIsStale(file)) { await rm(file, { force: true }); continue; }
    if (Date.now() > deadline) throw new Error('Another Extalia process is still moving data to the new folder. Try again in a moment.');
    await delay(100);
    if (await exists(path.join(target, MIGRATION_MARKER)) || await exists(path.join(target, CONFIG_FILE))) return false;
  }
}

const mode = (value: number) => value & 0o777;

/** Copy a file without overwriting, keeping its mode and times. Returns false when the target existed. */
async function copyOne(source: string, destination: string): Promise<boolean> {
  try { await copyFile(source, destination, constants.COPYFILE_EXCL); }
  catch (error) { if (errorCode(error) === 'EEXIST') return false; throw error; }
  const info = await stat(source);
  if (process.platform !== 'win32') await chmod(destination, mode(info.mode));
  await utimes(destination, info.atime, info.mtime).catch(() => undefined);
  return true;
}

async function copyTree(source: string, destination: string, relative: string, skip: (relative: string) => boolean): Promise<number> {
  const info = await lstat(source);
  if (info.isSymbolicLink() || skip(relative) || relative.endsWith('.tmp')) return 0;
  if (info.isFile()) return (await copyOne(source, destination)) ? 1 : 0;
  if (!info.isDirectory()) return 0;
  await mkdir(destination, { recursive: true, mode: mode(info.mode) });
  if (process.platform !== 'win32') await chmod(destination, mode(info.mode));
  let copied = 0;
  for (const entry of await readdir(source)) {
    copied += await copyTree(path.join(source, entry), path.join(destination, entry), `${relative}/${entry}`, skip);
  }
  return copied;
}

/** Point backup paths recorded in the copied connect manifest at the new folder. */
async function repointManifest(target: string, from: string): Promise<void> {
  const file = path.join(target, 'connect', 'manifest.json');
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, 'utf8')); } catch { return; }
  const prefix = from + path.sep;
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return value === from ? target : value.startsWith(prefix) ? path.join(target, value.slice(prefix.length)) : value;
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return value;
  };
  await writeJsonAtomic(file, visit(raw));
}

/** The shim left at the old forwarder path. */
export function forwarderShimSource(newForwarder: string): string {
  return `${SHIM_MARKER} v1
// Extalia moved its data folder to ${JSON.stringify(path.dirname(path.dirname(newForwarder)))}.
// This file only runs the forwarder there, so agent-app hooks connected before
// the move keep working. Run \`extalia connect <app>\` to point them to the new
// folder directly. It prints nothing and always exits 0.
import(${JSON.stringify(pathToFileURL(newForwarder).href)}).catch(() => process.exit(0));
`;
}

async function shimLegacyForwarder(from: string, target: string): Promise<boolean> {
  const legacy = path.join(from, 'hooks', 'forward.mjs');
  let text: string;
  try { text = await readFile(legacy, 'utf8'); } catch { return false; }
  if (text.startsWith(SHIM_MARKER)) return true;
  if (!text.startsWith(FORWARDER_MARKER)) return false;
  const temporary = `${legacy}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, forwarderShimSource(path.join(target, 'hooks', 'forward.mjs')), { mode: mode((await stat(legacy)).mode) });
  await rename(temporary, legacy).catch(async error => { await rm(temporary, { force: true }); throw error; });
  return true;
}

function noteText(target: string, at: string): string {
  return [
    'Extalia now keeps its data in a new folder:',
    `  ${target}`,
    '',
    `On ${at} Extalia copied this folder there (caches excluded).`,
    'Nothing here was deleted. Newer versions of Extalia no longer read this folder;',
    'once you have checked that everything is in place you may remove it yourself.',
    '',
    'hooks/forward.mjs here now forwards to the new folder, so connected agent apps',
    'keep reporting. Run `extalia connect <app>` to point them to the new folder.',
    '',
  ].join('\n');
}

/**
 * Copy user data from the pre-0.0.21 location into `options.target` once.
 * Safe to call on every start; it does nothing when there is nothing to do.
 */
export async function migrateLegacyDataDirectory(options: LegacyMigrationOptions): Promise<LegacyMigrationResult> {
  const target = path.resolve(options.target);
  if (await exists(path.join(target, CONFIG_FILE))) return { status: 'not-needed' };
  const marker = await readMigrationMarker(target);
  if (marker) return { status: 'already-migrated', from: marker.from };
  const from = await findLegacy(options.legacy ?? legacyDataDirectories(options), target);
  if (!from) return { status: 'no-legacy' };

  await ensurePrivateDirectory(target);
  const release = await acquire(target, options.waitMs ?? 60_000);
  if (!release) {
    const done = await readMigrationMarker(target);
    return { status: 'migrated-elsewhere', ...(done ? { from: done.from } : {}) };
  }
  try {
    // Re-check under the lock: another process may have finished while this one waited.
    const done = await readMigrationMarker(target);
    if (done) return { status: 'migrated-elsewhere', from: done.from };
    if (await exists(path.join(target, CONFIG_FILE))) return { status: 'not-needed' };

    const skip = (relative: string) => SKIPPED_FILES.has(relative.slice(1)) || relative.slice(1) === CONFIG_FILE.split(path.sep).join('/');
    let files = 0;
    for (const entry of MIGRATED_ENTRIES) {
      const source = path.join(from, entry);
      if (await exists(source)) files += await copyTree(source, path.join(target, entry), `/${entry}`, skip);
    }
    await repointManifest(target, from);
    // The configuration goes last and atomically: its presence means the copy is complete.
    const config = path.join(from, CONFIG_FILE);
    if (await exists(config)) {
      const staged = path.join(target, `${CONFIG_FILE}.${randomBytes(4).toString('hex')}.migrating`);
      await mkdir(path.dirname(staged), { recursive: true, mode: 0o700 });
      await copyOne(config, staged);
      if (await exists(path.join(target, CONFIG_FILE))) await rm(staged, { force: true });
      else { await rename(staged, path.join(target, CONFIG_FILE)); files++; }
    }
    const at = (options.now?.() ?? new Date()).toISOString();
    await writeJsonAtomic(path.join(target, MIGRATION_MARKER), { from, at } satisfies MigrationMarker);
    // The old folder is only touched after the copy is complete; failures there do not undo the migration.
    const forwarderShim = await shimLegacyForwarder(from, target).catch(() => false);
    await writeFile(path.join(from, MIGRATION_NOTE), noteText(target, at), { mode: PRIVATE_FILE_MODE }).catch(() => undefined);
    return { status: 'migrated', from, files, forwarderShim };
  } finally {
    await release();
  }
}
