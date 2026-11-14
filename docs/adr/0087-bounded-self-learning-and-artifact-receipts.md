# 0087: Bounded self-learning and artifact confirmations

Status: Accepted for the implementation decision; release acceptance requires
recorded cross-platform CI and live-provider validation. Extends ADRs 0066, 0067,
0074 and 0081. Skill storage and activation
continue to follow ADRs 0082 and 0026.

## Context

Automatic learning could expand into broad project exploration, reject useful
tool-free discussions, omit unbound Observe sessions and report total failure
after saving part of its output. An immutable attempted admission prevented
duplicate effects but did not establish successful artifact publication.

Research of [Hermes at commit
005389f78b750749b58f5a5d066956bc117c58b2][hermes] supports separating compact
memory, episodic retrieval, procedural skills and background review. Its detached
review, atomic memory/skill mutation and bounded loops inform this decision.
Hermes uses a different scope and activation model; no performance or quality
parity is inferred. The [product specification][prd] records primary sources,
exact comparisons and the evidence limits.

## Decision

### Bounded extraction before publication

The Rust curator receives at most ten redacted evidence records, including
explicitly labelled current-turn user/assistant claims when present. Claims
remain separate from successful tool output. Observed transcript claims retain
their external source attribution and cannot grant permission.

Analysis admits six provider requests, eight unique indexed reads, a 12,000
per-request input estimate and a 32,000 aggregate estimate. The estimate is
serialized UTF-8 bytes divided by three, rounded up, reserved before provider
entry. Identical reads reuse a previous bounded result. General filesystem,
shell, web, delegation and mutation tools are absent.

A solitary valid `submit_learning` ends analysis immediately. Its nested skill
object declares its fields and required properties. Bare nested objects were a
provider-compatibility risk; the observed Gemini failure has not been reproduced
as proof of that specific cause. The final opportunity offers submission only.
Analysis defaults to ninety seconds, capped at 120; accepted findings receive
a separate ninety-second publication lease. Cancellation requests never release
ownership before entered promises settle.

Automatic team Knowledge review uses one round, at most three saved members,
three provider requests and two indexed reads per member, six reads overall,
and input estimates of 8,000 per request and 24,000 across the meeting. These
limits also include fallback attempts. Ordinary user-directed meetings retain
their existing defaults.

### Explicit scopes

Native and registered observed work use their current workspace vault profile.
Only a freshly resolved unbound observed source can select the default profile
without a workspace, with explicit Observe consent. Missing explicit workspace
IDs, invalid or ambiguous associations and unknown profiles are refused.

Global Observe uses `global-observe` solely as its artifact/scheduler namespace.
It gains no project filesystem authority. A sole eligible default-profile model
route is preferred; otherwise only a sole eligible saved connection is selected.
An ambiguous or unavailable route is reported before inference. Root, consent,
source association and connection changes invalidate queued work rather than
redirecting it.

### Independent, positively confirmed artifacts

Knowledge writes precede skill proposals and have separate content admissions.
The note digest binds workspace, admitted profile revision and lesson, inside
the profile-hashed receipt namespace. A changed destination cannot reuse an old
note confirmation. Skill digests cover the normalized candidate independently.

Keep `receipt.claim` backward compatible. Add `receipt.get` returning `missing`,
`attempted` or `recorded`, and `receipt.record` for acknowledged host artifact
results. Confirmation is a separate immutable file, atomically published and
bound to the original profile/content/run hashes. Exact repeat acknowledgement
is idempotent. JSON payloads are bounded to 8 KiB and validated. Admission and
binding fields use profile/run hashes; the artifact payload still carries the
note path or registry IDs needed to identify the saved result. Corrupt files,
unsafe paths, symlinks, orphan confirmations and mismatched bindings are errors.

Legacy attempted markers remain uncertain. Neither restart nor missing
confirmation authorizes replay. Artifact success remains visible if later
confirmation, inspection, indexing or cleanup fails. Note-writer preparation
failure also remains visible while an independently enabled skill output proceeds.

Skills remain generated candidates in the shared user library. Inspection,
immutable revision history, user review/approval and activation retain their
existing owners. This decision grants no new activation authority and does not
create profile-private skill libraries.

### Honest presentation

Schedule results retain Knowledge and skill results separately, including partial
success. Acknowledged note writes trigger the destination's index refresh;
saved-but-not-indexed remains distinct. Error categories expose connection,
provider, timeout, invalid-request, authority or publication failures without
copying sensitive response text. A repeated identical skill revision does not
appear as a newly saved revision.

### Reviewed backend ownership

Rust continues to own curator state, evidence normalization, budgets, immutable
artifact admissions and confirmations. TypeScript owns existing host effect
admission/drain, profile/source routing and result projection. The two small new
host modules decode bounded acknowledgements and resolve explicit Observe scope;
they do not introduce a second curator loop. This placement follows ADR 0071.
The ownership baseline is explicitly refreshed for the reviewed changed sources,
without changing classifications, exclusions or the checker. It is not a claim
of zero backend JavaScript.

## Consequences and limits

Enabled profiles can autonomously add Knowledge notes and skill candidates from
eligible Native or observed work, with finite analysis and independently confirmed
outputs. Exact deduplication is not semantic consolidation. A confirmation proves
historical publication, not continued existence after manual deletion or skill
usefulness on future tasks.

Source queues and curator jobs remain in-memory. Durable source recovery,
restart checkpoints, a global episodic inspector and empirical usefulness
evaluation remain open. Windows artifact support and broader scanner platform
certification remain separate gates. No provider-cost percentage, benchmark
superiority or automatic activation is claimed.

The daemon build, focused Rust learning tests, lint, typechecks and product builds
passed. The final full Vitest run passed 10,229 tests; 127 failed at Unix-socket
fixture setup. Two Rust artifact fixtures have the same environment restriction.
The [PRD validation record][validation] records exact commands, counts, subsequent
regression fixes, UI evidence and remaining live-provider acceptance.

[hermes]: https://github.com/nousresearch/hermes-agent/tree/005389f78b750749b58f5a5d066956bc117c58b2
[prd]: ../product/prd-reliable-self-learning.md
[validation]: ../product/prd-reliable-self-learning.md#acceptance-and-validation-record
