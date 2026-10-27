# Native core benchmark, 2026-10-22

TypeScript mission journal (`missions.sqlite` in the host process) against the Rust core
daemon (`extalia-daemon`, stdio sidecar) for audit PR 10, the benchmark gate of
[ADR 0021](../adr/0021-rust-integration-strategy.md) (decision 6) and gap-map decision 8.
Method and metric definitions: [README](README.md). Raw output of this run:
[native-core-2026-10-22.json](native-core-2026-10-22.json).
Follow-up with per-mission running totals (journal depth, gate 10): [native-core-2026-10-22-totals.md](native-core-2026-10-22-totals.md).

Command: `node tooling/bench/native-core.mjs --out docs/benchmarks/native-core-2026-10-22.json`
(full mode, default counts). The table below is the script's own Markdown output for that run.

## Environment

| | |
| --- | --- |
| Hardware | Apple M3 Max, 14 cores (10 performance + 4 efficiency), 36 GiB RAM, on battery power |
| OS | macOS 26.6.1 (Darwin 25.6.0), arm64 |
| Node | v26.12.0 |
| Rust | rustc 1.99.1 (`rust-toolchain.toml`) |
| Revision | git `5c67478`, dirty working tree (see caveats) |
| Daemon | `aarch64-apple-darwin` release, symbols stripped, 2,582,592 bytes, sha256 `3a8751ce71d4b838a68a3ec8e551e7288b219cbea76eff1d301d86aca84ecb39`, `daemonVersion` 0.4.70 |

## Results

Measured 2026-10-22T14:28:56.348Z · Apple M3 Max (14 logical cores, 10 performance + 4 efficiency), 36 GiB RAM, battery power · macOS 26.6.1 (Darwin 25.6.0) · Node v26.12.0 · rustc 1.99.1 (58cf8f9c3 2026-10-13) · git 5c67478 (dirty) · daemon target/aarch64-apple-darwin/release/extalia-daemon (2582592 bytes, sha256 3a8751ce71d4…, daemonVersion 0.4.70)
Mode full: 2000 commits per series after 200 warm-up commits, at most 250 activity events per mission. Commit latency = issue → acknowledgement, including the wait behind other missions' commits. Ratio = Rust / TypeScript (below 1× means the daemon is lower).

| Metric | TypeScript core | Rust daemon | Ratio |
| --- | ---: | ---: | ---: |
| Event commit p50, 1 mission concurrent | 0.317 ms | 0.131 ms | 0.41× |
| Event commit p95, 1 mission concurrent | 0.535 ms | 0.185 ms | 0.35× |
| Event commit p99, 1 mission concurrent | 0.815 ms | 0.291 ms | 0.36× |
| Event commit throughput, 1 mission (commits/s) | 2892.4 | 7054.1 | 2.44× |
| Event commit p50, 3 missions concurrent | 1.12 ms | 0.376 ms | 0.34× |
| Event commit p95, 3 missions concurrent | 1.758 ms | 0.635 ms | 0.36× |
| Event commit p99, 3 missions concurrent | 2.414 ms | 1.136 ms | 0.47× |
| Host thread blocked per commit p50, 3 missions | 0.355 ms | n/a (async request) | — |
| Host thread blocked per commit p95, 3 missions | 0.522 ms | n/a (async request) | — |
| Event commit throughput, 3 missions (commits/s) | 2482.9 | 7356.3 | 2.96× |
| Event commit p50, 8 missions concurrent | 3.264 ms | 1.009 ms | 0.31× |
| Event commit p95, 8 missions concurrent | 4.529 ms | 1.401 ms | 0.31× |
| Event commit p99, 8 missions concurrent | 5.205 ms | 2.202 ms | 0.42× |
| Host thread blocked per commit p50, 8 missions | 0.371 ms | n/a (async request) | — |
| Host thread blocked per commit p95, 8 missions | 0.572 ms | n/a (async request) | — |
| Event commit throughput, 8 missions (commits/s) | 2363.6 | 7722.8 | 3.27× |
| Mission create (4 tasks) p50 | 0.192 ms | 0.28 ms | 1.46× |
| Mission create (4 tasks) p95 | 0.293 ms | 0.388 ms | 1.32× |
| Mission create (4 tasks) p99 | 0.642 ms | 1.189 ms | 1.85× |
| Burst of 1000 commits, median (commits/s) | 2297.5 | 6415.7 | 2.79× |
| Cold start, empty data folder p50 | 3.935 ms | 9.032 ms | 2.3× |
| Cold start, empty data folder p95 | 4.899 ms | 9.594 ms | 1.96× |
| Cold start, 16 missions × 500 events p50 | 319.255 ms | 29.271 ms | 0.09× |
| Cold start, 16 missions × 500 events p95 | 330.936 ms | 29.761 ms | 0.09× |
| Restart recovery, 1 in-flight task p50 | 16.562 ms | 8.602 ms | 0.52× |
| Restart recovery, 1 in-flight task p95 | 18.086 ms | 9.448 ms | 0.52× |
| Restart recovery, 16 in-flight tasks p50 | 17.772 ms | 8.079 ms | 0.45× |
| Restart recovery, 16 in-flight tasks p95 | 20.278 ms | 9.129 ms | 0.45× |
| Restart recovery, 64 in-flight tasks p50 | 49.228 ms | 11.042 ms | 0.22× |
| Restart recovery, 64 in-flight tasks p95 | 51.26 ms | 11.534 ms | 0.23× |
| Daemon idle RSS | — | 5.3 MiB | — |
| Daemon RSS after 4000 commits | — | 7.5 MiB | — |
| Daemon CPU time while idle (3 s window, 10 ms resolution) | — | 0 ms | — |
| Host Node RSS Δ after open | 1.8 MiB | 1.7 MiB | — |
| Host Node RSS Δ after 4000 commits | 21.1 MiB | 16.6 MiB | — |
| Host Node heapUsed Δ after 4000 commits | 0.51 MiB | 0.71 MiB | — |
| Binary size (stripped release) | — (built into Node) | 2.46 MiB | — |

