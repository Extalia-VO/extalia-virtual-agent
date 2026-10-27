import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import type { AgentAppTrustStatus } from '@extalia/platform';
import { isExtaliaCodexCommand } from './codex.js';
import type { Env } from './util.js';

/**
 * A minimal JSON-RPC client for `codex app-server` (newline-delimited over
 * stdio), used only to read hook trust status and to write trust records with
 * the user's explicit consent. Codex itself validates and writes its config.
 */
export interface CodexRpc {
  call<T = unknown>(method: string, params: unknown): Promise<T>;
  close(): void;
}

export type CodexRpcFactory = (options: { bin: string; codexHome: string; env: Env; cwd: string }) => Promise<CodexRpc>;

const REQUEST_TIMEOUT_MS = 15_000;

export const spawnCodexAppServer: CodexRpcFactory = async ({ bin, codexHome, env, cwd }) => {
  const child = spawn(bin, ['app-server'], { cwd, env: { ...env, CODEX_HOME: codexHome } as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'ignore'] });
  let buffer = '';
  let nextId = 0;
  let dead: Error | undefined;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const failAll = (error: Error) => { dead = error; for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
        if (typeof message.id !== 'number') continue;
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message ?? 'Codex reported an error.'));
        else entry.resolve(message.result);
      } catch { /* not a JSON-RPC line */ }
    }
  });
  child.on('error', error => failAll(error));
  child.on('exit', () => failAll(new Error('Codex app-server exited.')));
  child.stdin.on('error', () => undefined);

  const send = (message: unknown) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...(message as object) })}\n`);
  const rpc: CodexRpc = {
    call: <T>(method: string, params: unknown) => new Promise<T>((resolve, reject) => {
      if (dead) { reject(dead); return; }
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex did not answer ${method} in time.`)); }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value as T); }, reject: error => { clearTimeout(timer); reject(error); } });
      send({ id, method, params });
    }),
    close() { try { child.kill(); } catch { /* already gone */ } },
  };
  try {
    await rpc.call('initialize', { clientInfo: { name: 'extalia-connect', version: '1' } });
    send({ method: 'initialized' });
  } catch (error) { rpc.close(); throw error; }
  return rpc;
};

export interface CodexHookInfo {
  key: string;
  eventName: string;
  command: string;
  currentHash: string;
  trustStatus: string;
  sourcePath: string;
}

interface HooksListResponse { data: Array<{ hooks: Array<{ key: string; eventName: string; handlerType: string; command?: string; currentHash: string; trustStatus: string; sourcePath: string }> }> }

async function samePath(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  try { return (await realpath(a)) === (await realpath(b)); } catch { return false; }
}

/** Extalia's hooks in the given config file as Codex sees them (key, hash, trust status). */
export async function listExtaliaHooks(rpc: CodexRpc, configPath: string, cwd: string): Promise<CodexHookInfo[]> {
  const response = await rpc.call<HooksListResponse>('hooks/list', { cwds: [cwd] });
  const hooks: CodexHookInfo[] = [];
  const seen = new Set<string>();
  for (const entry of response.data ?? []) {
    for (const hook of entry.hooks ?? []) {
      if (hook.handlerType !== 'command' || !isExtaliaCodexCommand(hook.command) || seen.has(hook.key)) continue;
      if (!(await samePath(hook.sourcePath, configPath))) continue;
      seen.add(hook.key);
      hooks.push({ key: hook.key, eventName: hook.eventName, command: hook.command as string, currentHash: hook.currentHash, trustStatus: hook.trustStatus, sourcePath: hook.sourcePath });
    }
  }
  return hooks;
}

export function summarizeTrust(hooks: readonly Pick<CodexHookInfo, 'trustStatus'>[]): { status: AgentAppTrustStatus; trusted: number; total: number } {
  const total = hooks.length;
  const trusted = hooks.filter(hook => hook.trustStatus === 'trusted' || hook.trustStatus === 'managed').length;
  if (!total) return { status: 'unknown', trusted, total };
  if (hooks.some(hook => hook.trustStatus === 'modified')) return { status: 'modified', trusted, total };
  return { status: trusted === total ? 'trusted' : 'untrusted', trusted, total };
}

/** Mark Extalia's hooks as trusted through Codex's own config API. Returns the keys written. */
export async function trustExtaliaHooks(rpc: CodexRpc, hooks: readonly CodexHookInfo[]): Promise<string[]> {
  const pendingHooks = hooks.filter(hook => hook.trustStatus !== 'trusted' && hook.trustStatus !== 'managed');
  if (!pendingHooks.length) return [];
  const read = await rpc.call<{ layers?: Array<{ name?: { type?: string }; version?: string }> }>('config/read', { includeLayers: true });
  const expectedVersion = read.layers?.find(layer => layer.name?.type === 'user')?.version ?? null;
  await rpc.call('config/batchWrite', {
    edits: pendingHooks.map(hook => ({ keyPath: `hooks.state."${hook.key}".trusted_hash`, value: hook.currentHash, mergeStrategy: 'upsert' })),
    expectedVersion,
  });
  return pendingHooks.map(hook => hook.key);
}
