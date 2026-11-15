# ADR 0091: Scoped context optimization and durable learning recovery

- Date: 2026-11-15.
- Status: Implemented for v0.4.330; focused local verification. Installed Caveman,
  live-provider quality/cost and platform acceptance remain separate.
- Extends: ADRs 0067, 0071 and 0087–0089.

## Problem

Saved memory does not guarantee useful future context. Short continuation
messages can lose the original topic, a large optional block can crowd out a
useful note, and activity counts do not identify the sources actually admitted.
Tool-body compaction needs protection for complete source reads, archive
recovery, important diagnostics and honest per-transform evidence.

Learning analysis previously depended on a live job handle. A crash could lose
accepted findings; replaying the job could repeat an entered model request or
confuse an attempted write with a confirmed artifact. Recovery must distinguish
known-unentered work from physically uncertain effects.

## 1. Prepare context from current scoped sources

Mandatory skills retain their existing priority. A bounded planner uses the
current user request; explicit English/Indonesian continuations may inherit terms
only from the nearest substantive user goal supplied in that same request.
Assistant/tool text and other requests do not become query authority.

Knowledge's literal search requires all terms to match. The planner removes
generic request verbs and makes at most three progressively broader topic
queries. Work memory keeps its separately owned lexical search. Fresh note
bodies are ranked and excerpted around relevant paragraphs. Amendment and
contradiction hints receive separate reads under the same vault binding and
matching source revisions. Dates and relationship labels never prove truth.

Optional work-memory and individual note blocks are admitted independently under
an 8,192-character default cap and the complete request budget. A rejected large
memory block does not exclude a smaller eligible note. Reports distinguish
included/dropped/unavailable/empty blocks, IDs or relative paths, revisions,
preview/reference coverage, content hashes, omission reasons and local token
estimates. They omit raw prompts, queries, note bodies and absolute vault roots.

Authority and cancellation checks surround asynchronous I/O and reporting.
Previews remain untrusted source evidence; they do not satisfy complete-read or
revision-pinned skill-review requirements.

## 2. Optimize eligible tool data at the Native request boundary

`Connection.contextOptimization` is optional and defaults to local behavior:

| Mode | Behavior |
| --- | --- |
| `local` or absent | Conservative local projection of eligible tool-result bodies. |
| `caveman` | An explicit absolute executable invokes the local Caveman Engine; verified output may replace the local projection. |
| `off` | No persistent archive or tool-body compaction for that connection. |

Lead and worker routes use their own frozen settings. Mid-turn changes invalidate
stale admission. Existing Extalia-memory, saved-history and profile-learning
consent gates still apply. Unsupported Windows archive publication remains
unavailable.

Local projection compacts JSON whitespace, repeated lines or bounded excerpts
while retaining important diagnostic, negation and constraint lines. Protected
source reads, recovery results and errors are not compacted. User/system/assistant
instructions, skill context, schemas, IDs, arguments, order and provider-native
blocks remain intact. Original history stays complete. The default trigger is
24,000 estimated tokens or 85% of an explicit request limit; small contexts remain
unmodified.

Every replacement first receives an acknowledged scoped archive reference. New
version-2 archives contain only selected sanitized tool reports; unrelated
messages/results occupy null slots. User/assistant text, attachments, native
payloads and tool arguments are absent. Legacy archives stay readable with
explicit version/evidence labels. Sanitized recovery is not a byte-exact claim
about the original unredacted report.

### Caveman integration contract

