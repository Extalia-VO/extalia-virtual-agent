import { BrowserWindow, Notification, ipcMain } from 'electron';
import { acceptNotification } from './notifications';
import { IPC, reply } from './ipc';
import { isTrustedSender } from './security';

export interface NotificationOptions {
  smokeTest: boolean;
  devServer: URL | undefined;
}

/**
 * A click focuses the trusted window that raised the notification and returns
 * only its validated navigation target. Smoke tests never show system popups.
 */
export function registerNotifications({ smokeTest, devServer }: NotificationOptions): void {
  ipcMain.handle(IPC.notify, (event, value: unknown) => reply(() => {
    const notification = acceptNotification(event.senderFrame?.url, devServer, value);
    if (smokeTest || !Notification.isSupported()) return;
    const native = new Notification({ title: notification.title, ...(notification.body ? { body: notification.body } : {}) });
    native.on('click', () => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner || owner.isDestroyed() || !isTrustedSender(owner.webContents.getURL(), devServer)) return;
      if (owner.isMinimized()) owner.restore();
      owner.show();
      owner.focus();
      owner.webContents.send(IPC.notificationActivate, notification.target);
    });
    native.show();
  }));
}
