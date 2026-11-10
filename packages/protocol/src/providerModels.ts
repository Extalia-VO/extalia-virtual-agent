/** Dedicated one-shot contract for provider model discovery. It does not open a profile or normal daemon RPC. */
export const PROVIDER_MODELS_SCHEMA = 'extalia.provider-models.v1' as const;
export const PROVIDER_MODELS_MAX_REQUEST_BYTES = 16_384;
export const PROVIDER_MODELS_MAX_RESPONSE_BYTES = 131_072;

export type ProviderModelsErrorCode =
  | 'invalid_request'
  | 'http_error'
  | 'transport_error'
  | 'timeout'
  | 'invalid_response'
  | 'response_too_large';

export interface ProviderModelsRequest {
  schema: typeof PROVIDER_MODELS_SCHEMA;
  requestId: string;
  clientVersion: string;
  baseUrl: string;
  apiKey?: string;
  headers?: { 'x-omniroute-no-memory': 'true' };
  timeoutMs: number;
}

export type ProviderModelsResponse =
  | {
      schema: typeof PROVIDER_MODELS_SCHEMA;
      requestId: string;
      daemonVersion: string;
      outcome: 'ok';
      models: string[];
      truncated: boolean;
    }
  | {
      schema: typeof PROVIDER_MODELS_SCHEMA;
      requestId: string;
      daemonVersion: string;
      outcome: 'error';
      code: ProviderModelsErrorCode;
      status?: number;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const ERROR_CODES: readonly ProviderModelsErrorCode[] = [
  'invalid_request', 'http_error', 'transport_error', 'timeout', 'invalid_response', 'response_too_large',
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** Parses the narrow response envelope without interpreting or exposing provider error text. */
export function parseProviderModelsResponse(value: unknown): ProviderModelsResponse | undefined {
  if (!isObject(value)) return undefined;
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { return undefined; }
  if (serialized === undefined || utf8Length(serialized) > PROVIDER_MODELS_MAX_RESPONSE_BYTES) return undefined;
  if (value.schema !== PROVIDER_MODELS_SCHEMA || typeof value.requestId !== 'string' || !UUID.test(value.requestId) ||
      !boundedText(value.daemonVersion, 64)) return undefined;

  if (value.outcome === 'ok') {
    if (!hasOnlyKeys(value, ['schema', 'requestId', 'daemonVersion', 'outcome', 'models', 'truncated']) ||
        !Array.isArray(value.models) || value.models.length > 500 || typeof value.truncated !== 'boolean' ||
        !value.models.every(model => typeof model === 'string' && MODEL_ID.test(model))) return undefined;
    return {
      schema: PROVIDER_MODELS_SCHEMA,
      requestId: value.requestId,
      daemonVersion: value.daemonVersion,
      outcome: 'ok',
      models: [...value.models],
      truncated: value.truncated,
    };
  }

  if (value.outcome === 'error') {
    if (typeof value.code !== 'string' || !ERROR_CODES.includes(value.code as ProviderModelsErrorCode)) return undefined;
    const allowed = value.code === 'http_error'
      ? ['schema', 'requestId', 'daemonVersion', 'outcome', 'code', 'status']
      : ['schema', 'requestId', 'daemonVersion', 'outcome', 'code'];
    if (!hasOnlyKeys(value, allowed)) return undefined;
    if (value.code === 'http_error') {
      if (typeof value.status !== 'number' || !Number.isInteger(value.status) || value.status < 100 || value.status > 599) return undefined;
      return { schema: PROVIDER_MODELS_SCHEMA, requestId: value.requestId, daemonVersion: value.daemonVersion,
        outcome: 'error', code: 'http_error', status: value.status };
    }
    return { schema: PROVIDER_MODELS_SCHEMA, requestId: value.requestId, daemonVersion: value.daemonVersion,
      outcome: 'error', code: value.code as ProviderModelsErrorCode };
  }
  return undefined;
}
