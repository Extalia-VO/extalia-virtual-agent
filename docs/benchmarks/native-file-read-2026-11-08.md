# Native file-page resource benchmark — 2026-11-08

Scope: the actual Native `read_file` host tool. Frozen v0.4.183 working-tree implementation versus the bounded scanner candidate for v0.4.184. This does not benchmark model inference, a Rust harness, or whole-application memory.

## Method

- Apple M3 Max, 14 logical cores, 36 GiB RAM; macOS 26.6.1 ARM64; Node v26.12.1; AC power. No dedicated-machine or cold-disk claim.
- Three synthetic temporary files: newline-dense (`x` plus LF), ordinary 200-byte lines, and one huge line. Actual bytes: newline-dense=5242880, ordinary-200-char-lines=5242800, huge-line=5242880.
- First ten lines and a deeper page; the huge-line deep request is intentionally past EOF, exercising the same full-scan line-count/error path.
- Fresh subprocess per variant/scenario; five sequential warm-ups, then 100 total measured operations shared across concurrency 1, 3 or 8. The percentile includes tool execution and the small output digest computation. File generation and module loading are outside operation timing. Filesystem cache is warm.
- Eighteen paired scenarios, 3,600 measured operations total. Every baseline/candidate output digest matches. The final run was sequential after the focused test run completed. Samples within each worker are correlated; these percentiles are observed local results, not a confidence interval across repeated fresh-process trials.
- Peak RSS is the OS process high-water mark from `process.resourceUsage().maxRSS`, normalized by Node to KiB, including import/warm-up. This is an absolute worker-process peak; baseline/end RSS, heap and external memory are current snapshots, not allocation peaks. See [Node process documentation](https://nodejs.org/api/process.html#processresourceusage).
- Event-loop delay uses `monitorEventLoopDelay({ resolution: 1 })` during measured operations. It is observed scheduling delay, not CPU time, a hard responsiveness guarantee or a UI benchmark. See [Node performance documentation](https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions).
- No provider, real workspace/profile, Obsidian vault or user prompt was accessed.

## Results

All values below are baseline → candidate. MiB divides the reported KiB by 1,024. Full unrounded measurements, current memory snapshots, output digests and bundle/source hashes are in [the raw report](native-file-read-2026-11-08.json).

| Fixture | Page | Concurrency | p50 ms | p95 ms | Peak RSS MiB | Max observed loop delay ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| newline-dense | first10 | 1 | 41.04 → 25.49 | 43.02 → 26.60 | 166.2 → 75.9 | 43.32 → 1.78 |
| newline-dense | first10 | 3 | 120.26 → 84.16 | 123.95 → 85.22 | 176.1 → 79.4 | 43.61 → 1.99 |
| newline-dense | first10 | 8 | 293.16 → 198.23 | 365.04 → 202.59 | 356.0 → 79.7 | 116.59 → 2.71 |
| newline-dense | deep-page | 1 | 40.72 → 26.51 | 42.13 → 27.24 | 166.3 → 76.5 | 42.83 → 1.64 |
| newline-dense | deep-page | 3 | 120.63 → 74.40 | 124.17 → 75.92 | 176.0 → 80.0 | 42.37 → 1.85 |
| newline-dense | deep-page | 8 | 324.98 → 196.14 | 367.48 → 198.93 | 358.4 → 81.0 | 124.78 → 2.58 |
| ordinary-200-char-lines | first10 | 1 | 1.67 → 1.82 | 2.60 → 2.25 | 156.4 → 85.8 | 2.73 → 1.32 |
| ordinary-200-char-lines | first10 | 3 | 3.72 → 3.49 | 5.15 → 4.49 | 176.1 → 100.1 | 2.75 → 1.14 |
| ordinary-200-char-lines | first10 | 8 | 9.10 → 8.44 | 10.49 → 10.73 | 210.6 → 100.9 | 3.25 → 1.14 |
| ordinary-200-char-lines | deep-page | 1 | 1.71 → 1.83 | 2.64 → 2.24 | 156.4 → 85.7 | 2.81 → 1.11 |
| ordinary-200-char-lines | deep-page | 3 | 3.67 → 3.42 | 5.01 → 4.37 | 181.7 → 100.6 | 2.82 → 1.09 |
| ordinary-200-char-lines | deep-page | 8 | 10.50 → 8.81 | 14.43 → 10.41 | 231.0 → 105.3 | 4.13 → 1.30 |
| huge-line | first10 | 1 | 1.39 → 1.50 | 2.09 → 1.94 | 140.5 → 84.8 | 1.75 → 1.23 |
| huge-line | first10 | 3 | 2.41 → 2.56 | 3.24 → 3.89 | 165.4 → 98.3 | 1.65 → 1.35 |
| huge-line | first10 | 8 | 5.58 → 6.45 | 6.78 → 8.66 | 205.7 → 100.2 | 2.06 → 2.05 |
| huge-line | deep-page | 1 | 1.28 → 1.58 | 2.13 → 1.88 | 140.4 → 74.8 | 1.57 → 1.62 |
| huge-line | deep-page | 3 | 2.46 → 2.65 | 3.45 → 3.44 | 170.4 → 77.7 | 1.63 → 1.50 |
| huge-line | deep-page | 8 | 5.29 → 6.80 | 6.59 → 8.50 | 205.5 → 78.1 | 2.06 → 1.11 |

## Interpretation

Observed process peak RSS fell by 39.7%–77.6% across these fixtures. Dense-line scans also improved p95 wall time and substantially reduced the observed event-loop delay after the unselected-line count optimization.

The new scanner does not improve every latency sample. For example, one huge line with eight concurrent first-page reads changed p95 from 6.78 to 8.66 ms; ordinary first-page reads at concurrency eight changed 10.49 to 10.73 ms. These differences and the other regressions are retained in the raw report. The selected tradeoff prioritizes bounded memory and main-thread responsiveness; no general percentage speedup is claimed.

The implementation still scans the bounded file to retain exact total/remaining-line semantics. It uses one 64 KiB input buffer, decoder state, counters, a line prefix and bounded page candidates, instead of retaining a whole-file Buffer/string/line array. The actual read ceiling is 5 MiB plus one detection byte. This is a TypeScript transitional-tool improvement; the Rust harness/executor migration remains open under [ADR 0053](../adr/0053-evidence-based-native-process-partition.md).

## Provenance and reproduction

Frozen baseline `files.ts` SHA-256: `12f8918957defba3de1b073b7e8a05ee9c55beab23e7428932d3ff9d09ee9081`. The benchmark records baseline bundle, candidate bundle and combined candidate source hashes; the baseline source matched the existing tracked file before this change. No immutable v0.4.183 release is implied.

To reproduce, freeze/build the pre-change `packages/host/src/tools/files.ts` as an ESM bundle exporting `createFileTools` using the project esbuild dependency. Keep that bundle outside the source tree, then run:

```sh
node tooling/bench/native-file-read.mjs --baseline-module /temporary/baseline-tools.mjs --json > /temporary/native-file-read-report.json
```

The runner builds the current candidate itself, creates/removes synthetic fixtures and refuses differing output digests. Run one benchmark at a time, without concurrent builds/tests. Changed runtime, source, hardware or workload requires a new report.

Raw JSON SHA-256: `b5c3bbb8c08095a25343e286242bfec5e99bfe71b6a0fa19ce66cbb9670697f4`.
