import type { HookIngestStatus } from '@extalia/platform';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { writeJsonAtomic } from '../jsonStore.js';
import { PRIVATE_FILE_MODE } from '../paths.js';
import { ensureHookToken, hookFiles, readHookToken, removeHookEndpoint, writeHookEndpoint } from './files.js';
import { handleHookRequest, HookRateLimiter, secretMatches, signatureMatches, startHookListener, type HookListener } from './http.js';
import { HOOK_APPS, normalizeHook, type HookApp, type NormalizedHook } from './normalize.js';

/** A rotated token is picked up from disk at most this often while wrong tokens arrive. */
const TOKEN_RELOAD_MS = 1_000;
const LAST_EVENTS_SAVE_MS = 5_000;

export interface HookIngest {
  /** Shared `/api/hooks/<app>` handler (Bridge route and Desktop listener). */
  handle(request: IncomingMessage, response: ServerResponse, app: string): Promise<void>;
  /** Record the port serving hooks: written to `hooks/endpoint.json` for `extalia connect` and forwarders. */
  announce(port: number): Promise<void>;
  /** Desktop: start a loopback listener (preferred port, else a free one) and announce it. */
  listen(preferredPort?: number): Promise<HookListener>;
  status(): HookIngestStatus;
  /** Stops the own listener and removes endpoint.json written by this process. */
  close(): Promise<void>;
}

export interface HookIngestOptions {
  dataDirectory: string;
  kind: 'bridge' | 'desktop';
  /** Receives each normalized hook (already authenticated, rate limited and redacted). */
  sink(hook: NormalizedHook): void;
  /** Drop prompt text, assistant reply text and tool output, keeping only activity labels. */
  labelsOnly?: boolean | (() => boolean);
  now?: () => number;
}

export async function createHookIngest(options: HookIngestOptions): Promise<HookIngest> {
  const now = options.now ?? Date.now;
  const files = hookFiles(options.dataDirectory);
  let token = await ensureHookToken(options.dataDirectory);
  let reloadedAt = now();
  let port: number | undefined;
  let listener: HookListener | undefined;
  let closed = false;
  const lastEvents: Record<HookApp, string | undefined> = { codex: undefined, claude: undefined, gemini: undefined, antigravity: undefined, hermes: undefined };
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const saveLastEvents = () => writeJsonAtomic(files.lastEvents, Object.fromEntries(HOOK_APPS.flatMap(app => lastEvents[app] ? [[app, lastEvents[app]]] : [])), { mode: PRIVATE_FILE_MODE }).catch(() => undefined);

  /** `extalia connect --rotate` replaces the file while the host runs; re-read it (throttled) before refusing. */
  async function current(given: (secret: string) => boolean): Promise<boolean> {
    if (given(token)) return true;
    if (now() - reloadedAt < TOKEN_RELOAD_MS) return false;
    reloadedAt = now();
    const fresh = await readHookToken(options.dataDirectory).catch(() => undefined);
    if (!fresh || fresh === token) return false;
    token = fresh;
    return given(token);
  }

  const limiter = new HookRateLimiter();
  const isLabelsOnly = () => (typeof options.labelsOnly === 'function' ? options.labelsOnly() : Boolean(options.labelsOnly));
  const handle = (request: IncomingMessage, response: ServerResponse, app: string) => handleHookRequest(request, response, app, {
    limiter,
    verifyToken: given => current(secret => secretMatches(secret, given)),
    verifySignature: (body, header) => current(secret => signatureMatches(secret, body, header)),
    deliver(app, payload) {
      lastEvents[app] = new Date(now()).toISOString();
      saveTimer ??= setTimeout(() => { saveTimer = undefined; void saveLastEvents(); }, LAST_EVENTS_SAVE_MS);
      saveTimer.unref?.();
      const hook = normalizeHook(app, payload, { labelsOnly: isLabelsOnly() });
      if (hook) options.sink(hook);
    },
  });

  async function announce(next: number): Promise<void> {
    if (closed) return;
    port = next;
    await writeHookEndpoint(options.dataDirectory, { port: next, pid: process.pid, kind: options.kind });
  }

  return {
    handle,
    announce,
    async listen(preferredPort) {
      listener ??= await startHookListener({ ...(preferredPort ? { port: preferredPort } : {}), handle });
      await announce(listener.port);
      return listener;
    },
    status: () => ({ ...(port ? { port } : {}), tokenPath: files.token, lastEvents: { ...lastEvents } }),
    async close() {
      if (closed) return;
      closed = true;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; await saveLastEvents(); }
      await listener?.close();
      if (port !== undefined) await removeHookEndpoint(options.dataDirectory).catch(() => undefined);
    },
  };
}
