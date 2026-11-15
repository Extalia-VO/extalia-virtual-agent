# Reliable self-learning for Knowledge and Skills

Status: implemented through v0.4.330; CI and live-provider acceptance are tracked
separately. Reviewed against upstream Hermes on 2026-11-14. The acceptance record
below distinguishes source inspection, deterministic tests and live-provider
work, including the earlier local socket-fixture restriction.

## Goal

### v0.4.330 strengthening

[ADR 0091](../adr/0091-context-optimization-and-learning-recovery.md) adds durable
curator checkpoints and explicit recovery through the existing profile-aware
queue. Known-unentered steps resume with retained budgets; entered effects with
missing completion remain uncertain. Ready findings revalidate current Knowledge
and reconcile note/skill receipts separately. A temporarily unavailable note
destination does not block independent skills or reconciliation of saved notes.
Retained refinements require fresh source review.

Context preparation now supports English/Indonesian continuation recall,
progressive topic queries, fresh amendment/conflict previews and per-source
admission receipts. Connection settings select local Native tool projection,
an explicit Caveman Engine executable, or off, independently for each worker.
These additions preserve existing consent, candidate activation and source
authority. CI fixture repairs are deferred by the owner; live task quality,
installed Caveman and platform acceptance remain separate from local tests.

### Product goal

Extalia should autonomously preserve useful knowledge and create reusable skill
candidates after eligible work, using the saved profile policy. This must work
for Native conversations, registered observed projects and explicitly unbound
Observe sessions using the default profile. A private workspace's notes remain
inside its selected vault. Users should see what was saved, what remains
unconfirmed and whether the Knowledge index refreshed.

The desired improvement is reliable learning from bounded evidence, followed by
useful retrieval in later work. It is not a promise to save something after every
message, approve generated procedures automatically or outperform another agent
on unmeasured tasks. Generated findings remain interpretations of their sources.

This PRD extends [profile learning][adr66], [Rust ownership][adr67],
[deferred learning][adr74] and [observed work memory][adr81].

## Evidence and diagnosis

Reported failures included searches that exceeded their deadline, reviews that
used the ordinary worker step limit, very large aggregate model input and a
failed overall status despite an already saved note. These observations establish
poor completion and reporting behavior; they do not identify every provider-side
cause or establish a reproducible cost baseline.

Source inspection confirmed several actionable gaps:

- Automatic team reviews inherited broad project tools and an expansive meeting
  loop. They could rediscover a project instead of extracting a lesson.
- Native curator admission required successful tool output, excluding useful
  conversational decisions and preferences.
- Unbound observed sessions lacked a complete default-profile curation route.
- An attempted publication marker could suppress later work without confirming
  which artifact, if any, had actually been saved.
- Analysis and publication needed independent time allowances and results.
- A failed note-writer preparation could disappear when skill output continued.

The old `submit_learning.skill` schema also described a bare nested object,
without its required fields. That is a confirmed schema-quality defect and a
compatibility risk for stricter function-calling providers, including Gemini.
The available evidence does **not** prove it caused the reported Gemini failure.
The replacement describes the nested properties, required fields and closed
object shape, and separately categorizes provider invalid-request failures.

## What Hermes actually implements

The comparison is pinned to
[`005389f78b750749b58f5a5d066956bc117c58b2`][hermes-commit],
not an evolving branch or a marketing claim.

