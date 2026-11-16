# Provider completion benchmark

Build an optimized experimental daemon (not the official release configuration),
then run from the repository root:

```sh
cargo build --release -p extalia-daemon --bin extalia-daemon --features provider-experiments
node tooling/bench/provider-completion.mjs --output docs/architecture/provider-completion-benchmark.json
```

The default compares the persistent native worker. Use `--mode one-shot` to
rerun the separate one-child-per-request control. Use `--json` for
machine-readable stdout, `--binary <release-binary>` for a
specific release artifact, or `--quick` for smoke testing. Quick results are
explicitly labeled and are insufficient for performance claims. Run without
other builds or tests competing for CPU. The harness uses existing esbuild,
Node, `ps` and `/usr/bin/time`; it supports macOS and Linux.

The frozen v0.4.242 production OpenAI adapter is compared with the current
OpenAI adapter explicitly composed with the proposed `RustCompletionWorker`
host port (or
`RustCompletion` in one-shot mode). Both run in fresh
Node processes against the same synthetic loopback HTTP server. All fixtures,
time outputs and synthetic working directories live in an isolated temporary
directory, removed on exit. The server and benchmark driver are excluded from
both measured process trees. No model service, credentials, application
configuration or user profile is accessed.
The benchmark selects the candidate port explicitly; it does not establish
that the production default should select that candidate.
The measured sum covers the entire provider harness process tree, including its
Node parent and native children. It does **not** measure the Electron Desktop,
3D Office, or whole Extalia application RSS; these figures cannot establish an
application-wide percentage reduction.

The recorded results are the v0.4.243 prototype snapshot, taken before final
production selection and feature isolation. TypeScript remains the production
default; native completion experiments are excluded from official release builds.
The recorded binary hash identifies the measured experiment, not the final
release binary. Rebuilding with the explicit feature above enables reproduction;
source/build hashes change after cleanup and must be recorded for each new run.

The isolated-provider cases start without earlier global `fetch` use. A second
control runs small text, history, both dense streams and concurrency after
**both** Node parents fetch an unmeasured loopback health response. This loads
shared HTTP machinery in both parents, representing a host that already used
network features. A memory advantage from avoiding Node's lazy HTTP loading in
the isolated case must not be generalized to the prewarmed host.

Every scenario sends identical system text, image history, prior assistant/tool
history and tool schemas. Cases cover a small Unicode response, 2 MiB history,
512 SSE text frames of 8 KiB each, 8192 small 66-character SSE text fragments,
tool fragments with malformed arguments,
eight simultaneous completions, and cancellation after the first text delta.
Concurrency has both an immediate-response fixture and a fixture that waits
200 ms before sending tokens, representing overlapping provider wait time.
The delayed case must capture at least five RSS samples while all eight requests
and all expected processes are active. Native `pendingCount` must also report
eight admitted operations: two processes alone cannot establish eight active
requests. Persistent mode expects one Node parent plus one worker; one-shot
mode expects one Node parent plus eight children. Its concurrent-sum RSS plateau is
reported separately. The immediate case can still miss brief native peaks.
Prebuilt HTTP body buffers preserve individual SSE events; TCP controls network
chunk boundaries. Cancellation sends one delta and leaves the stream open.
Sorted semantic JSON request hashes exclude only `stream_options` negotiation.
Prior tool arguments deliberately use unsorted keys; their serialized JSON
argument strings remain byte-sensitive inside the semantic request hash.
Canonical result hashes and length-prefixed UTF-8 delta hashes must match;
changed delta boundaries also fail parity. Cancellation requires rejection and
the host port must drain its pending/reserved work on close.

Full runs use two warmups, 20 measured small/tool requests, five measured heavy
requests, and five batches of eight concurrent requests. Per-request latency
includes completion settlement. Persistent mode shares the same child after
warmup; its first cold request includes actual child startup. One-shot mode
includes child startup and exit in every request. Module import and first cold
request are reported separately. Raw samples support the reported p50/p95.
Node CPU and its OS peak RSS come from native process accounting. Event-loop
delay measures the Node parent during measured work.
Parent CPU includes identical result/delta verification work in both
variants; request latency stops before final result hashing.

The primary path uses a pass-through spawn observer with the same binary,
arguments and options as production. It returns the original native child and
reports its PID/lifetime, without a wrapper or altered kill/close behavior.
The driver samples each Node parent and every live native child with targeted
`ps` queries, reports
the actual sampling gaps, and records the largest **concurrent sum** of RSS.
Independent process peaks are never added. Idle, measured and post-close phases
are reported. Short child processes and transient peaks can fall between
samples: sampled child CPU is a quantized lower bound, and sampled RSS is not an
OS peak. Separate successful runs with the same measured request count and no
warmup wrap native children with
`/usr/bin/time` for individual OS peak RSS and CPU diagnostics; its measurements
are excluded from primary latency and tree-memory comparisons. Cancellation
uses the unwrapped process path and has no timed-child diagnostic.
`/usr/bin/time` rounds CPU to 0.01 seconds: zero CPU readings are below the
diagnostic sensitivity and do not establish zero cost. Primary child CPU is
reported as a sampled lower bound, never an exact process-tree CPU total.
Persistent mode also observes 100 ms of resident idle time, then waits past the
default 1000 ms idle TTL and requires actual child close before checking the
post-TTL and explicit-close memory. Both Node parents wait for the same idle
observation windows. Per-run child creation count must be exactly one in
persistent mode; one-shot mode requires one per request. No process crash or
restart is hidden by these assertions.

