# Automatic learning after Native and observed work

Extalia can automatically save useful Knowledge notes and create reusable skill
candidates after eligible work. In **Settings → Storage → Workspace vault
profiles**, choose notes, skill candidates or both, or disable learning. Managed
vaults enable Native learning by default; explicit opt-outs stay disabled.
Previously configured custom folders without learning consent stay off. Skill
output also requires the connection's Extalia skills feature and the Rust registry.

Observe learning has its own profile opt-in. Enabling it permits Extalia to review
new eligible activity from watched apps. Existing visible history establishes a
watermark; enabling the feature does not replay the whole conversation as a paid
learning backlog.

Operational work memory complements this artifact review. With Native Extalia
memory, history and profile learning enabled, a bounded local record is captured
even when the turn fails or is cancelled. Observe uses its own opt-in and can
retain newly terminal failed/cancelled frames as attributed evidence. These
records do not themselves schedule successful-task curation. Local capture and
retrieval call no model; a later enabled curator can use the history as context
while still grounding a new note or skill in its current evidence.

## Where learning belongs

| Source | Knowledge destination |
| --- | --- |
| Saved Native conversation | The workspace's selected vault profile |
| Observed conversation associated with a registered project | That workspace's selected vault profile |
| Observed conversation explicitly resolved as unbound | The default vault profile, under `Learning/global-observe/` |
| Invalid or ambiguous observed association, missing workspace or unknown profile | No learning destination until the association/settings are resolved |

Each isolated workspace has a dedicated stable profile and managed folder at
`~/.extalia-vo/vaults/<profile-id>`. Shared workspaces keep their selected profile.
Profile names are shown in the UI; renaming one does not move its files. The
Knowledge page's workspace selector opens that profile's actual index, including
a selected custom folder. Workers inherit the source workspace's vault boundary.

Saving a custom folder with notes enabled authorizes learning writes to that
folder. Changing settings cancels pending updates for the previous destination;
existing notes are not moved or deleted. Extalia leaves `.obsidian` configuration
untouched. Global Observe can use the default Knowledge index but receives no
project filesystem permission and does not create a workspace. Invalid or
ambiguous project links never silently become global learning.

Profiles group Knowledge notes. Skills use the shared user library; profiles do
not create private skill libraries or separate credential stores. Project facts
belong in the selected vault; generated reusable skills should replace private
names, paths and identifiers with parameters.

## What starts a review

A successful saved Native task can supply recent successful tool results and the
current user/assistant text. A useful conversation can therefore preserve a
decision or preference even when no tool was used. Current conversation text is
labelled as a speaker's claim; an assistant's report does not become independent
proof that a test passed or a file changed. Recognized trivial greetings can skip
the model request, and the curator can skip repetitive or unsupported findings.

Plan mode, history-off, failed and cancelled source tasks do not schedule this
curator. Explicit skill-learning requests use their separate proposal flow and
do not also enqueue duplicate post-task curation. The saved profile policy remains
authoritative; no per-message checkbox is needed for enabled automatic learning.

Observed episodes retain the external app, conversation and event attribution.
They are untrusted reports, even when the external app reports success or appears
idle. Learning requires current watching/privacy state and explicit Observe
consent. Resumed work, a changed project association or revoked consent prevents
publication under stale authority.

Native learning uses the saved source connection. Registered Observe learning
uses the workspace's saved connection. Global Observe prefers the sole eligible
connection selected by default-profile workspaces; if none is selected there,
it can use the sole eligible saved connection. The connection must keep history.
Multiple possible routes, no usable route or history-off show a connection
problem before a curator model call. Extalia does not guess another account.

## Countdown and bounded work

The source task finishes before a **60-second idle countdown** begins. The shared
notification shows the project or global source, session, profile and remaining
time. Pending decisions appear above the main prompt; accepted and running
work appears as a compact top-left notification, including on other pages. **Run now** advances an armed deadline; **Snooze 10 min** chooses
a longer idle interval. With no click, learning starts after the deadline when
conflicting work has settled.