| Mechanism | Verified upstream behavior | Extalia decision |
| --- | --- | --- |
| Durable memory | `MemoryStore` maintains `MEMORY.md` and `USER.md`, with default limits of 2,200 and 1,375 characters. The system-prompt snapshot is frozen when loaded; later mutations change the live store. [Sources][h-memory] [and defaults][h-memory-tool] | Keep bounded evidence and indexed profile vaults; do not inject an entire Obsidian vault into every review. |
| Profile persistence | The active Hermes home is task-scoped. Cross-profile session reads depend on launch/caller policy: confined routed secondary profiles cannot read the default store, while local interactive access can explicitly select another profile. [Home resolution][h-home] [and search policy][h-search] | Resolve the destination explicitly; missing or invalid workspace bindings never select default implicitly. |
| Episodic retrieval | `session_search` uses database/FTS5 discovery, lineage handling and bounded message hydration. The inspected read path clips message content at 2,000 characters. It is not an LLM summarization pass. [Source][h-search] | Offer indexed Knowledge reads to the curator. A general global episodic inspector remains separate work. |
| Learning triggers | Default intervals are ten user turns for memory and ten tool iterations for skill review. Eligibility and review signals determine actual dispatch; these are not ten guaranteed successful writes. [Defaults][h-init] [and signals][h-signals] | Admit useful completed Native evidence and newly captured eligible observed episodes, then wait for an idle interval. |
| Background review | A detached fork has sixteen iterations and disables its own learning nudges. The default aggregate input threshold is 75% of the review model's context window, capped at 600,000 tokens, with a 120,000 fallback. [Source][h-review] | Use smaller, explicit pre-request estimates and a terminal submission, independent of normal task-worker limits. |
| Context reuse | The same-model fork preserves the parent's prompt/tool prefix and conversation for cache reuse; a differently routed model receives a digest and recent history. This is a deliberate cache tradeoff, not a constant-size input guarantee. [Source][h-review] | Pass selected evidence rather than replaying the complete source conversation. |
| Memory writes | The store locks, rereads current state, performs atomic writes and supports atomic batches. Exact duplicate handling and a finite consolidation-failure budget prevent some retry loops. [Source][h-memory] | Preserve immutable artifacts and positive confirmations; never treat an admission flag as completion. |
| Skill improvement | `skill_manage` supports creation and edits, per-skill locking, read-before-write guards, atomic mutation, scanning and rollback on blocked changes. Background prompts prefer refining a relevant existing procedure. [Mutation code][h-skills] [and review guidance][h-review] | Search/read eligible existing skills, then create a new immutable user-library candidate revision through the existing inspection workflow. |
| Periodic cleanup | Curator defaults are weekly eligibility after two idle hours, stale after fourteen days and archive after thirty. Deterministic transitions are separate from optional LLM consolidation, which is off by default. [Source][h-curator] | Do not add periodic merging or deletion to routine post-task learning. |

Two qualifications matter. Hermes checks its aggregate input threshold at the
**next** loop iteration, after the crossing request completes; it is not a strict
pre-admission billing cap. Its quality instructions and scanner checks also do
not demonstrate that a learned skill improves task outcomes. [Budget check][h-loop]
The reviewed idle queue is in-memory, so upstream background dispatch is not
evidence of durable crash-resumable source jobs. [Queue][h-queue]

The architectural inference is to separate evidence capture, bounded extraction,
publication and later retrieval. Copying a prompt that says “learn” would not
address the observed failure modes.

## Scope, consent and model routing

| Source | Knowledge destination | Admission boundary |
| --- | --- | --- |
| Saved Native conversation | Its workspace's selected vault profile | Current workspace, session, connection and profile revision |
| Registered observed project | The freshly resolved workspace profile | Physical project association, source identity, watching/privacy state and explicit Observe learning consent |
| Explicitly unbound observed session | Default profile; `Learning/global-observe/` | No fabricated workspace; default-profile Observe consent and one eligible saved model route |
| Missing explicit workspace, invalid/ambiguous link or unknown profile | None | Refuse; never fall back to default |

Only an intentionally omitted workspace argument selects default profile APIs.
An invalid supplied ID is an error. Global Observe can read the default Knowledge
index under its profile binding, but receives no project filesystem authority.
Changing a vault or association invalidates queued evidence; it never silently
retargets it. Isolated workspaces require a dedicated non-default vault profile.

Global routing prefers the sole eligible connection selected by default-profile
workspaces. Otherwise it can use the sole eligible saved connection. Ambiguity,
absence or history-disabled connections produce a visible connection problem
before inference. No new account, provider selection or credential is invented.
Existing visible observed history seeds a watermark instead of being replayed as
a paid backlog. Privacy revocation and resumed source work revoke admission.

Managed vault defaults remain useful; explicit opt-outs and exact-root consent
for external folders remain authoritative. Observe learning is separately opted
in. Knowledge isolation does not imply a private skill library or credential
store. See the [scope helper][scope-code] and [vault resolver][vault-code].

## Evidence and bounded extraction

Successful Native tool results and current-turn user/assistant text have distinct
provenance. Tool-free work can preserve a preference or decision, but an assistant
sentence cannot become verified execution evidence. Recognized trivial greetings
can bypass inference; the curator can also submit a skip for unsupported or
repetitive findings. Observed transcripts remain attributed, untrusted reports.
Neither archived user text nor a note grants new permission.

