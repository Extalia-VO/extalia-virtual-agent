import { describe, expect, it } from 'vitest';
import {
  parseProviderModelsResponse,
  PROVIDER_MODELS_MAX_REQUEST_BYTES,
  PROVIDER_MODELS_MAX_RESPONSE_BYTES,
  PROVIDER_MODELS_SCHEMA,
  type ProviderModelsRequest,
} from '../src/index.js';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const success = () => ({ schema: PROVIDER_MODELS_SCHEMA, requestId, daemonVersion: '0.4.241', outcome: 'ok', models: ['gpt-4.1', 'vendor/model:v2'], truncated: false });

describe('one-shot provider model discovery contract', () => {
  it('exposes the request shape and transport bounds', () => {
    const request: ProviderModelsRequest = {
      schema: PROVIDER_MODELS_SCHEMA, requestId, clientVersion: '0.4.241', baseUrl: 'http://localhost:1234/v1',
      apiKey: 'secret', headers: { 'x-omniroute-no-memory': 'true' }, timeoutMs: 15_000,
    };
    expect(request.timeoutMs).toBe(15_000);
    expect(PROVIDER_MODELS_MAX_REQUEST_BYTES).toBe(16_384);
    expect(PROVIDER_MODELS_MAX_RESPONSE_BYTES).toBe(131_072);
  });

  it('accepts valid success and returns a detached envelope', () => {
    const value = success();
    const parsed = parseProviderModelsResponse(value);
    expect(parsed).toEqual(value);
    if (parsed?.outcome === 'ok') expect(parsed.models).not.toBe(value.models);
  });

  it('accepts correlation UUIDs and bounded model lists, rejects malformed envelopes', () => {
    expect(parseProviderModelsResponse({ ...success(), requestId: 'not-a-uuid' })).toBeUndefined();
    expect(parseProviderModelsResponse({ ...success(), models: Array.from({ length: 501 }, () => 'model') })).toBeUndefined();
    for (const model of ['', ' leading', 'bad id', 'a'.repeat(201), 'a\n']) {
      expect(parseProviderModelsResponse({ ...success(), models: [model] })).toBeUndefined();
    }
    expect(parseProviderModelsResponse({ ...success(), unexpected: true })).toBeUndefined();
    expect(parseProviderModelsResponse({ ...success(), daemonVersion: ' '.repeat(65) })).toBeUndefined();
  });

  it('requires status only for HTTP errors and bounds it to HTTP status values', () => {
    const base = { schema: PROVIDER_MODELS_SCHEMA, requestId, daemonVersion: '0.4.241', outcome: 'error', code: 'http_error' };
    expect(parseProviderModelsResponse({ ...base, status: 503 })).toEqual({ ...base, status: 503 });
    expect(parseProviderModelsResponse(base)).toBeUndefined();
    expect(parseProviderModelsResponse({ ...base, status: 99 })).toBeUndefined();
    expect(parseProviderModelsResponse({ ...base, status: 600 })).toBeUndefined();
    expect(parseProviderModelsResponse({ ...base, status: 200, message: 'raw provider body' })).toBeUndefined();
    expect(parseProviderModelsResponse({ ...base, code: 'timeout', status: 504 })).toBeUndefined();
    expect(parseProviderModelsResponse({ ...base, code: 'timeout' })).toMatchObject({ outcome: 'error', code: 'timeout' });
  });

  it('rejects responses larger than the wire envelope bound', () => {
    expect(parseProviderModelsResponse({ ...success(), models: ['a'.repeat(PROVIDER_MODELS_MAX_RESPONSE_BYTES)] })).toBeUndefined();
  });
});
