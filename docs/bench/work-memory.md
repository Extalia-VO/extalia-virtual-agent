# Operational work-memory local storage probe

Recorded: 2026-11-15. Review source: ADR 0089, v0.4.328 review patch.

The reproducible fixture is
[`work_memory_bench.rs`](../../crates/extalia-core/examples/work_memory_bench.rs).
It creates and removes a private temporary data directory, uses the production
Rust store, and never opens a real profile or calls a model. Run:

```sh
cargo run -p extalia-core --example work_memory_bench --locked
```

The captured run used Linux, Rust 1.99.1 and the unoptimized development build.
The fixture writes 2,000 synthetic records across two workspaces sharing one
profile, closes/reopens the store, warms each query three times and measures
twenty repeats. OS caches were not cleared. Exact observations are in
[`work-memory-local.json`](work-memory-local.json).

| Case | Expected outcome | Observed result | p50 | p95 |
| --- | --- | --- | --- | --- |
| Old English decision | Retrieve the first record of the selected workspace | Found; other workspace excluded | 1.013 ms | 1.152 ms |
| Old Indonesian decision | Retrieve the second record of the selected workspace | Found; other workspace excluded | 1.053 ms | 1.134 ms |
| Unrelated terms | Return no fabricated relevance | No hits | 0.298 ms | 0.371 ms |

The full capture fixture took about 2.003 seconds; reopening took 25.817 ms.
Serialized search responses were 928, 922 and 23 UTF-16 units respectively.
These are backend responses, before the additional compact model-tool projection.

These measurements support bounded local retrieval feasibility in this fixture.
They do not measure cold-start behavior on another machine, simultaneous Desktop
load, embeddings, provider latency, answer quality, paid curation, token cost or
an improvement over another agent. They do not compare this Rust implementation
with an equivalent TypeScript implementation. Whole-task savings need a separate
controlled baseline with actual reported foreground/cache/curator/retry usage.
