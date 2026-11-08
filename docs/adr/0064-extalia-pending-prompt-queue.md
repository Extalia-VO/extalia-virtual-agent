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
and observed Codex sessions. Queue creation starts paused. The user prepares
text prompts, then explicitly starts dispatch when ready. The normal Send action
continues to use its existing immediate transport.

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

## Verification

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
