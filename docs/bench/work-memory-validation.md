# Work-memory v0.4.328 review validation

Date: 2026-11-15. Environment: Linux, Node 24.22.1, pnpm 12.7.0,
Rust 1.99.1. Source basis: published v0.4.324 plus the previously delivered
v0.4.327 review tree. Validation uses temporary synthetic profiles and scripted
providers; it does not use a personal vault, installed desktop profile or paid model.

## Final gate results

The required **`pnpm check` did not fully pass** in this environment. Its final
failure is confined to Unix-domain socket fixture creation in two existing test
files. Remaining independent stages were executed separately so the failed
Vitest stage would not hide their results.

| Check | Observed outcome |
| --- | --- |
| ESLint, dependency boundaries, ownership baseline, public-data checks, generated schemas | Passed in the final `pnpm check` run. |
| All workspace TypeScript checks | Passed in the final run. |
| Rust daemon build with test provider experiments | Passed in the final run. |
| Complete Vitest run | **10,389 passed, 127 failed, 60 skipped**, 10,576 total cases. Files: 777 passed, 2 failed, 8 skipped, 787 total. Duration: 87.19 seconds. |
| `cargo fmt --all --check` | Passed. |
| Workspace Clippy, all targets, test fixtures, warnings denied | Passed. |
| Core Rust library tests | **396 passed, 1 failed**, 397 total. |
| Daemon Rust tests, all reported targets, `--no-fail-fast` | **291 passed, 2 failed**, 293 total. |
| Combined reported Rust cases | **687 passed, 3 failed**, 690 total; zero ignored or filtered. |
| `pnpm build` | Passed for Web, CLI and Desktop build scripts. This is not an installed desktop smoke run or signed release packaging. |
| Version consistency | Passed at **0.4.328**. The patch version was bumped once. |
| Character-hair check | Exited successfully with an explicit skip: local avatar assets are absent; the public build uses procedural characters. |
| Patch whitespace | `git diff --check` passed. |

## Exact environmental blockers

All **127 Vitest failures** report `listen EPERM: operation not permitted`
while the fixture attempts to create a Unix-domain socket:

- `packages/host/test/codexObservedControl.test.ts`: 115 failing cases.
- `packages/host/test/observedCodexService.test.ts`: 12 failing cases.

All **three Rust failures** occur at `UnixListener::bind(...)` during creation of
synthetic socket fixtures, with OS code 1, `PermissionDenied`,
`Operation not permitted`:

- `skills::tests::refuses_symlinks_hard_links_and_special_files`.
- `worker_bundle::tests::filesystem::links_and_non_regular_entries_are_never_followed_or_read`.
- `socket_manifest_is_rejected_before_content_read` in `python_bundle_probe`.

The Python probe fails before its probe process is launched. Its other three
tests passed; this is not a missing-Python or missing-bundle failure. No Rust
timing or missing-file failure occurred in these runs. Socket tests were not
deleted, disabled or counted as passing. A normal development/CI environment
that permits these fixture sockets must rerun the full gate before release.

## New path verification

The real-host/Rust integration file
[`workMemoryService.test.ts`](../../packages/host/test/workMemoryService.test.ts)
has **17 passing cases**, covering:

- Durable Native evidence followed by host restart and automatic fresh-session recall.
- Default, shared custom-profile and isolated workspace boundaries.
- Profile reassignment without inheriting the old profile's operational memory.
- Memory-off, history-off and learning-off capture/context gates.
- Explicit failed outcomes retained in later context.
- Historical curator context separated from current evidence; publication of a
  real indexed Knowledge note and an inactive generated skill candidate.
- Fresh Knowledge content included in a later Native provider request.
- Selected-worker feature gates and consent for raw worker evidence.
- New linked Observe completed/failed frames, Native recall and watch-revocation exclusion.
- Explicit unbound Observe capture in default/global scope without workspace leakage.
- A real SQLite commit whose acknowledgement is delayed across shutdown, and an
  aborted Native turn captured as cancelled and recalled after restart.

All **13 core work-memory tests** and **5 daemon work-memory tests** passed.
The host WorkMemory/Observe suites passed **54 cases**, including outbox replay,
revocation, corruption/link checks, source-coverage reporting, steering, batch
episodes and first-directory publication failures. Request-preparation tests
passed **10 cases**, including current source revisions, long-prompt tail recall,
mandatory-skill budget priority and asynchronous access changes.

Runtime/archive tests exercise recoverable request projection, intact instructions
and tool pairing, paged original evidence, per-worker archives, corrupt/missing
data and directory-sync refusal. Meeting tests verify read-only memory helpers
per participant, with writers excluded. Real-host Knowledge meetings receive the
latest steering in both default and isolated workspaces when the final assistant
does not repeat the correction.

These are data/control-flow checks with deterministic providers. They establish
that evidence was stored, retrieved, injected and consumed by a scripted curator;
they do not establish live-model judgment, automatic skill effectiveness or
superiority over another agent.

## Issues corrected during whole-project verification

An earlier whole-project run found six additional failures beyond the socket
restriction. The final run contains none of them:

- Two release tests needed the repository's release workflow, which was absent
  from the initial sparse checkout. Materializing the existing workflow fixed them.
- Two skill-learning scope tests exposed an over-broad memory authority check
  on memory-disabled connections. The check now follows the selected connection's
  actual memory/history feature; the skill proposal's own scope guard still refuses.
- One queue test treated an admitted `sent` receipt as completed model execution.
  It now waits for both actual requests and both terminal events and asserts their
  exact order, retaining the original behavioral assertions.
- An approval-ownership test timed out in that earlier run; it passed focused
  verification and the final complete run. Its assertions and timeout were unchanged.

## Performance and cost evidence

The [local probe](work-memory.md) recorded 2,000 synthetic records, successful
scope-safe recall of old English/Indonesian decisions, empty unrelated results,
and local p95 query times around 1.15 ms / 1.13 ms / 0.37 ms in its measured run.
These are warm repeated local timings in a development build. No paid inference,
answer-quality score or complete-task token saving was measured.

## Delivery verification

The review ZIP includes the final logs, the initial diagnostic log, this report,
the architecture/usage documents and two alternative patches: one from published
v0.4.324 and one from the exact v0.4.327 review tree. `patch-validation.json` records
their independent application checks and resulting tree identity. Checksums and
source-file changes are recorded in the ZIP manifest.

No commit, push, PR or release is part of this review. General external prompt
injection, semantic consolidation/retention, durable paid-job scheduling, live
quality/cost comparison and Windows/macOS installed-product certification remain
outside the demonstrated results.
