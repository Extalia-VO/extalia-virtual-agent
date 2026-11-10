/** Isolated completion-worker transport. It carries no workspace/tool execution authority. */
import type { Usage } from './events.js';

export const PROVIDER_COMPLETE_SCHEMA = 'extalia.provider-complete.v1' as const;
export const PROVIDER_COMPLETE_MAX_REQUEST_BYTES = 128 * 1024 * 1024;
export const PROVIDER_COMPLETE_MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const PROVIDER_COMPLETE_MAX_DELTA_BYTES = 16 * 1024;

export interface ProviderCompleteResult {
  text: string;
  toolCalls: { id: string; name: string; input: Record<string, unknown>; inputError?: string }[];
  stop: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  model?: string;
  usage?: Usage;
  promptTokens?: number;
  refusal?: string;
}
export type ProviderCompleteErrorCode = 'invalid_request' | 'request_too_large' | 'http_error' | 'provider_error'
  | 'transport_error' | 'timeout' | 'invalid_response' | 'response_too_large' | 'cancelled' | 'busy';
interface Envelope { schema: typeof PROVIDER_COMPLETE_SCHEMA; requestId: string; seq: number }
export type ProviderCompleteFrame = Envelope & (
  | { kind: 'delta'; text: string }
  | { kind: 'result'; result: ProviderCompleteResult; streamOptionsRejected?: boolean }
  | { kind: 'error'; code: ProviderCompleteErrorCode; message?: string; status?: number; retryable: boolean }
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ERROR_CODES: readonly string[] = ['invalid_request', 'request_too_large', 'http_error', 'provider_error',
  'transport_error', 'timeout', 'invalid_response', 'response_too_large', 'cancelled', 'busy'];
const RESULT_KEYS = ['text', 'toolCalls', 'stop', 'model', 'usage', 'promptTokens', 'refusal'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const only = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function text(value: unknown, bytes: number): value is string {
  if (typeof value !== 'string' || value.length > bytes) return false;
  if (value.length * 3 <= bytes) return true;
  let size = 0;
  for (let index = 0; index < value.length; index++) {
    const point = value.charCodeAt(index);
    if (point < 0x80) size++;
    else if (point < 0x800) size += 2;
    else if (point >= 0xd800 && point <= 0xdbff && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { size += 4; index++; }
    else size += 3;
    if (size > bytes) return false;
  }
  return true;
}

/** Bound untrusted result structure without creating another serialized response copy. */
function jsonObject(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false;
  const seen = new Set<object>();
  let remaining = 100_000;
  function visit(item: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > 64) return false;
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || seen.has(item)) return false;
    if (!Array.isArray(item) && !record(item)) return false;
    seen.add(item);
    let valid = true;
    for (const key in item) {
      if (Object.hasOwn(item, key) && !visit((item as Record<string, unknown>)[key], depth + 1)) { valid = false; break; }
    }
    seen.delete(item);
    return valid;
  }
  return visit(value, 0);
}

function result(value: unknown): value is ProviderCompleteResult {
  if (!record(value) || !only(value, RESULT_KEYS) || !text(value.text, 8 * 1024 * 1024)
    || typeof value.stop !== 'string' || !['end', 'tool_use', 'max_tokens', 'refusal', 'other'].includes(value.stop)
    || !Array.isArray(value.toolCalls) || value.toolCalls.length > 128) return false;
  if (value.model !== undefined && (!text(value.model, 4096) || !value.model.trim())) return false;
  if (value.refusal !== undefined && !text(value.refusal, 4096)) return false;
  if (value.promptTokens !== undefined && !counter(value.promptTokens)) return false;
  if (value.usage !== undefined) {
    if (!record(value.usage) || !only(value.usage, ['inputTokens', 'outputTokens', 'cachedInputTokens'])
      || !Object.keys(value.usage).length || !Object.values(value.usage).every(counter)) return false;
    const usage = value.usage;
    if (typeof usage.cachedInputTokens === 'number' && typeof usage.inputTokens === 'number'
      && usage.cachedInputTokens > usage.inputTokens) return false;
    if (value.promptTokens !== undefined && value.promptTokens !== usage.inputTokens) return false;
  }
  return value.toolCalls.every(call => record(call) && only(call, ['id', 'name', 'input', 'inputError'])
    && text(call.id, 4096) && call.id.length > 0 && text(call.name, 4096) && jsonObject(call.input)
    && (call.inputError === undefined || text(call.inputError, 4096)));
}

/** Frame size/correlation/sequence and process settlement are checked by the transport. */
export function parseProviderCompleteFrame(value: unknown): ProviderCompleteFrame | undefined {
  if (!record(value) || value.schema !== PROVIDER_COMPLETE_SCHEMA || typeof value.requestId !== 'string'
    || !UUID.test(value.requestId) || !counter(value.seq) || value.seq > 1_000_000) return undefined;
  const base = ['schema', 'requestId', 'seq', 'kind'];
  if (value.kind === 'delta') {
    if (!only(value, [...base, 'text']) || !text(value.text, PROVIDER_COMPLETE_MAX_DELTA_BYTES)) return undefined;
  } else if (value.kind === 'result') {
    if (!only(value, [...base, 'result', 'streamOptionsRejected']) || !result(value.result)
      || (value.streamOptionsRejected !== undefined && typeof value.streamOptionsRejected !== 'boolean')) return undefined;
  } else if (value.kind === 'error') {
    if (!only(value, [...base, 'code', 'message', 'status', 'retryable']) || typeof value.code !== 'string' || !ERROR_CODES.includes(value.code)
      || typeof value.retryable !== 'boolean' || (value.message !== undefined && !text(value.message, 512))) return undefined;
    if (value.status !== undefined && (!counter(value.status) || value.status < 100 || value.status > 599)) return undefined;
    if (value.code === 'http_error' && value.status === undefined) return undefined;
    if (value.status !== undefined && value.code !== 'http_error') return undefined;
    if (value.retryable && value.code !== 'http_error' && value.code !== 'provider_error') return undefined;
  } else return undefined;
  return value as unknown as ProviderCompleteFrame;
}
