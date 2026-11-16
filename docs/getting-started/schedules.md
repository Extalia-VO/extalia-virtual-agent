# Schedules

Open **Schedules**, choose a project, then use a Suggested card or **New schedule**.
The first page also lists saved schedules with their next occurrence, last
dispatch, pause/resume, edit, delete, Run now and a link to the conversation.

Suggested cards are editable templates. Project review uses the selected project;
session follow-up uses a recent conversation in that project. A Knowledge review
template appears when the host reports a matching vault-profile binding. These
suggestions do not read vault notes, infer user intent or enable jobs by themselves.
Review the draft and explicitly save it.

You can also ask **Extalia Native** in an ordinary chat, for example:

- “Every Monday at 9 AM, review this project’s open work in this conversation.”
- “In two hours, check the build results using a new session.”
- “Save a paused daily project review at 5 PM.”

The main Native agent reads the host clock and existing jobs before saving. It
asks about ambiguous dates, frequency or timezone, then reports the actual saved
job ID and next occurrence. The job appears in the same project’s Schedules
list, where you can edit advanced settings. Current conversation is the default;
new reusable or fresh-per-run sessions must be requested explicitly. A
conversation with history disabled cannot be a persistent existing-session target.
Reusable new sessions also require retained history in their destination. If a
previously bound conversation is removed, the job reports the missing target
instead of silently replacing its history.
Plan mode can inspect jobs but cannot create them. Observed apps, delegated
workers and scheduled invocations do not receive this job-creation tool.

Creation receipts prevent the same tool invocation from duplicating, rewriting
or resurrecting a job after an edit or deletion. These private receipts are
bounded to 1,024 per profile without eviction; at capacity, new prompt-created
jobs are refused and the regular Schedules editor remains available. Different
requests remain different jobs. This is not an exactly-once execution guarantee.

The simple editor asks for a name, instructions, session and frequency. Daily,
weekdays, weekly, hourly and one-off choices avoid writing cron. **New session**
creates a conversation at the first execution and reuses it afterwards. Choose an
existing session to retain its exact identity and history. A missing selected
session must be replaced explicitly; it never silently becomes another one.

**Advanced** contains raw five-field cron, intervals, a fresh session on every
occurrence, derivation from an existing Native conversation, model/effort,
permissions, team/workers and missed-occurrence policy. Derivation requires a
readable Native source within the current project access boundary. Requested
settings that cannot be applied stop dispatch instead of falling back silently.

Cron uses the executing agent host's local timezone, shown when the host reports
it. This is not yet a persisted timezone per job. One-off date/time inputs use
the browser's local timezone. When browser and host timezones differ, the editor
does not present a browser-calculated cron time as an authoritative host preview;
the saved schedule provides the host's actual next timestamp.
Cron follows local clock occurrences: a repeated fall-back time can have two
distinct UTC occurrences, while a missing spring-forward time advances to the
next matching local date. Use an interval for elapsed-time scheduling.

Schedules run while Desktop or the Bridge host is running. They are not installed
into the operating system's cron service and do not wake a sleeping computer.
New jobs default to **Run once after coming back online**: when the host starts
again or wakes after missing several occurrences, one catch-up runs, then the
usual cadence resumes. Existing jobs retain their saved policy. Choose **Skip**
explicitly to advance to the next normal occurrence without backfilling. The
same policy applies after restart and sleep; a delay of up to 60 seconds is
normal timer jitter, rather than a missed occurrence.

A bounded 30-second clock check re-evaluates forward/backward clock changes;
it does not promise real-time execution while the OS suspends the process.
Intervals stay anchored to their planned slots, rather than drifting with slow
dispatch. Run now before a pending deadline is an extra explicit occurrence;
the pending deadline remains. Run now at or after a deadline consumes that slot.

If an automatic recurring catch-up targets a busy conversation, it waits with
persisted delays of 1, 2, 5 and 10 minutes. The list shows its retry time. An
explicit Run now while that same conversation is still busy leaves the pending
automatic retry intact. Once this retry budget is exhausted, the job returns to
its next normal slot. Pausing, editing or deleting a job clears its old retry;
resuming establishes a fresh future occurrence. One-off jobs retain their
explicit single-attempt behavior.

Before creating a destination or submitting instructions, a Native HTTP job
checks its configured endpoint with a short HEAD request through the same
transport. A verified connection-level unreachable result leaves one occurrence
queued with delays of 1, 2, 5 and 10 minutes, then at most one check every 10
minutes while the endpoint remains unavailable. The queue survives restart and
coalesces additional missed slots. No new session or prompt is created for each
failed check. Once reachable, it dispatches once and returns to normal cadence.
One-off jobs can wait for this pre-admission connection recovery, but their
existing single-attempt busy-target behavior still applies.

This check does not send model instructions or credentials, follow redirects,
or require public internet for local models. Any HTTP response—including 401,
405 or a redirect—allows normal admission. Timeouts, TLS errors and unknown
failures do not prove a safe retry. Experimental completion transports skip an
unmatched HTTP probe. A reachable local router with an offline upstream, or
connectivity lost after the check, is handled by the first-request gate below.

If a reachable router's upstream fails on the first Native model request,
retry is allowed only for a trusted transient failure before any response,
streamed text or tool execution. The host waits for that Native attempt to
settle, drains steering/writes, and verifies the exact saved history while it
still owns the session. A private receipt pins the same destination and one
pending model prompt across retry and restart, including fresh-per-run jobs.
The retained workspace boundary is checked again at Native admission, even when
that pending prompt is the conversation’s only message.
Failed-attempt diagnostics remain visible; retries do not append repeated copies
to the model context. If the user continues or changes that conversation while
waiting, the receipt becomes stale and this retry stops for review. A missing
or unavailable retained destination also requires review; no substitute
conversation is silently created.

**Prompt sent** means the agent accepted the instructions, not that its work
finished. Open the linked session to inspect progress, approvals and results.
Normal workspace permissions still apply. Once a model reply, streamed text,
tool/command or other agent work has started, later connectivity failures are
not replayed automatically. Authentication, unknown failures, cancellation,
changed ownership and unverified persistence never grant retry authority.
This is proof that no agent work was replayed; it does not certify that a remote
provider performed no computation or incurred no usage before failing.

A persisted interrupted dispatch is reported as failed and advances to the next
normal occurrence, because the previous work may already have started. Unknown
or rejected dispatch effects are never automatically retried. Exactly-once
external effects across a crash or power loss are not certified.

A one-off occurrence is consumed after its attempt, including Run now. Failure
or a busy session never causes an immediate retry loop. Inspect and explicitly
run or edit it again if needed. Storage errors halt automatic scheduling and
surface a warning; inspect the saved state and existing work before restarting
the host. Shutdown retains ownership of entered schedule work until it settles.
