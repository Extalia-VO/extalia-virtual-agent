import type { NotificationCapability } from '@extalia/platform';

/**
 * Browser notifications for approval requests. Shown only when the page already
 * has permission (the Settings toggle asks for it); a click focuses this window
 * and tells the shell to open the inbox. Undefined where the browser has no API.
 */
export function browserNotifications(): NotificationCapability | undefined {
  if (typeof window === 'undefined' || !('Notification' in window)) return undefined;
  const listeners = new Set<() => void>();
  return {
    async notify({ title, body }) {
      if (Notification.permission !== 'granted') return;
      const note = new Notification(title, { ...(body ? { body } : {}), tag: 'extalia-approval' });
      note.onclick = () => {
        window.focus();
        note.close();
        for (const listener of listeners) listener();
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
