/** Experimental shared provider execution; a result is distinct from owner settlement. */
import { parseProviderCompleteFrame, PROVIDER_COMPLETE_SCHEMA, type ProviderCompleteFrame } from './providerComplete.js';

export const PROVIDER_WORKER_SCHEMA = 'extalia.provider-worker.v1' as const;
export const PROVIDER_WORKER_MAX_CONTROL_FRAME_BYTES = 65_536;
export const PROVIDER_WORKER_MAX_INPUT_CHUNK_BYTES = 16_384;
type WorkerEnvelope = { schema: typeof PROVIDER_WORKER_SCHEMA; workerId: string };
type OperationFrame<T = ProviderCompleteFrame> = T extends unknown ? Omit<T, 'schema'> & WorkerEnvelope : never;
export type ProviderWorkerFrame = OperationFrame | (WorkerEnvelope & (
  | { kind: 'hello' }
  | { kind: 'settled'; requestId: string; seq: number; joined: true }
));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const only = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));

export function parseProviderWorkerFrame(value: unknown): ProviderWorkerFrame | undefined {
  if (!object(value) || value.schema !== PROVIDER_WORKER_SCHEMA || typeof value.workerId !== 'string' || !UUID.test(value.workerId)) return undefined;
  if (value.kind === 'hello') return only(value, ['schema', 'workerId', 'kind']) ? value as unknown as ProviderWorkerFrame : undefined;
  if (value.kind === 'settled') {
    if (!only(value, ['schema', 'workerId', 'requestId', 'seq', 'kind', 'joined']) || value.joined !== true
      || typeof value.requestId !== 'string' || !UUID.test(value.requestId)
      || typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 0 || value.seq > 1_000_000) return undefined;
    return value as unknown as ProviderWorkerFrame;
  }
  // Only metadata is copied; large result strings and containers retain their references.
  const neutral = { ...value };
  delete neutral.workerId;
  if (!parseProviderCompleteFrame({ ...neutral, schema: PROVIDER_COMPLETE_SCHEMA })) return undefined;
  return value as unknown as ProviderWorkerFrame;
}
