import type { AgentHostOptions, AgentHostRuntime } from '@extalia/host';
import { BridgeRequestError, startBridgeServer, type BridgeServer } from './bridge/server';
import { FORWARDED_SIGNALS, relaunchPlan, supervise, type SignalSource, type SupervisedChild } from './relaunch';
import { installBlocker, type Updater } from './update';

export interface StartOptions {
  port: number;
  open: boolean;
  updateCheck: boolean;
}

export interface StartDeps {
  version: string;
  out(line: string): void;
  err(line: string): void;
  env: Readonly<Record<string, string | undefined>>;
  dataDirectory: string;
  webRoot: string;
  /** Token inherited from a supervisor after an in-app update. */
  token?: string;
  createAgentHost(options: AgentHostOptions): Promise<AgentHostRuntime>;
  updater: Updater;
  openBrowser(url: string): void;
  signals: SignalSource;
  /** What a relaunch runs: this bin with these arguments. */
  relaunch: { execPath: string; execArgv: readonly string[]; binPath: string; args: readonly string[] };
  spawn(command: string, args: string[], options: { stdio: 'inherit'; env: Record<string, string | undefined> }): SupervisedChild;
  /** Upper bound for closing the server and the agent host. */
  shutdownTimeoutMs?: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const withTimeout = (promise: Promise<unknown>, ms: number) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  void promise.catch(() => undefined).finally(() => { clearTimeout(timer); resolve(); });
});

/** Run the Bridge until a signal stops it or an update relaunches it; resolves to the exit code. */
export async function startBridge(options: StartOptions, deps: StartDeps): Promise<number> {
  // Requests may arrive as soon as the port is bound, before the host exists.
  let resolveRuntime!: (runtime: AgentHostRuntime) => void, rejectRuntime!: (error: unknown) => void;
  const runtimeReady = new Promise<AgentHostRuntime>((resolve, reject) => { resolveRuntime = resolve; rejectRuntime = reject; });
  runtimeReady.catch(() => undefined);
  let runtime: AgentHostRuntime | undefined;
  let relaunch: () => void = () => undefined;

  let server: BridgeServer;
  try {
    server = await startBridgeServer({
      port: options.port,
      webRoot: deps.webRoot,
      ...(deps.token ? { token: deps.token } : {}),
      agents: () => runtimeReady.then(ready => ready.host),
      updates: {
        status: () => deps.updater.status(),
        check: () => deps.updater.check({ force: true }),
        install: async () => {
          const blocker = installBlocker(deps.updater.status(), runtime?.isBusy() ?? false);
          if (blocker) throw new BridgeRequestError(blocker, 409);
          void deps.updater.install().then(status => {
            if (status.state === 'ready') relaunch();
            else deps.err(status.detail ?? 'The update failed.');
          });
          return deps.updater.status();
        },
      },
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') deps.err(`Port ${options.port} is already in use. Is Extalia already running? Open http://127.0.0.1:${options.port}/ or start with --port <number>.`);
    else deps.err(`Could not start the Bridge: ${message(error)}`);
    return 1;
  }

  deps.createAgentHost({ kind: 'bridge', version: deps.version, dataDirectory: deps.dataDirectory, env: deps.env }).then(
    ready => { runtime = ready; resolveRuntime(ready); },
    error => { deps.err(`Agents are not available: ${message(error)}`); rejectRuntime(error); },
  );

  deps.out(`Extalia ${deps.version} is running at ${server.url}`);
  deps.out('Press Ctrl+C to stop.');
  if (options.open) deps.openBrowser(server.url);
  if (options.updateCheck && deps.updater.status().state !== 'unsupported') {
    void deps.updater.check().then(status => {
      if (status.state === 'available') deps.out(`Extalia ${status.latest} is available. Run: extalia update`);
    }, () => undefined);
  }

  const shutdownTimeout = deps.shutdownTimeoutMs ?? 5000;
  const shutdown = () => withTimeout((async () => {
    await server.close();
    const ready = await runtimeReady.catch(() => undefined);
    await ready?.close();
  })(), shutdownTimeout);

  return new Promise<number>(resolve => {
    let stopping = false;
    const onSignal = () => {
      // A terminal Ctrl+C can arrive twice (directly and forwarded by a supervisor); stop once.
      if (stopping) return;
      stopping = true;
      release();
      deps.out('Stopping Extalia…');
      void shutdown().then(() => resolve(0));
    };
    const release = () => { for (const signal of FORWARDED_SIGNALS) deps.signals.off(signal, onSignal); };
    for (const signal of FORWARDED_SIGNALS) deps.signals.on(signal, onSignal);

    const restart = async () => {
      if (stopping) return;
      stopping = true;
      release();
      deps.out('Update installed. Restarting Extalia…');
      await shutdown();
      const plan = relaunchPlan({ ...deps.relaunch, env: deps.env, token: server.token });
      const child = deps.spawn(plan.command, plan.args, { stdio: 'inherit', env: plan.env });
      resolve(await supervise(child, deps.signals, error => deps.err(`Could not restart Extalia: ${error.message}. Start it again with: extalia`)));
    };
    relaunch = () => {
      // Never cut a running turn short; wait for the agents to finish.
      if (!runtime?.isBusy()) { void restart(); return; }
      deps.out('Update installed. Extalia restarts when the running agents finish.');
      // onIdle fires later, after `off` is assigned.
      const off = runtime.onIdle(() => { off(); void restart(); });
    };
  });
}
