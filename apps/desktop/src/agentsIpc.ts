import { createAgentHost, DESKTOP_HOOK_PORT, type AgentHostRuntime } from '@extalia/host';
import { BrowserWindow, app, ipcMain } from 'electron';
import path from 'node:path';
import { IPC, reply, safeMessage } from './ipc';
import { isTrustedSender, parseAgentCall } from './security';
import type { WorkState } from './updatePolicy';

/** Quitting (including an update restart) waits this long at most for the host to save and stop. */
const CLOSE_TIMEOUT_MS = 5_000;

export interface AgentsOptions {
  devServer: URL | undefined;
  /** Explicit data directory (smoke tests); otherwise the host's default, which honours EXTALIA_HOME. */
  dataDirectory?: string;
  /** Isolated profile for the packaged UI smoke test. */
  smokeTest?: boolean;
  /** Synthetic home required by smoke tests; never inferred from the user's profile. */
  homeDirectory?: string;
}

export interface Agents {
  /** Agent activity for the updater. Idle while the host is unavailable. */
  work: WorkState;
  close(): Promise<void>;
}

/**
 * Where the Rust core daemon is looked for when the native core flag selects it: beside the
 * app when packaged, the workspace's cargo build in development. The host starts it lazily
 * with the first daemon-routed mission and stops it when it closes (on quit).
 */
function daemonLocation(): { resourcesPath: string } | { repoRoot: string } {
  return app.isPackaged ? { resourcesPath: process.resourcesPath } : { repoRoot: path.resolve(__dirname, '../../..') };
}

/**
 * Start the Extalia Native agent host in the main process and carry it over
 * IPC. If the host cannot start, the app keeps working and agent calls fail
 * with the reason.
 */
export function startAgents({ devServer, dataDirectory, smokeTest = false, homeDirectory }: AgentsOptions): Agents {
  let runtime: AgentHostRuntime | undefined;
  let unavailable = 'the agent host did not start.';
  let starting: Promise<AgentHostRuntime | undefined> | undefined;
  let stopping = false;
  const ensureRuntime = (): Promise<AgentHostRuntime | undefined> => {
    if (stopping) return Promise.resolve(undefined);
    if (runtime) return Promise.resolve(runtime);
    if (starting) return starting;
    // A failed startup is retryable by the next trusted call (including the
    // recovery panel's getState). Concurrent calls share exactly one attempt.
    starting = Promise.resolve()
      .then(() => {
        if (smokeTest && (!dataDirectory || !homeDirectory)) throw new Error('Smoke tests require an isolated data and home directory.');
        const isolatedEnv = smokeTest && dataDirectory && homeDirectory ? {
          ...process.env,
          HOME: homeDirectory,
          USERPROFILE: homeDirectory,
          APPDATA: path.join(homeDirectory, 'AppData', 'Roaming'),
          LOCALAPPDATA: path.join(homeDirectory, 'AppData', 'Local'),
          XDG_CONFIG_HOME: path.join(homeDirectory, '.config'),
          XDG_DATA_HOME: path.join(homeDirectory, '.local', 'share'),
          XDG_CACHE_HOME: path.join(homeDirectory, '.cache'),
          XDG_STATE_HOME: path.join(homeDirectory, '.local', 'state'),
          CODEX_HOME: path.join(homeDirectory, '.codex'),
          CLAUDE_CONFIG_DIR: path.join(homeDirectory, '.claude'),
          GEMINI_CLI_HOME: path.join(homeDirectory, '.gemini'),
          ANTIGRAVITY_CONFIG_DIR: path.join(homeDirectory, '.gemini', 'config'),
          ANTIGRAVITY_HOME: path.join(homeDirectory, '.gemini', 'antigravity'),
          HERMES_HOME: path.join(homeDirectory, '.hermes'),
          EXTALIA_HOME: dataDirectory,
          EXTALIA_SECRET_STORE: 'memory',
        } : undefined;
        return createAgentHost({
          kind: 'desktop', version: app.getVersion(),
          ...(dataDirectory ? { dataDirectory } : {}),
          ...(homeDirectory ? { homeDirectory, importHome: homeDirectory } : {}),
          ...(isolatedEnv ? { env: isolatedEnv } : {}),
          daemon: { binary: daemonLocation() },
        });
      })
      .then(started => {
        runtime = started;
        // close() owns this pending attempt and will release it, even if its
        // bounded wait has expired. Do not start listeners while quitting.
        if (stopping) return started;
        if (!smokeTest) {
          void started.hooks?.listen(DESKTOP_HOOK_PORT).catch(() => undefined);
        }
        started.host.subscribe(event => {
          for (const window of BrowserWindow.getAllWindows()) {
            // Events carry prompts and file contents, so only the app's own pages receive them.
            if (!window.isDestroyed() && isTrustedSender(window.webContents.getURL(), devServer)) window.webContents.send(IPC.agentEvent, event);
          }
        });
        return started;
      }, (error: unknown) => {
        unavailable = safeMessage(error, unavailable);
        console.warn(`Agents are not available: ${unavailable}`);
        return undefined;
      }).finally(() => { starting = undefined; });
    return starting;
  };
  void ensureRuntime();

  ipcMain.handle(IPC.agents, (event, method: unknown, args: unknown) => reply(async () => {
    const call = parseAgentCall(event.senderFrame?.url, devServer, method, args);
    const host = (await ensureRuntime())?.host;
    if (stopping) throw new Error('The agent host is shutting down.');
    if (!host) throw new Error(`Agents are not available: ${unavailable}`);
    const run = host[call.method] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    // Optional methods (for example the worktree methods) may be missing on a host.
    if (typeof run !== 'function') throw new Error('This host does not support this action.');
    return run.apply(host, call.args);
  }));

  let closing: Promise<void> | undefined;
  const close = () => {
    stopping = true;
    return closing ??= Promise.race([
      (starting ?? Promise.resolve(runtime)).then(async started => {
        runtime = undefined;
        await started?.close();
      }),
      new Promise<void>(resolve => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref()),
    ]).catch((error: unknown) => console.error('The agent host did not close cleanly.', error));
  };

  let closed = false;
  app.on('will-quit', event => {
    if (closed) return;
    event.preventDefault();
    void close().finally(() => { closed = true; app.quit(); });
  });

  return {
    work: {
      isBusy: () => runtime?.isBusy() ?? false,
      onIdle: listener => runtime?.onIdle(listener) ?? (() => undefined),
    },
    close,
  };
}
