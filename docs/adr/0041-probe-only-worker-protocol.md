# ADR 0041: Probe-only worker protocol foundation

Status: Verified locally in v0.4.140 for protocol testing, 2026-10-30.
Tracking: [V2-16 / #54](https://github.com/Extalia-VO/extalia-virtual-agent/issues/54).
Refines [ADR 0022](0022-python-worker-distribution.md); scanner gates in
[ADR 0023](0023-skill-scanner-adapter-pinning.md) remain closed.

## Scope and wire contract

Add an independent snake_case NDJSON worker contract in `@extalia/protocol`,
a generated `python-worker-frame.schema.json`, and Rust codec/exchange modules.
Existing length-prefixed daemon frames, negotiated capabilities and runtime
dispatch do not change. No application surface or production process consumer
is connected to these modules.

Schema version 1 admits exactly five frame kinds: `hello`, `request`, `cancel`,
`response`, `error`. The only operation is `health`, with an empty payload and
an exact singleton operations list in hello. Results contain `status: "ok"`
and a worker-version claim. Errors contain a fixed allow-listed code only;
no worker-controlled free text, paths, commands, credentials, scanner results,
permissions or readiness claims exist. Unknown fields are rejected at every
level. Raw wire JSON additionally refuses duplicate members (including escaped
key aliases), more than two container levels, and non-ASCII/overlong string
tokens before object validation; overwritten invalid values cannot disappear.
Versions are one to 128 ASCII characters; request identities are exact
lowercase versioned UUIDs. Integer JSON values are semantic numbers: `1.0` and
`1e0` denote the same schema version as `1`; booleans are rejected.

Both codecs accept LF and CRLF, with a 65,536-byte frame limit including its
terminator. They consume chunks incrementally into a bounded line buffer rather
than concatenating untrusted chunks. Each push returns at most 64 frames and
fails atomically: a bad later frame suppresses every frame from that push.
Malformed UTF-8/JSON, BOMs, blank frames, invalid fields, oversized frames,
oversized batches and incomplete EOF tails close the reader permanently.
Errors expose coarse fixed codes only. A clean EOF also closes the reader.

The batch bound depends on caller chunk boundaries, not a global throughput or
stream-lifetime limit. Parsing an already materialized JSON value is a separate
API; the wire byte bound applies at the reader. Arbitrary executable JavaScript
objects, getters and proxies are outside this JSON-data contract.

## Pure Rust exchange lifecycle

`AwaitingHello → Ready → Pending → Ready` accepts only a matching version hello,
then one request at a time and a correlated matching-version health response.
The caller supplies a monotonic millisecond clock and relative deadlines of one
to 300,000 milliseconds. Every transition checks time first; deadline equality,
clock regression and addition overflow fail closed. There is no autonomous
watchdog or process supervision in this pure state machine.

All issued IDs remain reserved for the stream lifetime, including successful
requests. Reuse is refused, and the 65th request retires the exchange rather
than evicting history. Unsolicited frames, wrong directions, duplicate hello,
correlation/version mismatch, worker error, framing failure, EOF, cancellation
and timeout permanently retire admission. Late data cannot restore it.

Cancellation returns an outbound intent and retires immediately. Neither this
intent, a worker `cancelled` error, a health response nor EOF proves that a
process stopped. `physical_settlement_verified()` always returns false. No
reset, grant, drain receipt or recovery-release API is added. A future process
owner must independently enforce deadlines, bound stderr/output, stop and reap
the exact owned child, and retain evidence tied to that process identity.

## Test-only Python reference

`tooling/worker-protocol/reference_worker.py` is a stdlib-only one-probe fixture:
emit hello, accept one health request, emit response, exit. It rejects malformed,
oversized, scanner and command requests with a fixed exit status and no raw
stderr. It is not a scanner, long-lived worker or implementation of cancellation.

An optional interoperability test launches an explicitly selected developer
interpreter with `-I -S -B`, a temporary working directory, an allow-listed
environment without provider credentials, a timeout and output bound. Ordinary
`pnpm check` skips this fixture unless `EXTALIA_TEST_PYTHON` is supplied. For an
explicit local developer run:

```sh
EXTALIA_TEST_PYTHON=python3 pnpm exec vitest run tooling/test/workerReference.test.ts
```

This test is evidence about that interpreter and fixture only. The product does
not discover or require system Python. ADR 0022 still requires a pinned,
relocatable bundled runtime for actual features. No `workers/intelligence/`
package, dependency installation or real user-profile access is introduced.

## Verification and remaining gates

Shared structured fixtures compare TypeScript, generated schema and Rust
verdicts. Byte-level tests cover chunk splits, semantic numeric forms, exact
LF/CRLF byte limits, malformed encoding, escaped lone surrogates, atomic failure,
batch limits and terminal EOF. Rust exchange tests cover every retirement class,
deadline boundaries, clock anomalies, lifetime identity history and absence of
physical-settlement proof. The optional Python subprocess tests decode actual
stdout through the TypeScript reader.

Production launcher ownership, version/hash-bound artifact checks, embedded
CPython builds, sandbox/resource/network enforcement, scanner report schemas,
attestation binding, activation, and per-platform certification remain open.
No health result can satisfy those gates or alter `UnavailableInspector`.
