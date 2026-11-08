import { afterEach, describe, expect, it, vi } from 'vitest';
import { run, type CliHost } from '../src/cli';
import { parseReplyArgs } from '../src/connect';

const url = 'http://127.0.0.1:4321/reply/12345678-1234-1234-1234-123456789abc';
const token = 'c'.repeat(64);
function host() {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliHost = {
    version: '0.0.0-test', out: line => out.push(line), err: line => err.push(line),
    readFile: async () => { throw new Error('No files should be read'); }, exists: async () => false,
    platform: 'linux', arch: 'x64', nodeVersion: 'v24.0.0', env: {}, homeDirectory: '/unused',
    start: async () => { throw new Error('No engine should start'); }, update: async () => 0,
  };
  return { value, out, err };
}
afterEach(() => vi.unstubAllGlobals());

describe('extalia reply', () => {
  it('parses both forms of flags and preserves question text', () => {
    expect(parseReplyArgs([`--url=${url}`, '--token', token, '--question', 'Choose = Green'])).toEqual({ url, token, question: 'Choose = Green' });
    expect(parseReplyArgs(['--url', url, '--url', url, '--token', token])).toBeUndefined();
  });

  it('rejects invalid arguments without disclosing tokens or requesting a foreign URL', async () => {
    const io = host();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await run(['reply', '--url', 'https://example.com', '--token', token], io.value)).toBe(2);
    expect(await run(['reply', '--url', url, '--token', token, `--unknown=${token}`], io.value)).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(io.out).toEqual([]);
    expect(io.err.join('\n')).not.toContain(token);
  });

  it('returns the exact answer as JSON and cleans up signal listeners', async () => {
    const io = host();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'answered', text: 'Green\nContinue' })));
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    expect(await run(['reply', '--url', url, '--token', token, '--question', 'Pick one'], io.value)).toBe(0);
    expect(io.out).toEqual([JSON.stringify({ status: 'answered', text: 'Green\nContinue' })]);
    expect(io.err).toEqual([]);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
    expect(io.out.join('')).not.toContain(token);
  });

  it.each(['expired', 'unavailable'])('returns nonzero for %s without reporting success', async status => {
    const io = host();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status })));
    expect(await run(['reply', '--url', url, '--token', token], io.value)).toBe(1);
    expect(io.out).toEqual([JSON.stringify({ status })]);
  });
});
