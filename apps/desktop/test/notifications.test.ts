import { describe, expect, it } from 'vitest';
import { IPC } from '../src/ipc';
import { NOTIFICATION_BODY_LIMIT, NOTIFICATION_TITLE_LIMIT, acceptNotification, parseNotification } from '../src/notifications';
import { parseDevServerUrl } from '../src/security';

describe('notification payload validation', () => {
  it('accepts a title with an optional body', () => {
    expect(parseNotification({ title: 'Ada needs your approval' })).toEqual({ title: 'Ada needs your approval' });
    expect(parseNotification({ title: 'Ada', body: 'Run npm test' })).toEqual({ title: 'Ada', body: 'Run npm test' });
  });

  it('refuses anything that is not a plain object with only title and body', () => {
    for (const value of [null, 'hello', 1, [], [{ title: 'x' }]]) expect(() => parseNotification(value)).toThrow('Notification must be an object.');
    for (const value of [{ title: 'x', url: 'https://example.com' }, { title: 'x', approvalId: 'a1' }, JSON.parse('{"__proto__":{"title":"x"},"title":"y"}')]) {
      expect(() => parseNotification(value)).toThrow('Unknown notification field.');
    }
  });

  it('requires text and a non-empty title', () => {
    expect(() => parseNotification({})).toThrow('Notification title must be text.');
    expect(() => parseNotification({ title: 42 })).toThrow('Notification title must be text.');
    expect(() => parseNotification({ title: 'x', body: { secret: true } })).toThrow('Notification body must be text.');
    expect(() => parseNotification({ title: '   \n\t ' })).toThrow('Notification title is empty.');
  });

  it('bounds the length and removes control characters and line breaks', () => {
    const long = parseNotification({ title: 'T'.repeat(500), body: 'B'.repeat(5000) });
    expect(long.title.length).toBeLessThanOrEqual(NOTIFICATION_TITLE_LIMIT);
    expect(long.body!.length).toBeLessThanOrEqual(NOTIFICATION_BODY_LIMIT);
    expect(long.title.endsWith('…')).toBe(true);
    expect(parseNotification({ title: 'Line\u0000one\r\ntwo' }).title).toBe('Line one two');
  });

  it('keeps the sender check first: only the app pages may raise a notification', () => {
    const dev = parseDevServerUrl('http://127.0.0.1:5180');
    expect(acceptNotification('extalia://app/index.html', undefined, { title: 'x' })).toEqual({ title: 'x' });
    expect(acceptNotification('http://127.0.0.1:5180/', dev, { title: 'x' })).toEqual({ title: 'x' });
    expect(() => acceptNotification('https://example.com/', dev, { title: 'x' })).toThrow('Untrusted sender.');
    expect(() => acceptNotification(undefined, dev, { title: 'x' })).toThrow('Untrusted sender.');
    // An untrusted sender gets the same refusal whatever the payload is, so it learns nothing about the rules.
    expect(() => acceptNotification('https://example.com/', dev, 'not-an-object')).toThrow('Untrusted sender.');
  });

  it('has its own audited channels, separate from the agent channel', () => {
    expect(IPC.notify).toBe('extalia:notify');
    expect(IPC.notificationActivate).toBe('extalia:notification-activate');
    expect(new Set(Object.values(IPC)).size).toBe(Object.values(IPC).length);
  });
});
