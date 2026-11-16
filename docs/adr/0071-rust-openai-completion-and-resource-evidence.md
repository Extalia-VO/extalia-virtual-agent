# ADR 0071: Completion placement follows measured efficiency

Status: Efficiency-first placement accepted; TypeScript production default
retained after measurement and combined validation in v0.4.243 (2026-11-10).

## Choice of implementation

Rust candidates implement deterministic request conversion, provider HTTP,
streaming parsers, tool-call assembly and usage normalization for
OpenAI-compatible completions. Production selection must demonstrate a
worthwhile measured benefit; TypeScript remains a valid backend choice.
Python remains appropriate for verified scanner/ML libraries that provide a
specific capability or demonstrably better processing. Adding a Python HTTP
relay does not improve a remote model's reasoning or output by itself.

The provider and model still perform inference. Compare identical model input
and results before attributing a difference to the backend implementation.
Choose resource changes from measurements of the complete participating process
tree, not an isolated Rust executable or an assumed language advantage.

The latest product decision explicitly supersedes ADR 0069's mandatory language
destination: do not replace a faster TypeScript implementation when the new path
has no worthwhile memory or responsiveness benefit. The ownership audit remains
an inventory guard. Its strict zero-backend-JavaScript mode is an optional
diagnostic, not an acceptance requirement or a reason to disable useful code.

## Production selection

Retain TypeScript for production OpenAI-compatible completion processing. Neither
native placement establishes an overall efficiency improvement across the
measured workload. Preserve existing Rust model discovery, knowledge, registry,
notes and learning artifact ownership and the supervised Python scanner; their
capabilities and workload decisions are independent of this comparison.

The native completion candidates remain development experiments behind Cargo's
`provider-experiments` feature. Official release builds do not enable it, expose
the candidate modes or import their TypeScript clients in production composition.
Development checks enable the feature to exercise actual native processes.

The production TypeScript adapter also receives the filtered/truncated tool
safety corrections below. It is not replaced by a test fixture or a silent
fallback after an uncertain native request. Explicit injected ports support
controlled experiments; the ordinary factory stays on the TypeScript path.

## Experimental ownership

The development executable gains exclusive `--provider-complete`, before any
profile/store initialization. `extalia.provider-complete.v1` carries one neutral
model request through stdin, terminated by EOF. Credentials are never command
arguments, environment variables, diagnostics or durable receipts.

Rust constructs the HTTP request and handles JSON responses and SSE streams,
including UTF-8 boundaries, CRLF, multiline/final events, indexed tool fragments,
usage updates, invalid arguments and the narrow pre-response `stream_options`
HTTP-400 compatibility retry. Unknown or malformed tool arguments never become
executable clipped data. Original JSON ordering in tool schemas and argument
strings must survive transport so migration does not silently change prompt
content or prompt-cache opportunities.

The native candidate can serve factory-created OpenAI-compatible calls through
an explicit port: connection-test inference, planning, Chat, Teams, Missions and
automatic learning. Candidate tests never implicitly select a JavaScript fallback
after transport uncertainty. The frozen benchmark fixture remains independent
of production selection. Anthropic processing and turn/history, delegation,
permission and host-storage lifecycles remain at their current owners.

The experimental TypeScript facade carries the neutral request, IPC validation,
stream projection and connection negotiation receipt. Its processing and memory
must count in the comparison; moving HTTP alone is not a whole-host migration.

## One-shot bounds and settlement

Admission allows at most 32 live children and 256 MiB of aggregate encoded input,
with no waiting queue or implicit retry. Synchronous snapshots retain string
references while copying JSON containers; later caller mutation cannot change
an admitted request. Encoding writes bounded chunks under stdin backpressure,
without one whole-request JavaScript serialization.

The input ceiling is 128 MiB, preserving the existing eight-million UTF-16
character preflight and supported image uploads. Rust parses the typed request
under that ceiling. Model/tool policy and selected connection permissions remain
the host's existing gates; request data cannot grant workspace capabilities.

Response processing bounds provider wire bytes, pending SSE events, text, tool
count and accumulated tool arguments independently. Frames use a four-byte
little-endian length, a versioned UUID/sequence envelope and at most 32 MiB per
frame. Delta text is at most 16 KiB. Tool input also has depth/value ceilings;
exceeding a bound fails the operation rather than truncating executable data.

Success requires one validated terminal frame and a successful, positively
observed child close. Cancellation, timeout, pipe/protocol failure and overflow
request termination but retain admission and ownership until actual close.
A spawn failure with no process is separately settled. Shutdown aborts and
drains admitted completions before releasing profile ownership.

Transport uncertainty is never retryable. Only explicitly classified provider
HTTP/quota failures can participate in the existing model fallback policy.
Closing a local process does not establish that the remote model stopped
processing; this port does not grant mission recovery closure authority.

## Compatibility and safety corrections

- Configured local HTTP routers and verified HTTPS endpoints are supported.
  Explicit bounded headers and bearer/header precedence are preserved.
- Redirects, implicit retries and environment proxies are disabled. TLS checking
  stays enabled. Node-specific custom-CA/proxy behavior is not silently emulated;
  configure the final endpoint. Cross-platform TLS packaging needs its own tests.
- A completion has a bounded total deadline, at most ten minutes in this port,
  plus a host startup watchdog. It cannot wait forever for a broken stream.
