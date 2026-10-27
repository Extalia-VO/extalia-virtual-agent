/**
 * Length-prefixed framing for the daemon wire contract: an unsigned 32-bit big-endian
 * payload length, then that many bytes of UTF-8 JSON (no BOM). Pure helpers; the
 * caller owns the stdio streams.
 */
import { DAEMON_FRAME_HEADER_BYTES, DAEMON_MAX_FRAME_BYTES, type DaemonErrorCode, type DaemonFrame } from './daemon.js';
import { parseDaemonFrame } from './daemonValidate.js';

export type DaemonFrameReadResult =
  | { ok: true; frame: DaemonFrame }
  | { ok: false; code: DaemonErrorCode; errors: string[]; requestId?: string; /** The stream cannot continue. */ fatal: boolean };
export interface DaemonFrameReader {
  /** Append received bytes; returns every frame completed by them, in order. */
  push(chunk: Uint8Array): DaemonFrameReadResult[];
  /** Bytes buffered for an incomplete frame. */
  readonly pending: number;
  /** True after a fatal framing error; every later push repeats it. */
  readonly failed: boolean;
}

interface Utf8 { encode(text: string): Uint8Array; decode(bytes: Uint8Array): string }
function utf8(): Utf8 {
  const scope = globalThis as unknown as {
    TextEncoder: new () => { encode(input: string): Uint8Array };
    TextDecoder: new (label: string, options: { fatal: boolean; ignoreBOM: boolean }) => { decode(input: Uint8Array): string };
  };
  const encoder = new scope.TextEncoder();
  // Keep a byte order mark so JSON.parse rejects it, as strict JSON readers do.
  const decoder = new scope.TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  return { encode: text => encoder.encode(text), decode: bytes => decoder.decode(bytes) };
}
function frameLimit(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DAEMON_MAX_FRAME_BYTES) throw new RangeError(`Frame limit must be an integer between 1 and ${DAEMON_MAX_FRAME_BYTES}.`);
  return maxBytes;
}

/** Encode a validated frame with its length prefix. Throws for an invalid or oversize frame. */
export function encodeDaemonFrame(frame: DaemonFrame, maxBytes: number = DAEMON_MAX_FRAME_BYTES): Uint8Array {
  const limit = frameLimit(maxBytes);
  const parsed = parseDaemonFrame(frame);
  if (!parsed.ok) throw new Error(`Invalid daemon frame (${parsed.code}): ${parsed.errors.join(' ')}`);
  const payload = utf8().encode(JSON.stringify(frame));
  if (payload.length > limit) throw new RangeError(`Daemon frame of ${payload.length} bytes exceeds ${limit} bytes.`);
  const bytes = new Uint8Array(DAEMON_FRAME_HEADER_BYTES + payload.length);
  new DataView(bytes.buffer).setUint32(0, payload.length);
  bytes.set(payload, DAEMON_FRAME_HEADER_BYTES);
  return bytes;
}

/** Decode and validate one frame payload (without its length prefix). */
export function decodeDaemonFramePayload(payload: Uint8Array): DaemonFrameReadResult {
  let raw: unknown;
  try { raw = JSON.parse(utf8().decode(payload)); } catch { return { ok: false, code: 'invalid_frame', errors: ['Frame payload is not UTF-8 JSON.'], fatal: false }; }
  const result = parseDaemonFrame(raw);
  return result.ok ? result : { ...result, fatal: false };
}

/**
 * Incremental reader for a byte stream. A malformed payload is reported and skipped,
 * since its length is known; a declared length above the limit is fatal (fail closed).
 */
export function createDaemonFrameReader(maxBytes: number = DAEMON_MAX_FRAME_BYTES): DaemonFrameReader {
  const limit = frameLimit(maxBytes);
  let buffer = new Uint8Array(0);
  let failure: DaemonFrameReadResult | undefined;
  return {
    get pending() { return buffer.length; },
    get failed() { return failure !== undefined; },
    push(chunk) {
      if (failure) return [failure];
      const joined = new Uint8Array(buffer.length + chunk.length);
      joined.set(buffer);
      joined.set(chunk, buffer.length);
      const results: DaemonFrameReadResult[] = [];
      let offset = 0;
      while (joined.length - offset >= DAEMON_FRAME_HEADER_BYTES) {
        const length = new DataView(joined.buffer, offset).getUint32(0);
        if (length > limit) {
          failure = { ok: false, code: 'frame_too_large', errors: [`Frame length ${length} exceeds ${limit} bytes.`], fatal: true };
          buffer = new Uint8Array(0);
          return [...results, failure];
        }
        if (joined.length - offset - DAEMON_FRAME_HEADER_BYTES < length) break;
        const start = offset + DAEMON_FRAME_HEADER_BYTES;
        results.push(length === 0
          ? { ok: false, code: 'invalid_frame', errors: ['Frame payload is empty.'], fatal: false }
          : decodeDaemonFramePayload(joined.subarray(start, start + length)));
        offset = start + length;
      }
      buffer = joined.slice(offset);
      return results;
    },
  };
}
