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

The source prompt finishes before a **60-second countdown** begins. A global
notification shows the profile and remaining time. **Run now** brings the deadline
forward; **Snooze 10 min** postpones it. With no click it starts automatically after
the deadline. A new prompt resets the workspace's quiet period without shortening
a longer snooze. Foreground work takes priority; the notice explains a busy delay.
Tasks without successful current-turn tool evidence skip learning without an extra
model request. Plan mode, paused teams, explicit skill-learning prompts, unsaved
history and cancelled or failed source tasks do not schedule this curator.

The host admits at most sixteen waiting source tasks and runs one curator at a
time. Each queued task retains at most ten evidence excerpts of 2,000 UTF-16 units;
it does not store conversation history or attachments. Rust filters and redacts
these again before inference. Queue capacity and failed updates are reported,
without retrying uncertain writes or imports automatically. Learning errors do not
turn a successful source prompt into a failed task. New prompts can run while a
curator is active; changing its connection/profile settings waits for settlement.

Countdowns are scoped to the running host connection, not a durable restart queue.
Closing Extalia cancels waiting countdowns and aborts active learning, while waiting
for entered provider/file/registry effects to settle before releasing ownership.
A restart does not replay a possibly executed inference or publication.

Skill output requires Extalia skills and the Rust registry to be available. A
generated instructions-only candidate enters the existing import and inspection
workflow and is never approved or activated automatically. Candidates live in
the shared user Skills library with profile/run provenance; profiles do not
create isolated skill libraries. Workspace activation permissions still govern
their later use.

Notes are immutable Markdown files at
`Learning/<workspace-id>/<run-id>.md` in the profile's vault. A confirmed write also refreshes that profile's Knowledge index. They contain the
generated lesson, source invocation and evidence references, plus any confirmed
skill receipt. Findings are generated interpretations, not independently verified
facts. Existing differing notes are never overwritten; profile and folder identity
are checked again before saving. Private hash receipts prevent automatic repeat
imports, including uncertain outcomes that require inspection before retrying.

Failed, cancelled, read-only plan, history-off and tool-free tasks do not trigger
this phase. A paused saved team also suppresses it. Explicit `/learn-skill` turns
keep their separate user-directed workflow. The curator can skip repetitive or
unhelpful findings. This implementation covers saved Native Chat; observed apps,
Hermes-managed sessions and mission runs do not acquire new learning capabilities.
Additional profile vaults remain export destinations; the Knowledge index continues
to use the selected original vault.

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
