import { describe, expect, it } from 'vitest';
import { parseProviderCompleteFrame, PROVIDER_COMPLETE_SCHEMA } from '../src/providerComplete.js';

const envelope = { schema: PROVIDER_COMPLETE_SCHEMA, requestId: '00000000-0000-4000-8000-000000000001', seq: 0 };
const result = { text: 'hello', toolCalls: [], stop: 'end', usage: { inputTokens: 4, outputTokens: 2 }, promptTokens: 4 };
describe('native completion frames', () => {
  it('accepts correlated Unicode deltas, results and explicitly classified provider failures', () => {
    for (const frame of [
      { ...envelope, kind: 'delta', text: '你好 🌍' },
      { ...envelope, kind: 'result', result, streamOptionsRejected: true },
      { ...envelope, kind: 'error', code: 'http_error', status: 429, retryable: true },
      { ...envelope, kind: 'error', code: 'transport_error', retryable: false },
    ]) expect(parseProviderCompleteFrame(frame)).toEqual(frame);
  });
  it('rejects unknown fields, counters, cross-field usage and transport retries', () => {
    for (const frame of [
      { ...envelope, kind: 'result', result, surprise: true },
      { ...envelope, seq: -1, kind: 'delta', text: 'x' },
      { ...envelope, requestId: 'unbound', kind: 'delta', text: 'x' },
      { ...envelope, kind: 'error', code: 'transport_error', retryable: true },
      { ...envelope, kind: 'error', code: 'invented', retryable: false },
      { ...envelope, kind: 'result', result: { ...result, promptTokens: 5 } },
      { ...envelope, kind: 'result', result: { ...result, usage: { inputTokens: 2, cachedInputTokens: 3 } } },
      { ...envelope, kind: 'result', result: { ...result, usage: { inputTokens: Number.MAX_SAFE_INTEGER + 1 } } },
    ]) expect(parseProviderCompleteFrame(frame)).toBeUndefined();
  });
  it('bounds Unicode bytes and refuses non-JSON or cyclic tool input', () => {
    expect(parseProviderCompleteFrame({ ...envelope, kind: 'delta', text: '界'.repeat(6000) })).toBeUndefined();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const input of [cyclic, new Date(), { notJson: undefined }]) {
      expect(parseProviderCompleteFrame({ ...envelope, kind: 'result', result: { ...result,
        toolCalls: [{ id: 'call', name: 'tool', input }] } })).toBeUndefined();
    }
    expect(parseProviderCompleteFrame({ ...envelope, kind: 'result', result: { ...result,
      toolCalls: [{ id: 'call', name: 'tool', input: {}, inputError: 'Truncated arguments.' }] } })).toBeDefined();
  });
});
