# Native harness development review

Audit date: 2026-11-08. Starting baseline: v0.4.186. The owner requested local
implementation through 06:00 WIB. This report records product gaps and evidence;
it does not redefine the PRD or claim completion from UI appearance alone.

## Current incremental checkpoint (2026-11-09)

The table and v0.4.187–188 results below are historical evidence. Current status
is recorded in the [PRD tracker](prd-app-flow-and-live-agents.md#11-status-tracker).
There is no defensible overall completion percentage from test or file counts.

Rust already owns canonical mission records/leases, recovery inspection,
knowledge indexing, skill revisions and approvals, bounded learning jobs and
profile artifact publication. The pinned SkillSpector path has actual macOS
ARM64 execution evidence; Unix learning exports and scanner isolation on other
platforms retain their documented limits.

The v0.4.242 implemented cut is [Rust OpenAI-compatible model discovery](../adr/0070-rust-provider-model-discovery.md):
actual catalog HTTP/parsing/normalization, an isolated executable mode and
positive local child settlement. It does not migrate completion streaming or the
whole Native harness. The source audit deliberately retains its Node transport
and shared envelope validator as debt.

Major open acceptance groups remain:

1. Provider completion HTTP/streaming, large-request transport/backpressure,
   bounded provider ingress and Anthropic parity, followed by turn/history,
   scheduling, delegation and meeting execution (ADR 0069, FR-004/005/012).
2. Complete executor/child membership and writer fencing, physical reconciliation,
   exact action approvals and accepted evidence before dependency release
   (V2-03/04/05/06, FR-009/010/025). Read-only discovery cannot close these gates.
3. One fully certified permitted worker with ownership, lifecycle, authentication
   and artifacts; simulated endpoints are supporting evidence only
   (V2-11/14/15, FR-006/007).
4. Reviewed memory continuation/compaction, cross-store conflicts and measured
   skill-quality promotion, beyond saving a lesson or passing a security scan
   (V2-17A/17, FR-026).
5. Actual packaged platform/TLS behavior, signing/notarization and traceable
   end-to-end acceptance evidence. A green unit suite is not broad certification.

Continue through bounded executable cuts with the existing permission and
recovery boundaries intact. The next provider cut needs a reviewed stream and
large-input contract before replacing completion execution; it must not move
JavaScript into a Rust-launched script and call that migration.

## Historical baseline and measurements

| Area | Actual baseline | Gap and current work |
| --- | --- | --- |
| Workspace memory | Bounded metadata, literal search, paged redacted reads, lead-only confirmed writes already exist | v0.4.187 adds revision integrity, human inspection/editing and effective scope/context UX. v0.4.188 adds bounded lexical metadata recall and a stat-validated metadata cache; synthetic evaluation records both hits and distant-summary misses |
| Token/cache usage | Providers emit some cache counts; Anthropic input excluded cache in mission accounting | Normalize new total input, display reported cache and retain unknown metrics; explicit provider caching and replay opt-out checks. v0.4.188 rejects contradictory cache subsets and unsafe totals. Failed attempts preceding successful fallback can still lack usage, and partial reports remain known subtotals rather than complete billing totals; no measured savings claim |
| Long conversations | Complete model history is retained and resent | Explicit estimated input ceiling and aggregate safety guard; no silent truncation. Reviewed compaction/continuation is not yet implemented |
| Personal adaptation | Explicit workspace memory and concise-response built-in exist | v0.4.187 makes durable preferences inspectable/editable; v0.4.188 improves bounded metadata recall. Current user instructions still win. No automatic transcript capture or unsupported claim of learning improvement |
| Skill growth | Progressive built-in/registered reads, immutable revisions, explicit quarantined proposals and routing diagnostics exist | v0.4.188 adds bounded discovery for 1,000-skill fixtures and metadata/digest retention instead of every body. The 2,048-raw-row bound and linear startup reads remain explicit. Production scanner, sandbox evaluation and reviewed activation gates remain open; proposals are not automatically active skills |
| Knowledge and Native memory | Knowledge has independent vault setup, search/graph, guarded note editing and explicit imports | Workspace memory and Knowledge copies are separate stores. No automatic transcript-to-vault capture, cross-store conflict resolution or verified learning promotion is established by the new memory controls |
| Execution/recovery | Rust mission leases, preparation/planning receipts, recovery inspection and shared Native status exist | Complete executor/child membership, writer fencing and physical-settlement reconciliation remain open |
| Acceptance | Runtime success and existing integration checks exist | Accepted evidence/waiver and dependency-release gates in V2-06 remain open |
| Durable delivery | Checkpoints and conservative ownership markers exist | Canonical queue/outbox/command receipts and replay-safe dispatch still need V2-03/04/05/06 prerequisites |
| Native process placement | UI/provider/tool loop remains TypeScript with Rust control-plane capabilities | Full Rust harness turn-loop migration remains a target; optional Python is not a production worker claim |
| Team/meeting workflow | Actual delegation updates Office presence and task/session views | Shared native meeting records, evidence-backed decisions and authoritative cross-team context need a separate coherent workflow |
| Visual/assets carryover | Grimoire Book/List, in-place page turns, Knowledge graph contrast and garment fit corrections have local verification | [Garment review](garment-fit-review.md): only 16 of 32 published garments meet the decimal 1 MB target. Remaining models need reviewed geometry reduction; lossless repacking alone did not achieve the full target |

The first implementation increment follows
[ADR 0055](../adr/0055-native-memory-integrity-and-context-budgets.md). Further
increments must identify a concrete outcome, preserve user authority, update the
PRD tracker, run meaningful focused checks and the complete repository gate, and
report measurements only when actually collected. No real profile, external
application configuration, private vault or paid provider is used in tests.

The next core implementation order remains V2-03 complete executor membership
and writer fencing, V2-04 reviewed physical reconciliation, V2-05 durable exact
action approval, then V2-06 evidence acceptance before dependent task release.
Queue/outbox dispatch cannot bypass those gates. Passing local write-drain tests
does not close any of them.

Memory has a separate next increment: a reviewable continuation/compaction flow
with a pinned source revision, preserved original history, explicit user choice
and provenance. The current request-size guard only holds work; it does not
implement that continuation. Larger skill libraries also need authoritative
metadata retrieval without reading every eligible body at startup; the current
metadata-only retention improves lifetime resource use while retaining linear
verification I/O and the raw-row limit.

Reviewed skill improvement still needs pinned production scanning, sandbox
evaluation and explicit activation. Native meeting decisions need shared records
with actual event/evidence provenance. Neither a visual room nor a proposed
skill establishes those capabilities. See the
[canonical development plan](prd-v2-development-plan.md) for the complete
dependency and acceptance map.

The completed increments are v0.4.187 and v0.4.188. The final v0.4.188
`pnpm check` passed: 6,182 TypeScript tests, 23 optional tests skipped, 474 Rust
tests, lint/typechecks, all builds and version/asset checks. Independent reviews
covered persistence lifetimes, skill authority/retention, cache replay, numeric
usage and compact-layout focus handling. Browser checks used real temporary
host/sidecar code with mocked provider responses, including held-request/retry
history preservation, Native skill discovery, exclusive Grimoire views and a
61-note/76-link vault whose source files remained unchanged. Results are local;
no commit, publication or paid-provider savings claim is implied.

`pnpm test:desktop` also passed on the local macOS/arm64 development Electron
build: Desktop v0.4.188 IPC was available, Node was not exposed to the renderer,
the Office scene and all three floor views loaded, and renderer/model/texture
diagnostics were empty. It used the smoke runner's temporary profile and does
not establish packaged-release or other-platform readiness.

With WebGL explicitly unavailable at browser startup, Chat and Native note
reading remained usable, Grimoire automatically selected its List fallback and
displayed instructions, and Knowledge searched/read a note outside its bounded
25-row hub list. Expected WebGL initialization errors occurred in that simulation;
this does not claim a rendered 3D view or a complete V2 AR-19 certification.

Reproducible measurements: [memory recall](../benchmarks/native-memory-recall-2026-11-08.md)
and [skill catalog contract](../benchmarks/native-skill-catalog-2026-11-08.md).
