import { randomBytes } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AgentAppId } from '@extalia/platform';
import { writeFileAtomic } from '../jsonStore.js';
import { readTextIfExists } from './util.js';

/** Desktop's default hook endpoint port, used when no host has reported another. */
export const DEFAULT_HOOK_PORT = 4317;

export const hooksDirectory = (extaliaHome: string) => path.join(extaliaHome, 'hooks');
export const tokenFile = (extaliaHome: string) => path.join(hooksDirectory(extaliaHome), 'token');
export const endpointFile = (extaliaHome: string) => path.join(hooksDirectory(extaliaHome), 'endpoint.json');
export const hookTargetsFile = (extaliaHome: string) => path.join(hooksDirectory(extaliaHome), 'targets.json');

/** Explicit per-app overrides; never overwrite the endpoint owned by a running host. */
export async function readHookTargets(extaliaHome: string): Promise<Partial<Record<AgentAppId, number>>> {
  try {
    const value: unknown = JSON.parse((await readTextIfExists(hookTargetsFile(extaliaHome))) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries((['codex', 'claude', 'gemini', 'antigravity', 'hermes'] as const).flatMap(app => {
      const port: unknown = (value as Record<string, unknown>)[app];
      return Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536 ? [[app, port]] : [];
    }));
  } catch { return {}; }
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export async function readToken(extaliaHome: string): Promise<string | undefined> {
  const text = (await readTextIfExists(tokenFile(extaliaHome)))?.trim();
  return text && TOKEN_PATTERN.test(text) ? text : undefined;
}

/** Create the ingest token (32 random bytes, hex, mode 0600) when missing; `rotate` replaces it. */
export async function ensureToken(extaliaHome: string, rotate = false): Promise<{ token: string; created: boolean }> {
  const existing = await readToken(extaliaHome);
  if (existing && !rotate) return { token: existing, created: false };
  const token = randomBytes(32).toString('hex');
  await mkdir(hooksDirectory(extaliaHome), { recursive: true, mode: 0o700 });
  await writeFileAtomic(tokenFile(extaliaHome), token, { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(tokenFile(extaliaHome), 0o600);
  return { token, created: true };
}

export interface HostEndpoint {
  port: number;
  pid?: number;
  kind?: string;
  /** The recorded process still exists. */
  alive: boolean;
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as { code?: string }).code === 'EPERM'; }
}

/** The endpoint a running host published, or undefined when none is (or the file is stale). */
export async function readEndpoint(extaliaHome: string, alive: (pid: number) => boolean = processExists): Promise<HostEndpoint | undefined> {
  const text = await readTextIfExists(endpointFile(extaliaHome));
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as { port?: unknown; pid?: unknown; kind?: unknown };
    if (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535) return undefined;
    const pid = Number.isInteger(value.pid) ? (value.pid as number) : undefined;
    return { port: value.port as number, ...(pid !== undefined ? { pid } : {}), ...(typeof value.kind === 'string' ? { kind: value.kind } : {}), alive: pid === undefined ? true : alive(pid) };
  } catch { return undefined; }
}
