# ADR 0053: Native process ownership follows resource measurements

Status: Verified locally v0.4.184, 2026-11-08

## Context

The Native harness assembles context, calls a model provider, validates requested
tools, performs local operations and returns results to the model. Model inference
belongs to the selected provider/server. React displays and controls this work.
Changing the host language alone does not remove response buffering, repeated
history copies or an unbounded queue. The v1.1.1 blueprint retains an incremental
Rust control-plane destination and on-demand Python workers.

The first resource audit found a concrete existing allocation: `read_file` loaded
a whole file up to 5 MiB into a Buffer, decoded it and split every line before
returning a small requested page. A newline-dense input therefore created a
file-sized line array even for ten requested lines. A stat/read interval also
allowed growth beyond the declared read ceiling.

## Process allocation

| Responsibility | Current owner | Destination / admission rule |
| --- | --- | --- |
| React UI, Office rendering, themes and interaction | TypeScript in renderer | Retain; never run privileged tools or provider credentials in renderer |
| Canonical mission/task state, leases, recovery review, policy and knowledge index | Rust daemon for routed paths | Rust; one existing authoritative store/sidecar, shared with lazy Knowledge |
| Native turn loop, model adapters and delegation | TypeScript runtime/host | Incrementally move scheduling, provider/tool lifecycle and resource enforcement to Rust behind versioned ports; preserve current behavior until parity and ownership gates pass |
| Workspace file/process tools | TypeScript host and isolated search worker | Bound memory now; migrate to Rust only with workspace/path/permission/cancellation parity, not a new subprocess per small read |
| Search regular expressions | Isolated JavaScript worker with deadline | Preserve supported expression semantics; benchmark traversal/scan before replacing an engine |
| Scanner, embedding, learning/evaluation libraries | Production scanner unavailable; Python health/staging experiments only | Optional verified Python worker, started on demand under Rust supervision and resource limits; no Python requirement for basic chat |
| Third-party agents | Their actual runtime, plus existing adapters/observers | Preserve negotiated control and ownership; observations do not create task-control authority |

Avoid running duplicate authoritative harnesses, mirroring whole histories across
processes, or keeping Python resident solely to relay HTTP. Separate CPU-heavy
jobs from event delivery; keep queues and worker counts bounded. A new language,
process or IPC boundary needs an actual lifetime owner and workload evidence.
This decision grants no new execution or skill activation capability.

## First implementation: bounded file pages

Keep the current host permission/path boundary and replace full-file decoding
with an opened-handle fixed-chunk scanner. Enforce the 5 MiB read ceiling against
actual bytes with one detection byte; preserve line numbering, pagination,
Unicode decoding, binary-file handling and clipped-line counts. Retain bounded
selected output, one line prefix, counters and decoder state instead of every
line. Cancellation and I/O errors close the handle before the tool settles.

This is an actual Chat/Teams/Missions file-tool improvement. It is not a migrated
Rust workspace executor and does not solve the existing independent path-swap
race or guarantee a whole-application RSS ceiling.

## Measurement and migration gates

Freeze the pre-change implementation and compare the same public `read_file`
tool against the candidate in fresh Node subprocesses using synthetic temporary
files. Record output hashes, fixture bytes, sample counts, concurrency, warm-up,
per-operation p50/p95 latency, RSS after module import and before warm-up, plus OS process peak RSS.
Generate fixtures outside the worker. Report heap/external diagnostics separately;
sampled memory is not a peak measurement. Include regressions and peak memory
from the complete worker, not an inferred language saving or whole-app estimate.
The benchmark directory records actual results and reproduction commands.

Follow-up work remains explicit:

1. Bound provider SSE framing, JSON fallback and accumulated answers/tool inputs
   on every provider path; do not truncate edit arguments into executable data.
2. Complete Rust executor/child membership, writer fencing, reconciliation and
   exact effect-time approvals before widening dispatch authority.
3. Move one provider/turn lifecycle through a versioned Rust port, keeping a single
   owner. Verify streaming/tool-call parity, backpressure, cancellation, credential
   redaction, late completion and restart handling with synthetic servers.
4. Compare the complete old/new process sets at equal workloads and concurrency,
   including IPC copies, idle RSS, first-token delivery and tool turnaround.
5. Enable Python workloads only after verified artifacts, supervision, isolation
   and scanner/permission gates pass.

A unit test, pure Rust codec or local benchmark does not certify a production
Rust harness, live-provider behavior, packaged platform support or Python worker.

## Local evidence

The [2026-11-08 benchmark](../benchmarks/native-file-read-2026-11-08.md) preserves all eighteen paired scenarios and output hashes. Process peak RSS falls by 39.7%–77.6% on the measured machine; dense-line p95/observed event-loop delay improve while some huge-line cases regress. These are file-tool worker measurements, not Rust-versus-TypeScript or whole-app comparisons. Independent code and measurement reviews found the opened-handle validation gap, which was fixed and covered before the final run.

Full `pnpm check` passed: 5,883 TypeScript tests, 23 optional tests skipped, 474 Rust tests and all builds. Focused file/read/search lifecycle coverage passed 58 tests. This update does not activate a Rust turn-loop or a production Python worker.
