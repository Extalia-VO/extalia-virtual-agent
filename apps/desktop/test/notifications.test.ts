import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_TARGET_ID_LIMIT, type DesktopHostApi } from '@extalia/platform';
import { registerNotifications } from '../src/notificationIpc';
import { IPC } from '../src/ipc';
import { NOTIFICATION_BODY_LIMIT, NOTIFICATION_TITLE_LIMIT, acceptNotification, parseNotification } from '../src/notifications';
import { parseDevServerUrl } from '../src/security';

describe('notification payload validation', () => {
  it('accepts a title with an optional body', () => {
    expect(parseNotification({ title: 'Ada needs your approval' })).toEqual({ title: 'Ada needs your approval' });
    expect(parseNotification({ title: 'Ada', body: 'Run npm test' })).toEqual({ title: 'Ada', body: 'Run npm test' });
  });

  it('refuses anything that is not a plain object with only allowed fields', () => {
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

const electron = vi.hoisted(() => ({
  handle: vi.fn(), fromWebContents: vi.fn(), supported: vi.fn(() => true), create: vi.fn(),
  instances: [] as Array<{ click?: () => void; show: ReturnType<typeof vi.fn> }>,
  expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: electron.handle },
  BrowserWindow: { fromWebContents: electron.fromWebContents },
  Notification: class {
    static isSupported = electron.supported;
    click?: () => void;
    show = vi.fn();
    constructor(options: unknown) { electron.create(options); electron.instances.push(this); }
    on(_event: string, listener: () => void) { this.click = listener; return this; }
  },
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}));
const questionTarget = { kind: 'observed-input' as const, sessionId: 'session-one', requestId: 'question-one' };
const badTargets: unknown[] = [null, [], 'approval-inbox', {}, { kind: 'other' },
  { kind: 'approval-inbox', sessionId: 'extra' }, { ...questionTarget, url: 'https://example.com' },
  { ...questionTarget, requestId: '' }, { ...questionTarget, sessionId: '   ' },
  { ...questionTarget, requestId: 'bad\nvalue' }, { ...questionTarget, sessionId: 12 },
  { ...questionTarget, requestId: 'x'.repeat(NOTIFICATION_TARGET_ID_LIMIT + 1) },
  Object.create({ kind: 'approval-inbox' }), JSON.parse('{"kind":"approval-inbox","__proto__":{}}')];

beforeEach(() => {
  vi.clearAllMocks(); electron.instances.length = 0; electron.supported.mockReturnValue(true);
});

it('copies only bounded validated targets and rejects malformed or oversized navigation', () => {
  expect(parseNotification({ title: 'Approval', target: { kind: 'approval-inbox' } })).toEqual({ title: 'Approval', target: { kind: 'approval-inbox' } });
  const parsed = parseNotification({ title: 'Question', target: questionTarget });
  expect(parsed.target).toEqual(questionTarget); expect(parsed.target).not.toBe(questionTarget);
  expect(parseNotification({ title: 'Question', target: { ...questionTarget, requestId: 'x'.repeat(NOTIFICATION_TARGET_ID_LIMIT) } }).target).toBeDefined();
  for (const target of badTargets) expect(() => parseNotification({ title: 'Question', target })).toThrow('Invalid notification target.');
});

function setupNative(smokeTest = false) {
  registerNotifications({ smokeTest, devServer: undefined });
  const sender = {};
  const owner = { isDestroyed: vi.fn(() => false), isMinimized: vi.fn(() => true), restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
    webContents: { getURL: vi.fn(() => 'extalia://app/index.html'), send: vi.fn() } };
  electron.fromWebContents.mockImplementation(value => value === sender ? owner : undefined);
  const handler = electron.handle.mock.calls[0]![1] as (event: unknown, value: unknown) => Promise<unknown>;
  return { owner, sender, call: (value: unknown, url = 'extalia://app/index.html') => handler({ sender, senderFrame: { url } }, value) };
}

it('routes each native click to its trusted owning window with only its copied target', async () => {
  const { call, owner, sender } = setupNative();
  const target = { ...questionTarget };
  await call({ title: 'Question', body: 'Safe preview', target }); target.requestId = 'later-change';
  await call({ title: 'Approval', target: { kind: 'approval-inbox' } });
  await call({ title: 'Legacy approval' });
  expect(electron.create.mock.calls[0]).toEqual([{ title: 'Question', body: 'Safe preview' }]);
  electron.instances[0]!.click!();
  expect(electron.fromWebContents).toHaveBeenCalledWith(sender);
  expect(owner.restore).toHaveBeenCalledOnce(); expect(owner.show).toHaveBeenCalledOnce(); expect(owner.focus).toHaveBeenCalledOnce();
  expect(owner.webContents.send).toHaveBeenLastCalledWith(IPC.notificationActivate, questionTarget);
  electron.instances[1]!.click!(); expect(owner.webContents.send).toHaveBeenLastCalledWith(IPC.notificationActivate, { kind: 'approval-inbox' });
  electron.instances[2]!.click!(); expect(owner.webContents.send).toHaveBeenLastCalledWith(IPC.notificationActivate, undefined);
});

it('does not activate missing, destroyed or navigated-away notification owners', async () => {
  const { call, owner } = setupNative(); await call({ title: 'Question', target: questionTarget });
  owner.isDestroyed.mockReturnValue(true); electron.instances[0]!.click!();
  owner.isDestroyed.mockReturnValue(false); owner.webContents.getURL.mockReturnValue('https://example.com'); electron.instances[0]!.click!();
  electron.fromWebContents.mockReturnValue(undefined); electron.instances[0]!.click!();
  expect(owner.webContents.send).not.toHaveBeenCalled(); expect(owner.focus).not.toHaveBeenCalled();
});

it('shows no native popup in smoke mode or for unsupported, untrusted or invalid requests', async () => {
  let setup = setupNative(true); await setup.call({ title: 'Question', target: questionTarget }); expect(electron.create).not.toHaveBeenCalled();
  electron.handle.mockClear(); setup = setupNative(); electron.supported.mockReturnValue(false);
  await setup.call({ title: 'Question', target: questionTarget }); expect(electron.create).not.toHaveBeenCalled();
  electron.supported.mockReturnValue(true);
  expect(await setup.call({ title: 'Question', target: questionTarget }, 'https://example.com')).toEqual({ ok: false, error: 'Untrusted sender.' });
  for (const target of badTargets) expect(await setup.call({ title: 'Question', target })).toEqual({ ok: false, error: 'Invalid notification target.' });
  expect(electron.create).not.toHaveBeenCalled();
});

it('exposes target support from preload and validates activation pushes without leaking IPC events', async () => {
  await import('../src/preload');
  const api = electron.expose.mock.calls[0]![1] as DesktopHostApi;
  expect(api.notifications!.supportsTargets).toBe(true);
  electron.invoke.mockResolvedValue({ ok: true, value: undefined });
  await api.notifications!.notify({ title: 'Question', target: questionTarget });
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.notify, { title: 'Question', target: questionTarget });
  const listener = vi.fn(); const stop = api.notifications!.onActivate(listener);
  const push = electron.on.mock.calls[0]![1] as (event: unknown, payload?: unknown) => void;
  push({ secret: 'IPC event' }, questionTarget); expect(listener).toHaveBeenLastCalledWith(questionTarget);
  push({}, undefined); expect(listener).toHaveBeenLastCalledWith();
  const count = listener.mock.calls.length;
  for (const target of badTargets) push({}, target);
  expect(listener).toHaveBeenCalledTimes(count);
  stop(); expect(electron.removeListener).toHaveBeenCalledWith(IPC.notificationActivate, push);
});
