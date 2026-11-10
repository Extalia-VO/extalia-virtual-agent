# 0064: Extalia-owned pending prompt queues

Status: accepted (2026-11-08).

## Context

Users need to edit, reorder and delete prompts before an agent receives them.
Managed sessions previously rejected a second prompt while a turn was running.
The observed Codex message box handed text directly to the original native queue.
Extalia cannot assume it can retract or mutate messages already handed to another
application.

Installed Codex CLI 0.167.0 exposes enqueue only through `codex queue`. Its
experimental app-server protocol includes `thread/queue/list`, `update`, `delete`
and `reorder`. Source review shows these use the configured persisted queue store
and can inspect a stored thread without loading or resuming it. They require a
public API connected to the same authoritative storage. A read-only public daemon
probe found the default shared endpoint absent. The current Extalia adapter does
not expose or emulate those source operations; isolated runtime compatibility
probes remain separate from live source certification.

An isolated 0.167.0 probe subsequently verified list/update/delete/reorder through
independent queue-only stdio clients against the same temporary SQLite store.
The controllers kept zero loaded threads, performed no resume/turn-start/queue-start
and made zero provider requests. This proves persisted CRUD, not live dispatch
serialization: the vendor's dispatch guard is process-local, and a queued row is
removed after turn start. Another process can mutate during that window; the RPC
has no expected revision condition. This adapter therefore does not expose that
independent-process path as safe mutation of the active Desktop queue. The public
owning-server connection remains unavailable in the inspected live environment.

## Decision

Add a host-owned per-session outbox exposed by `promptQueueStatus` and
`changePromptQueue`. The UI includes it in Chat, an Office lead's message dialog,
and observed Codex sessions. Queue creation and restart restoration start paused.
The unified-composer update below changes how an explicit message submission
admits and starts pending prompts.

Only pending entries can be edited, deleted or reordered. Every mutation compares
an opaque queue revision; reorder requires a full exact permutation of pending
IDs and excludes delivery receipts. Dispatch atomically reserves and persists an
entry as sending before invoking its original-session transport. Source identity
and execution readiness are rechecked before handoff. Native/Hermes managed
prompts reuse normal host admission, permissions and current session settings;
observed Codex prompts use the exact existing registered native source and public
queue route. Unsupported observed transports remain unsupported.

The source binding includes immutable managed session identity and workspace
boundary policy, or the observed source profile, canonical transcript fingerprint,
native UUID and working directory. A changed source disables dispatch rather than
retargeting pending text. Local deletion/receipt acknowledgement remains possible;
an emptied queue can bind to a newly selected source only for a subsequent
explicit add. Per-session readiness avoids waiting for unrelated sessions.

Entries already sending or handed off become read-only receipts. Unknown outcomes
pause the queue and are never automatically retried. An explicit acknowledgement
removes only a local receipt after checking the source; it never cancels or resends
a source prompt. A successful handoff is not a claim that the agent completed it.

Persistence is private and revisioned under `state/prompt-queues.json`, with caps
on queues, entries and text. History-off managed sessions and labels-only observed
sessions keep their queues in memory. Restart always pauses restored queues;
interrupted sending becomes unknown. Shutdown/suspend revoke pre-handoff authority,
bound external drain time, seal late writes and preserve uncertain outcomes.
Deleting a pending prompt never aborts an active turn. Attachments are not queued.

## Unified composer update (2026-11-09)

Chat, the character message dialog and observed Codex use one main message input.
While working, waiting for approval, or holding pending prompts, Send admits text
to the Extalia queue with `add.start: true`. Admission and unpausing share one
revision-checked mutation; unresolved sending/unknown receipts cannot be bypassed.
Idle managed messages with no pending queue retain their existing immediate
transport. The queue list has no second add input. Its pending rows support
drag-and-drop and keyboard/touch reorder buttons, with the source revision captured
at drag start. Editing still uses an explicit temporary editor.

