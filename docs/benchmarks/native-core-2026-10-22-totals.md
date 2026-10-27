# Native core benchmark, 2026-10-22: running journal totals

Re-measurement of [native-core-2026-10-22.md](native-core-2026-10-22.md) (the baseline, "before")
after both mission stores keep running per-mission totals instead of scanning the journal on
every commit. Method and metric definitions: [README](README.md). Raw output of this run:
[native-core-2026-10-22-totals.json](native-core-2026-10-22-totals.json).

Command: `node tooling/bench/native-core.mjs --out docs/benchmarks/native-core-2026-10-22-totals.json`
(full mode, default counts). The table below is the script's own Markdown output for that run.

## What changed

- **Rust core** (`core.sqlite`, schema 3, migration `0003_mission_totals.sql`): table
  `mission_totals` (event count, last sequence, payload bytes per mission), backfilled from
  existing journals and kept equal to the journal by triggers on `missions` and `events` in
  the same transaction. `append` reads one row by primary key for the gap check, the
  sequence and the count and byte caps, instead of `count(*)`, `max(sequence)` and
  `sum(length(payload))` over the mission's events.
- **TypeScript core** (`missions.sqlite`, schema 3): tables `checkpoint_session_totals` (change
  count and encoded event bytes per session) and `mission_event_totals` (event count and last
  sequence per mission), backfilled when migrating from schema 1 or 2 and kept equal by
  triggers. `writeSession` reads them for the change, event and byte caps and the sequence,
  instead of `count(*)` over the session's changes, `count/min/max` over the mission's events
  and `sum(encoded_bytes)` over the session's events. Opening the store verifies every totals
  row against the recomputed aggregates.

## Environment

| | |
| --- | --- |
| Hardware | Apple M3 Max, 14 cores (10 performance + 4 efficiency), 36 GiB RAM, on battery power |
| OS | macOS 26.6.1 (Darwin 25.6.0), arm64 |
| Node | v26.12.0 |
| Rust | rustc 1.99.1 (`rust-toolchain.toml`) |
| Revision | git `5c67478`, dirty working tree (see caveats) |
| Daemon | `aarch64-apple-darwin` release, symbols stripped, 2,582,544 bytes, sha256 `a0ee2c99fe002e6b5e59196e5cde90f0c57b6ee9537229d659fa940943cde046`, `daemonVersion` 0.4.71 |
| Load | Other processes were active during both runs (load average about 9) |

## Results

Measured 2026-10-22T15:11:57.919Z · Apple M3 Max (14 logical cores, 10 performance + 4 efficiency), 36 GiB RAM, battery power · macOS 26.6.1 (Darwin 25.6.0) · Node v26.12.0 · rustc 1.99.1 (58cf8f9c3 2026-10-13) · git 5c67478 (dirty) · daemon target/aarch64-apple-darwin/release/extalia-daemon (2582544 bytes, sha256 a0ee2c99fe00…, daemonVersion 0.4.71)
Mode full: 2000 commits per series after 200 warm-up commits, at most 250 activity events per mission. Commit latency = issue → acknowledgement, including the wait behind other missions' commits. Ratio = Rust / TypeScript (below 1× means the daemon is lower).