The evidence includes source/bundle/binary hashes, runtime/compiler versions,
platform and CPU details, request counts, raw latency samples and diagnostic
counts. Results are conditional on those artifacts and this synthetic non-TLS
fixture. They do not establish real-provider latency, whole-application memory,
TLS behavior or unique physical memory (RSS includes shared pages).

The immutable [original one-shot full run](../architecture/provider-completion-oneshot-benchmark.json)
uses release source version 0.4.243, Node 26.12.1 and macOS ARM64 on Apple M3 Max.
All 14 cases pass semantic request, result and delta parity, including exact
serialized prior tool argument order. Each implementation completes 255
measured requests plus two warmups per case. Shared-fetch control medians are:

| Case | Measured requests | TypeScript total p50 (ms) | Rust total p50 (ms) |
| --- | ---: | ---: | ---: |
| Small text | 20 | 0.45 | 5.87 |
| 2 MiB history | 5 | 5.66 | 17.66 |
| 512 large SSE frames | 5 | 10.20 | 21.79 |
| 8192 small SSE frames | 5 | 10.96 | 26.02 |
| Eight concurrent, immediate | 40 | 1.85 | 9.31 |
| Eight concurrent, 200 ms provider wait | 40 | 202.74 | 207.58 |

The one-shot native path has worse median latency in every case. During the
shared-fetch delayed concurrency case, 20 samples positively observe the Node
parent plus all eight native children: median concurrent RSS is 142,864 KiB,
against 93,008 KiB for the TypeScript parent with eight active requests.
The corresponding sampled peaks are 147,360 and 94,048 KiB. The immediate
concurrency native run captures no samples with all nine processes active;
its lower sampled RSS does not demonstrate a memory saving. Native PID queries
have actual sampling gaps around 50 ms at p95 on this machine despite the 5 ms
target, so even targeted sampling does not establish true peaks.

Small-frame streaming reduces the shared-fetch Node event-loop maximum delay
from 19.32 to 1.94 ms, but measured parent CPU increases from 93.87 to 131.29 ms
for those five requests, before adding native child CPU. The saved per-request
latencies, parent CPU, individual child diagnostics and idle/post-close memory
show the remaining tradeoffs. These one-shot results motivated evaluation of a
bounded persistent worker. The [latest candidate evidence](../architecture/provider-completion-benchmark.json)
is a decision gate against the frozen TypeScript adapter, with no assumption
that Rust must be selected when the resource or latency comparison is worse.

The latest persistent run also passes all 14 parity, cancellation and lifecycle
cases, with 255 measured requests per implementation. Each native scenario
creates exactly one worker, and every worker exits after the default idle TTL.
Its shared-fetch results are:

