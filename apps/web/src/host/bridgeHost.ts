import { ATTACHMENT_BODY_HEADER, GOAL_DOCUMENT_BODY_HEADER, MAX_GOAL_DOCUMENT_RPC_BODY_BYTES, type AgentHostApi, type UpdateCapability, type UpdateStatus } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import { createRemoteHost, listenerSet } from './remote';

/**
 * The Web client served by the `extalia` command (the local Bridge). The
 * Bridge writes a per-launch token into index.html; every request carries it.
 */
export const BRIDGE_META = 'extalia-bridge';
export const BRIDGE_TOKEN_HEADER = 'x-extalia-token';

export function readBridgeToken(doc: Pick<Document, 'querySelector'>): string | null {
  const token = doc.querySelector<HTMLMetaElement>(`meta[name="${BRIDGE_META}"]`)?.content.trim();
  return token ? token : null;
}

interface BridgeDeps {
  fetch: typeof fetch;
  EventSource?: typeof EventSource;
}

const defaultDeps = (): BridgeDeps => ({ fetch: (...args) => globalThis.fetch(...args), EventSource: globalThis.EventSource });

export interface BridgeConnection {
  readonly token: string;
  /** Recover only an explicitly refused credential, never an uncertain request. */
  recover(rejectedToken: string): Promise<boolean>;
  subscribe(listener: () => void): () => void;
}

interface BridgeConnectionOptions {
  fetch?: typeof fetch;
  /** Trusted bootstrap dependency for isolated transport tests. */
  bootstrap?: (signal: AbortSignal) => Promise<string | null>;
  bootstrapTimeoutMs?: number;
}

/** Re-read the same-origin page without executing it or replacing the mounted application. */
async function bootstrapBridgeToken(fetch: typeof globalThis.fetch, signal: AbortSignal): Promise<string | null> {
  if (typeof location === 'undefined' || typeof DOMParser === 'undefined' || !['http:', 'https:'].includes(location.protocol)) return null;
  const origin = location.origin;
  const response = await fetch('/', { method: 'GET', headers: { Accept: 'text/html' }, cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal });
  if (!response.ok || response.redirected || !response.url || new URL(response.url).origin !== origin
    || !/^text\/html(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) return null;
  const document = new DOMParser().parseFromString(await response.text(), 'text/html');
  return readBridgeToken(document);
}

/** Shared by AgentHost and updater so a manual Bridge restart does not require a page reload. */
export function createBridgeConnection(initialToken: string, options: BridgeConnectionOptions = {}): BridgeConnection {
  let token = initialToken;
  let pending: Promise<boolean> | undefined;
  const listeners = new Set<() => void>();
  const bootstrap = options.bootstrap ?? (signal => bootstrapBridgeToken(options.fetch ?? globalThis.fetch, signal));
  return {
    get token() { return token; },
    recover(rejectedToken) {
      // An older request may finish after another poll has already recovered.
      if (token !== rejectedToken) return Promise.resolve(true);
      if (pending) return pending;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('The Bridge reconnect request timed out.')); }, options.bootstrapTimeoutMs ?? 5_000);
      });
      const recovery = Promise.race([Promise.resolve().then(() => bootstrap(controller.signal)), deadline]).then(next => {
        if (token !== rejectedToken) return true;
        if (!next || next === token || /[\r\n]/.test(next)) return false;
        token = next;
        for (const listener of [...listeners]) listener();
        return true;
      }).finally(() => { clearTimeout(timer); if (pending === recovery) pending = undefined; });
      pending = recovery;
      return recovery;
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

