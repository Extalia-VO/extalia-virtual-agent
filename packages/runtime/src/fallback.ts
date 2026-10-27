import { ProviderError, type ModelProvider, type ModelRequest, type ModelResult } from './model.js';

/**
 * Model fallback chains: a subagent team member (or the lead of a team) lists
 * models in priority order. When the current model runs out of quota, is rate
 * limited or the endpoint fails temporarily, the same request is retried on the
 * next model, and the chain stays on that model for the rest of the turn.
 *
 * A request that already streamed text before failing is retried as a whole, so
 * the transcript may show the partial text of the failed attempt first.
 */
export interface ModelChainEntry {
  model: string;
  /** Created on first use, so fallbacks that are never needed cost nothing. */
  provider: () => ModelProvider;
}

export interface FallbackSwitch {
  from: string;
  to: string;
  error: ProviderError;
}

export interface FallbackOptions {
  onSwitch?(change: FallbackSwitch): void;
}

export interface FallbackProvider extends ModelProvider {
  /** The model the chain uses now. */
  readonly current: string;
}

/** Errors worth trying another model for: quota, credit and rate limits, overload and unreachable endpoints. */
export function isFallbackError(error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.retryable;
}

/** Build a chain from model ids and a factory; duplicates and empty ids are dropped. */
export function modelChain(models: readonly string[], create: (model: string) => ModelProvider): ModelChainEntry[] {
  return [...new Set(models.filter(Boolean))].map(model => ({ model, provider: () => create(model) }));
}

export function createFallbackProvider(chain: readonly ModelChainEntry[], options: FallbackOptions = {}): FallbackProvider {
  if (!chain.length) throw new Error('A model chain needs at least one model.');
  const created = new Map<number, ModelProvider>();
  const providerAt = (index: number) => {
    if (!created.has(index)) created.set(index, chain[index]!.provider());
    return created.get(index)!;
  };
  let index = 0;

  return {
    get api() { return providerAt(index).api; },
    get images() { return providerAt(index).images; },
    get current() { return chain[index]!.model; },
    listModels: signal => providerAt(0).listModels(signal),
    async complete(request: ModelRequest): Promise<ModelResult> {
      for (;;) {
        try {
          return await providerAt(index).complete(request);
        } catch (error) {
          if (request.signal?.aborted || !isFallbackError(error)) throw error;
          if (index >= chain.length - 1) {
            if (chain.length === 1) throw error;
            throw new ProviderError(`${error.message} Every model in the order was tried (${chain.map(entry => entry.model).join(', ')}).`, error.status, error.retryable);
          }
          const from = chain[index]!.model;
          index++;
          options.onSwitch?.({ from, to: chain[index]!.model, error });
        }
      }
    },
  };
}
