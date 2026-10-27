import { randomBytes } from 'node:crypto';
import { chmod, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { isNotFound, writeFileAtomic, writeJsonAtomic } from '../jsonStore.js';
import { ensurePrivateDirectory, PRIVATE_FILE_MODE } from '../paths.js';

/**
 * Files shared between the running host and `extalia connect`:
 *
 * - `EXTALIA_HOME/hooks/token`: the ingest token, 64 hexadecimal characters
 *   (32 random bytes), mode 0600. It authorizes `POST /api/hooks/*` only and is
 *   never accepted by `/api/call`.
 * - `EXTALIA_HOME/hooks/endpoint.json`: `{ "port", "pid", "kind" }` of the host
 *   listening for hooks, written atomically when the listener starts and
 *   removed on a clean shutdown.
 */

export const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
/** Desktop's preferred hook port; it falls back to a free port when this one is taken. */
export const DESKTOP_HOOK_PORT = 4317;

export interface HookFiles { directory: string; token: string; endpoint: string; lastEvents: string }
export interface HookEndpoint { port: number; pid: number; kind: 'bridge' | 'desktop' }

export function hookFiles(dataDirectory: string): HookFiles {
  const directory = path.join(path.resolve(dataDirectory), 'hooks');
  return { directory, token: path.join(directory, 'token'), endpoint: path.join(directory, 'endpoint.json'), lastEvents: path.join(directory, 'last-events.json') };
}

/** The current token, or undefined when the file is missing or malformed. */
export async function readHookToken(dataDirectory: string): Promise<string | undefined> {
  try {
    const value = (await readFile(hookFiles(dataDirectory).token, 'utf8')).trim();
    return TOKEN_PATTERN.test(value) ? value : undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** Write a fresh token (also used by `extalia connect --rotate`). */
export async function rotateHookToken(dataDirectory: string): Promise<string> {
  const files = hookFiles(dataDirectory);
  await ensurePrivateDirectory(files.directory);
  const token = randomBytes(32).toString('hex');
  await writeFileAtomic(files.token, token, { mode: PRIVATE_FILE_MODE });
  return token;
}

/** The existing token (its mode tightened to 0600), or a new one when none is valid. */
export async function ensureHookToken(dataDirectory: string): Promise<string> {
  const files = hookFiles(dataDirectory);
  await ensurePrivateDirectory(files.directory);
  const existing = await readHookToken(dataDirectory);
  if (!existing) return rotateHookToken(dataDirectory);
  if (process.platform !== 'win32' && ((await stat(files.token)).mode & 0o777) !== PRIVATE_FILE_MODE) await chmod(files.token, PRIVATE_FILE_MODE);
  return existing;
}

export async function writeHookEndpoint(dataDirectory: string, endpoint: HookEndpoint): Promise<void> {
  const files = hookFiles(dataDirectory);
  await ensurePrivateDirectory(files.directory);
  await writeJsonAtomic(files.endpoint, { port: endpoint.port, pid: endpoint.pid, kind: endpoint.kind }, { mode: PRIVATE_FILE_MODE });
}

export async function readHookEndpoint(dataDirectory: string): Promise<HookEndpoint | undefined> {
  try {
    const raw = JSON.parse(await readFile(hookFiles(dataDirectory).endpoint, 'utf8')) as Partial<HookEndpoint>;
    const valid = Number.isInteger(raw.port) && raw.port! > 0 && raw.port! < 65536 && Number.isInteger(raw.pid) && (raw.kind === 'bridge' || raw.kind === 'desktop');
    return valid ? { port: raw.port!, pid: raw.pid!, kind: raw.kind! } : undefined;
  } catch {
    return undefined;
  }
}

/** Remove endpoint.json if this process wrote it (another host may have replaced it since). */
export async function removeHookEndpoint(dataDirectory: string, pid = process.pid): Promise<void> {
  const current = await readHookEndpoint(dataDirectory);
  if (!current || current.pid === pid) await rm(hookFiles(dataDirectory).endpoint, { force: true });
}