The host queues up to ten successful tool excerpts, each at most 2,000 UTF-16
units, plus bounded current user/assistant text. Rust reserves room for these
conversation claims within a maximum of ten evidence records, redacts again and
caps serialized evidence at 23,000 UTF-16 units. It does not receive attachments
or the full source history. Submission references must resolve to supplied IDs.

| Resource | Automatic curator | Automatic team Knowledge review |
| --- | --- | --- |
| Participants | One curator | First three saved members, one round |
| Provider requests | At most six | At most three per member |
| Indexed reads | Eight unique reads; identical arguments reuse the prior result | Six total, at most two per member |
| Input admission estimate | 12,000 per request; 32,000 aggregate | 8,000 per request; 24,000 aggregate across members and fallback models |
| Analysis allowance | 90 seconds by default; configurable up to 120 seconds | Finite request/read/input bounds; existing meeting lifetime and cancellation |
| Publication allowance | Separate 90 seconds after accepted submission | Existing pinned minutes exporter |

Curator estimation uses serialized request UTF-8 bytes divided by three, rounded
up. Team estimates use the runtime's request-budget calculation. Both reserve
before provider entry; failed admitted requests retain their reservation. These
are deterministic estimates, not exact tokenizer totals or a price guarantee.
Provider-reported usage remains separate and missing usage is not fabricated.

Only indexed Knowledge and eligible Skills read tools enter automatic analysis.
Broad filesystem search, web research, commands, writes and delegation are absent.
The final curator opportunity exposes only `submit_learning`; a valid solitary
submission immediately ends analysis. Mixed or duplicate terminal calls are
refused. Deadline cancellation still drains entered promises; elapsed wall time
can exceed the allowance when a provider ignores abort. [Curator][jobs-code]
[Team review][meeting-code]

The additional owner-supplied patch is based on the same v0.4.323 source. Its
explicit Native proposal scope checks and optional runtime final-response
reservation are integrated selectively. Both automatic and manual meetings
reserve the last configured worker step for tool-free evidence synthesis; the
ordinary Native and delegation defaults remain unchanged. The automatic host
budget guards also remain active. Duplicate version/baseline changes were not
applied a second time.

## Independent publication and durable receipts

Knowledge publishes first. Skill creation has a separate admission, so inspection
latency or failure cannot consume the note's opportunity. The note digest includes
workspace, admitted profile revision and lesson; the receipt namespace includes
the profile hash. Changing the vault revision cannot reuse a confirmation from
the previous destination. Skill content has its own normalized candidate digest.

The additive Rust receipt operations are:

| Operation | Meaning |
| --- | --- |
| `receipt.claim` | Existing exclusive attempted admission, bound to profile/content/run hashes |
| `receipt.get` | `missing`, `attempted` or `recorded`, with a bounded artifact receipt only for confirmed publication |
| `receipt.record` | Immutable confirmation after the host receives the artifact writer's result; exact duplicate acknowledgement is idempotent |

Confirmation is a separate atomically published file. It never overwrites the
admission marker. Payloads are bounded JSON, with path, credential and file-type
guards. Corrupt metadata, mismatched hashes, symlinks and orphan confirmations
remain errors. Legacy attempted admissions stay uncertain rather than becoming
successful or automatically replayable. [Receipt implementation][receipts-code]

A saved note remains saved if later inspection, event publication or confirmation
fails. Conversely, a claimed but unacknowledged write is not reported as saved.
Writer-preparation failures remain visible even when the other output succeeds.
Receipt persistence confirms a historical publication; it does not promise the
file still exists after manual deletion. No automatic repair is inferred.

## Skill creation and later use

The curator should inspect relevant eligible skills before proposing a general
procedure. Instructions describe when to use it, a procedure, pitfalls and
verification. Project-specific paths and identifiers become parameters; private
facts and raw transcripts belong only in authorized Knowledge notes. Prompt
guidance reduces inappropriate proposals but is not a proof of de-identification.

Candidates enter the shared user Skills library with source provenance and an
immutable revision. A same-name improvement can create a revised candidate;
identical registered content need not create another revision. Mandatory scanner
inspection, review, approval and activation remain separate under
[global skill storage][adr82] and the existing registry. An unavailable scanner
must not become a successful scan. This change autonomously adds knowledge and
candidate skills; it does not change automatic-activation policy or turn a draft
into an active procedure. Built-ins are not rewritten.

