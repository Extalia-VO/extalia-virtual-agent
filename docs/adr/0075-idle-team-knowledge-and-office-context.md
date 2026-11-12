# ADR 0075: Idle team knowledge and Office source context

Status: accepted, 2026-11-11. Extends ADRs 0073 and 0074.

## Problem

A snoozed learning deadline could expire while foreground workers were still
running. The old queue then started almost immediately after the worker stopped,
without giving the user another full countdown. Its curator was real, but it did
not conduct a team discussion or expose durable skill receipts to the Office.
Selecting another project's character also left the prompt in its old workspace,
and selecting a workspace removed other projects' characters from the board.

## Decision

Extend the existing connection-scoped `LearningSchedule`; do not add another
timer owner or durable replay queue. Jobs distinguish bounded task curation from
team knowledge meetings. Keep the existing 60-second quiet interval, ten-minute
snooze, sixteen pending entries, eight terminal entries and 256 recent source IDs.
Coalesce pending team meetings per workspace onto the latest completed source,
retaining the chosen snooze. A job retains bounded source context and immutable
session/profile identity, not the whole conversation or a completed run's writer.

Store the chosen delay separately from its effective deadline. New foreground
activity invalidates pending deadlines and Run-now intent. A fresh full interval
starts only when actual runs, workers, unfinished prompt queues, team planning,
memory operations, suggestions, persistence and relevant ownership guards allow
admission. A waiting job has no effective countdown, even though the legacy
`dueAt` field remains present for wire compatibility. The host alone dispatches;
client clock zero never claims that execution has started.

Foreground work reserves its ownership before yielding the queue. Human memory
operations validate workspace membership and reserve pending ownership before
awaiting that same fence; even an operation shorter than a timer interval
restarts the selected quiet period and cannot overlap active maintenance. Yield fences
timers synchronously, aborts entered maintenance and awaits its actual executor,
provider and writer settlement before foreground preparation proceeds. This
deliberately replaces ADR 0074's permission for a curator and new prompt to run
concurrently. A validation-only interrupted job can wait again. An entered or
uncertain job becomes terminal and is not automatically replayed; subsequent
successful work can schedule a fresh review. Shutdown retains the same drain and
no-replay rules. These countdowns still do not survive a host restart.

## Real team discussion and artifacts

Saved Native Chat with an enabled saved team and approved automatic notes can
schedule a knowledge meeting after successful completion, including text-based
project decisions. The curator retains its separate current-turn tool-evidence
requirement. Explicitly disabled learning, paused teams, plan mode, history-off
and explicit skill-proposal turns do not acquire automatic meeting authority.
Meeting-minute consent remains required; a missing destination prevents provider
requests rather than silently redirecting notes.

Queued source context includes only the current user prompt and final assistant
text from that turn. The shared credential redactor masks complete values before
bounding either field; older conversation turns and attachment/tool payloads are
not retained as meeting context. The meeting helper also redacts external context
before clipping so a long credential cannot be split into an unrecognized suffix.

At execution, re-read the source session, current roster, approved routes,
credentials, workspace access fingerprint and vault policy. Revalidate before
requests and note publication. Use `workspaceSessionBoundaryKey` and the session's
saved connection, preserving Native continuity when workspace defaults differ.
All entered parallel preparation operations settle before releasing ownership.

Invoke the existing two-round `conduct_team_meeting` runtime with at most thirteen
saved members and read-only tools. Participants keep their approved connection,
model and feature restrictions. Build fresh ADR 0073 skill preparation for every
participant and forward it into both rounds. The inner preparation guard remains
synchronous; awaited session/profile checks wrap the preparation callback. No
completed source-turn preparation closure or approval is reused.

Rust continues to pin, render and publish real meeting minutes. Strict protocol
events and actual worker lifetimes drive Office attendance. Discussion outcome
and durable note acknowledgement remain separate. Drain the note pin and event
writer even if result projection fails; refresh the matching Knowledge index only
after an acknowledged note publication.

A skill flash requires an actual registry receipt with `created: true` and a
recorded immutable revision. Existing identical content, unavailable or unknown
receipts do not imply a newly saved skill. New/revised wording needs consistent
registry history; otherwise say saved. Record the receipt before later completion
or export failures so partial success remains visible. Candidate inspection,
approval and activation remain distinct; this work grants no automatic activation.

## Presentation and source context

Keep one App-level countdown/controller. Portal its view into the measured Office
prompt dock when that slot is mounted, otherwise retain its global presentation.
Show project/session labels, waiting-for-idle, current countdown, actual meeting
results and bounded skill receipt flashes above the prompt. Run-now cannot bypass
host work or revision checks. Completed receipts can be dismissed locally; neither
timers nor receipt data contain provider instructions or new execution authority.

Explicit character, board and notification selection activates that character's
source session and workspace. A worker still addresses its lead's managed prompt;
an observed source retains its native session identity. The board and scene stay
global, with their existing capacity limits and observed-input priority. Workspace
selection does not reset standby or camera scope. Automatic camera attention
remains visual; existing persistent Follow behavior is preserved.

## Scope and verification

This is saved Native Chat maintenance and Office context selection. It does not
create a general calendar/Schedule page, resumable cross-provider native sessions,
or new observation/import capabilities. Existing observed controls and reviewed
Native workspace moves remain their own contracts.

Deterministic scheduler tests cover selected-delay restart, multiple lifetimes,
stale callbacks/revisions, coalescing, actual abort-ignoring drain, no replay and
truthful partial receipts. Runtime/host tests exercise genuine meeting rounds,
per-connection skill preparation and temporary exports. UI tests cover EN/ID,
receipt semantics, portal ownership and global-board/source-context behavior.
The release tracker records the combined gate and any environment limitations.
