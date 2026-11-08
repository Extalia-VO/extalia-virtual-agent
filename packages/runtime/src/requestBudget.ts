import { estimateTokens, isInputTokenLimit } from '@extalia/core';
import { ProviderError, type ModelProvider, type ModelRequest } from './model.js';

/** A text safety ceiling, independent of any provider's actual context window. */
export const REQUEST_CHARACTER_LIMIT = 8_000_000;
const MAX_DEPTH = 64;
const MAX_VALUES = 100_000;
const IMAGE_TOKENS = 1_500;

export interface RequestPressure {
  /** UTF-16 text characters plus JSON-like field/scalar overhead; image bytes are excluded. */
  characters: number;
  /** A four-characters-per-token heuristic plus roughly 1,500 tokens per typed image. */
  estimatedTokens: number;
  limitTokens?: number;
  characterLimit: number;
}

export interface RequestBudgetCheck {
  /** Absent when an invalid limit or unsupported structure prevents a complete measurement. */
  pressure?: RequestPressure;
  reason?: 'invalid-limit' | 'unsupported-request' | 'character-limit' | 'token-limit';
}

/** A local preflight refusal; prior failed fallback attempts can still have consumed tokens. */
export class RequestBudgetError extends ProviderError {
  readonly code = 'native_context_limit';
  constructor(readonly reason: NonNullable<RequestBudgetCheck['reason']>, readonly pressure?: RequestPressure, readonly priorRequestMayHaveRun = false) {
    super('native_context_limit', 400, false);
    this.name = 'RequestBudgetError';
  }
}

/** Guard every factory-created provider call, including callers outside the agent turn loop. */
export function guardProviderRequests(provider: ModelProvider, inputTokenLimit?: number): ModelProvider {
  return {
    get api() { return provider.api; },
    get images() { return provider.images; },
    listModels: signal => provider.listModels(signal),
    async complete(request) {
      request.signal?.throwIfAborted();
      if (inputTokenLimit !== undefined && !isInputTokenLimit(inputTokenLimit)) throw new RequestBudgetError('invalid-limit');
      const budget = checkRequestBudget(request, inputTokenLimit);
      request.signal?.throwIfAborted();
      if (budget.reason || !budget.pressure) throw new RequestBudgetError(budget.reason ?? 'unsupported-request', budget.pressure);
      return provider.complete(request);
    },
  };
}

type Location = 'request' | 'messages' | 'user' | 'images' | 'image';

const ownValue = (value: object, key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;
function typedImage(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false;
  const mimeType = ownValue(value, 'mimeType');
  return typeof mimeType === 'string' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)
    && typeof ownValue(value, 'data') === 'string';
}

/**
 * Measure the complete prospective request without serializing the history or copying image data.
 * Repeated object references count each occurrence; only ancestor cycles are refused. Traversal
 * refuses accessors, non-JSON objects and excessive depth/work rather than hanging or guessing.
 * An explicit token ceiling must be a positive safe integer; no model-name limit is inferred.
 */
export function checkRequestBudget(request: Pick<ModelRequest, 'system' | 'messages' | 'tools'>, maxInputTokens?: number): RequestBudgetCheck {
  if (maxInputTokens !== undefined && (!Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0)) return { reason: 'invalid-limit' };
  let characters = 0, images = 0, values = 0;
  const ancestors = new Set<object>();
  const unsupported = new Error('Unsupported request structure.');

  function walk(value: unknown, depth: number, location?: Location): void {
    if (++values > MAX_VALUES || depth > MAX_DEPTH) throw unsupported;
    if (value === null || value === undefined) { characters += 4; return; }
    if (typeof value === 'string') { characters += value.length + 2; return; }
    if (typeof value === 'boolean') { characters += value ? 4 : 5; return; }
    if (typeof value === 'number' && Number.isFinite(value)) { characters += String(value).length; return; }
    if (typeof value !== 'object' || ancestors.has(value)) throw unsupported;
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw unsupported;
    ancestors.add(value);
    characters += 2;
    if (array) {
      for (let index = 0; index < value.length; index++) {
        if (index) characters++;
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor && !('value' in descriptor)) throw unsupported;
        const child = descriptor?.value;
        let next: Location | undefined;
        if (location === 'messages' && child && typeof child === 'object' && ownValue(child, 'role') === 'user') next = 'user';
        if (location === 'images' && typedImage(child)) { next = 'image'; images++; }
        walk(child, depth + 1, next);
      }
    } else {
      let fields = 0;
      for (const key in value) {
        if (++values > MAX_VALUES) throw unsupported;
        if (!Object.hasOwn(value, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) throw unsupported;
        if (descriptor.value === undefined) continue; // Optional object fields are omitted by JSON.
        if (fields++) characters++;
        characters += key.length + 3;
        const next = location === 'request' && key === 'messages' ? 'messages'
          : location === 'user' && key === 'images' ? 'images' : undefined;
        walk(location === 'image' && key === 'data' ? '' : descriptor.value, depth + 1, next);
      }
    }
    ancestors.delete(value);
  }

  try { walk({ system: request.system, messages: request.messages, tools: request.tools }, 0, 'request'); }
  catch { return { reason: 'unsupported-request' }; }
  const pressure: RequestPressure = {
    characters, estimatedTokens: estimateTokens(characters) + images * IMAGE_TOKENS,
    ...(maxInputTokens !== undefined ? { limitTokens: maxInputTokens } : {}), characterLimit: REQUEST_CHARACTER_LIMIT,
  };
  return {
    pressure,
    ...(characters > REQUEST_CHARACTER_LIMIT ? { reason: 'character-limit' }
      : maxInputTokens !== undefined && pressure.estimatedTokens > maxInputTokens ? { reason: 'token-limit' } : {}),
  };
}
