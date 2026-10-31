/** Opt-in developer interoperability only; the product never searches for system Python. */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeWorkerFrame, WorkerFrameReader, type WorkerFrame } from '../../packages/protocol/src/workerProtocol.js';

const python = process.env.EXTALIA_TEST_PYTHON;
const fixture = fileURLToPath(new URL('../worker-protocol/reference_worker.py', import.meta.url));
const request: WorkerFrame = { schema_version: 1, kind: 'request', request_id: '00000000-0000-4000-8000-000000000001', operation: 'health', deadline_ms: 1000, payload: {} };

async function run(input: Uint8Array) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'extalia-worker-reference-'));
  try {
    const env = { PATH: process.env.PATH ?? '', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? '' } : {}) };
    const child = spawnSync(python!, ['-I', '-S', '-B', fixture], { input, cwd: directory, env, timeout: 2000, maxBuffer: 65536, windowsHide: true });
    if (child.error) throw child.error;
    const reader = new WorkerFrameReader(); const frames = reader.push(child.stdout); reader.finish();
    expect(child.stderr.toString()).toBe('');
    return { frames, status: child.status };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

describe.skipIf(!python)('opt-in Python reference interoperability', () => {
  it('exchanges a bounded health probe under an isolated credential-free environment', async () => {
    const result = await run(encodeWorkerFrame(request));
    expect(result.status).toBe(0);
    expect(result.frames).toEqual([
      { schema_version: 1, kind: 'hello', worker_version: '0.0.0-reference', operations: ['health'] },
      { schema_version: 1, kind: 'response', request_id: request.request_id, result: { status: 'ok', worker_version: '0.0.0-reference' } },
    ]);
  });
  it('rejects scanner/command requests, authority fields, malformed input and EOF tails', async () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + '\n');
    for (const input of [encode({ ...request, operation: 'skill.inspect' }), encode({ ...request, argv: ['bash'] }), new TextEncoder().encode('{}\n'), new TextEncoder().encode(JSON.stringify(request))]) {
      const result = await run(input); expect(result.status).toBe(2); expect(result.frames).toHaveLength(1);
      expect(result.frames[0]!.kind).toBe('hello');
    }
  });
  it('rejects oversized input and preserves semantic integer JSON interoperability', async () => {
    expect((await run(new Uint8Array(65537).fill(32))).status).toBe(2);
    const raw = JSON.stringify(request).replace('"schema_version":1', '"schema_version":1.0').replace('"deadline_ms":1000', '"deadline_ms":1e3');
    expect((await run(new TextEncoder().encode(raw + '\r\n'))).status).toBe(0);
  });
  it('rejects duplicate members and deeply nested malformed input without traceback', async () => {
    const duplicate = JSON.stringify(request).replace('"deadline_ms":1000', '"deadline_ms":2,"deadline_ms":1000');
    const escapedDuplicate = JSON.stringify(request).replace('"deadline_ms":1000', '"deadline_ms":2,"deadline_\\u006ds":1000');
    for (const raw of [duplicate, escapedDuplicate, '['.repeat(4000) + '0' + ']'.repeat(4000)]) {
      const result = await run(new TextEncoder().encode(raw + '\n'));
      expect(result.status).toBe(2); expect(result.frames).toHaveLength(1);
    }
  });
});