Explicit Native `/learn` proposals capture host-owned originating profile
provenance and revalidate the profile revision and workspace boundary immediately
before staging, including cancellation after the asynchronous check. This also
covers proposals requested directly rather than through automatic learning.

The curator's read catalog contains eligible active skills. An inactive or
quarantined candidate is not necessarily discoverable in the next review, so
same-name revision support does not establish complete autonomous improvement
of all existing candidates. A bounded candidate discovery surface is future work.

## Scheduling, reporting and indexing

The existing sixty-second idle countdown, Run now and ten-minute snooze remain.
At most sixteen updates wait, and one maintenance job executes. Known unrelated
profiles can proceed alongside uniquely isolated learning; shared/default work
retains broader guards. Foreground work cancels conflicting entered maintenance
and waits for actual settlement. The successful source task remains successful.

The notice retains separate Knowledge and skill results, including partial
completion. A confirmed note triggers the correct profile index refresh; failure
to refresh is displayed as saved but not yet indexed. Connection, provider,
timeout, invalid-request, authority and publication categories explain failure
without exposing provider response bodies or credentials. An unchanged skill
revision does not produce a false new-save flash. [Host orchestration][host-code]

## Acceptance and validation record

Acceptance requires tests for Native tool and tool-free evidence, default and
isolated vault destinations, unbound Observe without project access, invalid-link
refusal, opt-out, ambiguous model routing, bounded schema/loops, cancellation
settlement, independent artifact failure, destination changes and restart receipt
inspection. Test fixtures use temporary profiles and synthetic content.

Pre-publication validation of the combined patch on base `e53d81d`, using Linux,
Node 24.22.1, pnpm 11.25.0, Git 2.52.0 and Rust 1.99.1:

| Check | Observed result |
| --- | --- |
| `pnpm lint` | Passed: ESLint, package boundaries, explicitly reviewed ownership baseline, public-safety check and 14 current generated schema files |
| `pnpm typecheck` | Passed across the workspace |
| `pnpm build` and version check | Web, CLI and desktop builds passed; versions consistently 0.4.324 |
| Rust daemon build, formatting and clippy | Passed, with warnings denied for clippy |
| Final full Vitest run, 777 files | 10,229 passed, 127 failed, 59 skipped; 767 files passed, 2 failed, 8 skipped |
| Rust core library | 375 passed; one fixture failed at `UnixListener::bind` with `EPERM` |
| Rust daemon library | 115 passed; one fixture failed at `UnixListener::bind` with `EPERM` |
| Rust daemon binary | One test passed; both crates have zero doc tests |
| Focused Rust learning coverage | 39 passed, including eight durable-receipt tests; this is a subset of the daemon results above |

All 127 final Vitest failures are `listen EPERM` in the unchanged
`codexObservedControl` and `observedCodexService` socket fixtures, before the
control implementation is entered. The final log contains no assertion failures
or other error headers. The two Rust failures also occur while constructing
socket fixtures, before the tested artifact readers are called. The tests remain
enabled and their safety assertions are unchanged. Consequently **`pnpm check`
is not green in this environment**; rerun it on a runner permitted to bind local
Unix-domain sockets before release acceptance.

The first full run also exposed a providerless-Observe admission regression,
which was fixed while retaining capture, recall and upgrade assertions. Git
filter and unreadable-config positive controls were made portable without
weakening protected behavior assertions; explicit capture options fix listener
cleanup under the Node EventTarget used by UI tests. All these tests pass in the
final full run. No checker rules or test exclusions were relaxed.

UI validation covers rendered English/Indonesian receipt and lifecycle states;
there was no live desktop visual session. Integration tests use the actual Rust
sidecar and temporary profiles with simulated provider replies. They verify
control flow and persistence, not live Gemini compatibility or learning quality.
The repository requests pnpm 12.7.0, so release CI should also use its pinned
package manager. The optional hair-asset check reported no local avatar assets;
the public procedural-character build remains available.

PR preparation applies this patch to `68ff3b5`, preserving the subsequent
Electron 45 dependency update, lockfile, README changes and package metadata.
Those upstream changes use versions 0.4.324 and 0.4.325, so this implementation
uses 0.4.326. The table above records the earlier local gate; the draft PR records
CI results for its exact commit. Cross-platform checks remain required before
merge, and the local socket restriction must not be worked around by weakening
or excluding those tests.

