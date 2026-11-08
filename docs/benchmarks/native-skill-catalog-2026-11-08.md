# Native skill catalog resource contract, 2026-11-08

This probe runs the real host catalog, registry and runtime prompt code against a
synthetic in-process registry transport. It measures serialized metadata and tool
schemas, operation counts and retained body fields. It makes no provider calls
and does not measure production scanner availability, IPC latency, process RSS,
model answer quality or token/cost savings.

Run from the repository root:

```sh
node tooling/bench/native-skill-catalog.mjs
```sh

[Raw results](native-skill-catalog-2026-11-08.json) include source hashes and runtime details.
Each synthetic package has one active revision and about 4,400 instruction
characters. Actual libraries can have many inactive revisions; the inventory cap
counts raw registry rows, not distinct active packages.

| Registry rows | Catalog characters | Tool schema characters | Serialized inventory bytes | Retained external body characters | Last target found |
| ---: | ---: | ---: | ---: | ---: | --- |
| 16 | 1,984 | 1,654 | 3,786 | 0 | Yes |
| 128 | 1,986 | 1,654 | 30,218 | 0 | Yes |
| 1,000 | 1,986 | 1,654 | 236,010 | 0 | Yes |
| 2,048 | 1,987 | 1,654 | 483,338 | 0 | Yes |
| 2,049 | 1,987 | 1,654 | 483,329 | 0 | No; incomplete |

All cases offer eight external preview entries plus canonical built-ins. The
1,000-row fixture finds its final skill outside that preview with one selected
registry read after a shared fresh index scan. External bodies are absent from
the retained reference objects and preview; private digests bind fresh reads.
Serialized inventory bytes exclude private digest/Map overhead and are not a
heap measurement.

Startup still performs one authoritative content read per eligible active
revision, sequentially. A 1,000-row preview adds eight selected reads and eleven
99-row index pages, rather than one full index scan per selected item. No claim
is made that startup I/O is constant or that all 1,000 bodies are never read.

Exactly 2,048 raw rows with no continuation are complete. The 2,049-row fixture
stops at 2,048 and reports incomplete; its final target is unavailable to that
turn. Paged discovery does not bypass the initial inventory bound.
