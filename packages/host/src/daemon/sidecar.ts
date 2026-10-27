/**
 * The Rust core daemon as a sidecar child of the host that holds the profile lock
 * (ADR 0020): started lazily by the first daemon-routed mission, restarted on demand
 * after a failure with a bounded exponential backoff, and stopped with the host.
 *
 * A failure never falls back to the TypeScript core: requests reject with
 * `DaemonUnavailableError` and callers deny or latch (ADR 0014, ADR 0026). Failures
 * that a restart cannot fix (another daemon holds the store lock, a wrong binary or
 * arguments, too many failed starts) stay final until the host restarts.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import { DaemonClient, DaemonUnavailableError, type DaemonFailureCode, type DaemonProcess } from './client.js';

export type DaemonState = 'off' | 'starting' | 'ready' | 'unavailable';
export interface DaemonStatus { state: DaemonState; lastError?: DaemonFailureCode }
export type SpawnDaemon = (binary: string, args: string[], options: { cwd: string; env: Record<string, string> }) => DaemonProcess;

export interface DaemonSidecarOptions {
  /** Absolute binary path, resolved when a start is needed (`resolveDaemonBinary`). */
  binary(): string | undefined;
  /** The host's data directory: `--data-dir`, so the daemon owns `<dir>/state/core.sqlite`. */
  dataDirectory: string;
  /** `--profile` (ADR 0024). */
  profile: string;
  /**
   * `--vault-root` (ADR 0024 decision 5): a user-chosen vault folder the host has validated, asked
   * at every start; `undefined` keeps the default `<data>/vaults/<profile>`.
   */
  vaultRoot?(): string | undefined | Promise<string | undefined>;
  clientVersion: string;
  /** Environment the allow-list is taken from; provider credentials never pass. */
  env?: Readonly<Record<string, string | undefined>>;
  spawn?: SpawnDaemon;
  log?(line: string): void;
  now?(): number;
  handshakeDeadlineMs?: number;
  shutdownGraceMs?: number;
  /** Consecutive failed starts or crashes before giving up (default 5). */
  maxFailures?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

/** Failures a new process cannot fix. */
const FINAL: readonly DaemonFailureCode[] = ['binary_missing', 'invalid_arguments', 'locked', 'schema_mismatch', 'missing_capability', 'restart_limit'];
/** Variables the daemon may see (ADR 0020: a minimal allow-listed environment). */
const ENV_ALLOW = ['SystemRoot', 'windir', 'TMPDIR', 'TEMP', 'TMP'];

const spawnChild: SpawnDaemon = (binary, args, options) => spawn(binary, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

export class DaemonSidecar {
  private client: DaemonClient | undefined;
  private starting: Promise<DaemonClient> | undefined;
  private state: DaemonState = 'off';
  private lastError: DaemonFailureCode | undefined;
  private failures = 0;
  private retryAt = 0;
  private stopped = false;

  constructor(private readonly options: DaemonSidecarOptions) {}

  status(): DaemonStatus {
    return { state: this.state, ...(this.lastError ? { lastError: this.lastError } : {}) };
  }

  /**
   * The ready connection, starting the daemon if needed. During a backoff, after a final
   * failure and after `stop()` this rejects at once instead of waiting.
   */
  connect(): Promise<DaemonClient> {
    if (this.stopped) return Promise.reject(new DaemonUnavailableError('shutting_down'));
    if (this.client?.usable) return Promise.resolve(this.client);
    if (this.starting) return this.starting;
    if (this.lastError && (FINAL.includes(this.lastError) || this.now() < this.retryAt)) return Promise.reject(new DaemonUnavailableError(this.lastError));
    this.state = 'starting';
    const starting = this.start().finally(() => { if (this.starting === starting) this.starting = undefined; });
    this.starting = starting;
    return starting;
  }

  private async start(): Promise<DaemonClient> {
    const binary = this.options.binary();
    if (!binary) throw this.failed('binary_missing');
    const env: Record<string, string> = {};
    for (const name of ENV_ALLOW) { const value = this.options.env?.[name]; if (value) env[name] = value; }
    let vaultRoot: string | undefined;
    try { vaultRoot = await this.options.vaultRoot?.(); } catch { vaultRoot = undefined; }
    if (this.stopped) throw new DaemonUnavailableError('shutting_down');
    const args = ['--data-dir', this.options.dataDirectory, '--profile', this.options.profile, ...(vaultRoot ? ['--vault-root', vaultRoot] : [])];
    let child: DaemonProcess;
    try {
      child = (this.options.spawn ?? spawnChild)(binary, args, { cwd: this.options.dataDirectory, env });
    } catch { throw this.failed('spawn_failed'); }
    const client: DaemonClient = new DaemonClient(child, {
      clientVersion: this.options.clientVersion,
      redact: text => redact(text, this.options.dataDirectory),
      ...(this.options.log ? { log: this.options.log } : {}),
      onEnd: failure => { if (failure && this.client === client) { this.client = undefined; this.failed(failure); } },
    });
    try {
      await client.handshake(this.options.handshakeDeadlineMs);
    } catch (error) {
      await client.close(0).catch(() => undefined);
      throw this.failed(error instanceof DaemonUnavailableError ? error.code : 'handshake_failed');
    }
    if (this.stopped) { await client.close(this.options.shutdownGraceMs); throw new DaemonUnavailableError('shutting_down'); }
    this.client = client;
    this.state = 'ready'; this.lastError = undefined; this.failures = 0;
    return client;
  }

  /** Record a failure, schedule the next allowed start and return the error to throw. */
  private failed(code: DaemonFailureCode): DaemonUnavailableError {
    if (this.stopped) return new DaemonUnavailableError('shutting_down');
    this.failures++;
    const limit = this.options.maxFailures ?? 5;
    const final = FINAL.includes(code) || this.failures >= limit;
    this.state = 'unavailable';
    this.lastError = !FINAL.includes(code) && this.failures >= limit ? 'restart_limit' : code;
    const base = this.options.backoffBaseMs ?? 250, max = this.options.backoffMaxMs ?? 30_000;
    this.retryAt = final ? Number.POSITIVE_INFINITY : this.now() + Math.min(max, base * 2 ** (this.failures - 1));
    if (code === 'locked') this.options.log?.('extalia-daemon: another process holds the native core store of this data folder; not retrying');
    return new DaemonUnavailableError(code);
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  /**
   * Stop the running daemon (if any) so the next `connect()` starts a new one with fresh arguments,
   * for example another `--vault-root`. Clears earlier failures: this is a deliberate user action.
   * Requests in flight on the old process reject; the caller makes sure nothing depends on it.
   */
  async restart(): Promise<void> {
    if (this.stopped) throw new DaemonUnavailableError('shutting_down');
    const starting = this.starting;
    if (starting) await starting.catch(() => undefined);
    const client = this.client;
    this.client = undefined;
    if (client) await client.close(this.options.shutdownGraceMs);
    if (this.stopped) return;
    this.state = 'off'; this.lastError = undefined; this.failures = 0; this.retryAt = 0;
  }

  /** Close stdin, wait for the daemon to exit, then kill it. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    const starting = this.starting;
    if (starting) await starting.catch(() => undefined);
    const client = this.client;
    this.client = undefined;
    if (client) await client.close(this.options.shutdownGraceMs);
    if (this.state !== 'unavailable') this.state = 'off';
  }
}

/** Hide the profile and home folders in daemon diagnostics. */
function redact(text: string, dataDirectory: string): string {
  let result = text.split(dataDirectory).join('<data>');
  const home = os.homedir();
  if (home.length > 1) result = result.split(home).join('~');
  return result;
}
