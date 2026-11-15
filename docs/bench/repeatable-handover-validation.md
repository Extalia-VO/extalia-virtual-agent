# Repeatable handover v0.4.329 review validation

Date: 2026-11-15. Environment: Linux, Node 24.22.1, pnpm 12.7.0,
Rust 1.99.1. Source basis: published v0.4.324 plus the delivered v0.4.328
review tree `ce8e4b1b44757d3d2706450757d54666e4c56dd5`.

Tests use temporary synthetic profiles, real Extalia persistence and SQLite,
and deterministic provider/native-protocol fixtures. No personal project, vault,
installed agent profile, paid model or release installation is used.

## Final gate results

The required **`pnpm check` did not fully pass** in this environment. Its final
Vitest failures are confined to Unix-domain socket creation in two existing test
files. The later independent stages are executed separately so that the failed
Vitest stage cannot hide their results.

| Check | Observed outcome |
| --- | --- |
| ESLint, dependency boundaries, ownership baseline, public-data checks, generated schemas | Passed in the final `pnpm check` run. |
| All workspace TypeScript checks | Passed in the final run. |
| Rust daemon build with provider experiments | Passed in the final run. |
| Complete Vitest run | **10,471 passed, 127 failed, 60 skipped**, 10,658 total. Files: 781 passed, 2 failed, 8 skipped, 791 total. Duration: 87.29 seconds. |
| `cargo fmt --all --check` | Passed. |
| Workspace Clippy, all targets, test fixtures, warnings denied | Passed. |
| Complete Rust workspace tests, test fixtures, `--no-fail-fast` | **687 passed, 3 failed**, 690 total; zero ignored, measured or filtered. All three failures occur while creating Unix-socket fixtures. |
| `pnpm build` | Passed for Web, CLI and Desktop build scripts. This is not signed packaging or an installed Desktop smoke run. |
| Version consistency | Passed at **0.4.329**. The patch version was bumped once. |
| Character-hair check | Exited successfully with an explicit skip: no local optional avatar assets; the public build uses procedural characters. |
| Patch whitespace | `git diff --check` and both patch application checks are required by the package builder. |

All **127 Vitest failures** report `listen EPERM: operation not permitted` while
creating a synthetic Unix-domain socket:

- `packages/host/test/codexObservedControl.test.ts`: 115 failures.
- `packages/host/test/observedCodexService.test.ts`: 12 failures.

The final run contains no other failing Vitest file. These blocked cases are not
counted as passing. A development/CI environment that permits these sockets must
rerun the complete gate before release.

The three Rust failures occur at `UnixListener::bind(...)`, with OS code 1,
`PermissionDenied`, `Operation not permitted`:

- `skills::tests::refuses_symlinks_hard_links_and_special_files`.
- `worker_bundle::tests::filesystem::links_and_non_regular_entries_are_never_followed_or_read`.
- `socket_manifest_is_rejected_before_content_read` in `python_bundle_probe`.

Core Rust reported 396 passing cases and one failure. Daemon library/integration
targets together reported 291 passing cases and two failures. The Python bundle
probe's socket test fails before launching its probe process; its other three
cases pass. These are the same three fixture restrictions recorded for v0.4.328.

After `pnpm check` stopped at Vitest, the remaining stages were run with the
repository's required flags. Rust tests added `--no-fail-fast` so all targets,
including integration and doc-test targets, would report despite the socket
failures. `validation/remaining-gate-results.json` records each command, exit code
and measured duration. The Web build retains its existing large-chunk warning;
the build command exits successfully.

## New behavior verified

### Actual host checkpoints and destination writes

`packages/host/test/sessionHandoverCheckpoints.test.ts` has seven focused passing
cases. They exercise the real host, source importer, journal and session store:

- Capture an active Observe source, append evidence after review, refresh status,
  and apply only the frozen checkpoint. Explicit Observe-to-Native enablement
  preserves workspace permissions; preview and adoption make no provider call.
- Continue Native with that context, restart the host, capture later evidence and
  reuse the same endpoint and canonical work identity.
- Export while a Native inference call is pending. The original turn continues;
  a queued prompt remains pending and is excluded from the checkpoint. The same
  busy Native session cannot have its history replaced as a destination.
- Capture while the original source waits for a file-write approval. The same
  approval remains pending and the file is not written by handover.
- Refuse watch pause/resume ABA without creating a Native destination.
- Inspect an unregistered source, then associate its matching isolated project
  without a spurious permanent lock from passive inspection.
- Preserve canonical endpoint reuse through the legacy managed-workspace
  Continue path; an Observe-only workspace still needs explicit enablement review.

The final concurrency regression persists the real uncertain transfer reservation,
changes an existing destination through public `setSessionOptions` before the
effect acquires its destination lock, and verifies rejection against the exact
reviewed destination fingerprint. New options and old model history remain intact,
no inference occurs, and replay returns the rejected receipt without another effect.

### Actual host Hermes creation and repeated hops

`packages/host/test/hermesHandoverHost.test.ts` adds two integration cases:

1. Passive discovery performs no gateway RPC. Explicit creation produces a real
   empty SQLite session in the selected named profile while another profile holds
   the same native ID. Registration and automatic connection select the exact
   source, ready controls become available without an extra Connect click, and
   **Codex → Hermes → Native → original Codex** retains its canonical lineage.
