import { describe, expect, it, vi } from 'vitest';
import { checkScheduleConnection } from '../src/scheduleConnection.js';

const socketError = (code: string) => Object.assign(new Error('Fixture socket failure'), { code });
describe('pre-admission schedule endpoint reachability', () => {
  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'])('defers a verified %s transport failure', async code => {
    const transport = vi.fn(async (_url: string, _init?: RequestInit) => { throw new TypeError('fetch failed', { cause: socketError(code) }); });
    expect(await checkScheduleConnection('https://example.com/v1', transport)).toBe('connection-unavailable');
    expect(transport).toHaveBeenCalledWith('https://example.com/v1', expect.objectContaining({ method: 'HEAD', redirect: 'manual', signal: expect.any(AbortSignal) }));
    expect(transport.mock.calls[0]![1]).not.toHaveProperty('headers');
  });
  it.each([200, 301, 401, 403, 405, 429, 500])('treats HTTP %i as reachable without submitting model instructions or following redirects', async status => {
    const transport = vi.fn(async () => new Response(null, { status, headers: { location: 'https://example.org/login' } }));
    expect(await checkScheduleConnection('http://127.0.0.1:9/v1', transport)).toBe('ready');
    expect(transport).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:9/v1', expect.objectContaining({ method: 'HEAD', redirect: 'manual' }));
  });
  it.each([
    new Error('ENETUNREACH'), { code: 'ECONNREFUSED' },
    new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }),
    socketError('ETIMEDOUT'), socketError('ECONNRESET'), socketError('CERT_HAS_EXPIRED'),
    new DOMException('Timeout', 'TimeoutError'),
  ])('does not infer safe deferral from timeout, TLS, server disconnect or error text', async error => {
    expect(await checkScheduleConnection('https://example.com/v1', async () => { throw error; })).toBe('ready');
  });
  it('requires all terminal socket failures in an aggregate to be known unreachable', async () => {
    expect(await checkScheduleConnection('https://example.com', async () => { throw new AggregateError([socketError('ECONNREFUSED'), socketError('ENETUNREACH')]); })).toBe('connection-unavailable');
    for (const errors of [[], [socketError('ENOTFOUND'), socketError('ETIMEDOUT')], [socketError('ENOTFOUND'), new Error('Unknown')]]) {
      expect(await checkScheduleConnection('https://example.com', async () => { throw new AggregateError(errors); })).toBe('ready');
    }
  });
  it('handles cyclic cause graphs and non-HTTP endpoint shapes conservatively', async () => {
    const cycle = new Error('Cycle'); cycle.cause = cycle;
    expect(await checkScheduleConnection('https://example.com', async () => { throw cycle; })).toBe('ready');
    const transport = vi.fn();
    expect(await checkScheduleConnection('file:///tmp/fixture', transport)).toBe('ready');
    expect(await checkScheduleConnection('invalid', transport)).toBe('ready');
    expect(transport).not.toHaveBeenCalled();
  });
});