Conflicting work restarts the full chosen delay after it settles. For an isolated
vault, unrelated local persistence holds dispatch until writes settle without
restarting elapsed quiet time. A waiting
notice shows the selected interval without an active clock. Run now cannot
override active work or its queued successor. A unique isolated workspace with
a unique non-default vault can learn alongside known activity in other profiles.
Shared/default learning, unknown ownership, privacy/configuration changes and
shared-resource work retain broader guards.

The host admits at most sixteen waiting updates and executes one maintenance job
at a time. It retains bounded evidence excerpts rather than a source conversation
or attachments. Rust redacts and selects at most ten records, each up to 2,000
UTF-16 units, with a separate serialized evidence bound.

Automatic curator limits are:

- Six model requests and eight unique indexed reads. Repeated identical read
  arguments reuse their previous result.
- A 12,000 per-request and 32,000 aggregate input estimate, reserved before model
  entry. These estimates are not exact provider-token counts or a cost quote.
- A **90-second analysis allowance** by default, configurable up to 120 seconds,
  followed by a **separate 90-second publication allowance** for accepted output.
- A final request that can only submit a finding or skip reason. A valid terminal
  submission immediately ends analysis.

The curator can use `knowledge_search`, `knowledge_read` and eligible read-only
Skills discovery. When the selected connection enables memory, it also receives
bounded historical work context and read-only `work_memory_search/read`. The
historical records are separate from current task evidence; their IDs cannot
stand in for a current read or test. It cannot search arbitrary project files, browse the web,
run commands, delegate, activate skills or edit the vault through general tools.
It checks related indexed notes and existing skills using supplied evidence.
Obsidian `[[wikilinks]]` should reference notes actually read.

Foreground prompts take priority over conflicting maintenance. Extalia requests
cancellation and waits for the real provider, file and registry promises to
settle before releasing their ownership. A provider that ignores cancellation
can take longer than the analysis allowance. Learning failure does not change a
successful source prompt into a failed task.

## Saved Knowledge and skill candidates

Closing a finished learning notice remembers that dismissal in this browser's
local storage, scoped to the host profile and data directory. Navigation and
reload do not reopen that same result. New jobs and newly saved skill revisions
can still notify. Dismissal does not delete the underlying notes, candidates or
job history. Clearing browser storage clears this preference; Web and Desktop
do not share browser storage. If browser storage is unavailable, dismissal lasts
for the current mounted view only.

Notes are immutable Markdown at `Learning/<workspace-id>/<run-id>.md` inside the
selected profile vault. Global Observe uses `global-observe` as that path's
workspace segment. Notes contain the generated lesson, source identity and
evidence references, with `kind` and `tags` front matter for indexing. The text
remains an attributed interpretation rather than independently verified fact.

Knowledge publishes before a skill proposal, and each artifact has its own
admission and durable confirmation. Slow or unavailable skill inspection cannot
block an already prepared Knowledge write. Existing differing notes are never
overwritten; profile revision and folder identity are checked again before save.
The note deduplication scope includes the admitted profile revision, so a changed
vault destination cannot reuse the previous destination's confirmation.

A confirmed note triggers the correct vault's Knowledge index refresh. The notice
distinguishes **saved and indexed** from **saved, index refresh incomplete**. Here,
indexed means the destination vault's index refresh completed; it does not prove
retrieval will select that particular note or restore a manually deleted file.
The Markdown file can exist even if refreshing the index fails. Meeting minutes
retain the same independent index-refresh result.

Skill candidates enter the shared user Skills library as immutable generated
revisions. The curator can inspect eligible existing skills before proposing a
new procedure or a same-name improvement. Instructions should cover **When to
Use**, **Procedure**, **Pitfalls** and **Verification**, with a description that
explains the trigger. Built-in skills are not rewritten.

Mandatory inspection, review, approval and activation remain separate. A saved
candidate is not an active skill, a clean-scan claim or proof of improved task
performance. An unavailable scanner retains the actual registry state. Workspace
activation permissions still govern later use.

The Office announces an actually saved immutable skill revision. It labels new
and revised candidates only when registry history establishes the difference.
An identical existing revision does not create a new-save flash. If Knowledge or
another later stage fails, the confirmed skill remains visible with the partial
result.

