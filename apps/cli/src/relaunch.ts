import { constants } from 'node:os';

/**
 * Restart after an in-app update. The updated Bridge starts as a child with the
 * same bin path and arguments; this process stays as a thin supervisor so the
 * terminal keeps one foreground process and its exit code.
 */

/** Carries the Bridge token to the restarted child so open browser tabs can reconnect with it. */
export const RELAUNCH_TOKEN_ENV = 'EXTALIA_BRIDGE_RELAUNCH_TOKEN';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export interface RelaunchInput {
  execPath: string;
  execArgv: readonly string[];
  binPath: string;
  /** Arguments after the bin path, as this process received them. */
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  token: string;
}

export interface RelaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

export function relaunchPlan(input: RelaunchInput): RelaunchPlan {
  // The browser tab is already open and reconnects by itself.
  const args = input.args.includes('--no-open') ? [...input.args] : [...input.args, '--no-open'];
  return { command: input.execPath, args: [...input.execArgv, input.binPath, ...args], env: { ...input.env, [RELAUNCH_TOKEN_ENV]: input.token } };
}

/** Read and remove the inherited token so agents and their commands never see it. */
export function takeRelaunchToken(env: Record<string, string | undefined>): string | undefined {
  const value = env[RELAUNCH_TOKEN_ENV];
  delete env[RELAUNCH_TOKEN_ENV];
  return value && TOKEN_PATTERN.test(value) ? value : undefined;
}

/** Shell convention: a child killed by a signal exits with 128 + the signal number. */
export function exitCodeFor(code: number | null, signal: string | null): number {
  if (typeof code === 'number') return code;
  const number = signal ? (constants.signals as Record<string, number | undefined>)[signal] : undefined;
  return number ? 128 + number : 1;
}

export const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export interface SupervisedChild {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: string, listener: (...args: never[]) => void): unknown;
}

export interface SignalSource {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
}

/** Forward SIGINT/SIGTERM to the child and resolve with its exit code. */
export function supervise(child: SupervisedChild, signals: SignalSource, onError?: (error: Error) => void): Promise<number> {
  return new Promise(resolve => {
    const forwards = FORWARDED_SIGNALS.map(signal => [signal, () => { child.kill(signal); }] as const);
    for (const [signal, listener] of forwards) signals.on(signal, listener);
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      for (const [signal, listener] of forwards) signals.off(signal, listener);
      resolve(code);
    };
    child.once('exit', (code: number | null, signal: string | null) => done(exitCodeFor(code, signal)));
    child.once('error', (error: Error) => { onError?.(error); done(1); });
  });
}
