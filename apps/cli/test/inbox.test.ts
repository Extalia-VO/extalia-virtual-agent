import { expect, it } from 'vitest';
import { parseInboxArgs, runInbox } from '../src/inbox';
import type { CliHost } from '../src/cli';

const url = 'http://127.0.0.1:4311/inbox/11111111-1111-4111-8111-111111111111';
const secret = 'a'.repeat(64);

it('accepts one exact paired loopback route and keeps ack-only distinct from another poll', () => {
  const id = '22222222-2222-4222-8222-222222222222';
  expect(parseInboxArgs(['--url', url, '--token', secret, '--ack', id])).toEqual({ url, token: secret, ack: id });
  expect(parseInboxArgs(['--url='+url, '--token='+secret, '--ack='+id, '--wait-ms=0'])).toEqual({ url, token: secret, ack: id, waitMs: 0 });
});

it('refuses remote routes, duplicate flags and unbounded waits without contacting an endpoint', async () => {
  for (const args of [
    ['--url', url.replace('127.0.0.1', 'example.com'), '--token', secret],
    ['--url', url, '--token', secret, '--token', secret],
    ['--url', url, '--token', secret, '--wait-ms', '25001'],
    ['--url', url, '--token', secret, '--wait-ms', '-1'],
    ['--url', url, '--token', secret, '--ack', 'not-a-message-id'],
  ]) {
    const errors: string[] = [], output: string[] = [];
    const host: CliHost = {
      version: '0.0.0-test', out: line => { output.push(line); }, err: line => { errors.push(line); },
      readFile: async () => { throw new Error('No files should be read'); }, exists: async () => false,
      platform: 'linux', arch: 'x64', nodeVersion: 'v24.0.0', env: {}, homeDirectory: '/unused',
      start: async () => { throw new Error('No engine should start'); },
      update: async () => { throw new Error('No update should run'); },
    };
    expect(await runInbox(host, args)).toBe(2);
    expect(output).toEqual([]);
    expect(errors.join()).not.toContain(secret);
    expect(errors.join()).not.toContain(url);
  }
});