| Journal depth (events in the mission) | TypeScript p50 / p95 | Rust p50 / p95 |
| --- | ---: | ---: |
| 0–1000 | 0.385 / 0.625 ms | 0.184 / 0.255 ms |
| 1000–2000 | 0.503 / 0.802 ms | 0.272 / 0.327 ms |
| 2000–3000 | 0.945 / 1.411 ms | 0.652 / 1.239 ms |
| 3000–4000 | 1.132 / 1.62 ms | 0.911 / 1.446 ms |
| 4000–5000 | 1.534 / 2.179 ms | 1.08 / 1.311 ms |
| 5000–6000 | 1.942 / 3 ms | 1.303 / 1.544 ms |
| 6000–7000 | 2.289 / 3.448 ms | 1.622 / 2.6 ms |
| 7000–8000 | 2.327 / 3.517 ms | 1.831 / 2.769 ms |


### Repeatability

A second full run directly afterwards with the same binary (not published as JSON) gave, for
example: single-mission commit p50 0.331 ms (TypeScript) / 0.125 ms (Rust); 8-mission commit p95
3.725 / 1.171 ms; burst median 2,625 / 6,531 commits/s; cold start on an empty folder p50
4.0 / 10.5 ms; restart with 64 in-flight tasks p50 45.9 / 11.2 ms; daemon idle RSS 5.4 MiB. One
outlier: cold start on the populated folder p95 was 75.4 ms for the daemon (p50 30.8 ms). Every
ratio in the table kept its side of 1× in both runs.

## Reading the results

- **Event commits.** The daemon acknowledges a single mission's commit in about 0.13 ms p50 against
  0.32 ms for the in-process TypeScript store, and sustains about 7,000–8,300 commits/s against
  about 2,300–2,900. With 3 or 8 concurrent missions both backends queue (the daemon serves one
  request at a time; the TypeScript store holds the host thread), and the daemon's
  issue-to-acknowledgement latency stays about a third of TypeScript's. The TypeScript store
  additionally blocks the host's event loop for about 0.35 ms per commit (UI, Bridge and
  provider streams wait meanwhile); the daemon client does not.
- **Mission creation** is the one operation where the daemon is slower (about 0.25–0.28 ms
  against 0.18–0.19 ms p50, p99 about 1.1 ms against 0.5–0.6 ms); it happens once per mission.
- **Cold start.** On an empty data folder the daemon needs 9–11 ms p50 (process spawn, lock, schema
  creation, `hello`) against 4 ms for opening the TypeScript store inside an already running
  host. With 16 missions × 500 events the TypeScript store needs about 320 ms, because `open`
  verifies every stored event; the daemon needs about 30 ms.
- **Restart recovery** after a crash is about 2–4.5× faster with the daemon, and the gap grows with
  in-flight work (64 tasks: 11 ms against 46–49 ms).
- **Memory.** The daemon idles at about 5.3 MiB RSS with no measurable CPU time over 3 s and
  holds about 7.5 MiB after 4,000 commits. Host-side RSS after 4,000 commits grows by about
  21 MiB with the TypeScript store (SQLite page cache in the host process) and about 17 MiB
  with the daemon client; JavaScript heap growth is below 1 MiB for both.