| Metric | TypeScript core | Rust daemon | Ratio |
| --- | ---: | ---: | ---: |
| Event commit p50, 1 mission concurrent | 0.427 ms | 0.131 ms | 0.31× |
| Event commit p95, 1 mission concurrent | 0.839 ms | 0.192 ms | 0.23× |
| Event commit p99, 1 mission concurrent | 1.514 ms | 0.291 ms | 0.19× |
| Event commit throughput, 1 mission (commits/s) | 1911.5 | 5784.9 | 3.03× |
| Event commit p50, 3 missions concurrent | 1.308 ms | 0.31 ms | 0.24× |
| Event commit p95, 3 missions concurrent | 2.275 ms | 0.409 ms | 0.18× |
| Event commit p99, 3 missions concurrent | 3.936 ms | 1.229 ms | 0.31× |
| Host thread blocked per commit p50, 3 missions | 0.402 ms | n/a (async request) | — |
| Host thread blocked per commit p95, 3 missions | 0.613 ms | n/a (async request) | — |
| Event commit throughput, 3 missions (commits/s) | 2064.3 | 7865.3 | 3.81× |
| Event commit p50, 8 missions concurrent | 3.255 ms | 0.894 ms | 0.27× |
| Event commit p95, 8 missions concurrent | 4.527 ms | 3.508 ms | 0.77× |
| Event commit p99, 8 missions concurrent | 5.156 ms | 168.931 ms | 32.76× |
| Host thread blocked per commit p50, 8 missions | 0.372 ms | n/a (async request) | — |
| Host thread blocked per commit p95, 8 missions | 0.498 ms | n/a (async request) | — |
| Event commit throughput, 8 missions (commits/s) | 2359.7 | 2061.9 | 0.87× |
| Mission create (4 tasks) p50 | 0.256 ms | 0.295 ms | 1.15× |
| Mission create (4 tasks) p95 | 0.434 ms | 0.397 ms | 0.91× |
| Mission create (4 tasks) p99 | 1.515 ms | 1.318 ms | 0.87× |
| Burst of 1000 commits, median (commits/s) | 2462.5 | 9328.3 | 3.79× |
| Cold start, empty data folder p50 | 5.076 ms | 11.412 ms | 2.25× |
| Cold start, empty data folder p95 | 5.715 ms | 12.319 ms | 2.16× |
| Cold start, 16 missions × 500 events p50 | 346.4 ms | 36.186 ms | 0.1× |
| Cold start, 16 missions × 500 events p95 | 350.277 ms | 37.479 ms | 0.11× |
| Restart recovery, 1 in-flight task p50 | 19.379 ms | 9.996 ms | 0.52× |
| Restart recovery, 1 in-flight task p95 | 20.852 ms | 11.701 ms | 0.56× |
| Restart recovery, 16 in-flight tasks p50 | 19.637 ms | 10.777 ms | 0.55× |
| Restart recovery, 16 in-flight tasks p95 | 21.377 ms | 12.016 ms | 0.56× |
| Restart recovery, 64 in-flight tasks p50 | 51.894 ms | 13.843 ms | 0.27× |
| Restart recovery, 64 in-flight tasks p95 | 53.873 ms | 14.767 ms | 0.27× |
| Daemon idle RSS | — | 4.9 MiB | — |
| Daemon RSS after 4000 commits | — | 7.4 MiB | — |
| Daemon CPU time while idle (3 s window, 10 ms resolution) | — | 0 ms | — |
| Host Node RSS Δ after open | 1.8 MiB | 1.8 MiB | — |
| Host Node RSS Δ after 4000 commits | 21.8 MiB | 16.9 MiB | — |
| Host Node heapUsed Δ after 4000 commits | 0.52 MiB | 0.72 MiB | — |
| Binary size (stripped release) | — (built into Node) | 2.46 MiB | — |

| Journal depth (events in the mission) | TypeScript p50 / p95 | Rust p50 / p95 |
| --- | ---: | ---: |
| 0–1000 | 0.367 / 0.704 ms | 0.131 / 0.245 ms |
| 1000–2000 | 0.356 / 0.692 ms | 0.123 / 0.195 ms |
| 2000–3000 | 0.353 / 0.677 ms | 0.118 / 0.146 ms |
| 3000–4000 | 0.353 / 0.697 ms | 0.117 / 0.144 ms |
| 4000–5000 | 0.361 / 0.735 ms | 0.119 / 0.213 ms |
| 5000–6000 | 0.352 / 0.694 ms | 0.124 / 0.157 ms |
| 6000–7000 | 0.355 / 0.693 ms | 0.124 / 0.155 ms |
| 7000–8000 | 0.398 / 0.635 ms | 0.125 / 0.154 ms |


## Before and after: commit latency against journal depth

One mission, 8,000 activity commits, buckets of 1,000. "Before" is the baseline file, "after"
this run; the second "after" column is a second full run directly afterwards with the same
binary (not published as JSON).

| Journal depth | TypeScript p50 / p95, before | TypeScript p50 / p95, after | after, run 2 | Rust p50 / p95, before | Rust p50 / p95, after | after, run 2 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0–1000 | 0.385 / 0.625 ms | 0.367 / 0.704 ms | 0.4 / 0.793 ms | 0.184 / 0.255 ms | 0.131 / 0.245 ms | 0.131 / 0.252 ms |
| 1000–2000 | 0.503 / 0.802 ms | 0.356 / 0.692 ms | 0.38 / 0.731 ms | 0.272 / 0.327 ms | 0.123 / 0.195 ms | 0.118 / 0.15 ms |
| 2000–3000 | 0.945 / 1.411 ms | 0.353 / 0.677 ms | 0.39 / 0.787 ms | 0.652 / 1.239 ms | 0.118 / 0.146 ms | 0.117 / 0.147 ms |
| 3000–4000 | 1.132 / 1.62 ms | 0.353 / 0.697 ms | 0.384 / 0.774 ms | 0.911 / 1.446 ms | 0.117 / 0.144 ms | 0.121 / 0.154 ms |
| 4000–5000 | 1.534 / 2.179 ms | 0.361 / 0.735 ms | 0.386 / 0.775 ms | 1.08 / 1.311 ms | 0.119 / 0.213 ms | 0.118 / 0.15 ms |
| 5000–6000 | 1.942 / 3 ms | 0.352 / 0.694 ms | 0.376 / 0.763 ms | 1.303 / 1.544 ms | 0.124 / 0.157 ms | 0.118 / 0.15 ms |
| 6000–7000 | 2.289 / 3.448 ms | 0.355 / 0.693 ms | 0.362 / 0.64 ms | 1.622 / 2.6 ms | 0.124 / 0.155 ms | 0.119 / 0.157 ms |
| 7000–8000 | 2.327 / 3.517 ms | 0.398 / 0.635 ms | 0.355 / 0.515 ms | 1.831 / 2.769 ms | 0.125 / 0.154 ms | 0.12 / 0.152 ms |