## Linked findings and corrections

The curator can connect a new finding to an existing note after reading it from
the selected profile. Extalia validates the path and any heading/block anchor,
then writes a canonical Obsidian wikilink. Search snippets alone cannot justify a
link. Unread paths, ambiguous names and paths outside the selected vault receive
one bounded correction opportunity; they do not become verified graph edges.

A generated note can describe an amendment (`Updates:`) or an unresolved
disagreement (`Contradicts:`), with its evidence and the referenced source hash.
The original note is preserved. When that older note is read later, up to eight
current amendment/conflict sources appear separately, so the agent can inspect
their evidence. The automatic curator receives a compact subset of at most three
hints within its 2,000-character tool-output limit, with truncation identified.
A later timestamp or an `Updates:` label does not establish truth.
If a referenced source changes during publication, the finding is refused rather
than attached to an unseen revision.

The derived Knowledge index migrates to schema 3 and reparses existing Markdown
once for these relation types. This does not edit vault notes. An older Extalia
binary cannot open the newer derived index; return to a newer binary or follow
the index rebuild workflow when downgrading.

## Skill categories, usage and completeness

New generated skills persist one to eight category slugs and one to sixteen task
intent identifiers in their manifest and verified `SKILL.md` metadata. Grimoire
shows the declared categories and intents, supports category filtering and shows
the description. Native uses the metadata with the current task to select
relevant active, workspace-approved skills. Intents are identifiers such as
`validate_records`; natural-language usage guidance belongs in **When to Use**.

Generated proposals must contain populated **When to Use**, **Procedure**,
**Pitfalls** and **Verification** sections. Headings inside code fences and empty
sections do not satisfy this check. Required metadata, bounded references and
one to six declarative verification cases are checked independently by Rust.
Legacy packages without these fields are shown as incomplete or unchecked;
existing active authority is not silently changed.

## Testing a candidate before replacement

Open the candidate's testing panel in Grimoire, choose a saved Native workspace
with Extalia Skills and a configured model, and run the evaluation. This explicit
action uses that connection for bounded inference. It does not grant tools,
execute scripts, read current project files or activate the candidate.

Rust pins the candidate and current active baseline. The host asks Native to
answer the same synthetic case inputs with each procedure separately, without
tools, conversation history or the expected answers. Rust checks the resulting
answers against hidden required/forbidden substrings and records the outcome
against the exact trees and baseline. Missing, refused, truncated or malformed
answers are insufficient evidence. Failed tests keep the old active version and
leave the candidate available for correction.

The panel shows completeness, case counts, candidate and baseline results, and
stale evidence. A passing candidate still needs the existing scanner and user
approval/activation flow. Changing the candidate or active baseline invalidates
pending promotion evidence; tests must run again. Approval and activation check
this independently in the backend. Rerunning a pending candidate's tests also
invalidates its previous approvals, so a new passing run needs fresh approval.
Previously activated versions retain the
existing explicit rollback workflow.

Passing means the stored synthetic declarative suite passed. It does not prove
all real tasks succeed, that external tools were exercised, or that every change
is an improvement. Candidate-authored tests remain review material. There is no
automatic promotion or general-purpose executable sandbox. An older host without
the evaluation capability must report it as unavailable.

## Improving an existing generated skill

Curators have a separate read-only catalog of generated candidates, including
inactive and quarantined drafts with confirmed provenance in the same profile
and workspace. These reads are review material; they do not load an executable
skill. A draft from a different workspace or unknown provenance is not silently
admitted to automatic refinement.

Before proposing a revision, the curator reads the complete current `SKILL.md`,
manifest, `TESTS.json` and existing Markdown references through bounded pages. Extalia binds the proposal
to the actual read receipt, base revision and hash. A concurrent newer revision
requires another review. Identical procedure/reference content produces no new
revision. A change creates an immutable candidate and preserves the previous
active revision until the normal inspection and approval workflow selects a
replacement.

