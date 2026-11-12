# Continue work across agents

Open **Hand over work** in a Chat header or the lead character's message dialog.
Extalia keeps a canonical work record that links the original objective,
reviewed decisions, visible evidence and each transfer. Native application
thread IDs remain separate.

## Change an Extalia Native model connection

1. Finish or stop the current turn and inspect pending or uncertain prompts.
2. Choose **Extalia Native connection**, a saved connection and the intended
   model. Select an effort only when the target API supports it.
3. Review the six working-note fields. Keep completed work, pending steps and
   actual verification separate. Extalia initializes missing notes from visible
   source text; it does not silently certify a model's assertions.
4. Select **Review handover**, inspect the destination, exact packet and coverage
   gaps, then confirm and apply.
5. Continue with an ordinary prompt. The existing Native session ID and history
   are retained. Applying handover alone does not run a model or a tool.

The destination uses the same workspace and saved-history policy. Team settings
remain saved. Review inherited team model choices if the new endpoint has a
different model catalog.

## Hand work to an existing agent conversation

Choose **Existing agent conversation** and an observed conversation associated
with the same workspace. Extalia offers only routes its host currently verifies.
A Codex/Hermes attachment, source queue and cooperating inbox are different
routes; they are not universal remote-control support.

Use **Project association** beside the handover control in Chat or the lead
character dialog to review its workspace. Choices are existing workspaces whose
own folders contain the reported project. Register a missing folder under
Workspaces first. Ambiguous matches need a choice. A changed source or folder
requires a fresh review, and an existing work record keeps its workspace scope.

For Claude, Gemini or another app without a verified send route, choose
**Manual handover**, name the destination and optionally link its existing
observed conversation. Review and copy the packet, then paste it in that app.
Manual-ready means prepared: it does not prove you pasted the packet or that the
model read it. An unlinked manual destination is copy-only and cannot supply
future observed progress until it is explicitly linked.

To hand back, select the destination conversation in Extalia and open handover
again. Linked endpoints use the same canonical work record. The next packet
retains original source evidence and reviewed working notes, rather than
summarizing only the previous packet. Do not manually start an unrelated work
record when you intend to continue this one.

## Inspect what each agent actually had available

The dialog lists source/model identity, the last retained visible event, source
coverage, omissions, and reported token use/compactions. **Full** means the
visible source snapshot, not all of an outside harness's private context.
Inspect source archives to read retained older evidence. Native agents with
handover context also have paged `continuity_status` / `continuity_read` tools.
External agents using the updated Extalia MCP server can call
`extalia_continuity_status` and `extalia_continuity_read` with the scoped archive
code from their reviewed packet and their own conversation ID. Access is limited
to those reviewed notes and snapshots for 24 hours. It cannot read work added
later. Pausing/removing the observation or enabling labels-only privacy revokes
the grant; copied access codes are not ordinary task text and should not be
forwarded. A client may need its MCP tool connection refreshed after an Extalia
update. No other application's configuration is changed by a handover.

Agents without those tools need the packet or manually supplied archive pages;
Extalia does not claim they can retrieve hidden context automatically.

Verify current files before acting on old tool output. An archived edit or test
result is historical evidence, not permission to replay it or a guarantee that
the file still matches.

## Handle uncertain delivery

Queued and submitted receipts show transport acceptance only. If delivery is
unknown, inspect the destination and the original agent before continuing.
Record either destination acceptance or non-delivery through the explicit
inspection controls. This creates a **user-inspected** record; it never resends
the old operation, proves understanding, clears an approval, or releases an
unsettled worker. Existing execution/ownership guards still apply.

Saved work records survive host restart. History-off records are memory-only.
Labels-only privacy hides observed/mixed archives. Storage and packet limits
are explicit; Extalia refuses to discard earlier records silently when full.
