/** Probe-only v1 stdio worker contract (ADR 0022). Independent of daemon frames.
 * Identity/version fields are consistency claims, never installed-artifact proof.
 * No scanner operation, permission, activation or process-settlement result exists.
 */
import type { JsonSchema } from './jsonSchema.js';
import { array, enumeration, literal, number, object, rule, UUID_PATTERN, type Rule } from './rules.js';

export const WORKER_SCHEMA_VERSION = 1;
/** Includes LF (and CR when using CRLF). */
export const WORKER_MAX_FRAME_BYTES = 65_536;
export const WORKER_MAX_FRAMES_PER_PUSH = 64;
export const WORKER_MAX_DEADLINE_MS = 300_000;
export const WORKER_ERROR_CODES = ['invalid_request', 'unsupported_operation', 'cancelled', 'unavailable', 'internal_error'] as const;
export type WorkerErrorCode = typeof WORKER_ERROR_CODES[number];
export type WorkerFrame =
  | { schema_version: 1; kind: 'hello'; worker_version: string; operations: ['health'] }
  | { schema_version: 1; kind: 'request'; request_id: string; operation: 'health'; deadline_ms: number; payload: Record<string, never> }
  | { schema_version: 1; kind: 'cancel'; request_id: string }
  | { schema_version: 1; kind: 'response'; request_id: string; result: { status: 'ok'; worker_version: string } }
  | { schema_version: 1; kind: 'error'; request_id: string; error: { code: WorkerErrorCode } };

// The final negative lookahead prevents JS `$` accepting a trailing newline.
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$(?![\s\S])/;
const version = rule((value, _path, errors) => {
  if (typeof value !== 'string' || value.length > 128 || !VERSION.test(value)) errors.push('invalid worker version');
}, { type: 'string', maxLength: 128, pattern: VERSION.source });
const uuid = rule((value, _path, errors) => {
  if (typeof value !== 'string' || value.length !== 36 || !UUID_PATTERN.test(value)) errors.push('invalid request identity');
}, { type: 'string', minLength: 36, maxLength: 36, pattern: UUID_PATTERN.source });
const common = { schema_version: literal(WORKER_SCHEMA_VERSION) };
const variants: Record<WorkerFrame['kind'], Rule> = {
  hello: object({ ...common, kind: literal('hello'), worker_version: version, operations: array(literal('health'), true, 1, 1) }),
  request: object({ ...common, kind: literal('request'), request_id: uuid, operation: literal('health'), deadline_ms: number(1, true, WORKER_MAX_DEADLINE_MS), payload: object({}) }),
  cancel: object({ ...common, kind: literal('cancel'), request_id: uuid }),
  response: object({ ...common, kind: literal('response'), request_id: uuid, result: object({ status: literal('ok'), worker_version: version }) }),
  error: object({ ...common, kind: literal('error'), request_id: uuid, error: object({ code: enumeration(WORKER_ERROR_CODES) }) }),
};

/** Bound object traversal before rules can construct field-error strings. */
function boundedObject(value: unknown, max: number): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let count = 0;
  for (const key in value) if (Object.hasOwn(value, key)) {
    if (++count > max || key.length > 64) return false;
  }
  return true;
}

export function parseWorkerFrame(value: unknown): { ok: true; frame: WorkerFrame } | { ok: false; code: 'invalid_frame' } {
  if (!boundedObject(value, 7) || typeof value.kind !== 'string' || value.kind.length > 8 || !Object.hasOwn(variants, value.kind)) return { ok: false, code: 'invalid_frame' };
  if (value.kind === 'request' && !boundedObject(value.payload, 0)) return { ok: false, code: 'invalid_frame' };
  if (value.kind === 'response' && !boundedObject(value.result, 2)) return { ok: false, code: 'invalid_frame' };
  if (value.kind === 'error' && !boundedObject(value.error, 1)) return { ok: false, code: 'invalid_frame' };
  const errors: string[] = [];
  variants[value.kind as WorkerFrame['kind']].check(value, 'frame', errors);
  return errors.length ? { ok: false, code: 'invalid_frame' } : { ok: true, frame: value as WorkerFrame };
}

export function workerJsonSchemaDefs(): Record<string, JsonSchema> {
  return { PythonWorkerFrame: { oneOf: Object.values(variants).map(value => value.schema) } };
}

export const WORKER_DECODE_ERRORS = ['invalid_frame', 'oversize', 'too_many_frames', 'truncated', 'closed'] as const;
export class WorkerDecodeError extends Error {
  readonly code: typeof WORKER_DECODE_ERRORS[number];
  constructor(code: typeof WORKER_DECODE_ERRORS[number]) { super(`Worker stream refused (${code}).`); this.code = code; }
}

