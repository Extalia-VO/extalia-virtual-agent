/**
 * One stdio connection to the Rust core daemon (ADR 0020): length-prefixed frames from
 * `@extalia/protocol`, the `hello` handshake, request correlation and per-request
 * deadlines. Any failure of the connection itself (exit, timeout, malformed or
 * uncorrelated reply, schema mismatch) is final: the child is killed and every pending
 * and later request rejects with `DaemonUnavailableError`. The sidecar decides whether
 * to start a new process. Error frames that answer one request reject only that request.
 */
import {
  DAEMON_MAX_DEADLINE_MS, DAEMON_MAX_FRAME_BYTES, DAEMON_SCHEMA_VERSION, SKILL_REASON_PATTERN, createDaemonFrameReader, encodeDaemonFrame,
  type DaemonErrorCode, type DaemonFrame, type DaemonOp, type DaemonOperations, type DaemonRequest,
} from '@extalia/protocol';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

/** The child process surface the client needs; `node:child_process` children satisfy it. */
export interface DaemonProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * Why the daemon is unavailable. Stable codes for status and logs; never raw errors.
 * Exit statuses of `extalia-daemon`: 1 `protocol_error`, 2 `invalid_arguments`,
 * 3 `store_unavailable`, 4 `locked` (another daemon holds the store lock).
 */
export type DaemonFailureCode =
  | 'binary_missing' | 'spawn_failed' | 'invalid_arguments' | 'store_unavailable' | 'locked' | 'handshake_failed' | 'schema_mismatch'
  | 'missing_capability' | 'timeout' | 'malformed_reply' | 'protocol_error' | 'crashed' | 'restart_limit' | 'shutting_down';

/** The daemon cannot answer: callers must fail closed (deny, latch), never fall back. */
export class DaemonUnavailableError extends Error {
  override readonly name = 'DaemonUnavailableError';
  constructor(readonly code: DaemonFailureCode) { super(`The native core is unavailable (${code}).`); }
}
/** The daemon answered this request with an error frame; the connection stays usable. */
export class DaemonRequestError extends Error {
  override readonly name = 'DaemonRequestError';
  /** `reason`: the error frame's stable refusal code (skill operations), when it sent a valid one. */
  constructor(readonly code: DaemonErrorCode, readonly reason?: string) { super(`The native core refused the request (${code}).`); }
}

/** Operations the host needs; `hello` must advertise all of them. */
export const REQUIRED_DAEMON_OPS = ['mission.create', 'task.transition', 'event.commit', 'permission.check'] as const satisfies readonly DaemonOp[];
/** Frozen original v1 vocabulary: older daemons strictly validate hello names.
 * Discover optional operations from the server reply, rather than sending new names
 * before knowing the peer understands them. Do not grow this compatibility baseline.
 */
export const DAEMON_HELLO_BASELINE = Object.freeze(['hello', 'mission.create', 'task.transition', 'event.commit', 'permission.check', 'health'] as const satisfies readonly DaemonOp[]);
export const DEFAULT_DAEMON_DEADLINE_MS = 5_000;
const MAX_STDERR_LINE = 300;
const MAX_STDERR_PENDING = 4_096;
const MAX_LOGGED_LINES = 100;

export interface DaemonClientOptions {
  clientVersion: string;
  /** Receives bounded, redacted stderr lines and lifecycle notes. Diagnostics only. */
  log?(line: string): void;
  /** Applied to every stderr line before logging (for example to hide profile paths). */
  redact?(text: string): string;
  /** Called once when the connection ends; `failure` is absent after `close()`. */
  onEnd?(failure: DaemonFailureCode | undefined): void;
}

