import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RustCompletionWorker } from '../src/daemon/completionWorker.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

describe.skipIf(!HAS_DAEMON)('Persistent Rust completion HTTP candidate', () => {
  it('shares one process, cancels one real request while another succeeds, then retires when idle', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-provider-worker-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const accepted: string[] = []; let answer: ServerResponse | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string };
        accepted.push(body.model); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
        if (body.model === 'answer') answer = response;
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const client = new RustCompletionWorker({ binary: () => DAEMON_BINARY, directory: root, clientVersion: 'test', idleTtlMs: 10 });
    cleanup.push(() => client.close());
    const controller = new AbortController();
    const request = { system: 'sys', messages: [], tools: [] };
    const cancelled = client.complete({ baseUrl, model: 'held' }, { ...request, signal: controller.signal }, true).catch(error => error);
    const completed = client.complete({ baseUrl, model: 'answer' }, request, true);
    await vi.waitFor(() => expect(accepted.sort()).toEqual(['answer', 'held']));
    expect(client.processCount).toBe(1); expect(client.pendingCount).toBe(2);
    controller.abort(); expect(await cancelled).toMatchObject({ retryable: false, message: expect.stringContaining('cancelled') });
    expect(client.pendingCount).toBe(1); expect(client.processCount).toBe(1);
    answer!.end('data: {"choices":[{"delta":{"content":"Other request completed."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    await expect(completed).resolves.toMatchObject({ result: { text: 'Other request completed.', stop: 'end' } });
    expect(client.pendingCount).toBe(0); expect(client.reservedBytes).toBe(0);
    await vi.waitFor(() => expect(client.processCount).toBe(0));
    expect(await readdir(root)).toEqual([]); await client.close();
  });
});