// Portable Web Encoding API types, without depending on DOM or Node packages.
const utf8 = globalThis as unknown as {
  TextEncoder: new () => { encode(input: string): Uint8Array };
  TextDecoder: new (label: string, options: { fatal: boolean; ignoreBOM: boolean }) => { decode(input: Uint8Array): string };
};
const encoder = new utf8.TextEncoder();

/** Wire-only structural guard before JSON.parse can discard duplicate members.
 * The fixed probe schema has at most two container levels and ASCII strings.
 * JSON.parse remains responsible for complete JSON grammar validation.
 */
function rawProbeJson(text: string): unknown {
  const containers: ({ kind: '{'; keys: Set<string> } | { kind: '[' })[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      if (i === text.length) throw new WorkerDecodeError('invalid_frame');
      const token: unknown = JSON.parse(text.slice(start, i + 1));
      if (typeof token !== 'string' || token.length > 128 || [...token].some(char => char.charCodeAt(0) > 127)) throw new WorkerDecodeError('invalid_frame');
      let next = i + 1;
      while (next < text.length && /[ \t\r\n]/.test(text[next]!)) next++;
      if (text[next] === ':') {
        const container = containers[containers.length - 1];
        if (!container || container.kind !== '{' || token.length > 32 || container.keys.has(token) || container.keys.size === 6) throw new WorkerDecodeError('invalid_frame');
        container.keys.add(token);
      }
    } else if (char === '{' || char === '[') {
      if (containers.length === 2) throw new WorkerDecodeError('invalid_frame');
      containers.push(char === '{' ? { kind: '{', keys: new Set() } : { kind: '[' });
    } else if (char === '}' || char === ']') {
      const container = containers.pop();
      if (!container || (char === '}' ? container.kind !== '{' : container.kind !== '[')) throw new WorkerDecodeError('invalid_frame');
    }
  }
  return JSON.parse(text);
}
/** Encode only a fully validated probe frame; no raw error/value is echoed. */
export function encodeWorkerFrame(value: WorkerFrame): Uint8Array {
  const parsed = parseWorkerFrame(value);
  if (!parsed.ok) throw new WorkerDecodeError('invalid_frame');
  // Project known primitive fields so custom prototypes/toJSON cannot alter output.
  const frame = parsed.frame;
  const common = { schema_version: 1 };
  const projected = frame.kind === 'hello' ? { ...common, kind: 'hello', worker_version: frame.worker_version, operations: ['health'] }
    : frame.kind === 'request' ? { ...common, kind: 'request', request_id: frame.request_id, operation: 'health', deadline_ms: frame.deadline_ms, payload: {} }
      : frame.kind === 'cancel' ? { ...common, kind: 'cancel', request_id: frame.request_id }
        : frame.kind === 'response' ? { ...common, kind: 'response', request_id: frame.request_id, result: { status: 'ok', worker_version: frame.result.worker_version } }
          : { ...common, kind: 'error', request_id: frame.request_id, error: { code: frame.error.code } };
  const bytes = encoder.encode(`${JSON.stringify(projected)}\n`);
  if (bytes.length > WORKER_MAX_FRAME_BYTES) throw new WorkerDecodeError('oversize');
  return bytes;
}

/** Incremental bounded NDJSON reader. One failed push returns no partial batch and
 * permanently closes the reader. The batch cap depends on caller chunk boundaries.
 */
export class WorkerFrameReader {
  private readonly line = new Uint8Array(WORKER_MAX_FRAME_BYTES - 1);
  private length = 0;
  private closed = false;
  private readonly decoder = new utf8.TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  push(chunk: Uint8Array): WorkerFrame[] {
    if (this.closed) throw new WorkerDecodeError('closed');
    const frames: WorkerFrame[] = [];
    try {
      for (const byte of chunk) {
        if (byte === 10) {
          if (frames.length >= WORKER_MAX_FRAMES_PER_PUSH) throw new WorkerDecodeError('too_many_frames');
          const end = this.length > 0 && this.line[this.length - 1] === 13 ? this.length - 1 : this.length;
          const text = this.decoder.decode(this.line.subarray(0, end));
          const found = parseWorkerFrame(rawProbeJson(text));
          if (!found.ok) throw new WorkerDecodeError('invalid_frame');
          frames.push(found.frame); this.length = 0;
        } else {
          if (this.length === this.line.length) throw new WorkerDecodeError('oversize');
          this.line[this.length++] = byte;
        }
      }
      return frames;
    } catch (error) {
      this.closed = true; this.length = 0;
      throw error instanceof WorkerDecodeError ? error : new WorkerDecodeError('invalid_frame');
    }
  }

  finish(): void {
    if (this.closed) throw new WorkerDecodeError('closed');
    this.closed = true;
    if (this.length) { this.length = 0; throw new WorkerDecodeError('truncated'); }
  }
}

