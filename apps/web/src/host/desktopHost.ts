import type { AgentHostApi, DesktopHostApi, UpdateCapability } from '@extalia/platform';
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
