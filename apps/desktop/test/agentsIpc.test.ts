import { AGENT_HOST_METHODS, MAX_ATTACHMENT_BASE64_CHARS } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { reply, safeMessage, unwrap } from '../src/ipc';
import { isTrustedSender, parseAgentCall, parseDevServerUrl } from '../src/security';

const APP = 'extalia://app/index.html';

describe('agent host IPC validation', () => {
  it('accepts every whitelisted method with array arguments', () => {
    for (const method of AGENT_HOST_METHODS) expect(parseAgentCall(APP, undefined, method, [])).toEqual({ method, args: [] });
    expect(parseAgentCall(APP, undefined, 'refreshNativeMissionRecovery', ['session', 'mission'])).toEqual({ method: 'refreshNativeMissionRecovery', args: ['session', 'mission'] });
    expect(() => parseAgentCall('https://example.com/', undefined, 'refreshNativeMissionRecovery', ['session', 'mission'])).toThrow('Untrusted sender.');
    expect(parseAgentCall(APP, undefined, 'sendPrompt', ['session-1', 'hello'])).toEqual({ method: 'sendPrompt', args: ['session-1', 'hello'] });
  });

  it('bounds the payload of a file upload before it reaches the host', () => {
    const small = { name: 'notes.md', mimeType: 'text/markdown', data: 'aGVsbG8=' };
    expect(parseAgentCall(APP, undefined, 'uploadAttachment', ['s_abc123def456', small])).toEqual({ method: 'uploadAttachment', args: ['s_abc123def456', small] });
    const oversized = { name: 'big.bin', mimeType: 'application/octet-stream', data: 'A'.repeat(MAX_ATTACHMENT_BASE64_CHARS + 4) };
    expect(() => parseAgentCall(APP, undefined, 'uploadAttachment', ['s_abc123def456', oversized])).toThrow(/too large/);
    expect(() => parseAgentCall('https://example.com/', undefined, 'uploadAttachment', ['s_abc123def456', small])).toThrow('Untrusted sender.');
  });

  it('carries the shared profile calls only from the app', () => {
    expect(AGENT_HOST_METHODS).toEqual(expect.arrayContaining(['getProfile', 'saveProfile']));
    expect(parseAgentCall(APP, undefined, 'saveProfile', [{ preferences: { theme: 'dark' } }])).toEqual({ method: 'saveProfile', args: [{ preferences: { theme: 'dark' } }] });
    expect(() => parseAgentCall('https://example.com/', undefined, 'saveProfile', [{ displayName: 'x' }])).toThrow('Untrusted sender.');
    expect(() => parseAgentCall(APP, undefined, 'saveProfile', { displayName: 'x' })).toThrow('Agent host arguments must be an array.');
  });

  it('rejects methods outside the whitelist', () => {
    for (const method of ['subscribe', 'constructor', '__proto__', 'toString', 'close', '', 42, null, undefined]) {
      expect(() => parseAgentCall(APP, undefined, method, [])).toThrow('Unknown agent host method.');
    }
  });

  it('requires an argument array', () => {
    for (const args of [undefined, null, 'session-1', { 0: 'session-1', length: 1 }]) {
      expect(() => parseAgentCall(APP, undefined, 'getState', args)).toThrow('Agent host arguments must be an array.');
    }
  });

  it('refuses senders other than the app and the approved dev server', () => {
    const dev = parseDevServerUrl('http://127.0.0.1:5180');
    expect(parseAgentCall('http://127.0.0.1:5180/', dev, 'getState', []).method).toBe('getState');
    for (const sender of [undefined, '', 'https://example.com/', 'http://127.0.0.1:5180/', 'extalia://other/index.html', 'file:///index.html']) {
      expect(() => parseAgentCall(sender, undefined, 'getState', [])).toThrow('Untrusted sender.');
    }
    expect(isTrustedSender(APP)).toBe(true);
    expect(isTrustedSender(undefined)).toBe(false);
  });
});

describe('IPC replies', () => {
  it('carries values and safe error messages', async () => {
    expect(await reply(() => 42)).toEqual({ ok: true, value: 42 });
    expect(await reply(async () => { throw new Error('Agents are not available: no host.\n    at secret (/internal/file.ts:1:1)'); })).toEqual({ ok: false, error: 'Agents are not available: no host.' });
    expect(await reply(() => { throw { weird: true }; })).toEqual({ ok: false, error: 'Something went wrong.' });
    expect(unwrap({ ok: true, value: 'state' })).toBe('state');
    expect(() => unwrap({ ok: false, error: 'Untrusted sender.' })).toThrow(new Error('Untrusted sender.'));
    expect(safeMessage('x'.repeat(1000))).toHaveLength(300);
  });
});