Stable names and identical logical content avoid empty revisions. Equivalent
procedure/reference content under another generated name is refused, and
conservative intent/procedure overlap checks require review of a possible
duplicate instead of silently creating or merging a class. This is not universal
semantic deduplication. Refinements retain prior reference paths and verification
cases/assertions; new regression cases may be added within the suite bound.

Generated candidates can include up to four Markdown references under
`references/`, limited to 16 KiB each and 48 KiB together. Executable scripts are
not part of this automatic proposal format. Very long existing packages may need
more reads than a bounded review allows and will remain unchanged. A useful user
correction can guide a later review, but a model's claim of success is not a test
result. Saving a candidate is distinct from demonstrating improved task results.

## Partial results and recovery limits

Learning can finish with one artifact saved and another failed. The notice keeps
each result separately and reports partial completion rather than discarding the
successful result. Failure to prepare a note writer remains visible even when
skill creation succeeds. Connection, provider, timeout, invalid-request,
authority and publication categories help identify where work stopped.

A publication attempt is not a confirmation. Rust stores the attempted admission
and a separate immutable confirmation after receiving the writer's result.
Confirmed output can be recognized without repeating the write/import. Older
attempted markers or lost acknowledgements remain uncertain; inspect existing
notes and Skills before trying to reproduce the work. Extalia does not silently
retry an effect that may already have happened.

Countdowns and curator analysis are scoped to the running host. Closing Extalia
cancels waiting work and aborts active work while draining entered effects.
Restart does not replay possibly executed inference or publication. Durable
artifact confirmations survive restart, but they are not a durable source-job
queue. They also do not automatically recreate a note deleted later by hand.

The operational-memory outbox has a different purpose: it can recover an exact
local capture after restart without repeating inference or publication. It does
not turn this scheduler into a durable paid-job queue. Source/profile consent is
rechecked on replay, and complete history before first enable is not backfilled.

## Optional team Knowledge meetings

An enabled saved Native team can separately review completed work when automatic
notes and meeting-minute exports are enabled for its vault. This automatic review
uses **one round and at most three saved members**, using their approved model
routes and indexed skill review tools. Each member gets at most three model
requests and two indexed reads; the meeting admits six reads overall and a 24,000
aggregate input estimate, with an 8,000 estimate per request. Fallback models share
these budgets. Its last request asks for a final finding without tools.

The review uses supplied completed-work evidence, the latest user correction,
permitted prior work context and indexed Knowledge/Skills
reads, with no broad filesystem search or project rediscovery. Ordinary meetings
explicitly requested by the user retain their normal configuration. Extalia keeps
one pending automatic meeting per workspace and replaces its source with the
latest completed task while preserving the chosen snooze.

Real meeting events drive Office activity. Saved minutes remain visible even when
the discussion has incomplete contributions or later cleanup fails. Entered or
uncertain work is not silently retried. Selecting a character activates its source
session and workspace; automatic camera attention only changes the view.

## Explicit requests to learn a skill

A Native Chat request such as “Learn this procedure as a skill” or “Pelajari
tautan ini sebagai skill” can use the separate one-candidate proposal flow.
`/learn` and `/learn-skill` remain available. A link without a clear request to learn
does not itself authorize a proposal.

A supplied public link can be read through the bounded source reader. Its text is
untrusted evidence. The reader limits requests and content and rejects credentials,
private-network addresses, query parameters, unusual ports and unsafe redirects.
It does not install or execute anything. A denied or failed source read cannot
justify a candidate claiming to summarize unseen content. Explicit learning still
follows workspace write approval, plan restrictions, the saved profile policy and
the registry inspection workflow.

## Backend and platform availability

The Rust sidecar owns curator state, evidence/model-result processing, limits,
deduplication, artifact confirmations and note/skill staging. The host enforces
current consent, supervises effects and projects results into the UI. Inference
runs at the approved provider. An older or unavailable daemon stops learning
without falling back to JavaScript artifact writes.

The learning/artifact backend is available on macOS and Linux. Windows does not
yet advertise equivalent artifact publication: directory-handle and reparse-point
protections remain to be implemented and tested. Scanner platform support has
separate requirements; an unavailable scanner never becomes an approved skill.
Existing indexed Knowledge and skill lifecycle/read operations remain separate
capabilities. Managed external runtimes and mission execution do not inherit new
learning capabilities from this Native/Observe change.

