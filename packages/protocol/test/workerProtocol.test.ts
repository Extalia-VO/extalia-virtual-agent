import { describe, expect, it } from 'vitest';
import {
  encodeWorkerFrame, parseWorkerFrame, WorkerFrameReader, WORKER_MAX_FRAME_BYTES, type WorkerFrame,
} from '../src/workerProtocol.js';
import fixtures from './fixtures/worker/frames.json' with { type: 'json' };
import rawFixtures from './fixtures/worker/raw-frames.json' with { type: 'json' };

const hello: WorkerFrame = { schema_version: 1, kind: 'hello', worker_version: '0.0.0-reference', operations: ['health'] };
const { TextEncoder, TextDecoder } = globalThis as unknown as {
  TextEncoder: new () => { encode(input: string): Uint8Array };
  TextDecoder: new () => { decode(input: Uint8Array): string };
};
const encoder = new TextEncoder();
const code = (fn: () => unknown, expected: string) => expect(fn).toThrow(expect.objectContaining({ code: expected }));

describe('probe-only worker frame contract', () => {
  it.each(fixtures.cases)('$name', ({ valid, value }) => {
    const result = parseWorkerFrame(value);
    expect(result.ok).toBe(valid);
    if (result.ok) expect(new WorkerFrameReader().push(encodeWorkerFrame(result.frame))).toEqual([result.frame]);
  });
  it('does not echo raw values/errors and refuses constructed authority fields before encoding', () => {
    expect(parseWorkerFrame({ ...hello, command: 'private text' })).toEqual({ ok: false, code: 'invalid_frame' });
    code(() => encodeWorkerFrame({ ...hello, scanner_ready: true } as never), 'invalid_frame');
    const custom = { ...hello }; Object.defineProperty(custom, 'toJSON', { value: () => ({ scanner_ready: true }) });
    code(() => encodeWorkerFrame(custom), 'invalid_frame');
    code(() => encodeWorkerFrame({ ...hello, worker_version: 'x'.repeat(1_000_000) }), 'invalid_frame');
  });
});

describe('bounded worker NDJSON framing', () => {
  it.each(rawFixtures.cases)('raw JSON: $name', ({ valid, line }) => {
    const reader = new WorkerFrameReader();
    if (valid) expect(reader.push(encoder.encode(line + '\n'))).toHaveLength(1);
    else { code(() => reader.push(encoder.encode(line + '\n')), 'invalid_frame'); code(() => reader.push(encodeWorkerFrame(hello)), 'closed'); }
  });
  it('accepts every split of valid CRLF and escaped ASCII identity', () => {
    const line = encoder.encode(JSON.stringify(hello).replace('reference', '\\u0072eference') + '\r\n');
    for (let i = 0; i <= line.length; i++) {
      const reader = new WorkerFrameReader();
      expect([...reader.push(line.subarray(0, i)), ...reader.push(line.subarray(i))]).toEqual([hello]);
      reader.finish(); code(() => reader.push(new Uint8Array()), 'closed');
    }
  });
  it('accepts semantic integer spellings and bounds LF/CRLF bytes exactly', () => {
    const raw = '{"schema_version":1e0,"kind":"request","request_id":"00000000-0000-4000-8000-000000000001","operation":"health","deadline_ms":5e1,"payload":{}}\n';
    expect(new WorkerFrameReader().push(encoder.encode(raw))[0]).toMatchObject({ deadline_ms: 50 });
    const body = JSON.stringify(hello);
    for (const end of ['\n', '\r\n']) {
      const padded = encoder.encode(body + ' '.repeat(WORKER_MAX_FRAME_BYTES - body.length - end.length) + end);
      expect(new WorkerFrameReader().push(padded)).toEqual([hello]);
      code(() => new WorkerFrameReader().push(encoder.encode(' ' + new TextDecoder().decode(padded))), 'oversize');
    }
  });
  it('rejects invalid UTF-8, BOM, blank lines, malformed JSON and lone surrogates', () => {
    const invalid = [new Uint8Array([0xff, 10]), new Uint8Array([0xef, 0xbb, 0xbf, ...encodeWorkerFrame(hello)]), encoder.encode('\n'), encoder.encode(' \r\n'), encoder.encode('{}broken\n'),
      encoder.encode('{"schema_version":1,"kind":"hello","worker_version":"\\ud800","operations":["health"]}\n')];
    for (const bytes of invalid) {
      const reader = new WorkerFrameReader(); code(() => reader.push(bytes), 'invalid_frame');
      code(() => reader.push(encodeWorkerFrame(hello)), 'closed');
    }
  });
  it('rejects a failing batch atomically and never reopens after EOF tails', () => {
    const reader = new WorkerFrameReader();
    code(() => reader.push(encoder.encode(new TextDecoder().decode(encodeWorkerFrame(hello)) + '{}\n')), 'invalid_frame');
    code(() => reader.finish(), 'closed');
    const tail = new WorkerFrameReader(); expect(tail.push(encoder.encode('{}'))).toEqual([]);
    code(() => tail.finish(), 'truncated'); code(() => tail.push(encodeWorkerFrame(hello)), 'closed');
    const empty = new WorkerFrameReader(); empty.finish(); code(() => empty.push(encodeWorkerFrame(hello)), 'closed');
  });
  it('caps each push at64 complete frames and stops huge chunks without concatenation', () => {
    const line = new TextDecoder().decode(encodeWorkerFrame(hello));
    expect(new WorkerFrameReader().push(encoder.encode(line.repeat(64)))).toHaveLength(64);
    const reader = new WorkerFrameReader(); code(() => reader.push(encoder.encode(line.repeat(65))), 'too_many_frames');
    code(() => reader.push(new Uint8Array()), 'closed');
    code(() => new WorkerFrameReader().push(new Uint8Array(8 * WORKER_MAX_FRAME_BYTES).fill(32)), 'oversize');
  });
});
