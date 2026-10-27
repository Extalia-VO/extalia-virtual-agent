import type { AgentHostApi, DesktopHostApi, NotificationCapability, RestartCapability, UpdateCapability } from '@extalia/platform';
import { createRemoteHost, errorMessage } from './remote';

/** Agents over the Desktop preload bridge: one audited IPC channel per method plus an event push. */
export function desktopAgentHost(agents: DesktopHostApi['agents']): AgentHostApi {
  return createRemoteHost(
    async (method, args) => {
      try { return await agents.call(method, args); }
      catch (error) { throw new Error(errorMessage(error), { cause: error }); }
    },
    listener => agents.onEvent(listener),
  );
}

export function desktopUpdater(updater: DesktopHostApi['updater']): UpdateCapability {
  return {
    status: () => updater.status(),
    check: () => updater.check(),
    install: () => updater.install(),
    postpone: () => updater.postpone(),
    onStatus: listener => updater.onStatus(listener),
  };
}

/** Desktop relaunches the app process; the main process stops agent work and saves host state first. */
export function desktopRestart(restart: DesktopHostApi['restart']): RestartCapability {
  return { kind: 'relaunch', restart: options => restart(options) };
}

/** Native notifications through the Desktop main process, which validates and bounds every payload. */
export function desktopNotifications(notifications: NonNullable<DesktopHostApi['notifications']>): NotificationCapability {
  return { notify: notification => notifications.notify(notification), onActivate: listener => notifications.onActivate(listener) };
}
