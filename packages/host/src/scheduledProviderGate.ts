import { ProviderError, type ModelProvider, type ModelRequest } from '@extalia/runtime';

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

function retryableFailure(error: unknown, seen = new Set<Error>()): boolean {
  if (!(error instanceof Error) || seen.has(error) || seen.size >= 16) return false;
  if (error.name === 'AbortError' || error.name === 'APIUserAbortError') return false;
  seen.add(error);
  if (error instanceof ProviderError) return error.retryable && (error.status === undefined || RETRYABLE_STATUSES.has(error.status));
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(item => retryableFailure(item, seen));
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string' && CONNECTION_CODES.has(code)) return true;
  return error.cause !== undefined && retryableFailure(error.cause, seen);
}

export interface ScheduledProviderGate {
  provider: ModelProvider;
  /** Resolves before any successful model result escapes, or when the parent releases the gate. */
  started: Promise<void>;
  /** A first-request failure candidate only; this does not prove a complete Native turn had no effects. */
  readonly retryableBeforeResponse: boolean;
  /** Release a preparation, cancellation or otherwise unclassified turn without granting retry authority. */
  settleAccepted(): void;
}

/**
 * Classify only the first main-provider request. The host must separately verify
 * completed Native settlement, unchanged history and no steering before retrying.
 * A result, any nonempty streamed text, another request or an unknown failure
 * permanently closes this candidate window.
 */
export function createScheduledProviderGate(provider: ModelProvider, options: { onStarted?(): void } = {}): ScheduledProviderGate {
  let accepted = false, candidate = false, requests = 0;
  let resolveStarted!: () => void;
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  const settleAccepted = () => {
    if (accepted) return;
    accepted = true; candidate = false; resolveStarted();
    try { options.onStarted?.(); } catch { /* Notification cannot reopen provider admission. */ }
  };
  const wrapped: ModelProvider = {
    api: provider.api,
    ...(provider.images !== undefined ? { images: provider.images } : {}),
    listModels: signal => provider.listModels(signal),
    async complete(request: ModelRequest) {
      const first = requests++ === 0 && !accepted;
      if (!first) settleAccepted();
      let responseText = false, callbackFailed = false, settled = false;
      try {
        const result = await provider.complete({ ...request, onText: delta => {
          // An adapter callback after its promise settled cannot be evidence of
          // a model response available to the Native loop.
          if (settled) return;
          if (delta.length > 0) { responseText = true; settleAccepted(); }
          try { request.onText?.(delta); } catch (error) { callbackFailed = true; throw error; }
        } });
        settleAccepted();
        return result;
      } catch (error) {
        if (first && !accepted && !responseText && !callbackFailed && !request.signal?.aborted && retryableFailure(error)) candidate = true;
        else settleAccepted();
        throw error;
      } finally { settled = true; }
    },
  };
  return { provider: wrapped, started, get retryableBeforeResponse() { return candidate && !accepted; }, settleAccepted };
}