- **Depth no longer matters.** Before, p50 at 7,000–8,000 events was 6.0× (TypeScript) and
  10.0× (Rust) the value below 1,000 events. After, it is 1.08× and 0.95× in this run (0.89×
  and 0.92× in run 2): within run-to-run noise, flat across the whole range up to the cap.
- **At depth 7,000–8,000** p50 fell from 2.327 to 0.398 ms (TypeScript) and from 1.831 to
  0.125 ms (Rust); p95 from 3.517 to 0.635 ms and from 2.769 to 0.154 ms.
- **Shallow journals** are no slower than before (0–1,000 bucket: TypeScript p50 0.385 → 0.367 ms,
  Rust 0.184 → 0.131 ms): the triggers that maintain the totals do not show against the
  commit itself.

## Proposed thresholds, this run

Same proposals as the baseline (proposal only; the owner decides, ADR 0021, gap-map decision 8).

| # | Proposed gate (daemon) | This run | Run 2 | Status |
| --- | --- | --- | --- | --- |
| 1 | Event commit p95, 1 mission: ≤ TypeScript p95 and ≤ 1 ms | 0.192 ms (TS 0.839 ms) | 0.181 ms (TS 0.777 ms) | pass |
| 2 | Event commit p99, 8 concurrent missions: ≤ TypeScript p99 and ≤ 5 ms | 168.931 ms (TS 5.156 ms) | 3.025 ms (TS 9.558 ms) | fail in this run, pass in run 2 (see caveats) |
| 3 | Burst throughput (median): ≥ 1.5× TypeScript | 9,328/s (3.79×) | 9,268/s (4.24×) | pass |
| 4 | Mission create p95: ≤ 1 ms | 0.397 ms | 0.447 ms | pass |
| 5 | Cold start p95, empty data folder: ≤ 50 ms | 12.3 ms | 13.3 ms | pass |
| 6 | Cold start p95, 16 missions × 500 events: ≤ TypeScript p95 | 37.5 ms (TS 350.3 ms) | 39.3 ms (TS 347.2 ms) | pass |
| 7 | Restart recovery p95, 64 in-flight tasks: ≤ TypeScript p95 and ≤ 100 ms | 14.8 ms (TS 53.9 ms) | 14.7 ms (TS 63.4 ms) | pass |
| 8 | Daemon idle RSS ≤ 16 MiB; RSS after 4,000 commits ≤ 32 MiB; idle CPU over 3 s ≤ 10 ms | 4.9 MiB; 7.4 MiB; 0 ms | 5 MiB; 7.4 MiB; 0 ms | pass |
| 9 | Stripped release binary ≤ 8 MiB on every release target | 2.46 MiB (this target only) | 2.46 MiB | pass here; other targets not measured |
| 10 | Optional: event commit p95 at 7,000–8,000 journal events ≤ 1 ms | 0.154 ms | 0.152 ms | pass (baseline: 2.769 ms, fail) |

## Caveats

- **Busy machine, battery power.** Both runs ran on battery while other processes kept the load
  average at about 9 (the baseline does not record its load). Metrics that do not depend on
  journal depth moved in both directions against the baseline (for example Rust burst
  6,416 → 9,328 commits/s, TypeScript single-mission throughput 2,892 → 1,912 commits/s,
  restart recovery with one task 16.6 → 19.4 ms and 8.6 → 10.0 ms); this file does not
  attribute those differences to the change. The depth comparison is internal to each run
  (same process, same mission, consecutive buckets), so it does not depend on the load.
- **One stall.** In this run the daemon's 8-mission series had a p99 of 168.9 ms and 2,062
  commits/s; run 2 measured 3.0 ms and 4,317 commits/s, and the 1- and 3-mission series of both
  runs show no such tail. A single stalled request (for example an fsync under load) explains a
  p99 outlier of this kind; the gate needs a rerun on AC power on an idle machine.
- **Dirty tree.** The working tree differs from `5c67478`, and other work (skill registry, daemon
  contract, host worktrees) was in progress while this ran. The binary's sha256 identifies
  exactly what was measured. A third run attempted afterwards could not complete because the
  host's daemon contract had changed in the working tree meanwhile (handshake refused); it is
  not reported.
- **Migration cost not measured.** Every scenario starts from a fresh data folder created by this
  build. Opening an existing schema-2 store runs migration 3 once (Rust: online backup, then the
  backfill; TypeScript: content verification, then the backfill).
- The baseline's other caveats (measured layers, one mission per session for TypeScript, cold start
  and restart definitions, macOS arm64 only, quick mode) apply unchanged.
