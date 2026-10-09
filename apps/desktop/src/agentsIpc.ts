import { createAgentHost, type AgentHostRuntime } from '@extalia/host';
import { BrowserWindow, app, ipcMain } from 'electron';
import { IPC, reply, safeMessage } from './ipc';
import { isTrustedSender, parseAgentCall } from './security';
import type { WorkState } from './updatePolicy';

/** Quitting (including an update restart) waits this long at most for the host to save and stop. */
const CLOSE_TIMEOUT_MS = 5_000;

export interface AgentsOptions {
  devServer: URL | undefined;
  /** Explicit data directory (smoke tests); otherwise the host's default, which honours EXTALIA_HOME. */
  dataDirectory?: string;
}

export interface Agents {
  /** Agent activity for the updater. Idle while the host is unavailable. */
  work: WorkState;
  close(): Promise<void>;
}

/**
 * Start the Extalia Native agent host in the main process and carry it over
 * IPC. If the host cannot start, the app keeps working and agent calls fail
 * with the reason.
 */
export function startAgents({ devServer, dataDirectory }: AgentsOptions): Agents {
  let runtime: AgentHostRuntime | undefined;
  let unavailable = 'the agent host did not start.';
  const ready = Promise.resolve()
    .then(() => createAgentHost({ kind: 'desktop', version: app.getVersion(), ...(dataDirectory ? { dataDirectory } : {}) }))
    .then(started => {
      runtime = started;
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
    });

  ipcMain.handle(IPC.agents, (event, method: unknown, args: unknown) => reply(async () => {
    const call = parseAgentCall(event.senderFrame?.url, devServer, method, args);
    const host = (await ready)?.host;
    if (!host) throw new Error(`Agents are not available: ${unavailable}`);
    const run = host[call.method] as (...args: unknown[]) => Promise<unknown>;
    return run.apply(host, call.args);
  }));

  let closing: Promise<void> | undefined;
  const close = () => closing ??= Promise.race([
    ready.then(started => started?.close()),
    new Promise<void>(resolve => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref()),
  ]).catch((error: unknown) => console.error('The agent host did not close cleanly.', error));

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