- Provider error bodies are used only for bounded compatibility/classification
  decisions. User-visible failures use safe codes/status rather than echoing
  possible credentials or prompt content.
- A `length` finish invalidates returned tool calls and stops as `max_tokens`.
  A `content_filter` finish clears calls and stops as `refusal`. These explicitly
  correct the previous adapter's tool-call precedence; filtered or truncated
  results must not execute tools even if an argument prefix happens to parse.

## Why one-shot first

The profile daemon's current IPC failure path can reject before its child has
actually exited. Sharing it immediately with provider execution would entangle
mission/control ownership with provider cancellation. A separate one-shot child
reuses the independently verified positive-close pattern from ADR 0070.

This choice has real costs: startup/TLS setup per request, no reusable HTTP pool,
and memory from concurrent children. It has no idle provider-worker residency.
The Rust parser/HTTP implementation should remain reusable by a future isolated
worker pool once per-request settlement and cancellation isolation are proven.
If measurements show an efficiency regression, record it and optimize placement;
do not call the language change a whole-application resource improvement.

The measured one-shot eight-way delayed workload increased median concurrent
RSS from 93,008 to 142,864 KiB, so it was rejected. A second candidate uses one
lazy `--provider-worker` process, bounded chunked intake and independent request
owner threads. Each request owns its async HTTP client and current-thread Tokio
runtime. The runtime is dropped and its owner positively joined before terminal
and settlement frames. Cancellation is isolated; IPC failure retains affected
operations until actual process close. Idle workers retire after one second;
bounded retirement waiters enter a replacement only after observed old close.
This candidate is also not selected for production after measurement.

## Measurement and validation

The [benchmark guide](../bench/provider-completion.md) describes a frozen
v0.4.242 JavaScript baseline and the actual Rust host transport. Synthetic
loopback fixtures compare request/result hashes, token streaming, large history,
tool arguments, image transport, eight-way concurrency and cancellation.

Record warmup/sample counts, first-token/total p50 and p95, parent event-loop
delay, CPU, OS per-process peaks and the sampled concurrent sum of parent and
worker RSS. Independent process peaks are not additive. The server is outside
both measured process trees. Successful-only diagnostic wrappers are separate
from primary latency/cancellation tests; sampling and timer resolution limits
must remain explicit. Loopback fixtures do not certify production TLS latency.

Both native designs passed 14 cases with 255 measured requests per implementation,
including request/result/delta parity, cancellation, actual process counts and
eight-way overlap. The final shared-worker run after shared HTTP prewarming gave:

| Workload | TypeScript p50 ms | Native p50 ms | Sampled concurrent RSS KiB (TS → native) |
| --- | ---: | ---: | ---: |
| Small response | 0.53 | 2.08 | See full evidence |
| 2 MiB history | 5.12 | 12.34 | 127,888 → 133,552 |
| Large SSE frames | 10.65 | 14.24 | 167,872 → 201,440 |
| Small SSE frames | 11.54 | 44.82 | 140,160 → 104,048 |
| Eight delayed requests | 202.59 | 203.25 | 91,856 → 85,312 (overlap plateau) |

Small-frame event-loop maximum delay improved from 19.60 to 2.27 ms, but parent
CPU increased from 95.92 to 226.09 ms; a separate matched-request child diagnostic
used another 350 ms. These are different measurement windows and not an exact
aggregate CPU sum. The narrow responsiveness/memory benefits do not outweigh
the history/large-response and latency regressions for a default switch.

The [shared-worker evidence](../architecture/provider-completion-benchmark.json)
and [one-shot evidence](../architecture/provider-completion-oneshot-benchmark.json)
are immutable measurement snapshots taken before final production cleanup and
feature isolation. Their binary/source hashes identify the measured prototypes,
not the official release executable. See the guide for feature-enabled rebuilds
and sampling/TLS/whole-application limits. No general output-quality improvement,
whole-application RSS saving or cross-platform installer certification is claimed.

## Combined verification

Full serial `pnpm check` passes: 7,850 TypeScript tests (26 optional skips),
536 Rust tests, lint, ownership baseline, public-safety/schema checks, typechecks,
formatting, Clippy with warnings denied, application builds, version consistency
and asset validation. Development Rust builds enable the optional candidate so
its actual HTTP/cancellation tests run rather than being silently skipped.

The [production selection record](../architecture/provider-completion-selection.json)
checks that the CLI build graph excludes both native completion clients and that
the default release binary contains neither experimental mode/schema. Default
release discovery still passes actual loopback HTTP tests. The official daemon
build script does not enable `provider-experiments`; the feature is explicit
for development reproduction only. These checks do not certify a newly packaged
cross-platform Desktop installer.

## Python follow-up

The [CPython 3.13.18 comparison](../architecture/provider-completion-python-benchmark.json)
uses the same fixtures and a bounded reusable HTTP socket pool. All 14 parity
cases pass, but history and both streaming cases are slower and most measured
memory cases regress. The TypeScript default remains selected. The benchmark
guide records full numbers, concurrency observations, interpreter provenance,
implementation limits and CPU accounting. This development-only standard-library
prototype does not evaluate Python ML inference or every Python HTTP library.
The follow-up v0.4.244 full gate passes 7,854 TypeScript tests and 536 Rust tests,
with 18 Python functional tests verified separately and all builds/checks green.
