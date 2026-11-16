import { parseNotificationTarget, type NotificationCapability, type NotificationTarget } from '@extalia/platform';

/**
 * Browser notifications. Shown only when the page already
 * has permission (the Settings toggle asks for it); a click focuses this window
 * and returns that notification's navigation target. Undefined without the API.
 */
export function browserNotifications(): NotificationCapability | undefined {
  if (typeof window === 'undefined' || !('Notification' in window)) return undefined;
  const listeners = new Set<(target?: NotificationTarget) => void>();
  return {
    supportsTargets: true,
    async notify({ title, body, target: value }) {
      const target = value === undefined ? undefined : parseNotificationTarget(value);
      if (Notification.permission !== 'granted') return;
      const note = new Notification(title, { ...(body ? { body } : {}), ...(target?.kind === 'observed-input' ? {} : { tag: 'extalia-approval' }) });
      note.onclick = () => {
        window.focus();
        note.close();
        for (const listener of listeners) listener(target === undefined ? undefined : { ...target });
      };
    },
    onActivate(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** The browser's permission for notifications, or `unsupported` where there is no API. */
export function browserNotificationPermission(): NotificationPermission | 'unsupported' {
  return typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported';
}
