# Automatic learning after Native tasks

Automatic learning is on by default for Extalia-managed vaults, including new
isolated workspaces. An explicitly disabled policy stays disabled. Previously
configured custom folders without learning consent stay off. In **Settings →
Storage → Workspace vault profiles**, choose notes, skill candidates or both,
or disable learning. Skills also require the connection's Extalia skills feature.

Each isolated workspace gets a dedicated stable profile and managed folder at
`~/.extalia-vo/vaults/<profile-id>`. Existing shared workspaces keep their selected
profile. Profile names are shown in the UI; renaming one does not move its files.
The Knowledge page's workspace selector opens that profile's actual Rust index,
including a chosen custom folder, rather than always displaying the default vault.
Workers inherit the source workspace's vault boundary. Profiles group notes;
they do not introduce separate credential stores or private skill libraries.

Saving a chosen folder with notes enabled authorizes learning writes to that
folder. Pending updates for previous settings are cancelled, never redirected.
Existing notes are not moved or deleted. Extalia leaves `.obsidian` configuration
untouched and does not grant the model general access to the vault.

After a successful task with useful current-turn tool evidence, a bounded curator
uses the lead's already approved model connection. It reviews that evidence and
submits a reusable finding or a skip reason. It does not receive general file,
search, web or memory tools or gain access to the profile vault.
It cannot run commands, edit project files, change memory, activate skills or
delegate further. The Office sends this real knowledge activity to an available
Skills-room station. Room occupancy has three authored stations; overflow waits
at its desk until a station becomes available.

The source prompt finishes before a **60-second countdown** begins. A shared
notification shows the project, session, profile and remaining time. In the 3D
Office it appears immediately above the main prompt; on other pages it remains a
global notice. **Run now** brings the deadline forward; **Snooze 10 min** postpones
it. With no click it starts automatically after the deadline, once conflicting work has settled. A unique isolated workspace with a unique non-default vault profile can learn while known prompts, workers, planning, memory and queued messages in other profiles continue, including scoped Observe and observed-memory work. Unbound Observe activity is assigned to the default/global profile for scheduling only; this grants no new workspace, Knowledge access or consent. Ambiguous or invalid workspace links and unknown effects remain guarded. Work in the same vault still pauses the countdown. Shared/default vaults, privacy/configuration changes and shared-resource work retain broader guards. Only one maintenance job executes at a time.

After conflicting work settles, the **full selected delay starts again**: ten minutes if you chose Snooze, or sixty seconds otherwise. While waiting, the notice shows the selected interval rather than an ETA for other work; once armed, it shows the live remaining time. A waiting notice has no active clock. Run now advances an armed deadline but cannot override conflicting active work or its queued successor.
Tasks without successful current-turn tool evidence skip learning without an extra
model request. Plan mode, paused teams, unsaved history and cancelled or failed
source tasks do not schedule this curator. Ordinary successful work may produce
a useful finding or a skip; automatic learning does not create a skill for every
message. It remains governed by the saved profile policy, including an explicit
disable setting.

The host admits at most sixteen waiting updates and runs one maintenance job at a
time. Each queued task retains at most ten evidence excerpts of 2,000 UTF-16 units;
it does not store conversation history or attachments. Rust filters and redacts
these again before inference. Queue capacity and failed updates are reported,
without retrying uncertain writes or imports automatically. Learning errors do not
turn a successful source prompt into a failed task. New prompts take priority:
Extalia cancels conflicting active maintenance and waits for its actual provider
and file operations to settle before the new prompt proceeds. A known foreground
operation in another profile can proceed alongside isolated maintenance.
Cancellation does not imply that an external provider has already stopped. Changing connection/profile
settings also waits for settlement. Unknown execution ownership, unresolved
missions/preparations, handovers and shared configuration mutations retain their
conservative guards. Shared registry and persistence operations retain their
existing admission and settlement checks; no writes or provider effects are
replayed to obtain concurrency. One maintenance job still runs at a time.

Knowledge notes and indexes remain scoped to the selected vault profile. Skills
are a shared user library, not a private library per vault: a curator only adds a
source-bound candidate. Mandatory scanner inspection, explicit review/approval
and activation remain separate. An isolated vault never grants another workspace
access to its notes or activates a generated skill automatically.

## Team meetings for project knowledge

An enabled saved Native team can also review completed work in a real two-round
meeting. Automatic notes and meeting-minute exports must be enabled for its vault.
The meeting uses the source session's configured members and approved model
connections, read-only project tools, and each member's automatic skill context.
It can capture text-based project decisions even when the source did not use a
file tool. Extalia keeps one pending meeting per workspace and updates its source
to the latest completed task while preserving your chosen snooze.