- **Journal depth.** Both backends slow down linearly as one mission's journal grows: from about
  0.18 ms (Rust) and 0.39 ms (TypeScript) p50 below 1,000 events to 1.8 ms and 2.3 ms at
  7,000–8,000 events (the cap is 8,192). Both stores scan the mission's whole journal on every
  commit (Rust `append`: `count(*)`, `max(sequence)` and `sum(length(payload))` over the
  mission's events; TypeScript `writeSession`: `count/min/max` per mission and `sum(encoded_bytes)`
  per session).

## Proposed thresholds for default-on (proposal, not a decision)

> **Proposal only.** The owner sets the thresholds and reference hardware (ADR 0021, gap-map
> decision 8, audit open question 6); the default-on decision is a later ADR. The values below
> are derived from this first measured baseline and leave headroom for slower machines. Status
> is this run's result against each proposal.

| # | Proposed gate (daemon, full mode, reference hardware on AC power) | This run | Status |
| --- | --- | --- | --- |
| 1 | Event commit p95, 1 mission: ≤ TypeScript p95 of the same run and ≤ 1 ms | 0.185 ms (TS 0.535 ms) | pass |
| 2 | Event commit p99, 8 concurrent missions: ≤ TypeScript p99 of the same run and ≤ 5 ms | 2.202 ms (TS 5.205 ms) | pass |
| 3 | Burst throughput (median): ≥ 1.5× TypeScript of the same run | 6,416/s (2.8×) | pass |
| 4 | Mission create p95: ≤ 1 ms (absolute; it may be slower than TypeScript) | 0.388 ms | pass |
| 5 | Cold start p95, empty data folder: ≤ 50 ms | 9.6 ms | pass |
| 6 | Cold start p95, 16 missions × 500 events: ≤ TypeScript p95 of the same run | 29.8 ms (TS 330.9 ms) | pass |
| 7 | Restart recovery p95, 64 in-flight tasks: ≤ TypeScript p95 of the same run and ≤ 100 ms | 11.5 ms (TS 51.3 ms) | pass |
| 8 | Daemon idle RSS ≤ 16 MiB; RSS after 4,000 commits ≤ 32 MiB; idle CPU time over 3 s ≤ 10 ms | 5.3 MiB; 7.5 MiB; 0 ms | pass |
| 9 | Stripped release binary ≤ 8 MiB on every release target | 2.46 MiB (this target only) | pass here; other targets not measured |
| 10 | Optional, for the owner to decide: event commit p95 at 7,000–8,000 journal events ≤ 1 ms (needs per-mission running totals instead of whole-journal scans) | 2.769 ms | fail |

Proposed reference hardware: this machine class (Apple silicon laptop) on AC power **and** one
x64 Windows machine before default-on, because process spawn and pipe costs differ most there and
the script cannot read the daemon's RSS on Windows yet. Proposed procedure: rerun the full mode on
the release candidate's exact build, publish the output here, and require every gate on both
machines.

## Caveats

- **Battery power.** Both runs ran on battery; AC power may change absolute values. The ratios
  kept their direction across two runs.
- **Dirty tree.** The working tree differs from `5c67478` (many modified files; `crates/` is not
  committed yet), and other work in `crates/extalia-core` was in progress while this ran. The
  binary's sha256 above identifies exactly what was measured; the git revision alone does not.
- **Measured layers.** TypeScript commits are measured at `MissionCheckpointStore.writeSession`;
  the host's `MissionRecords.commitEvent` adds event validation and a `readSession` decode around
  it, and the Rust route adds `missions.updateMemory`. Neither wrapper is in these numbers.
- **One mission per session** in the TypeScript runs. A session holding several runs makes each
  TypeScript commit sum more event bytes (per-session scan); not measured here.
- **Mission start with the flag on** still writes the first TypeScript checkpoint
  (`missions.save`) in addition to `mission.create`; the create row compares each core's own
  operation only.
- **Cold start** for TypeScript excludes Node's own start (the host is already running); for the
  daemon it includes the process spawn.
- **Restart recovery** measures recovery only, not the host's restart; the TypeScript value is
  taken in a fresh process (cold JIT), the daemon value in a fresh daemon process.
- **macOS arm64 only.** No Windows, Linux or x64 numbers. Daemon RSS and CPU readings use `ps`
  and are unavailable on Windows.
- **Quick mode** (`--quick`) finished in 5–8 s here, including an up-to-date cargo build. Its
  counts are small and its timings vary run to run, so it is fit as a "runs and every scenario
  succeeds" smoke check, not as a gate.
