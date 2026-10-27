import { DESKTOP_HOST_GLOBAL, type DesktopHostApi, type HostInfo, type Platform, type PlatformCapabilities, type RestartCapability } from '@extalia/platform';
import { bridgeAgentHost, bridgeUpdater, readBridgeToken } from './host/bridgeHost';
import { browserNotifications } from './approvals/browserNotifications';
import { desktopAgentHost, desktopNotifications, desktopRestart, desktopUpdater } from './host/desktopHost';

/**
 * A page can only reload itself. That does not restart the Bridge, the CLI, Hermes or
 * outside agent apps, and the UI says so.
 */
const reloadPage: RestartCapability = { kind: 'reload', restart: async () => { location.reload(); } };

interface DirectoryHandle { name: string }
type DirectoryPicker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<DirectoryHandle>;

function browserOs(): HostInfo['os'] {
  const agent = navigator.userAgent;
  if (/Mac OS X|Macintosh/.test(agent)) return 'macos';
  if (/Windows/.test(agent)) return 'windows';
  if (/Linux|X11/.test(agent)) return 'linux';
  return 'other';
}

function browserCapabilities(): PlatformCapabilities {
  const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  // Browser notifications exist wherever the Notification API does; they show only after the user opts in (Settings).
  const notifications = browserNotifications();
  if (!picker) return notifications ? { notifications } : {};
  return {
    ...(notifications ? { notifications } : {}),
    filesystem: {
      async selectDirectory() {
        try {
          const handle = await picker.call(window, { mode: 'read' });
          return { name: handle.name };
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return null;
          throw error;
        }
      },
    },
  };
}

/**
 * Composition root for host capabilities. This is the only place that asks
 * which host the UI runs in; everything else receives a Platform.
 *
 * - Desktop: the preload bridge (`window.extaliaDesktop`) carries agents and updates over IPC.
 * - Bridge: the `extalia` command serves this page with a token meta tag; agents and updates go over HTTP/SSE.
 * - Static web: neither is present, so there is no agents capability.
 */
export async function resolvePlatform(): Promise<Platform> {
  // `vite build --mode development` keeps DEV false, so the mode is checked too; both are compile-time constants.
  if ((import.meta.env.DEV || import.meta.env.MODE === 'development') && new URLSearchParams(location.search).has('mock')) {
    // Development only: the import sits inside this branch so production builds never contain the mock.
    const { createMockPlatform, mockOptionsFromSearch } = await import('./host/mockHost');
    return createMockPlatform(mockOptionsFromSearch(location.search));
  }

  const desktop = (window as unknown as Record<string, DesktopHostApi | undefined>)[DESKTOP_HOST_GLOBAL];
  if (desktop) {
    const capabilities: PlatformCapabilities = { filesystem: { selectDirectory: () => desktop.selectDirectory() } };
    // Older preload scripts may not expose these yet; a missing one is simply unavailable.
    if (desktop.agents) capabilities.agents = desktopAgentHost(desktop.agents);
    if (desktop.updater) capabilities.updater = desktopUpdater(desktop.updater);
    if (desktop.restart) capabilities.restart = desktopRestart(desktop.restart);
    if (desktop.notifications) capabilities.notifications = desktopNotifications(desktop.notifications);
    return { info: await desktop.info(), capabilities };
  }

  const info: HostInfo = { kind: 'web', appVersion: __APP_VERSION__, os: browserOs() };
  const token = readBridgeToken(document);
  if (token) {
    return { info, capabilities: { ...browserCapabilities(), agents: bridgeAgentHost(token), updater: bridgeUpdater(token), restart: reloadPage } };
  }
  return { info, capabilities: { ...browserCapabilities(), restart: reloadPage } };
}

export function supportsWebGL2(): boolean {
  try { return Boolean(document.createElement('canvas').getContext('webgl2')); }
  catch { return false; }
}
