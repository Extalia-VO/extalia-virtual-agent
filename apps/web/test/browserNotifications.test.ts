import type { DesktopHostApi, NotificationTarget } from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserNotifications } from '../src/approvals/browserNotifications';
import { desktopNotifications } from '../src/host/desktopHost';

const question = { kind: 'observed-input' as const, sessionId: 'session-one', requestId: 'question-one' };
const instances: MockNotification[] = [];
class MockNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn();
  onclick?: () => void;
  close = vi.fn();
  constructor(readonly title: string, readonly options: NotificationOptions) { instances.push(this); }
}
const focus = vi.fn();
beforeEach(() => {
  instances.length = 0; vi.clearAllMocks(); MockNotification.permission = 'granted';
  vi.stubGlobal('Notification', MockNotification); vi.stubGlobal('window', { Notification: MockNotification, focus });
});
afterEach(() => vi.unstubAllGlobals());

describe('browser notification activation', () => {
  it('retains a copied target for each notification and keeps legacy activation optional', async () => {
    const notifier = browserNotifications()!; expect(notifier.supportsTargets).toBe(true);
    const listener = vi.fn(); const stop = notifier.onActivate(listener);
    const target = { ...question };
    await notifier.notify({ title: 'First question', target }); target.requestId = 'changed-after-notify';
    await notifier.notify({ title: 'Second question', target: { ...question, requestId: 'question-two' } });
    await notifier.notify({ title: 'Approval', target: { kind: 'approval-inbox' } });
    await notifier.notify({ title: 'Legacy' });
    instances[1]!.onclick!(); expect(listener).toHaveBeenLastCalledWith({ ...question, requestId: 'question-two' });
    instances[0]!.onclick!(); expect(listener).toHaveBeenLastCalledWith(question);
    instances[2]!.onclick!(); expect(listener).toHaveBeenLastCalledWith({ kind: 'approval-inbox' });
    instances[3]!.onclick!(); expect(listener).toHaveBeenLastCalledWith(undefined);
    expect(focus).toHaveBeenCalledTimes(4); expect(instances.every(note => note.close.mock.calls.length === 1)).toBe(true);
    expect(instances[0]!.options.tag).toBeUndefined(); expect(instances[2]!.options.tag).toBe('extalia-approval');
    stop(); instances[0]!.onclick!(); expect(listener).toHaveBeenCalledTimes(4);
  });

  it('never requests permission and creates no popup without existing permission', async () => {
    MockNotification.permission = 'default'; await browserNotifications()!.notify({ title: 'Question', target: question });
    MockNotification.permission = 'denied'; await browserNotifications()!.notify({ title: 'Question', target: question });
    expect(instances).toHaveLength(0); expect(MockNotification.requestPermission).not.toHaveBeenCalled();
    vi.stubGlobal('window', {}); expect(browserNotifications()).toBeUndefined();
  });

  it('refuses invalid targets before creating a browser notification', async () => {
    const notifier = browserNotifications()!;
    for (const target of [{ ...question, requestId: 'x'.repeat(513) }, { ...question, body: 'secret' }, { kind: 'approval-inbox', url: 'https://example.com' }]) {
      await expect(notifier.notify({ title: 'Question', target: target as NotificationTarget })).rejects.toThrow('Invalid notification target.');
    }
    expect(instances).toHaveLength(0);
  });
});

it('advertises desktop target support only when the preload explicitly supports it', async () => {
  for (const supported of [undefined, false, true]) {
    const notify = vi.fn(async () => undefined), onActivate = vi.fn(() => () => undefined);
    const native = { notify, onActivate, ...(supported === undefined ? {} : { supportsTargets: supported }) } satisfies NonNullable<DesktopHostApi['notifications']>;
    const notifier = desktopNotifications(native);
    expect(notifier.supportsTargets).toBe(supported === true);
    await notifier.notify({ title: 'Legacy' }); expect(notify).toHaveBeenCalledWith({ title: 'Legacy' });
    const listener = vi.fn(); notifier.onActivate(listener); expect(onActivate).toHaveBeenCalledWith(listener);
  }
});