type Result<O extends DaemonOp> = DaemonOperations[O]['result'];
interface Pending { op: DaemonOp; resolve(result: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** Exit status of `extalia-daemon` (see `crates/extalia-daemon/src/main.rs`) as a failure code. */
export function exitFailure(code: number | null): DaemonFailureCode {
  return code === 2 ? 'invalid_arguments' : code === 3 ? 'store_unavailable' : code === 4 ? 'locked' : code === 1 ? 'protocol_error' : 'crashed';
}

export class DaemonClient {
  private readonly pending = new Map<string, Pending>();
  private readonly reader = createDaemonFrameReader(DAEMON_MAX_FRAME_BYTES);
  private maxFrameBytes = DAEMON_MAX_FRAME_BYTES;
  private handshaken = false;
  private advertised: readonly DaemonOp[] = [];
  private closing = false;
  private ended = false;
  private exited = false;
  private failureCode: DaemonFailureCode | undefined;
  private logged = 0;
  private stderrLine = '';
  private readonly exit: Promise<void>;

  constructor(private readonly child: DaemonProcess, private readonly options: DaemonClientOptions) {
    let markExited!: () => void;
    this.exit = new Promise(resolve => { markExited = resolve; });
    child.stdout.on('data', (chunk: Uint8Array) => this.receive(chunk));
    child.stderr.on('data', (chunk: Uint8Array) => this.stderr(chunk));
    // A dead child makes writes fail with EPIPE; its exit status is the reason that counts.
    child.stdin.on('error', () => undefined);
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    child.once('error', () => { this.exited = true; markExited(); this.fail('spawn_failed'); });
    child.once('close', code => {
      this.exited = true; markExited();
      this.flushStderr();
      if (!this.ended) this.fail(this.closing ? 'shutting_down' : exitFailure(code));
    });
  }

  /** Why the connection ended, unless it was closed on purpose. */
  get failure(): DaemonFailureCode | undefined { return this.failureCode; }
  get usable(): boolean { return this.handshaken && !this.ended; }
  /** Operations the daemon advertised in `hello`; send optional ones (skills) only when listed. */
  get capabilities(): readonly DaemonOp[] { return this.advertised; }

  /** Send `hello`, check the advertised operations and adopt the daemon's frame limit. */
  async handshake(deadlineMs = DEFAULT_DAEMON_DEADLINE_MS): Promise<Result<'hello'>> {
    const hello = await this.send('hello', { clientVersion: this.options.clientVersion, capabilities: [...DAEMON_HELLO_BASELINE] }, deadlineMs).catch((error: unknown) => {
      if (error instanceof DaemonRequestError) this.fail(error.code === 'unsupported_schema_version' ? 'schema_mismatch' : 'handshake_failed');
      throw this.ended ? new DaemonUnavailableError(this.failureCode ?? 'handshake_failed') : error;
    });
    if (!REQUIRED_DAEMON_OPS.every(op => hello.capabilities.includes(op))) {
      this.fail('missing_capability');
      throw new DaemonUnavailableError('missing_capability');
    }
    this.maxFrameBytes = Math.min(DAEMON_MAX_FRAME_BYTES, hello.maxFrameBytes);
    this.advertised = Object.freeze([...hello.capabilities]);
    this.handshaken = true;
    return hello;
  }

  /** One request after the handshake. Its deadline is enforced here and sent to the daemon. */
  request<O extends Exclude<DaemonOp, 'hello'>>(op: O, params: DaemonOperations[O]['params'], deadlineMs = DEFAULT_DAEMON_DEADLINE_MS): Promise<Result<O>> {
    if (!this.ended && !this.handshaken) return Promise.reject(new DaemonUnavailableError('handshake_failed'));
    return this.send(op, params, deadlineMs);
  }

  private send<O extends DaemonOp>(op: O, params: DaemonOperations[O]['params'], deadlineMs: number): Promise<Result<O>> {
    if (this.ended) return Promise.reject(new DaemonUnavailableError(this.failureCode ?? 'shutting_down'));
    const deadline = Math.max(1, Math.min(Math.floor(deadlineMs), DAEMON_MAX_DEADLINE_MS));
    const requestId = randomUUID();
    let bytes: Uint8Array;
    try {
      bytes = encodeDaemonFrame({ schemaVersion: DAEMON_SCHEMA_VERSION, kind: 'request', requestId, op, deadlineMs: deadline, params } as DaemonRequest, this.maxFrameBytes);
    } catch {
      // Our own request failed validation; nothing was sent and the connection is intact.
      return Promise.reject(new DaemonRequestError('invalid_request'));
    }
    return new Promise<Result<O>>((resolve, reject) => {
      // A slow daemon is an unavailable daemon: everything queued behind it would stall too.
      const timer = setTimeout(() => { this.fail('timeout'); }, deadline);
      this.pending.set(requestId, { op, resolve: resolve as (result: unknown) => void, reject, timer });
      this.child.stdin.write(bytes);
    });
  }

  private receive(chunk: Uint8Array): void {
    if (this.ended) return;
    for (const read of this.reader.push(chunk)) {
      if (this.ended) return;
      if (!read.ok) { this.fail(read.code === 'unsupported_schema_version' ? 'schema_mismatch' : 'malformed_reply'); return; }
      this.dispatch(read.frame);
    }
  }

  private dispatch(frame: DaemonFrame): void {
    if (frame.kind === 'request') { this.fail('malformed_reply'); return; }
    const pending = frame.requestId === undefined ? undefined : this.pending.get(frame.requestId);
    if (frame.kind === 'error') {
      // Uncorrelated errors and connection-ending codes mean the daemon gave up on this connection.
      if (!pending || frame.error.code === 'frame_too_large' || frame.error.code === 'handshake_required' || frame.error.code === 'invalid_frame') {
        this.fail(frame.error.code === 'unsupported_schema_version' ? 'schema_mismatch' : 'protocol_error');
        return;
      }
      if (frame.error.code === 'unsupported_schema_version' && pending.op !== 'hello') { this.fail('schema_mismatch'); return; }
      this.settle(frame.requestId!, pending);
      const reason = frame.error.reason;
      pending.reject(new DaemonRequestError(frame.error.code, typeof reason === 'string' && SKILL_REASON_PATTERN.test(reason) ? reason : undefined));
      return;
    }
    if (!pending || pending.op !== frame.op) { this.fail('malformed_reply'); return; }
    this.settle(frame.requestId, pending);
    pending.resolve(frame.result);
  }

  private settle(requestId: string, pending: Pending): void {
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
  }

  /** End the connection with `code`, reject everything pending and stop the child. */
  private fail(code: DaemonFailureCode): void {
    if (this.ended) return;
    this.ended = true;
    this.failureCode = code;
    this.rejectAll(code);
    if (!this.exited) this.child.kill('SIGKILL');
    if (code !== 'shutting_down') this.note(`extalia-daemon unavailable (${code})`);
    this.options.onEnd?.(code);
  }

  private rejectAll(code: DaemonFailureCode): void {
    for (const [requestId, pending] of [...this.pending]) {
      this.settle(requestId, pending);
      pending.reject(new DaemonUnavailableError(code));
    }
  }

  /**
   * Graceful shutdown: pending requests are rejected, stdin is closed (the daemon exits
   * on EOF), and the child is killed if it has not exited within `graceMs`.
   */
  async close(graceMs = 2_000): Promise<void> {
    if (!this.ended) {
      this.closing = true;
      this.ended = true;
      this.rejectAll('shutting_down');
      this.options.onEnd?.(undefined);
      this.child.stdin.end();
    }
    if (this.exited) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([this.exit.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), graceMs); })]);
    clearTimeout(timer);
    if (waited) return;
    this.child.kill('SIGKILL');
    await Promise.race([this.exit, new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); })]);
    clearTimeout(timer);
  }

  private stderr(chunk: Uint8Array): void {
    const text = this.stderrLine + Buffer.from(chunk).toString('utf8');
    const lines = text.split(/\r?\n/);
    this.stderrLine = lines.pop()!.slice(-MAX_STDERR_PENDING);
    for (const line of lines) this.note(line);
  }

  private flushStderr(): void {
    if (this.stderrLine) this.note(this.stderrLine);
    this.stderrLine = '';
  }

  /** Bounded and redacted: the daemon promises sanitized stderr, but logs never trust it. */
  private note(raw: string): void {
    const line = (this.options.redact?.(raw) ?? raw).replace(/\p{Cc}/gu, ' ').trim().slice(0, MAX_STDERR_LINE);
    if (!line || !this.options.log || this.logged > MAX_LOGGED_LINES) return;
    this.logged++;
    this.options.log(this.logged > MAX_LOGGED_LINES ? 'extalia-daemon: further output suppressed' : line);
  }
}