| Case | Measured requests | TypeScript total p50 (ms) | Persistent Rust total p50 (ms) | TypeScript sampled peak RSS (KiB) | Persistent Rust sampled peak RSS (KiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small text | 20 | 0.53 | 2.08 | 91,792 | 83,984 |
| 2 MiB history | 5 | 5.12 | 12.34 | 127,888 | 133,552 |
| 512 large SSE frames | 5 | 10.65 | 14.24 | 167,872 | 201,440 |
| 8192 small SSE frames | 5 | 11.54 | 44.82 | 140,160 | 104,048 |
| Eight concurrent, immediate | 40 | 1.48 | 2.05 | 93,296 | 89,584 |
| Eight concurrent, 200 ms provider wait | 40 | 202.59 | 203.25 | 93,024 | 89,840 |

Persistent mode removes repeated process startup but still has worse median
latency in every measured case. The delayed concurrency control positively
captures eight native pending requests and two processes in 22 samples: median
concurrent RSS is 85,312 KiB against 91,856 KiB for TypeScript, a saving of about
6.4 MiB in this provider harness. Large history and large-frame SSE instead use
more sampled memory with the candidate. Fast scenarios have sparse or missing
fully-active samples; their sampled peaks are not true OS peaks.

For the small-frame burst, maximum Node event-loop delay improves from 19.60 to
2.27 ms, but parent CPU increases from 95.92 to 226.09 ms. The separate matched
five-request diagnostic records another 350 ms of native CPU; it is not an
exact total for the primary run. Small-request native CPU remains below the
diagnostic's 10 ms precision. The idle/post-TTL samples demonstrate worker
retirement rather than permanent background retention.

These results support retaining TypeScript as the production default. The
candidate has a narrow responsiveness and memory tradeoff, but it does not
establish an overall efficiency improvement and regresses representative
history and large-output workloads. No application-wide performance claim
follows from either comparison.

## Python comparison

Run the development-only Python candidate without building a Rust executable:

```sh
node tooling/bench/provider-completion.mjs --mode python --python apps/desktop/build-resources/skillspector/mac-arm64/payload/python/bin/python3.13 --output docs/architecture/provider-completion-python-benchmark.json
```

That interpreter path is the existing macOS ARM64 development bundle. On other
machines, pass an available compatible interpreter explicitly; the report binds
its actual version, implementation, executable hash and flags. The primary run
uses bundled CPython 3.13.18, rather than silently substituting the separately
installed system Python 3.15.2. No dependency installation is required.

The candidate is a persistent standard-library `asyncio` HTTP/1.1 client with a
bounded reusable socket pool. The same TypeScript framed transport controls the
Python child; its historical class name does not mean Rust performs the HTTP.
The Python command uses `-I -B -u` to isolate user configuration, avoid bytecode
writes and keep IPC unbuffered. Production application imports and defaults are
unchanged; the script stays under repository benchmark tooling.

All 14 fixtures, warmup/sample counts, shared-HTTP control, request/result/delta
hashes, eight active requests, process counts, idle retirement and cancellation
checks remain the same. Each measured process tree includes the Node parent and
the actual Python interpreter. HTTP socket counts record reuse; startup/import
costs and CPU diagnostics remain separate from warmed request distributions.
SSE parsing searches buffers by offset and text accumulates in lists, avoiding
unnecessary repeated copying in the measured implementation.

The [Python evidence](../architecture/provider-completion-python-benchmark.json)
describes this specific standard-library implementation and interpreter. It does
not measure every Python HTTP library, Python model inference or AI response
quality. No production TLS, HTTP/2, compression or proxy interoperability is
certified. A known prototype limitation is that shutdown may await a blocked
stdout consumer indefinitely; the controlling host must terminate the child in
that case. The benchmark host continuously drains stdout, so the measured
fixtures do not exercise that unsupported shutdown condition.

The final optimized Python run uses Node 26.12.1 and bundled CPython 3.13.18.
All 14 cases pass semantic request, result and exact delta parity: 255 measured
requests plus 28 warmups per implementation. Each Python scenario uses one
persistent interpreter and ends with no admitted/reserved work or live child.
The shared-fetch control gives:

| Case | TypeScript total p50 (ms) | Python total p50 (ms) | TypeScript sampled peak tree RSS (KiB) | Python sampled peak tree RSS (KiB) |
| --- | ---: | ---: | ---: | ---: |
| Small response | 0.47 | 0.77 | 91,840 | 103,792 |
| 2 MiB history | 5.50 | 20.13 | 127,536 | 158,608 |
| 512 large SSE frames | 10.28 | 68.06 | 178,384 | 253,296 |
| 8192 small SSE frames | 14.46 | 236.71 | 140,192 | 124,336 |
| Eight immediate requests | 1.25 | 3.09 | 93,648 | 108,928 |
| Eight delayed requests | 204.18 | 204.70 | 93,280 | 109,312 |

The delayed concurrency control captures 22 samples with all eight Python
operations active and both processes present. Median concurrent RSS is
104,960 KiB versus 92,192 KiB for TypeScript; p95 is 109,280 versus 93,152 KiB.
Serial Python cases use one model HTTP connection, and delayed concurrency uses
eight, so repeated connections are not the reason for the latency regression.
The sum of measured Node-parent CPU across the 14 cases is 1,350.65 ms for the
Python pipeline versus 676.29 ms for the TypeScript pipeline, before counting
the interpreter. Interpreter CPU is measured in separate matched diagnostics;
those windows are not an exact additive total for the primary run.

Small-frame streaming reduces maximum parent event-loop delay from 20.50 to
2.07 ms and uses less sampled tree memory, but the much higher completion latency
and CPU do not establish an overall improvement. Most other cases also use more
sampled memory. These results support retaining the TypeScript production
default. They apply to this stdlib worker, IPC path and interpreter; they are
not a verdict on Python ML libraries, other HTTP clients, newer interpreters or
model output quality. The two buffer-copy optimizations are included in the
recorded final script hash; the earlier unoptimized run is not the public result.

Verification for v0.4.244: 18 focused Python functional tests pass on the bundled
interpreter. The separate full serial `pnpm check` passes 7,854 TypeScript tests
(26 optional skips), 536 Rust tests, lint, typechecks, schemas, builds and
version/asset checks. A parallel Rust bundle-probe fixture timestamp collision
was corrected with atomic temporary-directory allocation before the final gate.
