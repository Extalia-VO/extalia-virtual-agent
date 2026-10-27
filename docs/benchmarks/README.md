# Benchmarks

Measured results that gate decisions. Each results file states its hardware, OS, toolchain
versions, git revision and daemon build, and contains only values a script measured on that
machine. No value is estimated or carried over from another machine.

| File | What it measures |
| --- | --- |
| [native-core-2026-10-22.md](native-core-2026-10-22.md) ([raw JSON](native-core-2026-10-22.json)) | TypeScript mission journal against the Rust core daemon (audit PR 10, the ADR 0021 benchmark gate) |
| [native-core-2026-10-22-totals.md](native-core-2026-10-22-totals.md) ([raw JSON](native-core-2026-10-22-totals.json)) | The same after per-mission running totals; before/after commit latency against journal depth |

## Native core benchmark (`tooling/bench/native-core.mjs`)

```sh
node tooling/bench/native-core.mjs            # full run (about one minute), Markdown table
node tooling/bench/native-core.mjs --json     # the same as JSON
node tooling/bench/native-core.mjs --quick    # smoke variant, small counts (under 10 s on the reference machine)
node tooling/bench/native-core.mjs --iterations 5000 --out result.json
node tooling/bench/native-core.mjs --daemon path/to/extalia-daemon   # skip the build, use this binary
```

It needs the Rust toolchain (`rust-toolchain.toml`) unless `--daemon` is given, and the
workspace dependencies (`pnpm install`; esbuild comes from `apps/cli`). It is not part of
`pnpm check`: the full run takes about a minute, and timings depend on the machine.

### Method

- **Builds.** The daemon is built like a release artifact:
  `cargo build --release --locked -p extalia-daemon --target <host triple>` with symbols
  stripped (the flags of `tooling/build-daemon.mjs`), and it must answer `hello`. The host
  sources (TypeScript) are bundled with esbuild into a temporary file.
- **Real code paths.** TypeScript core: `MissionCheckpointStore` from
  `packages/host/src/missionCheckpoints.ts` (the host's `state/missions.sqlite`), committing each
  event with `writeSession(session, [run], { event })` and a checkpoint whose `updatedAt` moves to
  the event, as the host's `MissionRecords.commitEvent` does; restart recovery through
  `MissionRecords.initialize`. Rust core: `DaemonSidecar`, `DaemonClient` and `createDaemonMission`
  from `packages/host/src/daemon/` over stdio to `extalia-daemon --data-dir <dir>` (the daemon's
  `state/core.sqlite`), exactly as the host does with `nativeCore: 'rust'`.
- **Isolation.** Every scenario runs in a fresh Node process (`--expose-gc`) on its own temporary
  data folder, which is deleted afterwards. Rust samples that need a new daemon spawn a new process
  per sample.
- **Workload.** Native control events only (`agent.state`, `tool.started`, `tool.completed`,
  ADR 0014), one worker task per mission for commit series. Every commit series uses missions
  that are pre-created before timing and receive at most 250 activity events each, so all
  series sample the same journal depths. Warm-up commits run before each measured series.
- **Fixed counts** (full run): 2,000 commits per series after 200 warm-up commits; 200 mission
  creations (4 tasks); 5 bursts of 1,000 commits; 15 cold starts after 2 discarded; restart
  recovery 10 runs after 1 discarded for 1, 16 and 64 in-flight tasks (16 tasks per mission,
  200 events per mission); memory after 4,000 commits; 8,000 commits into one mission for the
  depth table. `--iterations` scales the commit-based counts; `--quick` uses small counts.
- **Statistics.** Nearest-rank percentiles of per-operation wall time (`performance.now()`).
  Throughput is commits divided by the series' wall time.

### Metric definitions

| Metric | TypeScript core | Rust daemon |
| --- | --- | --- |
| Event commit latency | Issue → acknowledgement of `writeSession` with an event. With N missions, each mission yields to the event loop before its commit, so the value includes waiting while other missions' synchronous commits hold the host thread. | Issue → acknowledgement of `event.commit` through the client. With N missions the requests are pipelined on one connection and served one at a time. |
| Host thread blocked per commit | The synchronous `writeSession` call alone. | Not measured (the request is asynchronous). |
| Mission create | `writeSession` of a new run in a new session (the host's first checkpoint). | `createDaemonMission` (`mission.create`). |
| Burst throughput | A tight synchronous loop of commits. | All commits of the burst sent at once, pipelined. |
| Cold start | `MissionCheckpointStore.open` in a fresh process (the host process itself is already running). | `DaemonSidecar.connect()`: spawn, store lock, open and migrate `core.sqlite`, recovery, `hello`. |
| Restart recovery | `MissionRecords.initialize` on a copy of a store left by a SIGKILLed host with K running tasks: open, full content verification, recovery write. | `DaemonSidecar.connect()` on a copy of a store left by a SIGKILLed daemon with K running tasks: the daemon recovers them to `unknown` before `hello`; the benchmark checks its report of K tasks. |
| Memory | `process.memoryUsage()` deltas after garbage collection: after open, after M commits (includes SQLite's page cache in the host process). | Daemon RSS from `ps` (macOS/Linux) after 1 s idle and after M commits; daemon CPU time over an idle window (10 ms resolution); host-side deltas as for TypeScript. |
| Binary size | Not applicable (`node:sqlite` is part of Node). | Size of the stripped release binary. |

### Rules for publishing results

- Run on AC power when possible and close heavy applications; record the power source.
- State the hardware as model, core counts and RAM only: no host names, user names, paths or
  serial numbers (`pnpm lint` checks the public-safety rules).
- Publish the script's own output. A rerun replaces numbers; it never adjusts them.
