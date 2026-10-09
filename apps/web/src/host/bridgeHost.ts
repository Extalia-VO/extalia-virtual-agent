import type { AgentHostApi, UpdateCapability, UpdateStatus } from '@extalia/platform';
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

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function request(deps: BridgeDeps, token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Record<string, unknown> | undefined> {
  const headers: Record<string, string> = { [BRIDGE_TOKEN_HEADER]: token };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await deps.fetch(path, {
    method: init.method ?? 'GET',
    headers,
    cache: 'no-store',
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const payload = await readJson(response);
  if (!response.ok || typeof payload?.error === 'string') {
    throw new Error(typeof payload?.error === 'string' ? payload.error : `Extalia Bridge answered ${response.status}.`);
  }
  return payload;
}

const looksLikeEvent = (value: unknown): value is ExtaliaEvent => {
  const event = value as Partial<ExtaliaEvent> | null;
  return Boolean(event && typeof event === 'object' && typeof event.id === 'string' && typeof event.sessionId === 'string'
    && event.body && typeof event.body === 'object' && typeof event.body.type === 'string');
};

export function bridgeAgentHost(token: string, deps: BridgeDeps = defaultDeps()): AgentHostApi {
  let source: EventSource | undefined;
  const events = listenerSet<ExtaliaEvent>(
    () => {
      if (!deps.EventSource) return;
      // EventSource cannot send headers, so the token travels in the query; it reconnects on its own.
      source = new deps.EventSource(`/api/events?token=${encodeURIComponent(token)}`);
      source.onmessage = message => {
        let value: unknown;
        try { value = JSON.parse(String(message.data)); } catch { return; }
        if (looksLikeEvent(value)) events.emit(value);
      };
    },
    () => { source?.close(); source = undefined; },
  );
  return createRemoteHost(
    async (method, args) => (await request(deps, token, '/api/call', { method: 'POST', body: { method, args } }))?.result,
    listener => events.add(listener),
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
export function bridgeUpdater(token: string, options: UpdaterOptions = {}, deps: BridgeDeps = defaultDeps()): UpdateCapability {
  const { pollMs = 30_000, restartPollMs = 1_500, restartTimeoutMs = 120_000, reload = () => location.reload() } = options;
  const get = async (path: string, method = 'GET') => (await request(deps, token, path, { method })) as unknown as UpdateStatus;
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