See [ADR 0087](../adr/0087-bounded-self-learning-and-artifact-receipts.md),
[ADR 0088](../adr/0088-grounded-knowledge-and-skill-refinement.md), and the
[reliable self-learning PRD](../product/prd-reliable-self-learning.md) for the
implementation, Hermes comparison, acceptance evidence and remaining work.
The operational capture/recall and Native compaction extension is documented in
[ADR 0089](../adr/0089-operational-work-memory-and-context-reuse.md).

## Manual Knowledge updates

Choose a workspace on Knowledge and click **Update knowledge**. Extalia uses a
saved Native session with an enabled team and the workspace's selected Knowledge
vault. The source build starts after ten quiet seconds; conflicting foreground
work postpones that interval, and working team members are excluded. A manual
request can run even when automatic learning or meeting-minute exports are
disabled. Repeated requests coalesce into one pending update for the workspace.

The build reads eligible Markdown from the registered primary project folder,
including nested documentation and existing source vault folders. Hidden folders,
credentials, dependencies, symlinks and the destination vault are excluded. Rust
captures complete bounded UTF-8 source files and hashes; Native reviewers receive
bounded excerpts from every captured source. Native selects topics and exact
source evidence IDs; the host expands those IDs into unchanged source quotations
instead of asking the model to transcribe text. Rust independently checks the quotations and source freshness
before publishing. Source text remains untrusted evidence, including any embedded
instructions. A source's declared canon, draft or legacy status remains attributed
to that source; a build does not independently establish its factual truth.

Native extraction uses at most nine primary batches and twelve model requests
overall, reserving room for bounded quotation correction or one retry of a failed
batch through the next approved idle route. Each request has a 120-second
allowance and a compact topic/quotation limit. The build allows ten minutes, or
fifteen minutes for inventories of at least 128 sources; retries do not reset that
budget. Cancellation still waits for entered operations to physically settle.

Generated Markdown lives under `Projects/<workspace-id>/Knowledge/`:

- `Overview.md` links to folder maps and read coverage.
- `Maps/` groups source notes and the topics supported by them.
- `Topics/` contains neutral topic labels, exact checked quotations and source links.
- `Sources/` contains hashed source snapshots, declared status, source relationships
  and links back to relevant topics. Large sources use linked pages.
- `Coverage.md` reports exclusions and unresolved or ambiguous original references.

This is an ordinary Obsidian-compatible vault. Full vault-relative wikilinks with
display labels avoid duplicate-basename ambiguity. Only unique, captured source
targets become graph edges; missing original references stay in coverage rather
than creating phantom notes. Exact byte duplicates share one source snapshot and
retain their original paths as provenance. Different source versions remain
separate. These conventions follow Obsidian's [internal links](https://obsidian.md/help/links),
[properties](https://obsidian.md/help/properties) and [graph](https://obsidian.md/help/plugins/graph)
documentation; `.obsidian` settings are not changed.

An unchanged source fingerprint and matching generated-note hashes reuse the
existing publication without another Native extraction request. Changed sources
update stable managed paths; user-modified output is retained as a conflict.
Removed source files and previously generated notes are not silently deleted.
The receipt reports actual source coverage, unique contents, exact duplicates,
created/updated/unchanged notes, topic count, conflicts and indexing. Bounded topic
quotation omissions are counted separately from complete source snapshots.
Full source reads, sources represented through bounded Native input, truncated
model excerpts and sources ultimately cited are separate counts.

Pending automatic decisions appear above the prompt. Once accepted or started,
progress moves to a compact top-left notification. Project Knowledge builds,
automatic reviews and independent skill learning have separate labels. Saved
automatic reviews use a concise title; their source session and meeting identifiers
link to the full recorded review.
Completed team work has one Knowledge writer;
if meeting-note consent is unavailable, ordinary permitted note curation remains
available. A saved note and its indexing acknowledgement are reported separately.