2. A lost creation acknowledgement survives host/gateway restart. Inspection uses
   the original idempotent request and recovers the same native identity without
   creating a second session or sending a prompt.

These tests use real temporary SQLite with scripted native RPC. They validate
Extalia's adapter/control flow, not a live Hermes deployment or receiving-model
understanding. Creation makes no model request. Antigravity's existing creation
path may use its fixed readiness turn and is not included in that inference-free
claim.

### Archive, scope and delivery contracts

Focused continuity/access/Hermes-host suites passed 65 cases before the complete
gate. Coverage includes immutable source deltas, clipped legacy tails, source
authority changes, merge consent, canonical aliases and retained old scoped grants,
history-off demotion, corrupted state, exact operation replay, and unknown-receipt
inspection at the 256-snapshot limit. Newly activated grants are revoked precisely
when delivery is positively refused; older grants are not removed accidentally.

CLI and Hermes adapter/source/discovery/importer suites passed 170 cases across
ten files. They include repeated CLI resumes across restart, stale dispatch refusal,
profile/configuration replacement, explicit executable selection, cold Hermes
resume, native profile/project binding, advertised creation parameters, empty
linked sessions, uncertain creation recovery and shutdown cleanup ownership.

The shared UI's four focused suites passed 100 cases. They cover checkpoint
preservation during source progress, real scope invalidation, Observe-to-Native
enablement consent, lineage-join review, setup/manual/recovery controls, pending
creation without an invented ID, selection of a freshly registered destination,
receipt navigation and tool/status-only observed sources.

These focused totals overlap the full test run. They must not be added to it as
extra independent test cases.

## Storage measurement

Both implementations were asked to perform forty manual-ready transfers while
their synthetic source history grew. The initial evidence held one user record
and fourteen tool records with 6,900 filler characters each. Each cycle added one
tool record with 1,800 filler characters. No provider or network was involved.

| Implementation | Completed transfers | Last persisted file bytes | Snapshots | Stored evidence entries |
| --- | ---: | ---: | ---: | ---: |
| Delivered v0.4.328 | 34; next capture refused at capacity | 4,215,440 | 35 | 1,068 |
| New immutable deltas | 40 | 248,636 | 41 | 55 |

The compact-chain guard remains 4 MiB in both implementations. The measured
persisted files use pretty JSON and also contain metadata and receipts, so their
byte counts are not the compact-chain limit itself. Existing evidence was not
evicted. The new implementation retained the original fifteen plus forty new
entries without copying the full earlier history on every capture.

The completed-work totals differ. This is not an equal-work percentage comparison,
latency measurement, token-cost result or model-quality benchmark. The ZIP includes
`validation/continuity-storage-measurement.json`, the reproduction script and the
single baseline source file needed when the review tree object is unavailable.

## Issues resolved during the whole-project gate

The first full run found three failures beyond the existing socket restriction:

- Two Native handover cases exposed inconsistent destination fingerprints for a
  bound operating profile. Review used the raw workspace while the effect used
  its resolved operating defaults. Both now use the same resolved workspace;
  the post-reservation stale-destination check remains intact. The seven existing
  host cases and seven checkpoint cases passed together after the correction.
- The providerless Observe upgrade case expected Native discovery to remain
  unavailable after a connection was saved. The new reviewed enablement makes it
  available. The updated test also verifies that omitting enablement consent is
  refused, Observe mode is unchanged, and no model is called. Its original memory
  capture, archive, restart, recall and explicit upgrade assertions remain intact.

The initial diagnostic log is retained separately from the final complete run.
No socket test was removed, disabled or counted as passing.

## Browser and installed-client limits

Visual QA was attempted with an isolated synthetic fixture using the actual shared
dialog and styles. It could not complete in this runner:

- Local Chromium failed at `socket()` with `Operation not permitted`.
- The connected Browser plugin reported no originating browser context.
- The allowed cloud browser could not reach the scratch localhost fixture
  (`ERR_CONNECTION_REFUSED`).

No screenshots, light/dark verification or phone-layout acceptance are claimed.
The temporary server was stopped. Installed Codex/Claude/Antigravity/Hermes
versions, real Desktop attachment, paid-model context use and repeated execution
on a user's project still require acceptance in the intended environment.

The current official Hermes gateway contract was reviewed on 2026-11-15:
[gateway local sessions](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/gateway-local-sessions.md).
It documents native creation and exact resume with inference separated from
session reservation. Installed capability negotiation is still required. No exact
upstream commit was verified; this is a reference to the retrieved `main` document.

Codex and Claude creation APIs/CLI features are not treated as automatic support
for new destinations in this adapter. Existing observed sessions and verified
control routes remain the implemented paths, with an explicit manual fallback.

## Package verification

The ZIP includes a combined patch from published v0.4.324 and an incremental
patch from the delivered v0.4.328 review tree. Each is checked and applied in a
separate temporary Git index, and both must produce the exact same final tree.
The original index remains unchanged. Checksums cover source copies, patches,
documentation and logs.

No commit, push, PR, release or personal-profile migration is included. A prepared
manual packet, transport admission, Native readiness, uncertain delivery and model
consumption remain different observed outcomes.
