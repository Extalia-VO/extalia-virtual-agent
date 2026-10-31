# ADR 0042: Owned direct-child health probe supervision

Status: Verified locally in v0.4.141 for test-backed library use, 2026-10-30.
Tracking: [V2-16 / #54](https://github.com/Extalia-VO/extalia-virtual-agent/issues/54).
Extends [ADR 0041](0041-probe-only-worker-protocol.md) toward the ownership
requirements of [ADR 0022](0022-python-worker-distribution.md).

## Scope and trust boundary

Add `extalia_daemon::worker_probe` as a Rust library API for one health-only
subprocess. There is no daemon operation, host route, application setting,
scanner adapter or runtime consumer. It does not discover Python, download
anything, read profiles or enable inspection/activation. Trusted composition
code supplies an absolute executable, explicit cwd and bounded arguments;
these are configuration claims, not verified bundle artifacts or executable
grants. Never feed model/workspace-supplied launch specifications to this API.

Configuration validation bounds paths to 4,096 encoded bytes, arguments to
eight and 16 KiB total, rejects NULs and validates exact protocol version/UUID
claims. Handshake/request budgets are one to 300,000 ms; exit/cancel/reap
budgets are one to 5,000 ms. No shell or PATH search is used. `env_clear()`
removes inherited credentials and user/runtime configuration; only the OS
`SystemRoot` value is retained on Windows. These controls do not restrict the
child's filesystem or network access and do not verify executable hashes.

## Ownership and deadlines

Use exact-pinned Tokio 1.54.1 with only process, time, io-util, sync, rt and
macros features. A background owner task retains the direct `Child`, all three
pipe handles, exchange state, monotonic watchdogs and admission permit. Dropping
the client handle or its waiting future requests cancellation rather than
aborting that owner. The caller must keep an I/O/time-enabled runtime alive.
OS process creation itself is synchronous; these async timers do not establish
a hard bound on spawn duration or scheduler starvation.

One process-wide non-queued admission slot covers the owned direct probe.
It is released only after a verified no-spawn path or waiting/reaping the exact
owned child. Kill requests, EOF, health output and dropped handles do not
release it. Unverified reaping, owner panic or runtime teardown permanently
poisons admission; there is no public reset. Runtime teardown has only the
`kill_on_drop` fallback and cannot produce a verified cleanup report.

The owner selects independent deadlines/cancellation against bounded async
reads and offset-tracked writes. Timeout wins at equality; protocol correlation
still uses ADR 0041's exchange. At most one small fixed health request is
encoded. A response cannot be accepted while its request remains unwritten.
Success requires a matching response, clean EOF on both output pipes and
observed exit status zero within the exit grace period. A late response, error,
nonzero exit, stalled process or extra output cannot become `Healthy`.

## Bounded I/O and cleanup

Fixed 4 KiB read buffers feed the existing bounded frame reader. Lifetime output
budgets are 128 KiB stdout and 16 KiB stderr; reads request at most the remaining
budget plus one overflow-detection byte. Raw stderr is counted and discarded,
never logged or returned. Reports retain fixed outcome codes, byte counts,
whether cancellation was fully written/kill requested, and direct exit status.

On failure/cancellation, close output handles so inherited descriptors cannot
keep a local reader waiting. A completed request may receive one best-effort
cancel frame within a fixed grace budget. A partial request is never followed
by another JSON line: close stdin and force cleanup instead. Observe a natural
exit if available, otherwise request termination through the owned `Child` and
wait with a bounded reaping deadline. `start_kill()` success is not exit proof.
Unverified cleanup retains uncertainty and poisons admission.

The concurrency bound and exit evidence apply to the direct child only. This
increment does not contain or kill descendants. Reaped direct-child exit does
not verify descendant settlement, release mission recovery, or authorize skill
activation; `physical_settlement_verified()` remains literally false. Production
untrusted scanner execution still requires process-tree containment and all
applicable OS sandbox/resource/network and artifact gates.

Tokio's documented [child wait/kill semantics](https://docs.rs/tokio/1.54.1/tokio/process/struct.Child.html)
and [select cancellation safety](https://docs.rs/tokio/1.54.1/tokio/macro.select.html)
inform this design: take stdin before waiting and use cancellation-safe `write`
with explicit offsets, rather than cancelling and restarting `write_all`.

## Test and packaging boundary

An explicitly feature-gated Rust fixture binary lives under `tests/support/`.
The Rust gate enables `test-fixtures` for tests/clippy; normal builds do not.
Release tooling explicitly selects `--bin extalia-daemon`, so the fixture is
never staged as an application executable. Tests use owned temporary cwd paths
and require no Python, network, credentials or real profile/configuration.

Nineteen real-subprocess integration tests cover successful exit, environment
isolation, silent startup, request/exit timeout, cancellation before launch and
cooperative/ignored cancellation, handle/future abandonment, fail-fast capacity,
malformed/wrong-version/correlation output, overflow, nonzero exit, late output,
spawn refusal and a direct child exiting while a short-lived descendant holds
its pipes. The controlled descendant exits naturally; no descendant termination
is claimed. Three unit tests cover configuration bounds, permit retirement and
the absence of physical-settlement authority. Fixture hangs have a five-second
safety ceiling in addition to supervisor watchdogs.

Actual OS kill/reap failure and runtime-shutdown child behavior are not certified
by these tests; permit tests exercise uncertainty policy without pretending to
produce such OS evidence. The fixed health request fits a pipe buffer, so tests
do not claim to have forced a real blocked partial stdin write. Per-platform CI
and packaged Python/scanner certification remain separate acceptance gates.