The notice identifies an upcoming meeting, waits while conflicting work is active, and offers Run now or Snooze. Its countdown starts automatically after that work settles; unrelated default/global Observe work does not hold an isolated vault. Actual
meeting events drive the Office characters; the notification reports a saved
knowledge note only after the exporter confirms it. A cancelled or failed
discussion is shown separately from any note that was already saved. Entered or
uncertain maintenance is never silently retried; fresh completed work can queue a
new review.

Selecting a character activates its session and project workspace. The **Agents
& sessions** board continues showing all projects within its normal display
limits. Worker selection addresses the managed lead; observed characters keep
their original source session. Automatic camera attention only changes the view.

Countdowns are scoped to the running host connection, not a durable restart queue.
Closing Extalia cancels waiting countdowns and aborts active learning, while waiting
for entered provider/file/registry effects to settle before releasing ownership.
A restart does not replay a possibly executed inference or publication.

Skill output requires Extalia skills and the Rust registry to be available. A
generated instructions-only candidate enters the existing import and inspection
workflow and is never approved or activated automatically. Candidates live in
the shared user Skills library with profile/run provenance; profiles do not
create isolated skill libraries. Workspace activation permissions still govern
their later use. A candidate is a saved draft, not an active skill or a
certification of its instructions or sources.

When you explicitly ask in a Native Chat message to learn a reusable skill, Extalia
can use the separate one-candidate proposal flow instead of scheduling the
post-task curator. You can ask naturally, for example, “Learn this procedure as
a skill” or “Pelajari tautan ini sebagai skill.” A supplied public link may be
read through the bounded source reader; its page text is untrusted input, not
instructions to follow. The reader limits requests and content, rejects
credentials, private-network addresses, query parameters, unusual ports and
unsafe redirects, and does not install or execute anything. A failed or denied
source read cannot justify a candidate that claims to summarize unseen content.
This explicit request still follows workspace write approval, the saved profile
policy, and the skill registry's inspection workflow. The legacy `/learn-skill`
command remains available. A link mentioned without a clear request to learn from
it does not authorize a skill proposal.

The Office flashes a notification when a new immutable skill revision is actually
saved. It distinguishes new and revised candidates only when registry history
establishes that difference. An identical existing revision does not produce a
new-save flash. If another part of learning fails after the save, the notice keeps
the confirmed candidate and explains the partial result. No checkbox or special
prompt is required for enabled automatic learning.

Notes are immutable Markdown files at
`Learning/<workspace-id>/<run-id>.md` in the profile's vault. A confirmed write also refreshes that profile's Knowledge index. They contain the
generated lesson, source invocation and evidence references, plus any confirmed
skill receipt. Findings are generated interpretations, not independently verified
facts. Existing differing notes are never overwritten; profile and folder identity
are checked again before saving. Private hash receipts prevent automatic repeat
imports, including uncertain outcomes that require inspection before retrying.

Failed, cancelled, read-only plan and history-off tasks do not trigger maintenance.
Tool-free tasks skip the curator, while a configured team can still review their
completed discussion. A paused saved team also suppresses it. Explicit `/learn-skill` turns
keep their separate user-directed workflow. The curator can skip repetitive or
unhelpful findings. Explicit skill-learning turns use their proposal flow and do
not also enqueue the automatic curator. This implementation covers saved Native
Chat; observed apps, Hermes-managed sessions and mission runs do not acquire new
learning capabilities. The Knowledge index follows the selected workspace's
actual vault profile.

The existing Rust sidecar owns the curator's local state machine, evidence and
model-result processing, limits, deduplication, generated skill files and note
publication. Filesystem work runs on a bounded worker, separately from the daemon's
control requests. The host remains the consent and UI bridge and executes the
approved model's HTTP requests; language-model inference runs at that provider.
An older or unavailable daemon stops learning before inference, with no fallback
to JavaScript note writes. Ordinary Native Chat tools and provider adapters remain
separate transitional host paths. See [ADR 0067](../adr/0067-rust-owned-learning-and-profile-artifacts.md).

The new learning/artifact backend is available on macOS and Linux. Windows does
not yet advertise it: equivalent directory-handle and reparse-point checks remain
to be implemented and tested there. Automatic curation and native note/skill
staging therefore report unavailable on Windows; the existing indexed Knowledge
operations and skill lifecycle/read operations remain separate capabilities.
