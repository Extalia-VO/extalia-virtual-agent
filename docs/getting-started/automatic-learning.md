# Automatic learning after Native tasks

In **Settings → Storage → Workspace vault profiles**, select a profile, enable
automatic learning and choose **skill candidates**, **learning notes**, or both.
Save once. The setting applies to future saved Native Chat tasks in workspaces
assigned to that profile; no message checkbox or repeated instruction is needed.
Existing and new profiles start with automatic learning disabled.

Each profile has one Obsidian-compatible vault, shared by its assigned workspaces.
Enabling learning notes authorizes that exact selected vault independently of
meeting-minute exports. Changing the vault requires saving that consent again.
Extalia does not modify Obsidian's configuration or add vault folders to the
model's read permissions. Existing workspace write boundaries still apply.

After a successful task with useful current-turn tool evidence, a bounded curator
uses the lead's already approved model connection. It reviews that evidence and
submits a reusable finding or a skip reason. It does not receive general file,
search, web or memory tools or gain access to the profile vault.
It cannot run commands, edit project files, change memory, activate skills or
delegate further. The Office sends this real knowledge activity to an available
Skills-room station. Room occupancy has three authored stations; overflow waits
at its desk until a station becomes available.

The parent task remains busy until the curator and any storage operations settle.
Later messages stay queued during this phase. Stopping cancels the phase, while
Extalia still waits for in-flight operations to settle before releasing it.
Learning errors are reported separately and do not turn successful source work
into a failed task.

Skill output requires Extalia skills and the Rust registry to be available. A
generated instructions-only candidate enters the existing import and inspection
workflow and is never approved or activated automatically. Candidates live in
the shared user Skills library with profile/run provenance; profiles do not
create isolated skill libraries. Workspace activation permissions still govern
their later use.

Notes are immutable Markdown files at
`Learning/<workspace-id>/<run-id>.md` in the profile's vault. They contain the
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
