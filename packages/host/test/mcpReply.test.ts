import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleMcpJsonRpc, runMcpStdioServer } from '../src/hooks/mcp.js';

const args = { url: 'http://127.0.0.1:4321/reply/12345678-1234-1234-1234-123456789abc', token: 'b'.repeat(64), question: 'Which option?' };
const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'await_reply', arguments: args } };

describe('MCP cooperative reply', () => {
  it('returns an answer through the original request id without echoing pairing secrets', async () => {
    const result = await handleMcpJsonRpc(call, { extaliaHome: '/unused', fetch: async () => Response.json({ status: 'answered', text: 'Green' }) });
    expect(result).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ status: 'answered', text: 'Green' }) }], isError: false } });
    expect(JSON.stringify(result)).not.toContain(args.token);
  });

  it('rejects unsafe pairing without making a request', async () => {
    const fetch = vi.fn();
    const result = await handleMcpJsonRpc({ ...call, params: { name: 'await_reply', arguments: { ...args, url: 'https://example.com' } } }, { extaliaHome: '/unused', fetch });
    expect(result?.result).toMatchObject({ isError: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(args.token);
  });

  it.each(['cancel', 'eof'])('processes ping during a wait and aborts it on %s', async termination => {
    const input = new PassThrough();
    const lines: Array<Record<string, unknown>> = [];
    let admitted!: () => void;
    const started = new Promise<void>(resolve => { admitted = resolve; });
    let replySignal: AbortSignal | null | undefined;
    const fetch: typeof globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      replySignal = init?.signal;
      replySignal?.addEventListener('abort', () => reject(new Error('cancelled')));
      admitted();
    });
    const running = runMcpStdioServer({ extaliaHome: '/unused', input, fetch, output: line => lines.push(JSON.parse(line) as Record<string, unknown>) });
    input.write(JSON.stringify(call) + '\n');
    await started;
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    await vi.waitFor(() => expect(lines.some(line => line.id === 2)).toBe(true));
    expect(replySignal?.aborted).toBe(false);
    if (termination === 'cancel') {
      input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }) + '\n');
      await vi.waitFor(() => expect(replySignal?.aborted).toBe(true));
    }
    input.end();
    expect(await running).toBe(0);
    expect(replySignal?.aborted).toBe(true);
    expect(lines.find(line => line.id === 1)?.result).toMatchObject({ isError: true });
    expect(lines.map(line => line.id)).toEqual([2, 1]);
  });
});
