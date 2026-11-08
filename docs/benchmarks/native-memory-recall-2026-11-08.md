# Native memory metadata recall, 2026-11-08

This benchmark compares the former alphabetical eight-note catalog with bounded
lexical metadata recall and its stat-validated metadata cache. It uses generated
workspace notes, no real profile, no model and no paid provider.

Run from the repository root:

```sh
node tooling/bench/native-memory.mjs --iterations 20 --warmup 2 --json
```

[Full result](native-memory-recall-2026-11-08.json) records the source hash,
platform, 18 scenarios, diagnostics and latency. Each variant has 20 measured
iterations after two warmups: 720 measured operations total. File creation is
excluded. OS caches are not reset; these are repeated local reads, not cold-disk
measurements. The process-local metadata cache is warm in the reported samples.

Fixtures contain 16, 128 and 1,000 notes. Twelve positive English/Indonesian cases
place target notes after the alphabetical preview; six non-target greeting or
unrelated-query cases complete the matrix. Recall finds the expected metadata in
10/12 positive cases, versus 0/12 for the alphabetical preview. This is a narrow
synthetic metadata hit-at-eight measurement, not semantic retrieval, model answer
quality, general personalization accuracy or measured provider-token savings.

| Notes | English filename case: alphabetical p95 | Recall p95 | Recalled target | Warm body bytes read |
| --- | ---: | ---: | --- | ---: |
| 16 | 2.298 ms | 0.907 ms | Yes | 0 |
| 128 | 1.647 ms | 3.407 ms | Yes | 0 |
| 1,000 | 2.308 ms | 5.414 ms | Yes | 0 |

The larger recall cases perform more metadata checks than the eight-note
baseline, so they remain slower despite avoiding note-body reads on cache hits.
Hits still require fresh root/file checks; body reads, literal search and revision
guards never use cached content. The cache contains at most 512 redacted metadata
entries, not raw note bodies or user prompts.

The two misses are deliberate summary-only targets beyond the 128-candidate
bound in the 1,000-note fixture. Filename matches can enter from all discovered
names, but arbitrary distant summaries cannot. Their results remain explicitly
incomplete; paged memory search is still required. Descriptive names and first
lines make selective recall more useful without widening its resource budget.

Prompt catalog blocks remain 484–510 characters in these fixtures, below the
existing 2,000-character ceiling. Some relevant catalogs are slightly longer
than the alphabetical baseline. No claim is made that this change reduces tokens
or cost; provider-cache counts and real task evaluations are separate evidence.
