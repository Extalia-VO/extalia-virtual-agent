import { expect, it } from 'vitest';
import { parseProviderWorkerFrame, PROVIDER_WORKER_SCHEMA } from '../src/providerWorker.js';
const workerId = '00000000-0000-4000-8000-000000000001';
const base = { schema: PROVIDER_WORKER_SCHEMA, workerId };
it('distinguishes correlated outcomes from positive owner-join receipts', () => {
  for (const frame of [
    { ...base, kind: 'hello' },
    { ...base, requestId: workerId, seq: 0, kind: 'error', code: 'cancelled', retryable: false },
    { ...base, requestId: workerId, seq: 1, kind: 'settled', joined: true },
  ]) expect(parseProviderWorkerFrame(frame)).toEqual(frame);
  for (const frame of [
    { ...base, workerId: 'unbound', kind: 'hello' },
    { ...base, kind: 'hello', pid: 1 },
    { ...base, requestId: workerId, seq: 0, kind: 'settled', joined: false },
    { ...base, requestId: workerId, seq: 0, kind: 'settled', joined: true, result: {} },
    { ...base, requestId: workerId, seq: 0, kind: 'error', code: 'busy', retryable: true },
  ]) expect(parseProviderWorkerFrame(frame)).toBeUndefined();
});