`canSteer` advertises actual current-run authority, and `steer` promotes exactly
one pending item through the same durable reservation and receipt machinery.
Native chat owns a text inbox for the current invocation: it persists accepted
text before consumption, then reads it between complete model/tool steps. A late
message can continue after a model answer within that same invocation. It does
not interrupt a tool, grant an approval, cancel/restart work or create another
session. An attributed `user.intervention` with action `steer` displays the message
without ending the projected turn or expiring its pending approvals and workers.
Existing cancellation, step limits and request budgets still apply.
Observed Codex steering requires an already connected original-server controller
and the exact active connection/turn identity. Public native queue handoff alone
does not provide this capability. Hermes steering remains unavailable.

The composer clears text only after definite queue acceptance. Unknown outcomes
keep the draft and block retries even after the agent becomes idle. Queued prompts
remain text-only; attachments and explicit skill-learning selections are retained
with a visible refusal rather than silently removed. Users can send those through
the ordinary idle-session path.

## Read-only Codex source snapshots (2026-11-09)

`observedCodexNativeQueueStatus` adds a separate read-only projection of the
registered Codex source's persisted queue. The renderer supplies only its Extalia
session ID; the host resolves the original native UUID, canonical Codex home,
source fingerprint and working directory. A disposable public stdio app-server
client initializes with the experimental API capability and calls only
`thread/queue/list`. It never uses the existing control attachment path, which
can resume threads, nor queue mutation/start, turn, model or provider operations.
The read client is a helper process, not a new agent conversation.

Bound frame/text sizes, fifty-entry previews, a five-second in-memory cache,
single-flight reads and a two-reader concurrency ceiling limit inspection cost.
Only plain prompt text and counts of non-text inputs cross the view boundary;
attachments are never fetched or previewed. Pausing, removing a source, privacy
changes and shutdown invalidate pending results and drain admitted readers. Labels
only skips queue content inspection. No snapshot text is persisted by Extalia.

This is a best-effort snapshot of Codex's configured persisted queue, not its
Desktop client's complete local UI state or delivery authority. Prompts retained
only by that UI are not observable here; an empty persisted snapshot does not
prove the Desktop UI has no pending prompts. Consumed entries may disappear
between polls. Experimental methods absent in an installed version report
unsupported instead of fabricating an empty queue. Source edit/delete/reorder
remains unavailable; the independent-process mutation race described above still
applies. Schema and synthetic process/host/UI checks do not certify a live Desktop
connection or the visibility of Desktop-local prompts.

## Verification

### Composer text and delivery feedback

The renderer retains unsent text for the application lifetime, scoped by host
API, conversation and observed source/native binding. Status, display labels and
hook-hydrated project paths are not target identities. Real source rebindings use
separate drafts. Each new workspace input is separate, and its own freshly created
session inherits that pending draft before selection so a later upload/send failure
does not hide it. Text is never copied to browser storage or the host by retention.
Attachment chips and per-message skill grants retain their existing separate
lifecycle; this text store does not persist files or grants.

A shared per-draft submission lease prevents duplicate clicks across mounted
views. A validated positive receipt can settle the original draft after its view
closes. Revision checks preserve newer typing, including edits that return to the
same text. Retained text still triggers restart and browser-unload protection when
its composer is closed; reloading or exiting the application discards it.

A compact live status remains outside collapsed queue details: submitting,
accepted in Extalia, handing off, confirmed source submission, or uncertain.
Long waits get an additional explanation rather than a synthetic timeout failure.
Neither a CLI queue receipt nor native handoff proves Codex read or answered the
message. Transport loss after admission preserves the draft and blocks automatic
retry. Fresh reads alone never prove non-delivery; a user must inspect the source
and explicitly permit a retry, and unresolved host receipts remain blocking.

Temporary-profile tests cover CAS mutations, full permutations, dispatch ordering,
readiness, stale owners, pause/reservation races, unknown results, crash recovery,
transient privacy, session deletion, bounded shutdown and late-write suppression.
Host integration tests reuse the actual managed admission path and prove observed
outbox editing does not enable or send into the native source. Browser checks cover
managed and observed states, both languages/themes and desktop/phone layouts.

## References

- [Codex queue command](https://learn.chatgpt.com/docs/developer-commands#codex-queue)
- [Version-pinned queue protocol](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server-protocol/src/protocol/common.rs)
- [Original-server queue client](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/session_queue_commands.rs)