PR preparation also identified a pre-existing source-binding precision defect:
different 64-bit file IDs can collapse to the same JavaScript number. Codex queue
fingerprints and cached headers now retain exact device/file IDs, and resolution
refuses mismatches between named files, opened descriptors and the final source.
Append-only progress preserves the binding. Deterministic regressions cover
rounded-ID collisions, stale UUIDs, device changes and replacement during reads;
the original physical-replacement and symlink assertions remain enabled.

No latency, cost-saving percentage or cross-agent intelligence benchmark has
been measured for this change. No real user profile was modified. Publishing a
draft PR does not constitute release acceptance or deployment.

## Remaining work

- A durable source-job queue, retained extraction checkpoints and reviewed restart
  recovery. Current countdowns and analysis jobs are in-memory; restart never
  replays an uncertain effect merely because an admission exists.
- Evaluation of retrieval relevance and skill usefulness on held-out tasks,
  including regressions, contradictions and stale procedures.
- A global episodic inspector with explicit scope, freshness and privacy controls;
  existing scoped observed memory is not this complete product surface.
- Reviewed consolidation, conflict resolution and lifecycle feedback for learned
  knowledge and skills. Current exact deduplication is not semantic equivalence.
- Windows artifact publication with equivalent handle/reparse protections, and
  scanner availability/certification beyond the separately documented platform.
- Live-provider acceptance, including Gemini nested tool-schema behavior, and
  whole-product resource measurements. Hermes parity or superiority remains an
  evaluation target, not a claim established by these changes.

[adr66]: ../adr/0066-profile-automatic-post-task-learning.md
[adr67]: ../adr/0067-rust-owned-learning-and-profile-artifacts.md
[adr74]: ../adr/0074-deferred-learning-and-workspace-knowledge.md
[adr81]: ../adr/0081-observed-work-memory-and-curation.md
[adr82]: ../adr/0082-global-skill-storage.md
[scope-code]: ../../packages/host/src/observedLearningScope.ts
[vault-code]: ../../packages/host/src/vaultProfiles.ts
[jobs-code]: ../../crates/extalia-daemon/src/learning/jobs.rs
[receipts-code]: ../../crates/extalia-daemon/src/learning/receipts.rs
[meeting-code]: ../../packages/host/src/nativeKnowledgeMeeting.ts
[host-code]: ../../packages/host/src/service.ts
[hermes-commit]: https://github.com/nousresearch/hermes-agent/tree/005389f78b750749b58f5a5d066956bc117c58b2
[h-memory]: https://github.com/nousresearch/hermes-agent/blob/005389f78b750749b58f5a5d066956bc117c58b2/tools/memory_tool_store.py
[h-memory-tool]: https://github.com/nousresearch/hermes-agent/blob/005389f78b750749b58f5a5d066956bc117c58b2/tools/memory_tool.py
[h-home]: https://github.com/nousresearch/hermes-agent/blob/005389f78b750749b58f5a5d066956bc117c58b2/hermes_constants.py
[h-search]: https://github.com/nousresearch/hermes-agent/blob/005389f78b750749b58f5a5d066956bc117c58b2/tools/session_search_tool.py
[h-init]: https://github.com/nousresearch/hermes-agent/blob/005389f78b750749b58f5a5d066956bc117c58b2/agent/agent_init.py
[h-signals]: https://github.com/nousresearch/hermes-agent/blob/005389f78b750749b58f5a5d066956bc117c58b2/agent/review_signals.py
[h-review]: https://github.com/nousresearch/hermes-agent/blob/005389f78b750749b58f5a5d066956bc117c58b2/agent/background_review.py
[h-skills]: https://github.com/nousresearch/hermes-agent/blob/005389f78b750749b58f5a5d066956bc117c58b2/tools/skill_manager_tool.py
[h-curator]: https://github.com/nousresearch/hermes-agent/blob/005389f78b750749b58f5a5d066956bc117c58b2/agent/curator.py
[h-loop]: https://github.com/nousresearch/hermes-agent/blob/005389f78b750749b58f5a5d066956bc117c58b2/agent/conversation_loop.py
[h-queue]: https://github.com/nousresearch/hermes-agent/blob/005389f78b750749b58f5a5d066956bc117c58b2/agent/review_idle_queue.py