class BridgeResponseError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function assertCurrentCredential(connection: BridgeConnection, sentToken: string): void {
  if (connection.token !== sentToken) throw new Error('The Bridge connection changed while this request was running. Check its result before trying again.');
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function request(deps: BridgeDeps, token: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Record<string, unknown> | undefined> {
  const headers: Record<string, string> = { [BRIDGE_TOKEN_HEADER]: token, ...init.headers };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await deps.fetch(path, {
    method: init.method ?? 'GET',
    headers,
    cache: 'no-store',
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const payload = await readJson(response);
  if (!response.ok || typeof payload?.error === 'string') {
    throw new BridgeResponseError(response.status, typeof payload?.error === 'string' ? payload.error : `Extalia Bridge answered ${response.status}.`);
  }
  return payload;
}

const looksLikeEvent = (value: unknown): value is ExtaliaEvent => {
  const event = value as Partial<ExtaliaEvent> | null;
  return Boolean(event && typeof event === 'object' && typeof event.id === 'string' && typeof event.sessionId === 'string'
    && event.body && typeof event.body === 'object' && typeof event.body.type === 'string');
};

export function bridgeAgentHost(credential: string | BridgeConnection, deps: BridgeDeps = defaultDeps()): AgentHostApi {
  const connection = typeof credential === 'string' ? createBridgeConnection(credential, { fetch: deps.fetch }) : credential;
  let source: EventSource | undefined;
  let subscribed = false;
  let stopCredentials: (() => void) | undefined;
  const openSource = () => {
    source?.close(); source = undefined;
    if (!subscribed || !deps.EventSource) return;
    // EventSource cannot send headers; a changed token needs a new stream URL.
    let current: EventSource;
    try { current = new deps.EventSource(`/api/events?token=${encodeURIComponent(connection.token)}`); }
    catch { return; } // Polling still verifies the host when streaming is unavailable.
    source = current;
    current.onmessage = message => {
      if (!subscribed || source !== current) return;
      let value: unknown;
      try { value = JSON.parse(String(message.data)); } catch { return; }
      if (looksLikeEvent(value)) events.emit(value);
    };
  };
  const events = listenerSet<ExtaliaEvent>(
    () => {
      subscribed = true;
      stopCredentials = connection.subscribe(openSource);
      openSource();
    },
    () => { subscribed = false; stopCredentials?.(); stopCredentials = undefined; source?.close(); source = undefined; },
  );
  return createRemoteHost(
    // A file upload may be larger than an ordinary call; the Bridge admits that size only with this header.
    async (method, args) => {
      const owner = method === 'createSession' && args[1] && typeof args[1] === 'object' ? (args[1] as { team?: unknown }).team
        : ['planTeam', 'planNativeMission', 'saveSessionTeam', 'saveWorkspaceTeam'].includes(method) ? args[1] : undefined;
      const hasGoalDocument = Boolean(owner && typeof owner === 'object' && 'goalDocument' in owner);
      const payload = { method, args };
      if (hasGoalDocument && new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_GOAL_DOCUMENT_RPC_BODY_BYTES) {
        throw new Error('The goal attachment request is too large to send. Remove it or shorten the text, then try again.');
      }
      const headers: Record<string, string> = {};
      if (method === 'uploadAttachment') headers[ATTACHMENT_BODY_HEADER] = 'attachment';
      else if (hasGoalDocument) headers[GOAL_DOCUMENT_BODY_HEADER] = 'goal-document';
      const init = { method: 'POST', body: payload, headers };
      const sentToken = connection.token;
      const send = async (token: string) => {
        const response = await request(deps, token, '/api/call', init);
        assertCurrentCredential(connection, token);
        return response?.result;
      };
      try { return await send(sentToken); }
      catch (error) {
        // Only this read-only snapshot may be retried after an explicit 401.
        // A prompt/approval/upload may already have taken effect: never replay it.
        if (!['getState', 'getStateSummary'].includes(method) || !(error instanceof BridgeResponseError) || error.status !== 401) throw error;
        if (!await connection.recover(sentToken)) throw error;
        return send(connection.token);
      }
    },
    listener => events.add(listener),
    true,
  );
}

export class RestartTimeoutError extends Error {
  constructor() { super('Extalia did not come back after the update.'); }
}

interface UpdaterOptions {
  pollMs?: number;
  restartPollMs?: number;
  restartTimeoutMs?: number;
  reload?: () => void;
}

/**
 * Updates for the npm-installed Bridge. There is no push channel, so status
 * is polled while someone listens. After an install the Bridge restarts
 * itself; the page reloads once it answers again.
 */
export function bridgeUpdater(credential: string | BridgeConnection, options: UpdaterOptions = {}, deps: BridgeDeps = defaultDeps()): UpdateCapability {
  const connection = typeof credential === 'string' ? createBridgeConnection(credential, { fetch: deps.fetch }) : credential;
  const { pollMs = 30_000, restartPollMs = 1_500, restartTimeoutMs = 120_000, reload = () => location.reload() } = options;
  const get = async (path: string, method = 'GET') => {
    const token = connection.token;
    const response = await request(deps, token, path, { method });
    assertCurrentCredential(connection, token);
    return response as unknown as UpdateStatus;
  };
  let last: UpdateStatus | undefined;
  let restarting = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const publish = (status: UpdateStatus) => { last = status; statuses.emit(status); };
  const poll = () => { if (!restarting) get('/api/update').then(publish, () => { /* offline for now; next poll retries */ }); };
  const statuses = listenerSet<UpdateStatus>(
    () => { poll(); timer = setInterval(poll, pollMs); },
    () => { clearInterval(timer); timer = undefined; },
  );

  async function waitForRestart(before: string | undefined): Promise<void> {
    const deadline = Date.now() + restartTimeoutMs;
    let wentAway = false;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, restartPollMs));
      try {
        const status = await get('/api/update');
        if (wentAway || (before !== undefined && status.current !== before)) { reload(); return; }
      } catch {
        wentAway = true;
      }
    }
    restarting = false;
    throw new RestartTimeoutError();
  }

  return {
    async status() { const status = await get('/api/update'); last = status; return status; },
    async check() { const status = await get('/api/update/check', 'POST'); publish(status); return status; },
    async install() {
      const before = last?.current;
      let status: UpdateStatus | undefined;
      try {
        status = await get('/api/update/install', 'POST');
      } catch (error) {
        // A network error can mean the Bridge already went down to restart; anything else is a real refusal.
        if (!(error instanceof TypeError)) throw error;
      }
      restarting = true;
      const base = status ?? last ?? { current: before ?? '', channel: 'stable' as const, state: 'installing' as const };
      publish({ ...base, state: 'installing' });
      await waitForRestart(before);
    },
    async postpone() { /* The Bridge never restarts on its own, so there is nothing to postpone. */ },
    onStatus(listener) {
      const remove = statuses.add(listener);
      if (last) listener(last);
      return remove;
    },
  };
}