The reference is the upstream
[Caveman Engine at `b4ee71d`](https://github.com/JuliusBrussee/caveman/tree/b4ee71d557d96e3cbc14f88fa6e953a1362865f5/engine),
especially its CLI `compress`/`retrieve` protocol. Extalia does not install it,
run setup scripts, change a proxy or intercept other observed applications.

The host starts only the configured executable, with fixed argument arrays and
no shell. It supplies sanitized eligible tool data, a minimal environment without
provider credentials and a private disposable Caveman home/CCR. Input is bounded
to 512 KiB; compression and recovery share a five-second default deadline. At
most four engine calls are attempted per compaction. The host parses the machine
report and verifies byte-exact recovery of the sanitized input before accepting
a replacement. It disposes the temporary CCR and gives the model Extalia's scoped
archive reference.

Missing executables, malformed output, failed recovery, oversized output or
changed authority cannot masquerade as successful Caveman compression. Safe
engine failures retain local projection and an explicit fallback reason; revoked
scope prevents admission. Per-transform methods, references, sizes and estimator
basis are published before model admission. Replacements stay stable within a
turn; cross-turn projection caching is not implemented. Estimates are not
provider usage or monetary savings.

## 3. Persist learning state before an effect becomes executable

Rust retains bounded job state, exact evidence, remaining budgets, required
provider continuation data, read proofs and prepared findings. The host supplies
an opaque route/source digest without credential values. Durable behavior is
opt-in through that digest; legacy jobs cannot acquire retroactive checkpoints.

| Durable boundary | Recovery consequence |
| --- | --- |
| Next effect saved, not entered | Exact effect may resume after current authorization. |
| Entry saved, completion absent | Effect remains uncertain and is never replayed. |
| Completion and next effect saved | Results/budgets continue without repeating the previous step. |
| Structured findings ready | Revalidate sources, then reconcile/publish independent artifacts. |
| Terminal, expired or incompatible | No automatic execution. |

Immutable generations use exclusive publication and owner fencing. A corrupt or
incomplete latest generation is refused; the daemon never falls back to an older
apparently unentered effect. Durable release drops the live handle but retains
the exact checkpoint. Cleanup does not erase lost admission/completion
acknowledgements. Known-unentered steps and ready findings survive orderly
interruption; entered work drains before settlement.

Storage permits 64 jobs per profile and one MiB per checkpoint, with a seven-day
recovery window. Expired entries are pruned on later admission; this is not a
scheduled deletion guarantee. Filesystem identity/permission checks remain
required, including refusal on unsupported Windows paths.

## 4. Resume through fresh authority and the existing scheduler

The learning view lists authorized retained work and reports catalog
unavailability. Explicit Resume uses the existing profile-aware idle queue. UI
fields confer no authority. Host and Rust check source identity, workspace,
profile, destination revision, saved history, policy, route digest and reader
contracts. Observe also checks its retained episode's exact scope/revision and
current source revocation.

Native identity includes the boundary and team actually persisted by the source
task. A prompt-created team cannot invalidate its own checkpoint because the
pre-turn record differed. Later unrelated route changes still refuse recovery.
Fresh authority checks separate asynchronous activity emission from each
provider/read effect.

Publication first reconciles the existing receipt. A missing note prepares its
current writer before claiming publication. A temporarily unavailable vault
therefore does not consume the note claim or block independent skills. Recorded
notes need no writer. Knowledge hashes are revalidated after restart. A retained
refinement cannot reuse an expired in-process skill review; it requires fresh
review while an independent note may complete. Generated skills continue through
normal candidate inspection and activation.

## Placement and acceptance

Rust owns durable jobs, generations, replay decisions, budgets and receipts.
TypeScript owns live provider/process effects, current authorization, request
projection and the existing scheduler. React presents settings and metadata.
These extend existing owners; the ownership inventory records them without
claiming complete backend language migration.

Acceptance includes actual daemon kill/restart, restarted-host analysis and
publication recovery, independent partial outcomes, source revocation,
per-worker context settings, asynchronous permission changes, continuation
recall, AND-style Knowledge discovery and request budgets. Caveman subprocess
tests use controlled protocol fixtures; they are not an installed upstream
engine benchmark. Live-provider quality/cost, installed Desktop, external-agent
interception and Windows durability remain separate work. CI fixture repairs
are deferred by the owner; focused tests do not certify the complete CI gate.
